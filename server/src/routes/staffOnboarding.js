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

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const dataDir = process.env.DATA_DIR || join(projectRoot, 'data');
const staffUploadsDir = join(dataDir, 'uploads', 'staff');

const router = Router();

const documentTypes = ['drivers_licence_front', 'drivers_licence_back', 'blue_card', 'yellow_card', 'first_aid', 'car_insurance'];

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

    const id = uuidv4();
    db.prepare(`
      INSERT INTO staff_compliance_documents (id, staff_id, document_type, file_path, expiry_date, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, ctx.staff.id, documentType, relPath, expiryDate, status);

    db.prepare('DELETE FROM staff_renewal_tokens WHERE token = ?').run(req.params.token);

    try {
      const buf = readFileSync(req.file.path);
      void tryPushStaffDocument({
        staffId: ctx.staff.id,
        category: documentType,
        buffer: buf,
        originalFilename: req.file.filename,
        mimeType: mimeForStaffUpload(req.file.path),
        notes: documentType
      });
    } catch (e) {
      console.warn('[staff-onboarding renew] OneDrive push skipped:', e?.message);
    }

    res.json({ ok: true, message: 'Document uploaded. Thank you.', id, document_type: documentType, expiry_date: expiryDate, status });
  } catch (err) {
    console.error('[renew upload]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/public/staff-onboarding/:token/policy/:policyId - serve policy PDF (validates token)
router.get('/:token/policy/:policyId', (req, res) => {
  const staff = validateToken(req.params.token);
  if (!staff) return res.status(404).send('Invalid or expired link');
  const policy = db.prepare('SELECT id, display_name, file_path FROM company_policy_files WHERE id = ?').get(req.params.policyId);
  if (!policy) return res.status(404).send('Policy not found');
  const fullPath = join(projectRoot, policy.file_path);
  if (!existsSync(fullPath)) return res.status(404).send('File not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(policy.display_name || 'policy').replace(/"/g, '%22')}.pdf"`);
  createReadStream(fullPath).pipe(res);
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
      policyFiles = db.prepare('SELECT id, display_name, file_path FROM company_policy_files WHERE provider_profile_id = ?').all(onboarding.provider_profile_id);
    }
    res.json({
      staff: {
        name: staffRow?.name,
        email: staffRow?.email,
        role: staffRow?.role,
        employment_type: staffRow?.employment_type,
        hourly_rate: staffRow?.hourly_rate,
      },
      policyFiles: policyFiles.map((p) => ({ id: p.id, display_name: p.display_name })),
      currentStep: onboarding.current_step,
      status: onboarding.status,
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
    const flat = typeof data === 'object' ? flattenForIntake(data) : { 'step': String(data) };

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

    if (stepNum === 2 && data) {
      const tfn = data.tfn || data.tax_file_number;
      const bankBsb = data.bank_bsb;
      const bankAccount = data.bank_account;
      const superFund = data.super_fund_name;
      const superMember = data.super_member_number;
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
    }

    const nextStep = Math.min(5, stepNum + 1);
    db.prepare('UPDATE staff_onboarding SET current_step = ?, last_activity_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?').run(nextStep, onboarding.id);

    res.json({ ok: true, currentStep: nextStep });
  } catch (err) {
    console.error('[staff-onboarding step]', err);
    res.status(500).json({ error: err.message });
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
    if (!documentTypes.includes(documentType)) return res.status(400).json({ error: 'Invalid document_type' });

    const staff = validateToken(req.params.token);
    const onboarding = getOnboarding(staff.id);
    if (!onboarding) return res.status(404).json({ error: 'Onboarding not found' });

    const filePath = req.file.path;
    let expiryDate = req.body?.expiry_date || null;
    // PLACEHOLDER: integrate OCR service; otherwise use manual expiry from request body
    if (!expiryDate) {
      const extracted = await extractExpiryFromDocument(filePath);
      if (extracted) expiryDate = extracted;
    }
    const status = expiryDate ? computeDocStatus(expiryDate) : 'valid';
    const relPath = join('data', 'uploads', 'staff', staff.id, req.file.filename);

    const id = uuidv4();
    db.prepare(`
      INSERT INTO staff_compliance_documents (id, staff_id, document_type, file_path, expiry_date, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, staff.id, documentType, relPath, expiryDate, status);

    try {
      const buf = readFileSync(filePath);
      void tryPushStaffDocument({
        staffId: staff.id,
        category: documentType,
        buffer: buf,
        originalFilename: req.file.filename,
        mimeType: mimeForStaffUpload(filePath),
        notes: documentType
      });
    } catch (e) {
      console.warn('[staff-onboarding upload-document] OneDrive push skipped:', e?.message);
    }

    res.json({ ok: true, id, document_type: documentType, expiry_date: expiryDate, status });
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

    const staffRow = db.prepare('SELECT name FROM staff WHERE id = ?').get(staff.id);
    const docs = db.prepare('SELECT id, document_type, file_path FROM staff_compliance_documents WHERE staff_id = ?').all(staff.id);

    for (const doc of docs) {
      const fullPath = join(projectRoot, doc.file_path);
      if (existsSync(fullPath)) {
        try {
          const buf = readFileSync(fullPath);
          void tryPushStaffDocument({
            staffId: staff.id,
            category: doc.document_type,
            buffer: buf,
            originalFilename: `${doc.document_type}.${(doc.file_path || '').split('.').pop() || 'pdf'}`,
            mimeType: mimeForStaffUpload(fullPath),
            notes: `Onboarding submit: ${doc.document_type}`
          });
        } catch (e) {
          console.warn('[staff-onboarding submit] org OneDrive push skip:', e?.message);
        }
        try {
          await uploadFileToStaffFolder(staffRow?.name, doc.file_path, fullPath, `${doc.document_type}.${(doc.file_path || '').split('.').pop() || 'pdf'}`);
        } catch (e) {
          console.warn('[staff-onboarding submit] legacy OneDrive upload skip:', e?.message);
        }
      }
    }

    db.prepare('UPDATE staff_onboarding SET status = \'complete\', completed_at = datetime(\'now\'), current_step = 5, updated_at = datetime(\'now\') WHERE id = ?').run(onboarding.id);
    db.prepare('UPDATE staff SET onboarding_status = \'complete\', onboarding_token = NULL, onboarding_token_expires_at = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(staff.id);

    const adminUser = db.prepare('SELECT id, email FROM users WHERE role = \'admin\' ORDER BY created_at ASC LIMIT 1').get();
    if (adminUser?.email && isEmailConfiguredForUser(adminUser.id)) {
      const subject = 'Staff onboarding complete – ' + (staffRow?.name || staff.id);
      const text = `Staff member ${staffRow?.name || staff.id} has completed their onboarding form. Review their profile and compliance documents in Nexus Core.`;
      try {
        await sendEmailViaRelay(adminUser.id, adminUser.email, subject, text, null, null);
      } catch (e) {
        console.warn('[staff-onboarding submit] Admin notify failed:', e?.message);
      }
    }

    res.json({ ok: true, message: 'Onboarding complete' });
  } catch (err) {
    console.error('[staff-onboarding submit]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
