import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { requireAgencyShell } from '../middleware/agencyShell.js';
import { sendEmailViaRelay, isEmailConfiguredForUser, formatSmtpAuthError } from '../services/notification.service.js';
import { pullSummaryFromExcel } from '../services/excelPull.service.js';
import { computeHoursFromShifts } from '../services/shiftHours.service.js';
import { ensureProviderProfile, assertStaffOnboardingReady } from '../services/onboarding.service.js';
import { orchestrateStaffOnboarding } from '../services/staffOnboardingOrchestrator.service.js';
import { generateStaffContractBuffers } from '../services/staffContractFill.service.js';
import { buildPolicyAttachmentsForEmail } from '../services/onboardingDocumentPacks.service.js';
import { getStaffIntakeFieldMap, mergeStaffIntakeForProfile } from '../services/staffOnboardingSync.service.js';
import { STAFF_ONBOARDING_FIELD_DEFS } from '../../../shared/onboardingFieldRegistry.js';
import {
  getShifterFieldsByStaffId,
  setShifterEnabledForStaffEmail,
  sendShifterInvitesForStaffIds,
  isSupabaseShifterConfigured,
  provisionNexusSupabaseProfileForStaff,
  generateShifterInviteLinkForEmail,
} from '../services/supabaseStaffShifter.service.js';
import {
  scheduleRemoveShiftFromNexusSupabase,
  scheduleMirrorShiftsForStaffSqliteId,
} from '../services/nexusPublicShiftsSync.service.js';
import { availabilityFromRequestBody } from '../lib/staffAvailability.js';
import { tryPushStaffDocument, resolveOrgIdForStaff } from '../services/orgOnedriveSync.service.js';
import { getEmailConfigForUser, getRelayConfigFromEnv } from '../lib/emailSendConfig.js';
import { decrypt } from '../lib/crypto.js';
import { upsertStaffComplianceDocument } from '../services/staffComplianceDocuments.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const dataDir = process.env.DATA_DIR || join(projectRoot, 'data');
const staffUploadsDir = join(dataDir, 'uploads', 'staff');

const DOCUMENT_TYPES = ['drivers_licence_front', 'drivers_licence_back', 'blue_card', 'yellow_card', 'first_aid', 'car_insurance'];
const DOCUMENT_TYPE_LABELS = {
  drivers_licence_front: "Driver's licence (front)",
  drivers_licence_back: "Driver's licence (back)",
  blue_card: 'Blue Card (Working With Children Check)',
  yellow_card: 'Yellow Card (Disability Worker Screening)',
  first_aid: 'First Aid Certificate',
  car_insurance: 'Car insurance certificate',
};

function cleanDocumentDisplayName(value, fallback) {
  const cleaned = value == null ? '' : String(value).trim().replace(/\s+/g, ' ').slice(0, 120);
  return cleaned || fallback || 'Document';
}

const PAY_RATE_OVERRIDE_KEYS = ['weekday', 'saturday', 'sunday', 'public_holiday', 'evening'];
const STAFF_INTAKE_FIELD_META = new Map(STAFF_ONBOARDING_FIELD_DEFS.map((def, order) => [def.key, { ...def, order }]));
const STAFF_INTAKE_SECTION_ORDER = ['personal', 'employment', 'documents', 'policy', 'tax', 'other'];
const STAFF_INTAKE_SECTION_LABELS = {
  personal: 'Personal details',
  employment: 'Employment and payroll',
  documents: 'Compliance documents',
  policy: 'Policy acknowledgement',
  tax: 'Tax declaration',
  other: 'Other details',
};

/** @returns {string|null} JSON string, or null if all keys empty. */
function payRatesJsonFromBody(payRates) {
  if (payRates == null || payRates === undefined) return null;
  if (typeof payRates !== 'object' || Array.isArray(payRates)) return null;
  const out = {};
  for (const k of PAY_RATE_OVERRIDE_KEYS) {
    if (payRates[k] != null && payRates[k] !== '') {
      const n = Number(payRates[k]);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

function computeDocStatus(expiryDate) {
  if (!expiryDate) return 'valid';
  const exp = new Date(expiryDate);
  const now = new Date();
  if (exp < now) return 'expired';
  const daysLeft = (exp - now) / (24 * 60 * 60 * 1000);
  if (daysLeft <= 30) return 'expiring_soon';
  return 'valid';
}

/** SQLite organisations.id aligned with Nexus Core Supabase public.organizations (and Shifter org when configured). */
function nexusOrgIdForSessionUser(userId) {
  if (!userId) return null;
  const user = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  if (user?.org_id) return user.org_id;
  const first = db.prepare('SELECT id FROM organisations ORDER BY created_at ASC LIMIT 1').get();
  return first?.id || null;
}

const complianceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const staffId = req.params.id;
      const dir = join(staffUploadsDir, staffId);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const docType = req.body?.document_type || 'document';
      const ext = (file.originalname || '').split('.').pop() || 'pdf';
      cb(null, `admin_${docType}_${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const router = Router();

function decodeCsvBuffer(buffer) {
  let text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD')) {
    text = buffer.toString('latin1');
  }
  return text;
}

function detectCsvDelimiter(firstLine) {
  if (!firstLine) return ',';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ';' : ',';
}

function parseCSVLine(line, delimiter = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === delimiter && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}

function fileToCsvRows(buffer) {
  const text = decodeCsvBuffer(buffer);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const delimiter = detectCsvDelimiter(lines[0]);
  return lines.map((line) => parseCSVLine(line, delimiter));
}

function normHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function normalizeEmailForImport(e) {
  return String(e || '').trim().toLowerCase();
}

function isValidEmailBasic(email) {
  const s = String(email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function nameFromEmail(email) {
  const s = String(email || '').trim();
  const local = s.includes('@') ? s.split('@')[0] : s;
  const cleaned = local.replace(/[._-]+/g, ' ').trim();
  return cleaned
    ? cleaned.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Staff member';
}

function findColumnIndex(headersNorm, aliases) {
  for (let i = 0; i < headersNorm.length; i++) {
    if (aliases.has(headersNorm[i])) return i;
  }
  for (let i = 0; i < headersNorm.length; i++) {
    const h = headersNorm[i];
    for (const a of aliases) {
      if (h === a) return i;
      if (a.length >= 4 && h.includes(a)) return i;
    }
  }
  return -1;
}

function requesterOrgId(userId) {
  if (!userId) return null;
  return db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId)?.org_id || null;
}

function visibleStaffById(staffId, orgId) {
  if (orgId) {
    return db.prepare('SELECT * FROM staff WHERE id = ? AND org_id = ?').get(staffId, orgId);
  }
  return db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
}

function findStaffComplianceOneDriveUrl(staffId, docId, localFilename) {
  const doc = db
    .prepare('SELECT onedrive_web_url FROM staff_compliance_documents WHERE id = ? AND staff_id = ?')
    .get(docId, staffId);
  if (doc?.onedrive_web_url) return doc.onedrive_web_url;

  const marker = `staff_compliance_document:${docId}`;
  const byMarker = db.prepare(`
    SELECT web_url, graph_item_id
    FROM onedrive_document_register
    WHERE entity_type = 'staff'
      AND entity_id = ?
      AND notes = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(staffId, marker);
  if (byMarker?.web_url) {
    db.prepare(`
      UPDATE staff_compliance_documents
      SET onedrive_web_url = ?, onedrive_item_id = COALESCE(?, onedrive_item_id)
      WHERE id = ?
    `).run(byMarker.web_url, byMarker.graph_item_id || null, docId);
    return byMarker.web_url;
  }

  const orgId = resolveOrgIdForStaff(staffId);
  if (!orgId || !localFilename) return null;
  const rows = db.prepare(`
    SELECT web_url, graph_item_id, filename
    FROM onedrive_document_register
    WHERE organization_id = ?
      AND entity_type = 'staff'
      AND entity_id = ?
      AND web_url IS NOT NULL
    ORDER BY datetime(created_at) DESC
    LIMIT 200
  `).all(orgId, staffId);
  const matched = rows.find((r) => r.filename === localFilename || r.filename?.endsWith(`_${localFilename}`));
  if (!matched?.web_url) return null;
  db.prepare(`
    UPDATE staff_compliance_documents
    SET onedrive_web_url = ?, onedrive_item_id = COALESCE(?, onedrive_item_id)
    WHERE id = ?
  `).run(matched.web_url, matched.graph_item_id || null, docId);
  return matched.web_url;
}

function getProviderProfileForUser(userId) {
  const user = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  const orgId = user?.org_id || null;
  if (!orgId) {
    const first = db.prepare('SELECT id FROM organisations ORDER BY created_at ASC LIMIT 1').get();
    return { profile: first ? ensureProviderProfile(first.id) : null, organisation_id: first?.id || null };
  }
  const profile = ensureProviderProfile(orgId);
  return { profile, organisation_id: orgId };
}

router.get('/', async (req, res) => {
  try {
    const { include_archived } = req.query;
    const orgId = requesterOrgId(req.session?.user?.id);
    let staff;
    if (orgId) {
      staff = db.prepare('SELECT * FROM staff WHERE org_id = ? ORDER BY name').all(orgId);
    } else {
      staff = [];
    }
    if (include_archived !== 'true' && include_archived !== '1') {
      staff = staff.filter(s => !s.archived_at || s.archived_at === '');
    }
    const shifterDefaults = {
      shifter_enabled: false,
      shifter_status: 'not_enabled',
      supabase_profile_id: null,
    };
    let enriched = staff;
    if (isSupabaseShifterConfigured()) {
      try {
        const shifterMap = await getShifterFieldsByStaffId(staff);
        enriched = staff.map((s) => ({ ...s, ...(shifterMap.get(s.id) || shifterDefaults) }));
      } catch (e) {
        console.error('[staff list] shifter enrich failed:', e);
        enriched = staff.map((s) => ({ ...s, ...shifterDefaults, shifter_enrich_error: true }));
      }
    } else {
      enriched = staff.map((s) => ({ ...s, ...shifterDefaults }));
    }
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/shifter-invites', requireAdminOrDelegate, requireAgencyShell, async (req, res) => {
  try {
    const { staff_ids: staffIds } = req.body || {};
    if (!Array.isArray(staffIds) || staffIds.length === 0) {
      return res.status(400).json({ error: 'staff_ids array required' });
    }
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send Shifter invites.',
        code: 'EMAIL_NOT_CONNECTED',
      });
    }
    const orgId = requesterOrgId(req.session?.user?.id);
    const getStaffById = (id) => visibleStaffById(id, orgId);
    const nexusOrgId = nexusOrgIdForSessionUser(req.session?.user?.id);

    const redirectTo =
      (process.env.SHIFTER_INVITE_REDIRECT_URL || process.env.INVITE_REDIRECT_URL || '').trim() ||
      'shifter://';
    const playStoreUrl = String(process.env.SHIFTER_PLAY_STORE_URL || '').trim();
    const appStoreUrl = String(process.env.SHIFTER_APP_STORE_URL || '').trim();
    const orgName =
      (orgId ? db.prepare('SELECT name FROM organisations WHERE id = ?').get(orgId)?.name : null) ||
      process.env.COMPANY_NAME ||
      'Shifter';

    // Enable in profiles + resolve Shifter linkage (existing behavior)
    const results = await sendShifterInvitesForStaffIds(staffIds, getStaffById, { nexusOrgId, db });

    // Send actual invite emails with store links + Supabase action_link
    const enriched = [];
    for (const r of results) {
      if (!r?.ok) {
        enriched.push(r);
        continue;
      }
      const s = getStaffById(r.staff_id);
      if (!s?.email?.trim()) {
        enriched.push({ ...r, ok: false, error: 'Staff member has no email address', code: 'NO_EMAIL' });
        continue;
      }
      try {
        const { action_link } = await generateShifterInviteLinkForEmail(s.email, {
          redirectTo,
          nexusOrgId,
          profileRole: 'Support Worker',
        });

        const subject = `You're invited to Shifter – ${orgName}`;
        const lines = [
          `Hi ${s.name || 'there'},`,
          '',
          `${orgName} has invited you to use Shifter to record shifts and progress notes.`,
          '',
          '1) Download Shifter:',
          playStoreUrl ? `- Android: ${playStoreUrl}` : '- Android: (ask your manager for the download link)',
          appStoreUrl ? `- iPhone: ${appStoreUrl}` : '- iPhone: (ask your manager for the download link)',
          '',
          '2) Create your account / accept the invite:',
          action_link,
          '',
          'Tip: Open the invite link on the same phone you installed Shifter on. It will open the app and let you set a password.',
          '',
          'If you have issues, contact your manager.',
        ];
        await sendEmailViaRelay(userId, s.email, subject, lines.join('\n'), null, null);

        enriched.push({ ...r, invite_email_sent: true });
      } catch (e) {
        enriched.push({
          ...r,
          invite_email_sent: false,
          email_error: e?.message || String(e),
          code: e?.code,
        });
      }
    }

    res.json({ results: enriched });
  } catch (err) {
    if (err.code === 'SUPABASE_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    console.error('[shifter-invites]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Exported so `index.js` can register POST on the root app (avoids stale nested-router / mount issues). */
export async function handleSetStaffShifterEnabled(req, res) {
  try {
    const staffId = req.params?.id ?? req.body?.staff_id;
    if (!staffId) return res.status(400).json({ error: 'staff_id required' });
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(staffId, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    const shifter_enabled = Boolean(req.body?.shifter_enabled);
    const nexusOrgId = nexusOrgIdForSessionUser(req.session?.user?.id);
    const updated = await setShifterEnabledForStaffEmail(s.email, shifter_enabled, {
      nexusOrgId,
      staffId: s.id,
      db,
    });
    // Re-mirror this staff's shifts so public.shifts staff_id reflects current Shifter linkage.
    scheduleMirrorShiftsForStaffSqliteId(s.id);
    res.json(updated);
  } catch (err) {
    if (err.code === 'SUPABASE_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    if (
      err.code === 'NO_EMAIL' ||
      err.code === 'PROFILE_NOT_FOUND' ||
      err.code === 'PROFILE_AMBIGUOUS' ||
      err.code === 'NO_ORG_FOR_SHIFTER_LINK' ||
      err.code === 'SHIFTER_WORKER_NOT_FOUND' ||
      err.code === 'SHIFTER_AMBIGUOUS' ||
      err.code === 'NEXUS_AUTH_CREATE_FAILED' ||
      err.code === 'NEXUS_AUTH_ORPHAN' ||
      err.code === 'NEXUS_PROFILE_UPSERT_FAILED'
    ) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[shifter-enabled]', err);
    res.status(500).json({ error: err.message });
  }
}

// Static paths (must stay before any `/:id` route so they are not captured as an id).
// Import staff from CSV (email required). Creates/updates staff under the requester's org.
const staffCsvUpload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
router.post('/import-csv', requireAdminOrDelegate, staffCsvUpload.single('file'), async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = requesterOrgId(userId);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    if (!req.file?.buffer) return res.status(400).json({ error: 'CSV file required (multipart field "file")' });

    const rows = fileToCsvRows(req.file.buffer);
    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSV must include a header row and at least one data row.' });
    }

    const headers = rows[0].map((c) => String(c || '').trim());
    const headersNorm = headers.map(normHeader);
    const idxEmail = findColumnIndex(headersNorm, new Set(['email', 'email_address', 'e_mail', 'mail']));
    const idxName = findColumnIndex(headersNorm, new Set(['name', 'full_name', 'staff_name', 'employee_name']));
    const idxPhone = findColumnIndex(headersNorm, new Set(['phone', 'mobile', 'phone_number', 'contact_number']));
    const idxRole = findColumnIndex(headersNorm, new Set(['role', 'position', 'job_title', 'title']));

    if (idxEmail < 0) {
      return res.status(400).json({
        error: 'Could not find an email column. Name a column email (or email_address).',
        headers,
      });
    }

    const dataRows = rows.slice(1);
    const items = [];
    const errors = [];
    for (let i = 0; i < dataRows.length; i++) {
      const line = i + 2;
      const row = dataRows[i];
      if (!row || row.every((c) => String(c || '').trim() === '')) continue;
      const email = normalizeEmailForImport(row[idxEmail] || '');
      if (!email) {
        errors.push({ line, message: 'Missing email' });
        continue;
      }
      if (!isValidEmailBasic(email)) {
        errors.push({ line, message: `Invalid email: "${email}"` });
        continue;
      }
      const name = idxName >= 0 ? String(row[idxName] || '').trim() : '';
      const phone = idxPhone >= 0 ? String(row[idxPhone] || '').trim() : '';
      const role = idxRole >= 0 ? String(row[idxRole] || '').trim() : '';
      items.push({ email, name, phone, role });
    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'No valid rows found (email required).', errors });
    }

    const uniqueByEmail = new Map();
    for (const it of items) {
      if (!uniqueByEmail.has(it.email)) uniqueByEmail.set(it.email, it);
    }
    const unique = [...uniqueByEmail.values()];

    const insert = db.prepare(`
      INSERT INTO staff (id, org_id, name, email, phone, notify_email, notify_sms, role, employment_type, onboarding_status)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?, 'employee', 'not_started')
    `);
    const update = db.prepare(`
      UPDATE staff
      SET name = COALESCE(NULLIF(?, ''), name),
          phone = COALESCE(NULLIF(?, ''), phone),
          role = COALESCE(NULLIF(?, ''), role),
          updated_at = datetime('now')
      WHERE id = ?
    `);

    const created = [];
    const updated = [];
    const tx = db.transaction(() => {
      for (const it of unique) {
        const existing = db
          .prepare('SELECT id FROM staff WHERE org_id = ? AND lower(email) = lower(?) LIMIT 1')
          .get(orgId, it.email);
        if (existing?.id) {
          update.run(it.name, it.phone, it.role, existing.id);
          updated.push(existing.id);
          continue;
        }
        const id = uuidv4();
        const finalName = it.name || nameFromEmail(it.email);
        insert.run(id, orgId, finalName, it.email, it.phone || null, it.role || null);
        created.push(id);
      }
    });
    tx();

    // Provision Supabase profile rows for these emails (best-effort)
    const nexusOrgId = nexusOrgIdForSessionUser(userId);
    const provisioned = [];
    const provisionErrors = [];
    for (const it of unique) {
      try {
        const out = await provisionNexusSupabaseProfileForStaff(it.email, nexusOrgId, { staffRole: it.role });
        provisioned.push({ email: it.email, ...out });
      } catch (e) {
        provisionErrors.push({ email: it.email, error: e?.message || String(e) });
      }
    }

    res.json({
      ok: true,
      imported: unique.length,
      created_count: created.length,
      updated_count: updated.length,
      errors,
      provisioned,
      provision_errors: provisionErrors,
    });
  } catch (err) {
    console.error('[staff import-csv]', err);
    res.status(500).json({ error: err.message || 'Import failed' });
  }
});

router.post('/shifter-enabled', requireAdminOrDelegate, requireAgencyShell, handleSetStaffShifterEnabled);
router.post('/set-shifter-enabled', requireAdminOrDelegate, requireAgencyShell, handleSetStaffShifterEnabled);

router.post('/send-test-email', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Staff id required' });
    const scope = requesterScope(req.session?.user?.id);
    const s = visibleStaffById(id, scope);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    if (!s.email?.trim()) return res.status(400).json({ error: 'Staff member has no email address' });

    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not logged in' });

    if (!getRelayConfigFromEnv()?.url) {
      return res.status(400).json({
        error:
          'Email sending is not configured on the server. Ask your administrator to set AZURE_EMAIL_FUNCTION_URL.',
        code: 'EMAIL_RELAY_NOT_CONFIGURED',
        errorDetail: 'Deploy the Azure sendEmail function and add its URL to server environment.',
      });
    }
    if (!getEmailConfigForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send messages.',
        code: 'EMAIL_NOT_CONNECTED',
        errorDetail: 'Open Settings and use Connect email (Gmail or Microsoft 365).',
      });
    }

    const subject = 'Schedule Shift – Test email';
    const text = `Hi ${s.name},\n\nThis is a test email from Schedule Shift. Your email integration is working correctly.\n\nYou will receive roster and shift notifications at this address.`;

    await sendEmailViaRelay(userId, s.email, subject, text, null, null);

    res.json({ ok: true, message: `Test email sent to ${s.email}` });
  } catch (err) {
    const msg = formatSmtpAuthError(err);
    res.status(400).json({ error: msg, errorDetail: err?.message });
  }
});

router.patch('/:id/shifter-enabled', requireAdminOrDelegate, requireAgencyShell, handleSetStaffShifterEnabled);
router.put('/:id/shifter-enabled', requireAdminOrDelegate, requireAgencyShell, handleSetStaffShifterEnabled);

router.get('/:id', async (req, res) => {
  const orgId = requesterOrgId(req.session?.user?.id);
  const s = visibleStaffById(req.params.id, orgId);
  if (!s) return res.status(404).json({ error: 'Staff not found' });
  const shifterDefaults = {
    shifter_enabled: false,
    shifter_status: 'not_enabled',
    supabase_profile_id: null,
  };
  if (!isSupabaseShifterConfigured()) {
    return res.json({ ...s, ...shifterDefaults });
  }
  try {
    const shifterMap = await getShifterFieldsByStaffId([s]);
    return res.json({ ...s, ...(shifterMap.get(s.id) || shifterDefaults) });
  } catch (e) {
    console.error('[staff get] shifter enrich failed:', e);
    return res.json({ ...s, ...shifterDefaults, shifter_enrich_error: true });
  }
});

router.get('/:id/intake-form', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(req.params.id, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });

    const onboarding = db
      .prepare('SELECT id, status, current_step, started_at, completed_at, last_activity_at FROM staff_onboarding WHERE staff_id = ?')
      .get(req.params.id);
    if (!onboarding) {
      return res.json({
        staff: { id: s.id, name: s.name, email: s.email },
        onboarding: null,
        sections: []
      });
    }

    const rows = db
      .prepare('SELECT field_key, field_value, source, created_at, updated_at FROM staff_intake_fields WHERE staff_onboarding_id = ? ORDER BY field_key')
      .all(onboarding.id);

    const rowByKey = new Map(rows.map((row) => [row.field_key, row]));
    const sensitive = db
      .prepare('SELECT tfn_encrypted, bank_bsb, bank_account_encrypted, super_fund_name, super_member_number, updated_at FROM staff_sensitive_data WHERE staff_id = ?')
      .get(req.params.id);
    const sensitiveValues = {};
    if (sensitive) {
      try {
        if (sensitive.tfn_encrypted) sensitiveValues.tfn = decrypt(sensitive.tfn_encrypted);
      } catch {
        sensitiveValues.tfn = rowByKey.get('tfn')?.field_value || '';
      }
      try {
        if (sensitive.bank_account_encrypted) sensitiveValues.bank_account = decrypt(sensitive.bank_account_encrypted);
      } catch {
        sensitiveValues.bank_account = rowByKey.get('bank_account')?.field_value || '';
      }
      if (sensitive.bank_bsb) sensitiveValues.bank_bsb = sensitive.bank_bsb;
      if (sensitive.super_fund_name) sensitiveValues.super_fund_name = sensitive.super_fund_name;
      if (sensitive.super_member_number) sensitiveValues.super_member_number = sensitive.super_member_number;
    }

    const sectionsByKey = new Map();
    const pushField = (sectionKey, field) => {
      if (!sectionsByKey.has(sectionKey)) sectionsByKey.set(sectionKey, []);
      sectionsByKey.get(sectionKey).push(field);
    };

    for (const def of STAFF_ONBOARDING_FIELD_DEFS) {
      const meta = STAFF_INTAKE_FIELD_META.get(def.key);
      const row = rowByKey.get(def.key);
      const sensitiveValue = Object.prototype.hasOwnProperty.call(sensitiveValues, def.key) ? sensitiveValues[def.key] : undefined;
      pushField(def.section || 'other', {
        key: def.key,
        label: def.label,
        value: sensitiveValue !== undefined ? sensitiveValue : (row?.field_value || ''),
        type: def.type || 'text',
        order: meta?.order ?? 999,
        source: sensitiveValue !== undefined && !row ? 'sensitive_data' : (row?.source || 'not_provided'),
        updated_at: row?.updated_at || sensitive?.updated_at || null
      });
    }

    for (const row of rows) {
      if (STAFF_INTAKE_FIELD_META.has(row.field_key)) continue;
      if (row.field_key === 'documents') continue;
      const sectionKey = row.field_key === 'documents' ? 'documents' : 'other';
      pushField(sectionKey, {
        key: row.field_key,
        label: row.field_key.replace(/[._]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        value: row.field_value,
        type: 'text',
        order: 999,
        source: row.source,
        updated_at: row.updated_at
      });
    }

    const uploadedDocs = db
      .prepare('SELECT document_type, display_name, file_path, expiry_date, status, uploaded_at FROM staff_compliance_documents WHERE staff_id = ? ORDER BY document_type, uploaded_at DESC')
      .all(req.params.id);
    const docsByType = new Map();
    for (const doc of uploadedDocs) {
      if (!docsByType.has(doc.document_type)) docsByType.set(doc.document_type, []);
      docsByType.get(doc.document_type).push(doc);
    }
    for (const [idx, documentType] of DOCUMENT_TYPES.entries()) {
      const docs = docsByType.get(documentType) || [];
      const value = docs.length
        ? docs.map((doc) => {
          const filename = doc.display_name || (doc.file_path || '').split('/').pop() || 'Uploaded document';
          return [
            filename,
            doc.expiry_date ? `expires ${doc.expiry_date}` : null,
            doc.status ? `status ${doc.status.replace(/_/g, ' ')}` : null,
            doc.uploaded_at ? `uploaded ${doc.uploaded_at}` : null
          ].filter(Boolean).join(' - ');
        }).join('\n')
        : '';
      pushField('documents', {
        key: `document_${documentType}`,
        label: DOCUMENT_TYPE_LABELS[documentType] || documentType,
        value,
        type: 'document',
        order: 300 + idx,
        source: docs.length ? 'staff_compliance_documents' : 'not_provided',
        updated_at: docs[0]?.uploaded_at || null
      });
    }
    const extraDocs = uploadedDocs.filter((doc) => !DOCUMENT_TYPES.includes(doc.document_type));
    if (extraDocs.length) {
      pushField('documents', {
        key: 'document_other',
        label: 'Other documents',
        value: extraDocs.map((doc) => [
          doc.display_name || (doc.file_path || '').split('/').pop() || 'Uploaded document',
          doc.expiry_date ? `expires ${doc.expiry_date}` : null,
          doc.status ? `status ${doc.status.replace(/_/g, ' ')}` : null,
          doc.uploaded_at ? `uploaded ${doc.uploaded_at}` : null
        ].filter(Boolean).join(' - ')).join('\n'),
        type: 'document',
        order: 399,
        source: 'staff_compliance_documents',
        updated_at: extraDocs[0]?.uploaded_at || null
      });
    }

    const policyAcks = db
      .prepare(`
        SELECT a.acknowledged_at, a.signature_data, p.display_name
        FROM staff_policy_acknowledgements a
        LEFT JOIN company_policy_files p ON p.id = a.policy_file_id
        WHERE a.staff_onboarding_id = ?
        ORDER BY p.display_name, a.acknowledged_at
      `)
      .all(onboarding.id);
    pushField('policy', {
      key: 'acknowledged_policies',
      label: 'Acknowledged policy PDFs',
      value: policyAcks.length
        ? policyAcks.map((ack) => `${ack.display_name || 'Policy PDF'}${ack.acknowledged_at ? ` - ${ack.acknowledged_at}` : ''}`).join('\n')
        : '',
      type: 'text',
      order: 402,
      source: policyAcks.length ? 'staff_policy_acknowledgements' : 'not_provided',
      updated_at: policyAcks[0]?.acknowledged_at || null
    });
    const firstPolicySignature = policyAcks.find((ack) => ack.signature_data)?.signature_data;
    const signatureField = sectionsByKey.get('policy')?.find((field) => field.key === 'signature');
    if (signatureField && !signatureField.value && firstPolicySignature) {
      signatureField.value = firstPolicySignature;
      signatureField.source = 'staff_policy_acknowledgements';
    }

    const sections = STAFF_INTAKE_SECTION_ORDER
      .filter((sectionKey) => sectionsByKey.has(sectionKey))
      .map((sectionKey) => ({
        key: sectionKey,
        label: STAFF_INTAKE_SECTION_LABELS[sectionKey] || sectionKey,
        fields: sectionsByKey.get(sectionKey).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
      }));

    res.json({
      staff: { id: s.id, name: s.name, email: s.email },
      onboarding,
      sections
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staff–participant assignments
router.get('/:id/assignments', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT sp.id, sp.staff_id, sp.participant_id, sp.created_at,
        p.name as participant_name, p.ndis_number
      FROM staff_participants sp
      JOIN participants p ON p.id = sp.participant_id
      WHERE sp.staff_id = ?
      ORDER BY p.name
    `).all(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/assignments', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req.session?.user?.id);
    const { participant_id } = req.body;
    if (!participant_id) return res.status(400).json({ error: 'participant_id required' });
    const staffId = req.params.id;
    const staffRow = visibleStaffById(staffId, orgId);
    if (!staffRow) return res.status(404).json({ error: 'Staff not found' });
    const partRow = orgId
      ? db.prepare('SELECT id FROM participants WHERE id = ? AND provider_org_id = ?').get(participant_id, orgId)
      : db.prepare('SELECT id FROM participants WHERE id = ?').get(participant_id);
    if (!partRow) return res.status(404).json({ error: 'Participant not found' });
    const id = uuidv4();
    db.prepare('INSERT INTO staff_participants (id, staff_id, participant_id) VALUES (?, ?, ?)').run(id, staffId, participant_id);
    const row = db.prepare(`
      SELECT sp.id, sp.staff_id, sp.participant_id, p.name as participant_name, p.ndis_number
      FROM staff_participants sp
      JOIN participants p ON p.id = sp.participant_id
      WHERE sp.id = ?
    `).get(id);
    res.status(201).json(row);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'Participant already assigned' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/assignments/:assignmentId', requireAdminOrDelegate, (req, res) => {
  const result = db.prepare('DELETE FROM staff_participants WHERE id = ? AND staff_id = ?').run(req.params.assignmentId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found' });
  res.status(204).send();
});

router.get('/:id/excel-summary', async (req, res) => {
  try {
    const listScope = resolveStaffListScope(req);
    if (listScope.mode === 'none') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (listScope.mode === 'all') {
      return res.status(400).json({
        error: 'Pass ?org_id= to choose which organisation’s linked OneDrive to read (super admin).',
      });
    }
    const orgId = listScope.orgId;
    if (!orgId) {
      return res.status(400).json({ error: 'Organisation context required for Excel summary.' });
    }
    const s = db.prepare('SELECT id, name FROM staff WHERE id = ? AND org_id = ?').get(req.params.id, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    const { summaryRows } = await pullSummaryFromExcel({
      staffName: s.name,
      organizationId: orgId || undefined,
      log: (msg, data) => console.log('[staff excel-summary]', msg, data || ''),
    });
    res.json({ summaryRows });
  } catch (err) {
    console.error('[staff excel-summary]', err);
    res.status(500).json({ error: err.message || 'Failed to pull Excel summary' });
  }
});

router.get('/:id/shift-hours-summary', (req, res) => {
  try {
    const s = db.prepare('SELECT id FROM staff WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    const staffOrg = db.prepare('SELECT org_id FROM staff WHERE id = ?').get(req.params.id);
    const orgId = staffOrg?.org_id || null;
    const payPeriodStart = orgId
      ? (db.prepare('SELECT pay_period_start FROM business_settings WHERE org_id = ?').get(orgId)?.pay_period_start || null)
      : null;
    const shifts = db.prepare(`
      SELECT s.id, s.start_time, s.end_time, s.expenses,
        (SELECT MAX(pn.travel_time_min) FROM progress_notes pn WHERE pn.shift_id = s.id) as travel_time_min,
        (SELECT MAX(pn.travel_km) FROM progress_notes pn WHERE pn.shift_id = s.id) as travel_km
      FROM shifts s
      WHERE s.staff_id = ?
        AND s.status IN ('completed', 'completed_by_admin')
      ORDER BY s.start_time
    `).all(req.params.id);
    const summaryRows = computeHoursFromShifts(shifts, { payPeriodStart });
    res.json({ summaryRows });
  } catch (err) {
    console.error('[staff shift-hours-summary]', err);
    res.status(500).json({ error: err.message || 'Failed to compute shift hours' });
  }
});

router.post('/send-test-email', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Staff id required' });
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(id, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    if (!s.email?.trim()) return res.status(400).json({ error: 'Staff member has no email address' });

    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not logged in' });

    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send messages.',
        code: 'EMAIL_NOT_CONNECTED',
        errorDetail: 'Open Settings and use Connect email (Gmail or Microsoft 365).'
      });
    }

    const subject = 'Schedule Shift – Test email';
    const text = `Hi ${s.name},\n\nThis is a test email from Schedule Shift. Your email integration is working correctly.\n\nYou will receive roster and shift notifications at this address.`;

    await sendEmailViaRelay(userId, s.email, subject, text, null, null);

    res.json({ ok: true, message: `Test email sent to ${s.email}` });
  } catch (err) {
    const msg = formatSmtpAuthError(err);
    res.status(400).json({ error: msg });
  }
});

/**
 * Phase 3: One-click staff onboarding orchestrator.
 *
 * Idempotent — runs the readiness gate, clones master library templates, and ensures the
 * staff_onboarding row exists. Does NOT send the invite email or generate any signed
 * documents (those remain owned by /start-onboarding and the signing layer respectively).
 * Returns a per-step status array so the UI can show progress and disable itself with a
 * clear reason when a prerequisite is missing.
 */
router.post('/:id/onboarding/run', requireAdminOrDelegate, async (req, res) => {
  try {
    const staffId = req.params.id;
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(staffId, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    const result = await orchestrateStaffOnboarding({
      staffId,
      providerOrganisationId: req.body?.provider_organisation_id || s.org_id || orgId || null,
      userId: req.session?.user?.id || null,
      actorType: 'user',
      actorId: req.session?.user?.id || null,
      sourceIp: req.headers['x-forwarded-for'] || req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      projectRoot
    });
    const code = result.ready ? 200 : 409;
    res.status(code).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Phase 3: Lightweight readiness check used by StaffProfile to drive the "Run staff
 * onboarding" button state. Returns reason+code when blocked so the UI can deep-link
 * the user into the right Forms screen to fix it.
 */
router.get('/:id/onboarding/status', requireAdminOrDelegate, (req, res) => {
  try {
    const staffId = req.params.id;
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(staffId, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });

    const providerOrgId = s.org_id || orgId || null;
    /** @type {{ ready: boolean, reason?: string, code?: string }} */
    let readiness = { ready: false };
    if (providerOrgId) {
      try {
        assertStaffOnboardingReady(providerOrgId);
        readiness = { ready: true };
      } catch (err) {
        readiness = { ready: false, reason: err.message, code: err.code || 'NOT_READY' };
      }
    } else {
      readiness = { ready: false, reason: 'Staff has no organisation linked.', code: 'PROVIDER_ORG_MISSING' };
    }

    const onboarding = db
      .prepare(`SELECT id, status, current_step, started_at, completed_at, last_activity_at, document_pack_id FROM staff_onboarding WHERE staff_id = ?`)
      .get(staffId);

    res.json({
      staff: { id: s.id, name: s.name, email: s.email, onboarding_status: s.onboarding_status },
      provider_organisation_id: providerOrgId,
      readiness,
      staff_onboarding: onboarding || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start staff onboarding: create record, set token, send welcome email with form link and policy PDFs
router.post('/:id/start-onboarding', requireAdminOrDelegate, async (req, res) => {
  try {
    const staffId = req.params.id;
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(staffId, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    if (!s.email?.trim()) return res.status(400).json({ error: 'Staff member has no email address' });
    if (s.onboarding_status === 'complete') return res.status(400).json({ error: 'Onboarding already complete' });

    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send messages.',
        code: 'EMAIL_NOT_CONNECTED',
        errorDetail: 'Open Settings and use Connect email.'
      });
    }

    const { profile } = getProviderProfileForUser(userId);
    const providerProfileId = profile?.id || null;

    let onboarding = db.prepare('SELECT * FROM staff_onboarding WHERE staff_id = ?').get(staffId);
    if (!onboarding) {
      const onboardingId = uuidv4();
      db.prepare(`
        INSERT INTO staff_onboarding (id, staff_id, provider_profile_id, status, current_step, started_at, last_activity_at)
        VALUES (?, ?, ?, 'in_progress', 1, datetime('now'), datetime('now'))
      `).run(onboardingId, staffId, providerProfileId);
      onboarding = db.prepare('SELECT * FROM staff_onboarding WHERE id = ?').get(onboardingId);
    } else {
      db.prepare(`
        UPDATE staff_onboarding SET status = 'in_progress', current_step = 1, started_at = COALESCE(started_at, datetime('now')), last_activity_at = datetime('now'), updated_at = datetime('now') WHERE staff_id = ?
      `).run(staffId);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`
      UPDATE staff SET onboarding_token = ?, onboarding_token_expires_at = ?, onboarding_status = 'in_progress', updated_at = datetime('now') WHERE id = ?
    `).run(token, expiresAt, staffId);

    const baseUrl = (process.env.FRONTEND_BASE_URL || process.env.BASE_URL || 'http://localhost:5174').replace(/\/$/, '');
    const formLink = `${baseUrl}/staff-onboarding/${token}`;

    const org = profile ? db.prepare('SELECT name FROM organisations WHERE id = ?').get(profile.organisation_id) : null;
    const orgName = org?.name || process.env.COMPANY_NAME || 'Nexus Core';

    const subject = `${orgName}: complete your onboarding`;
    let text = `Hi ${s.name},\n\n${orgName} has invited you to complete your staff onboarding. Please fill out the form at the link below.\n\n`;
    text += `Onboarding form: ${formLink}\n\n`;
    text += `The form will collect your personal and employment details, compliance documents, and policy acknowledgements. Please sign to confirm you have read and acknowledged the company policies (attached).\n\n`;
    text += `If you have any questions, contact your manager.`;

    const packIdBody = req.body?.pack_id != null && req.body.pack_id !== '' ? String(req.body.pack_id) : null;
    const { attachments, resolvedPackId } = buildPolicyAttachmentsForEmail(providerProfileId, packIdBody, 'staff_onboarding', projectRoot);
    db.prepare(`UPDATE staff_onboarding SET document_pack_id = ? WHERE id = ?`).run(resolvedPackId, onboarding.id);

    const attachmentsForEmail = attachments.map((a) => ({
      ...a,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
    }));
    await sendEmailViaRelay(userId, s.email, subject, text, null, attachmentsForEmail, orgName);

    res.json({ ok: true, message: `Onboarding email sent to ${s.email}`, formLink });
  } catch (err) {
    console.error('[start-onboarding]', err);
    const msg = formatSmtpAuthError(err);
    res.status(400).json({ error: msg });
  }
});

router.get('/:id/employment-contract', requireAdminOrDelegate, async (req, res) => {
  try {
    const staffId = req.params.id;
    const orgId = requesterOrgId(req.session?.user?.id);
    const row = visibleStaffById(staffId, orgId);
    if (!row) return res.status(404).json({ error: 'Staff not found' });

    const staffFull = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    const onboarding = db.prepare('SELECT id, provider_profile_id FROM staff_onboarding WHERE staff_id = ?').get(staffId);
    let providerProfileId = onboarding?.provider_profile_id;
    if (!providerProfileId) {
      const { profile } = getProviderProfileForUser(req.session.user.id);
      providerProfileId = profile?.id || null;
    }
    if (!providerProfileId) return res.status(400).json({ error: 'No provider profile for your organisation.' });

    const rawIntake = onboarding?.id ? getStaffIntakeFieldMap(onboarding.id) : {};
    const merged = mergeStaffIntakeForProfile(rawIntake, staffFull?.name);
    const { docx, pdf, templateMeta } = await generateStaffContractBuffers(staffFull, merged, providerProfileId);
    if (!pdf?.length && !docx?.length) {
      return res.status(404).json({
        error: 'No employment contract template. Organisation form templates are being rebuilt — configure a staff contract template when available.'
      });
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
    console.error('[staff employment-contract]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/compliance-documents/:docId/file', requireAdminOrDelegate, (req, res) => {
  try {
    const { id: staffId, docId } = req.params;
    const doc = db.prepare('SELECT id, document_type, display_name, file_path, onedrive_web_url, onedrive_item_id FROM staff_compliance_documents WHERE id = ? AND staff_id = ?').get(docId, staffId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const ext = (doc.file_path || '').split('.').pop() || 'pdf';
    const filename = doc.display_name ? `${doc.display_name.replace(/[^a-zA-Z0-9-_]+/g, '_')}.${ext}` : ((doc.file_path || '').split('/').pop() || `${doc.document_type}.pdf`);
    const oneDriveUrl = findStaffComplianceOneDriveUrl(staffId, docId, filename);
    if (oneDriveUrl) return res.redirect(oneDriveUrl);
    const absPath = resolve(projectRoot, doc.file_path);
    const absUploadsDir = resolve(staffUploadsDir);
    if (!absPath.startsWith(absUploadsDir)) return res.status(403).json({ error: 'Invalid path' });
    if (!existsSync(absPath)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '%22')}"`);
    res.sendFile(absPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/compliance-documents', (req, res) => {
  try {
    const list = db.prepare('SELECT id, document_type, display_name, file_path, expiry_date, status, uploaded_at FROM staff_compliance_documents WHERE staff_id = ? ORDER BY document_type, uploaded_at DESC').all(req.params.id);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/compliance-documents', requireAdminOrDelegate, complianceUpload.single('file'), async (req, res) => {
  try {
    const staffId = req.params.id;
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(staffId, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const documentType = req.body?.document_type || '';
    if (!DOCUMENT_TYPES.includes(documentType) && documentType !== 'other') return res.status(400).json({ error: 'Invalid document_type' });
    const displayName = cleanDocumentDisplayName(req.body?.display_name, DOCUMENT_TYPE_LABELS[documentType] || documentType);
    if (documentType === 'other' && !String(req.body?.display_name || '').trim()) return res.status(400).json({ error: 'Please name this document.' });
    const expiryDate = req.body?.expiry_date || null;
    const status = expiryDate ? computeDocStatus(expiryDate) : 'valid';
    const relPath = join('data', 'uploads', 'staff', staffId, req.file.filename);
    const saved = upsertStaffComplianceDocument({
      staffId,
      documentType,
      displayName,
      filePath: relPath,
      expiryDate,
      status
    });
    try {
      const absPath = resolve(projectRoot, relPath);
      if (existsSync(absPath)) {
        const buf = readFileSync(absPath);
        const uploaded = await tryPushStaffDocument({
          staffId,
          category: documentType,
          buffer: buf,
          originalFilename: req.file.originalname || req.file.filename,
          mimeType: req.file.mimetype || null,
          notes: `staff_compliance_document:${saved.id}:${displayName}`
        });
        if (uploaded?.webUrl || uploaded?.itemId) {
          db.prepare(`
            UPDATE staff_compliance_documents
            SET onedrive_web_url = COALESCE(?, onedrive_web_url),
                onedrive_item_id = COALESCE(?, onedrive_item_id)
            WHERE id = ?
          `).run(uploaded?.webUrl || null, uploaded?.itemId || null, saved.id);
        }
      }
    } catch (e) {
      console.warn('[staff] OneDrive push skipped:', e?.message);
    }
    const row = db.prepare('SELECT id, document_type, display_name, file_path, expiry_date, status, uploaded_at FROM staff_compliance_documents WHERE id = ?').get(saved.id);
    res.status(saved.created ? 201 : 200).json({ ...row, replaced_existing: !saved.created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/compliance-documents/:docId', requireAdminOrDelegate, (req, res) => {
  try {
    const { id: staffId, docId } = req.params;
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(staffId, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });

    const doc = db
      .prepare('SELECT id, file_path FROM staff_compliance_documents WHERE id = ? AND staff_id = ?')
      .get(docId, staffId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    db.prepare('DELETE FROM staff_compliance_documents WHERE id = ? AND staff_id = ?').run(docId, staffId);

    if (doc.file_path) {
      const absPath = resolve(projectRoot, doc.file_path);
      const absUploadsDir = resolve(staffUploadsDir);
      if (absPath.startsWith(absUploadsDir) && existsSync(absPath)) {
        try {
          unlinkSync(absPath);
        } catch {
          /* local cleanup best-effort */
        }
      }
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/compliance-documents/:docId', requireAdminOrDelegate, (req, res) => {
  try {
    const { id: staffId, docId } = req.params;
    const { expiry_date: expiryDate } = req.body || {};
    const doc = db.prepare('SELECT id FROM staff_compliance_documents WHERE id = ? AND staff_id = ?').get(docId, staffId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const status = expiryDate ? computeDocStatus(expiryDate) : 'valid';
    db.prepare('UPDATE staff_compliance_documents SET expiry_date = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(expiryDate || null, status, docId);
    const row = db.prepare('SELECT id, document_type, display_name, file_path, expiry_date, status, uploaded_at FROM staff_compliance_documents WHERE id = ?').get(docId);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/send-renewal-reminder', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(req.params.id, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    if (!s.email?.trim()) return res.status(400).json({ error: 'No email address' });
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({ error: 'Connect your email in Settings.', code: 'EMAIL_NOT_CONNECTED' });
    }
    const docs = db.prepare('SELECT document_type, expiry_date, status FROM staff_compliance_documents WHERE staff_id = ? AND (status = ? OR status = ?)').all(req.params.id, 'expiring_soon', 'expired');
    const subject = 'Compliance document renewal reminder – Nexus Core';
    const text = `Hi ${s.name},\n\nPlease renew the following compliance document(s) and upload via the link we will send you, or contact your manager.\n\n${docs.map((d) => `- ${d.document_type}: expires ${d.expiry_date || 'N/A'} (${d.status})`).join('\n')}\n\nThank you.`;
    await sendEmailViaRelay(userId, s.email, subject, text, null, null);
    const manager = s.manager_id ? db.prepare('SELECT email FROM staff WHERE id = ?').get(s.manager_id) : null;
    if (manager?.email) {
      await sendEmailViaRelay(userId, manager.email, `Compliance reminder: ${s.name}`, text, null, null);
    }
    res.json({ ok: true, message: 'Reminder sent' });
  } catch (err) {
    console.error('[send-renewal-reminder]', err);
    res.status(400).json({ error: formatSmtpAuthError(err) || err.message });
  }
});

router.post('/:id/renewal-link', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = requesterOrgId(req.session?.user?.id);
    const s = visibleStaffById(req.params.id, orgId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    if (!s.email?.trim()) return res.status(400).json({ error: 'No email address' });
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({ error: 'Connect your email in Settings.', code: 'EMAIL_NOT_CONNECTED' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('INSERT INTO staff_renewal_tokens (id, staff_id, token, expires_at) VALUES (?, ?, ?, ?)').run(uuidv4(), req.params.id, token, expiresAt);
    const baseUrl = (process.env.FRONTEND_BASE_URL || process.env.BASE_URL || 'http://localhost:5174').replace(/\/$/, '');
    const link = `${baseUrl}/staff-onboarding/renew/${token}`;
    const subject = 'Upload your renewed compliance document – Nexus Core';
    const text = `Hi ${s.name},\n\nPlease use the link below to upload your renewed compliance document(s).\n\n${link}\n\nThis link expires in 7 days.`;
    await sendEmailViaRelay(userId, s.email, subject, text, null, null);
    res.json({ ok: true, message: 'Renewal link sent', link });
  } catch (err) {
    console.error('[renewal-link]', err);
    res.status(400).json({ error: formatSmtpAuthError(err) || err.message });
  }
});

router.post('/', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = requesterOrgId(req.session?.user?.id);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    const id = uuidv4();
    const { name, email, phone, notify_email, notify_sms, role, employment_type, hourly_rate, pay_rates } = req.body;
    const { present: availPresent, value: availabilityJson } = availabilityFromRequestBody(req.body);
    const payRatesJson = Object.prototype.hasOwnProperty.call(req.body, 'pay_rates')
      ? payRatesJsonFromBody(pay_rates)
      : null;
    db.prepare(`
      INSERT INTO staff (id, org_id, name, email, phone, notify_email, notify_sms, role, employment_type, hourly_rate, pay_rates_json, onboarding_status, availability_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?)
    `).run(
      id,
      orgId,
      name || '',
      email || null,
      phone || null,
      notify_email !== false ? 1 : 0,
      notify_sms ? 1 : 0,
      role || null,
      employment_type || null,
      hourly_rate != null ? Number(hourly_rate) : null,
      payRatesJson,
      availPresent ? availabilityJson : null
    );
    const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    const nexusOrgId = nexusOrgIdForSessionUser(req.session?.user?.id);
    let supabase_profile = null;
    if (email && String(email).trim()) {
      supabase_profile = await provisionNexusSupabaseProfileForStaff(email, nexusOrgId, { staffRole: role });
    }
    res.status(201).json(supabase_profile ? { ...row, supabase_profile } : row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function normStaffEmail(e) {
  return String(e || '')
    .trim()
    .toLowerCase();
}

router.put('/:id', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = requesterOrgId(req.session?.user?.id);
    const existing = visibleStaffById(req.params.id, orgId);
    if (!existing) return res.status(404).json({ error: 'Staff not found' });
    const { name, email, phone, notify_email, notify_sms, role, employment_type, hourly_rate, pay_rates } = req.body;
    const before = db.prepare('SELECT email, availability_json, pay_rates_json FROM staff WHERE id = ?').get(req.params.id);
    const emailBefore = normStaffEmail(before?.email);
    const emailAfter = normStaffEmail(email);
    const { present: availPresent, value: availabilityJson } = availabilityFromRequestBody(req.body);
    const availabilityToStore = availPresent ? availabilityJson : before?.availability_json ?? null;
    const payRatesToStore = Object.prototype.hasOwnProperty.call(req.body, 'pay_rates')
      ? payRatesJsonFromBody(pay_rates)
      : (before?.pay_rates_json ?? null);
    db.prepare(`
      UPDATE staff SET name = ?, email = ?, phone = ?, notify_email = ?, notify_sms = ?,
        role = ?, employment_type = ?, hourly_rate = ?, pay_rates_json = ?, availability_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name,
      email,
      phone,
      notify_email ? 1 : 0,
      notify_sms ? 1 : 0,
      role || null,
      employment_type || null,
      hourly_rate != null ? Number(hourly_rate) : null,
      payRatesToStore,
      availabilityToStore,
      req.params.id
    );
    const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id);
    const emailChanged = emailBefore !== emailAfter;
    if (emailChanged) {
      scheduleMirrorShiftsForStaffSqliteId(req.params.id);
    }
    let supabase_profile = null;
    if (emailAfter && emailAfter !== emailBefore) {
      const nexusOrgId = nexusOrgIdForSessionUser(req.session?.user?.id);
      supabase_profile = await provisionNexusSupabaseProfileForStaff(email, nexusOrgId, { staffRole: role });
    }
    res.json(supabase_profile ? { ...row, supabase_profile } : row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Archive staff (soft delete) (admin/delegate only)
router.post('/:id/archive', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req.session?.user?.id);
    const existing = visibleStaffById(req.params.id, orgId);
    if (!existing) return res.status(404).json({ error: 'Staff not found' });
    db.prepare('UPDATE staff SET archived_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
    res.json({ id: req.params.id, archived: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unarchive staff (admin/delegate only)
router.post('/:id/unarchive', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = requesterOrgId(req.session?.user?.id);
    const existing = visibleStaffById(req.params.id, orgId);
    if (!existing) return res.status(404).json({ error: 'Staff not found' });
    db.prepare('UPDATE staff SET archived_at = NULL WHERE id = ?').run(req.params.id);
    res.json({ id: req.params.id, archived: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdminOrDelegate, (req, res) => {
  const orgId = requesterOrgId(req.session?.user?.id);
  const existing = visibleStaffById(req.params.id, orgId);
  if (!existing) return res.status(404).json({ error: 'Staff not found' });
  const shiftIds = db.prepare('SELECT id FROM shifts WHERE staff_id = ?').all(req.params.id).map((r) => r.id);
  db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  for (const sid of shiftIds) scheduleRemoveShiftFromNexusSupabase(sid);
  res.status(204).send();
});

export default router;
