/**
 * Public staff onboarding API - no auth. Access by token in URL.
 * GET /:token - form context; POST /:token/step - save step; POST /:token/upload-document - compliance file; POST /:token/submit - complete.
 */

import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, existsSync, createReadStream, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import { extractExpiryFromDocument } from '../services/ocrExpiry.service.js';
import { uploadFileToStaffFolder } from '../services/oneDriveUpload.service.js';
import { tryPushStaffDocument } from '../services/orgOnedriveSync.service.js';
import { sendEmailViaRelay, isEmailConfiguredForUser } from '../services/notification.service.js';
import {
  applyStaffIntakeToStaffRow,
  getStaffIntakeFieldMap,
  mergeStaffIntakeForProfile
} from '../services/staffOnboardingSync.service.js';
import {
  generateStaffContractBuffers,
  getStaffContractTemplate,
  persistStaffContractDocx,
  persistStaffContractFile
} from '../services/staffContractFill.service.js';
import { listPoliciesForStaffOnboarding } from '../services/onboardingDocumentPacks.service.js';
import { upsertStaffComplianceDocument } from '../services/staffComplianceDocuments.service.js';
import { renderLibraryDocument } from '../services/documentLibraryRender.service.js';
import { fillAcroFormWithTokens } from '../services/formFill.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const dataDir = process.env.DATA_DIR || join(projectRoot, 'data');
const staffUploadsDir = join(dataDir, 'uploads', 'staff');

const router = Router();

const documentTypes = ['drivers_licence_front', 'drivers_licence_back', 'blue_card', 'yellow_card', 'first_aid', 'car_insurance'];
const documentTypeLabels = {
  drivers_licence_front: "Driver's licence (front)",
  drivers_licence_back: "Driver's licence (back)",
  blue_card: 'Blue Card (Working With Children Check)',
  yellow_card: 'Yellow Card (Disability Worker Screening)',
  first_aid: 'First Aid Certificate',
  car_insurance: 'Car insurance certificate',
};

function mimeForStaffUpload(filePath) {
  const ext = (filePath || '').split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  return 'application/octet-stream';
}

function validateToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT id, name, email, onboarding_token, onboarding_token_expires_at FROM staff WHERE onboarding_token = ?').get(token);
  if (!s) return null;
  const expires = s.onboarding_token_expires_at;
  if (expires && new Date(expires) < new Date()) return null;
  return s;
}

function getOnboarding(staffId) {
  return db.prepare('SELECT * FROM staff_onboarding WHERE staff_id = ?').get(staffId);
}

function cleanStr(v) {
  return v == null ? '' : String(v).trim();
}

function cleanDocumentDisplayName(value, fallback) {
  const cleaned = cleanStr(value).replace(/\s+/g, ' ').slice(0, 120);
  return cleaned || fallback || 'Document';
}

function composeAddressFromFields(fields = {}) {
  const existing = cleanStr(fields.address);
  if (existing) return existing;
  return [fields.street_address, fields.suburb_city, fields.state, fields.postcode]
    .map(cleanStr)
    .filter(Boolean)
    .join(', ');
}

function validateRequiredFields(fields, requiredKeys) {
  const missing = requiredKeys.filter((key) => !cleanStr(fields?.[key]));
  if (missing.length) {
    const err = new Error(`Missing required field(s): ${missing.join(', ')}`);
    err.statusCode = 400;
    err.missingFields = missing;
    throw err;
  }
}

/**
 * Normalize saved keys + legacy full_name into first_name / last_name / full_legal_name for the client.
 */
function normalizeStaffPersonalFields(intakeFields, staffNameFallback) {
  let first = cleanStr(intakeFields.first_name);
  let last = cleanStr(intakeFields.last_name);
  let fullLegal = cleanStr(intakeFields.full_legal_name);
  const legacyFull = cleanStr(intakeFields.full_name);
  if (!first && !last && legacyFull) {
    const p = legacyFull.split(/\s+/);
    first = p[0] || '';
    last = p.slice(1).join(' ') || '';
  }
  if (!fullLegal && legacyFull && !intakeFields.full_legal_name) fullLegal = legacyFull;
  const fb = cleanStr(staffNameFallback);
  if (!first && !last && fb && !legacyFull) {
    const p = fb.split(/\s+/);
    first = p[0] || '';
    last = p.slice(1).join(' ') || '';
  }
  return {
    first_name: first,
    last_name: last,
    full_legal_name: fullLegal,
    date_of_birth: intakeFields.date_of_birth || '',
    address: composeAddressFromFields(intakeFields),
    street_address: intakeFields.street_address || '',
    suburb_city: intakeFields.suburb_city || '',
    state: intakeFields.state || '',
    postcode: intakeFields.postcode || '',
    phone: intakeFields.phone || '',
    emergency_contact_name: intakeFields.emergency_contact_name || '',
    emergency_contact_phone: intakeFields.emergency_contact_phone || ''
  };
}

/** Organisation that owns this staff record — same scoping as the rest of the API (never notify a different tenant). */
function resolveStaffOrganisationId(staffId, onboardingRow) {
  const staffOrg = db.prepare('SELECT org_id FROM staff WHERE id = ?').get(staffId);
  if (staffOrg?.org_id) return staffOrg.org_id;
  if (onboardingRow?.provider_profile_id) {
    const pp = db
      .prepare('SELECT organisation_id FROM provider_profiles WHERE id = ?')
      .get(onboardingRow.provider_profile_id);
    if (pp?.organisation_id) return pp.organisation_id;
  }
  return null;
}

function validateRenewalToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT id, staff_id, token, expires_at FROM staff_renewal_tokens WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  const staff = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(row.staff_id);
  return staff ? { staff, renewalRow: row } : null;
}

// ----- Renewal link (staff upload renewed doc via email link) -----
// GET /api/public/staff-onboarding/renew/:token - context for renewal page
router.get('/renew/:token', (req, res) => {
  try {
    const ctx = validateRenewalToken(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'Invalid or expired renewal link' });
    res.json({ staffName: ctx.staff.name, documentTypes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const renewalStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ctx = validateRenewalToken(req.params.token);
    if (!ctx) return cb(new Error('Invalid token'));
    const dir = join(staffUploadsDir, ctx.staff.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const docType = req.body?.document_type || 'document';
    const ext = (file.originalname || '').split('.').pop() || 'pdf';
    cb(null, `renew_${docType}_${Date.now()}.${ext}`);
  },
});
const uploadRenewal = multer({ storage: renewalStorage, limits: { fileSize: 15 * 1024 * 1024 } });

// POST /api/public/staff-onboarding/renew/:token/upload - upload renewed document, then clear token
router.post('/renew/:token/upload', (req, res, next) => {
  const ctx = validateRenewalToken(req.params.token);
  if (!ctx) return res.status(404).json({ error: 'Invalid or expired renewal link' });
  req.renewalContext = ctx;
  next();
}, uploadRenewal.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ctx = req.renewalContext;
    const documentType = req.body?.document_type || '';
    if (!documentTypes.includes(documentType)) return res.status(400).json({ error: 'Invalid document_type' });

    let expiryDate = req.body?.expiry_date || null;
    if (!expiryDate) {
      const extracted = await extractExpiryFromDocument(req.file.path);
      if (extracted) expiryDate = extracted;
    }
    const status = expiryDate ? computeDocStatus(expiryDate) : 'valid';
    const relPath = join('data', 'uploads', 'staff', ctx.staff.id, req.file.filename);

    const displayName = cleanDocumentDisplayName(req.body?.display_name, documentTypeLabels[documentType] || documentType);
    const saved = upsertStaffComplianceDocument({
      staffId: ctx.staff.id,
      documentType,
      displayName,
      filePath: relPath,
      expiryDate,
      status
    });

    db.prepare('DELETE FROM staff_renewal_tokens WHERE token = ?').run(req.params.token);

    try {
      const buf = readFileSync(req.file.path);
      void tryPushStaffDocument({
        staffId: ctx.staff.id,
        category: documentType,
        buffer: buf,
        originalFilename: req.file.filename,
        mimeType: mimeForStaffUpload(req.file.path),
        notes: displayName
      });
    } catch (e) {
      console.warn('[staff-onboarding renew] OneDrive push skipped:', e?.message);
    }

    res.json({
      ok: true,
      message: 'Document uploaded. Thank you.',
      id: saved.id,
      document_type: documentType,
      display_name: displayName,
      expiry_date: expiryDate,
      status,
      replaced_existing: !saved.created
    });
  } catch (err) {
    console.error('[renew upload]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/public/staff-onboarding/:token/employment-contract - prefilled docx/pdf (validates token)
router.get('/:token/employment-contract', async (req, res) => {
  try {
    const staff = validateToken(req.params.token);
    if (!staff) return res.status(404).json({ error: 'Invalid or expired link' });
    const onboarding = getOnboarding(staff.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    const staffRow = db.prepare('SELECT * FROM staff WHERE id = ?').get(staff.id);
    const rawIntake = getStaffIntakeFieldMap(onboarding.id);
    const merged = mergeStaffIntakeForProfile(rawIntake, staffRow?.name);
    const { docx, pdf, templateMeta } = await generateStaffContractBuffers(staffRow, merged, onboarding.provider_profile_id);
    if (!pdf?.length && !docx?.length) {
      return res.status(404).json({ error: 'No employment contract template configured for your organisation.' });
    }
    const base = (templateMeta?.displayName || 'employment-contract').replace(/[^a-zA-Z0-9-_]+/g, '_');
    if (pdf?.length) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
      return res.send(pdf);
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.docx"`);
    return res.send(docx);
  } catch (err) {
    console.error('[staff-onboarding employment-contract]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/public/staff-onboarding/:token/policy/:policyId - serve policy PDF (validates token)
router.get('/:token/policy/:policyId', (req, res) => {
  const staff = validateToken(req.params.token);
  if (!staff) return res.status(404).send('Invalid or expired link');
  const policy = db.prepare('SELECT id, display_name, file_path FROM company_policy_files WHERE id = ?').get(req.params.policyId);
  if (!policy) return res.status(404).send('Policy not found');
  const onboarding = getOnboarding(staff.id);
  const allowed = listPoliciesForStaffOnboarding(onboarding?.provider_profile_id).some(
    (p) => p.kind === 'policy' && p.id === req.params.policyId
  );
  if (!allowed) return res.status(404).send('Policy not found');
  const fullPath = join(projectRoot, policy.file_path);
  if (!existsSync(fullPath)) return res.status(404).send('File not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(policy.display_name || 'policy').replace(/"/g, '%22')}.pdf"`);
  createReadStream(fullPath).pipe(res);
});

// GET /api/public/staff-onboarding/:token/library-doc/:masterId - serve branded library acknowledgement doc (validates token)
router.get('/:token/library-doc/:masterId', async (req, res) => {
  const staff = validateToken(req.params.token);
  if (!staff) return res.status(404).send('Invalid or expired link');
  const onboarding = getOnboarding(staff.id);
  if (!onboarding?.provider_profile_id) return res.status(404).send('Document not found');

  const allowed = listPoliciesForStaffOnboarding(onboarding.provider_profile_id).find(
    (p) => p.kind === 'library' && p.id === req.params.masterId
  );
  if (!allowed) return res.status(404).send('Document not found');

  const pp = db.prepare('SELECT organisation_id FROM provider_profiles WHERE id = ?').get(onboarding.provider_profile_id);
  const orgId = pp?.organisation_id || null;
  const staffFull = db.prepare('SELECT * FROM staff WHERE id = ?').get(staff.id);

  try {
    const rendered = await renderLibraryDocument({ masterId: req.params.masterId, orgId, staff: staffFull });
    let buf = rendered?.buffer;
    if (rendered?.needsAcroFormFill && buf) {
      buf = await fillAcroFormWithTokens(buf, rendered.tokens);
    }
    if (!buf) return res.status(404).send('Document not available');
    const ext = rendered.mime === 'application/pdf' ? 'pdf' : 'docx';
    const safe = (allowed.display_name || 'document').replace(/"/g, '%22');
    res.setHeader('Content-Type', rendered.mime || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safe}.${ext}"`);
    return res.send(buf);
  } catch (err) {
    console.error('[staff-onboarding library-doc]', err);
    return res.status(500).send('Failed to render document');
  }
});

// GET /api/public/staff-onboarding/:token - form context for staff (no auth)
router.get('/:token', (req, res) => {
  try {
    const staff = validateToken(req.params.token);
    if (!staff) return res.status(404).json({ error: 'Invalid or expired link' });

    const onboarding = getOnboarding(staff.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    const staffRow = db.prepare('SELECT name, email, role, employment_type, hourly_rate FROM staff WHERE id = ?').get(staff.id);
    let policyFiles = [];
    if (onboarding.provider_profile_id) {
      policyFiles = listPoliciesForStaffOnboarding(onboarding.provider_profile_id).map((p) => ({
        id: p.id,
        display_name: p.display_name,
        kind: p.kind
      }));
    }
    const rawIntake = getStaffIntakeFieldMap(onboarding.id);
    const normPersonal = normalizeStaffPersonalFields(rawIntake, staffRow?.name);
    const intakeFields = { ...rawIntake, ...normPersonal };
    res.json({
      staff: {
        name: staffRow?.name,
        email: staffRow?.email,
        role: staffRow?.role,
        employment_type: staffRow?.employment_type,
        hourly_rate: staffRow?.hourly_rate,
      },
      intakeFields,
      policyFiles,
      currentStep: onboarding.current_step,
      status: onboarding.status,
      employmentContractAvailable: Boolean(getStaffContractTemplate(onboarding.provider_profile_id)),
    });
  } catch (err) {
    console.error('[staff-onboarding GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/public/staff-onboarding/:token/step - save step data (JSON)
router.post('/:token/step', (req, res) => {
  try {
    const staff = validateToken(req.params.token);
    if (!staff) return res.status(404).json({ error: 'Invalid or expired link' });

    const onboarding = getOnboarding(staff.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    if (onboarding.status === 'complete') return res.status(400).json({ error: 'Onboarding already complete' });

    const { step, data } = req.body || {};
    if (!data || step == null) return res.status(400).json({ error: 'step and data required' });

    const stepNum = Number(step);
    const stepData = data && typeof data === 'object' ? { ...data } : data;
    if (stepNum === 1 && stepData && typeof stepData === 'object') {
      validateRequiredFields(stepData, [
        'first_name',
        'last_name',
        'date_of_birth',
        'street_address',
        'suburb_city',
        'state',
        'postcode',
        'phone',
        'emergency_contact_name',
        'emergency_contact_phone'
      ]);
      stepData.address = composeAddressFromFields(stepData);
    }
    if (stepNum === 2 && stepData && typeof stepData === 'object') {
      const required = ['role', 'hourly_rate', 'bank_bsb', 'bank_account'];
      if (stepData.employment_type === 'subcontractor') required.push('abn');
      validateRequiredFields(stepData, required);
    }
    if (stepNum === 4 && stepData && typeof stepData === 'object') {
      validateRequiredFields(stepData, ['signature']);
      if (!stepData.policy_acknowledged) {
        return res.status(400).json({ error: 'Confirm policy acknowledgement before continuing.', missingFields: ['policy_acknowledged'] });
      }
    }
    if (stepNum === 5 && stepData && typeof stepData === 'object' && !stepData.tfd_confirmed) {
      return res.status(400).json({ error: 'Confirm the Tax File Declaration before submitting.', missingFields: ['tfd_confirmed'] });
    }
    const flat = typeof stepData === 'object' ? flattenForIntake(stepData) : { 'step': String(stepData) };

    for (const [key, value] of Object.entries(flat)) {
      if (value === undefined || value === null) continue;
      const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
      const existing = db.prepare('SELECT id FROM staff_intake_fields WHERE staff_onboarding_id = ? AND field_key = ?').get(onboarding.id, key);
      if (existing) {
        db.prepare('UPDATE staff_intake_fields SET field_value = ?, updated_at = datetime(\'now\') WHERE id = ?').run(val, existing.id);
      } else {
        db.prepare('INSERT INTO staff_intake_fields (id, staff_onboarding_id, field_key, field_value, source) VALUES (?, ?, ?, ?, \'user\')').run(uuidv4(), onboarding.id, key, val);
      }
    }

    if (stepNum === 1 && stepData && typeof stepData === 'object') {
      const intakeMerged = mergeStaffIntakeForProfile(getStaffIntakeFieldMap(onboarding.id), staff.name);
      applyStaffIntakeToStaffRow(staff.id, intakeMerged, {
        onlyKeys: new Set(['name', 'phone', 'address', 'date_of_birth', 'emergency_contact_name', 'emergency_contact_phone'])
      });
    }

    if (stepNum === 2 && stepData) {
      const tfn = stepData.tfn || stepData.tax_file_number;
      const bankBsb = stepData.bank_bsb;
      const bankAccount = stepData.bank_account;
      const superFund = stepData.super_fund_name;
      const superMember = stepData.super_member_number;
      if (tfn != null || bankBsb != null || bankAccount != null || superFund != null || superMember != null) {
        const existing = db.prepare('SELECT id FROM staff_sensitive_data WHERE staff_id = ?').get(staff.id);
        const encTfn = tfn ? encrypt(String(tfn)) : null;
        const encAccount = bankAccount ? encrypt(String(bankAccount)) : null;
        if (existing) {
          db.prepare(`
            UPDATE staff_sensitive_data SET tfn_encrypted = COALESCE(?, tfn_encrypted), bank_bsb = COALESCE(?, bank_bsb),
              bank_account_encrypted = COALESCE(?, bank_account_encrypted), super_fund_name = COALESCE(?, super_fund_name),
              super_member_number = COALESCE(?, super_member_number), updated_at = datetime('now') WHERE staff_id = ?
          `).run(encTfn, bankBsb || null, encAccount, superFund || null, superMember || null, staff.id);
        } else {
          db.prepare(`
            INSERT INTO staff_sensitive_data (id, staff_id, tfn_encrypted, bank_bsb, bank_account_encrypted, super_fund_name, super_member_number)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(uuidv4(), staff.id, encTfn, bankBsb || null, encAccount, superFund || null, superMember || null);
        }
      }
      const intakeMerged = mergeStaffIntakeForProfile(getStaffIntakeFieldMap(onboarding.id), staff.name);
      applyStaffIntakeToStaffRow(staff.id, intakeMerged, {
        onlyKeys: new Set(['role', 'employment_type', 'hourly_rate', 'abn'])
      });
    }

    if (stepNum === 4 && stepData && typeof stepData === 'object' && stepData.policy_acknowledged) {
      const sig = stepData.signature != null ? String(stepData.signature) : '';
      if (onboarding.provider_profile_id) {
        const policies = listPoliciesForStaffOnboarding(onboarding.provider_profile_id);
        db.prepare('DELETE FROM staff_policy_acknowledgements WHERE staff_onboarding_id = ?').run(onboarding.id);
        const insertAck = db.prepare(`
          INSERT INTO staff_policy_acknowledgements (id, staff_onboarding_id, policy_file_id, signature_data, acknowledged_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `);
        for (const p of policies) {
          insertAck.run(uuidv4(), onboarding.id, p.id, sig);
        }
      }
    }

    const nextStep = Math.min(5, stepNum + 1);
    db.prepare('UPDATE staff_onboarding SET current_step = ?, last_activity_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?').run(nextStep, onboarding.id);

    res.json({ ok: true, currentStep: nextStep });
  } catch (err) {
    console.error('[staff-onboarding step]', err);
    res.status(err.statusCode || 500).json({ error: err.message, missingFields: err.missingFields || undefined });
  }
});

function flattenForIntake(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      Object.assign(out, flattenForIntake(v, prefix + k + '.'));
    } else {
      out[prefix + k] = v;
    }
  }
  return out;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const staff = validateToken(req.params.token);
    if (!staff) return cb(new Error('Invalid token'));
    const dir = join(staffUploadsDir, staff.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const docType = req.body?.document_type || 'document';
    const ext = (file.originalname || '').split('.').pop() || 'pdf';
    cb(null, `${docType}_${Date.now()}.${ext}`);
  },
});
const uploadDoc = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// POST /api/public/staff-onboarding/:token/upload-document - compliance document (multipart)
router.post('/:token/upload-document', (req, res, next) => {
  const staff = validateToken(req.params.token);
  if (!staff) return res.status(404).json({ error: 'Invalid or expired link' });
  next();
}, uploadDoc.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const documentType = req.body?.document_type || '';
    const displayName = cleanDocumentDisplayName(req.body?.display_name, documentTypeLabels[documentType] || documentType);
    if (!documentTypes.includes(documentType) && documentType !== 'other') return res.status(400).json({ error: 'Invalid document_type' });
    if (documentType === 'other' && !cleanStr(req.body?.display_name)) return res.status(400).json({ error: 'Please name this document.' });

    const staff = validateToken(req.params.token);
    const onboarding = getOnboarding(staff.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    const filePath = req.file.path;
    let expiryDate = req.body?.expiry_date || null;
    if (!expiryDate) {
      const extracted = await extractExpiryFromDocument(filePath);
      if (extracted) expiryDate = extracted;
    }
    const status = expiryDate ? computeDocStatus(expiryDate) : 'valid';
    const relPath = join('data', 'uploads', 'staff', staff.id, req.file.filename);

    const saved = upsertStaffComplianceDocument({
      staffId: staff.id,
      documentType,
      displayName,
      filePath: relPath,
      expiryDate,
      status
    });

    try {
      const buf = readFileSync(filePath);
      if (saved.created) {
        void tryPushStaffDocument({
          staffId: staff.id,
          category: documentType,
          buffer: buf,
          originalFilename: req.file.filename,
          mimeType: mimeForStaffUpload(filePath),
          notes: displayName
        });
      }
    } catch (e) {
      console.warn('[staff-onboarding upload-document] OneDrive push skipped:', e?.message);
    }

    res.json({
      ok: true,
      id: saved.id,
      document_type: documentType,
      display_name: displayName,
      expiry_date: expiryDate,
      status,
      replaced_existing: !saved.created
    });
  } catch (err) {
    console.error('[staff-onboarding upload-document]', err);
    res.status(500).json({ error: err.message });
  }
});

function computeDocStatus(expiryDate) {
  const exp = new Date(expiryDate);
  const now = new Date();
  if (exp < now) return 'expired';
  const daysLeft = (exp - now) / (24 * 60 * 60 * 1000);
  if (daysLeft <= 30) return 'expiring_soon';
  return 'valid';
}

// POST /api/public/staff-onboarding/:token/submit - final submit, complete onboarding
router.post('/:token/submit', async (req, res) => {
  try {
    const staff = validateToken(req.params.token);
    if (!staff) return res.status(404).json({ error: 'Invalid or expired link' });

    const onboarding = getOnboarding(staff.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });
    if (onboarding.status === 'complete') return res.status(400).json({ error: 'Already complete' });

    const staffRowFull = db.prepare('SELECT * FROM staff WHERE id = ?').get(staff.id);
    const rawIntake = getStaffIntakeFieldMap(onboarding.id);
    const normPersonal = normalizeStaffPersonalFields(rawIntake, staffRowFull?.name);
    const mergedIntake = { ...rawIntake, ...normPersonal };
    validateRequiredFields(mergedIntake, [
      'first_name',
      'last_name',
      'date_of_birth',
      'street_address',
      'suburb_city',
      'state',
      'postcode',
      'phone',
      'emergency_contact_name',
      'emergency_contact_phone',
      'role',
      'hourly_rate',
      'bank_bsb',
      'bank_account'
    ]);
    if (mergedIntake.employment_type === 'subcontractor') validateRequiredFields(mergedIntake, ['abn']);
    if (mergedIntake.policy_acknowledged !== 'true' && mergedIntake.policy_acknowledged !== true) {
      return res.status(400).json({ error: 'Confirm policy acknowledgement before submitting.', missingFields: ['policy_acknowledged'] });
    }
    if (mergedIntake.tfd_confirmed !== 'true' && mergedIntake.tfd_confirmed !== true) {
      return res.status(400).json({ error: 'Confirm the Tax File Declaration before submitting.', missingFields: ['tfd_confirmed'] });
    }
    applyStaffIntakeToStaffRow(staff.id, mergedIntake);

    const staffAfterSync = db.prepare('SELECT * FROM staff WHERE id = ?').get(staff.id);
    const { docx: contractDocx, pdf: contractPdf, templateMeta } = await generateStaffContractBuffers(
      staffAfterSync,
      mergedIntake,
      onboarding.provider_profile_id
    );
    try {
      if (contractPdf?.length && !contractDocx?.length) {
        persistStaffContractFile(staff.id, contractPdf, 'pdf');
      } else if (contractDocx?.length) {
        persistStaffContractDocx(staff.id, contractDocx);
      }
    } catch (e) {
      console.warn('[staff-onboarding submit] persist contract:', e?.message);
    }

    const docs = db.prepare('SELECT id, document_type, display_name, file_path FROM staff_compliance_documents WHERE staff_id = ?').all(staff.id);

    for (const doc of docs) {
      const fullPath = join(projectRoot, doc.file_path);
      if (existsSync(fullPath)) {
        try {
          const buf = readFileSync(fullPath);
          void tryPushStaffDocument({
            staffId: staff.id,
            category: doc.document_type,
            buffer: buf,
            originalFilename: `${(doc.display_name || doc.document_type).replace(/[^a-zA-Z0-9-_]+/g, '_')}.${(doc.file_path || '').split('.').pop() || 'pdf'}`,
            mimeType: mimeForStaffUpload(fullPath),
            notes: `Onboarding submit: ${doc.display_name || doc.document_type}`
          });
        } catch (e) {
          console.warn('[staff-onboarding submit] org OneDrive push skip:', e?.message);
        }
        try {
          await uploadFileToStaffFolder(staffRowFull?.name, doc.file_path, fullPath, `${(doc.display_name || doc.document_type).replace(/[^a-zA-Z0-9-_]+/g, '_')}.${(doc.file_path || '').split('.').pop() || 'pdf'}`);
        } catch (e) {
          console.warn('[staff-onboarding submit] legacy OneDrive upload skip:', e?.message);
        }
      }
    }

    db.prepare('UPDATE staff_onboarding SET status = \'complete\', completed_at = datetime(\'now\'), current_step = 5, updated_at = datetime(\'now\') WHERE id = ?').run(onboarding.id);
    db.prepare('UPDATE staff SET onboarding_status = \'complete\', onboarding_token = NULL, onboarding_token_expires_at = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(staff.id);

    const orgId = resolveStaffOrganisationId(staff.id, onboarding);
    if (!orgId) {
      console.warn('[staff-onboarding submit] Cannot resolve organisation for staff; skipping admin notification', staff.id);
    } else {
      const adminUsers = db
        .prepare(`SELECT id, email, role FROM users WHERE role IN ('admin', 'delegate') AND org_id = ? ORDER BY role = 'admin' DESC, created_at ASC`)
        .all(orgId);
      const configuredAdminUsers = adminUsers.filter((adminUser) => adminUser?.email && isEmailConfiguredForUser(adminUser.id));
      const subject = 'Staff onboarding complete – ' + (staffRowFull?.name || staff.id);
      let text = `Staff member ${staffRowFull?.name || staff.id} has completed their onboarding form. Review their profile and compliance documents in Nexus Core.`;
      const safeBase = (templateMeta?.displayName || 'Employment-contract').replace(/[^a-zA-Z0-9-_]+/g, '_');
      const contractAttachments = [];
      if (contractPdf?.length) {
        contractAttachments.push({
          filename: `${safeBase}.pdf`,
          content: contractPdf,
          contentType: 'application/pdf'
        });
      } else if (contractDocx?.length) {
        contractAttachments.push({
          filename: `${safeBase}.docx`,
          content: contractDocx,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
      }
      if (contractAttachments.length) {
        text += '\n\nA prefilled employment contract is attached for signing.';
      }
      if (configuredAdminUsers.length === 0) {
        console.warn('[staff-onboarding submit] No configured admin/delegate email recipients for completion notification', {
          orgId,
          staffId: staff.id,
          candidateCount: adminUsers.length
        });
      }
      for (const adminUser of configuredAdminUsers) {
        try {
          await sendEmailViaRelay(adminUser.id, adminUser.email, subject, text, null, contractAttachments.length ? contractAttachments : null);
        } catch (e) {
          console.warn('[staff-onboarding submit] Admin notify failed:', e?.message);
        }
      }
    }

    res.json({ ok: true, message: 'Onboarding complete' });
  } catch (err) {
    console.error('[staff-onboarding submit]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
