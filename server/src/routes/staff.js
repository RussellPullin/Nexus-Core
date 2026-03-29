import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { sendEmailViaRelay, isEmailConfiguredForUser, formatSmtpAuthError } from '../services/notification.service.js';
import { pullSummaryFromExcel } from '../services/excelPull.service.js';
import { computeHoursFromShifts } from '../services/shiftHours.service.js';
import { ensureProviderProfile } from '../services/onboarding.service.js';
import {
  getShifterFieldsByStaffId,
  setShifterEnabledForStaffEmail,
  sendShifterInvitesForStaffIds,
  isSupabaseShifterConfigured,
  provisionNexusSupabaseProfileForStaff,
} from '../services/supabaseStaffShifter.service.js';
import {
  scheduleRemoveShiftFromNexusSupabase,
  scheduleMirrorShiftsForStaffSqliteId,
} from '../services/nexusPublicShiftsSync.service.js';
import { availabilityFromRequestBody } from '../lib/staffAvailability.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import { tryPushStaffDocument, resolveOrgIdForStaff } from '../services/orgOnedriveSync.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const dataDir = process.env.DATA_DIR || join(projectRoot, 'data');
const staffUploadsDir = join(dataDir, 'uploads', 'staff');

const DOCUMENT_TYPES = ['drivers_licence_front', 'drivers_licence_back', 'blue_card', 'yellow_card', 'first_aid', 'car_insurance'];

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

function requesterScope(userId) {
  if (!userId) return { orgId: null, superAdmin: false };
  const u = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(userId);
  return { orgId: u?.org_id || null, superAdmin: isSuperAdminEmail(u?.email) };
}

function visibleStaffById(staffId, scope) {
  if (scope?.orgId && !scope.superAdmin) {
    return db.prepare('SELECT * FROM staff WHERE id = ? AND org_id = ?').get(staffId, scope.orgId);
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
    const scope = requesterScope(req.session?.user?.id);
    let staff;
    if (scope.orgId && !scope.superAdmin) {
      staff = db.prepare('SELECT * FROM staff WHERE org_id = ? ORDER BY name').all(scope.orgId);
    } else {
      staff = db.prepare('SELECT * FROM staff ORDER BY name').all();
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

router.post('/shifter-invites', requireAdminOrDelegate, async (req, res) => {
  try {
    const { staff_ids: staffIds } = req.body || {};
    if (!Array.isArray(staffIds) || staffIds.length === 0) {
      return res.status(400).json({ error: 'staff_ids array required' });
    }
    const scope = requesterScope(req.session?.user?.id);
    const getStaffById = (id) => visibleStaffById(id, scope);
    const nexusOrgId = nexusOrgIdForSessionUser(req.session?.user?.id);
    const results = await sendShifterInvitesForStaffIds(staffIds, getStaffById, { nexusOrgId, db });
    res.json({ results });
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
    const scope = requesterScope(req.session?.user?.id);
    const s = visibleStaffById(staffId, scope);
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
router.post('/shifter-enabled', requireAdminOrDelegate, handleSetStaffShifterEnabled);
router.post('/set-shifter-enabled', requireAdminOrDelegate, handleSetStaffShifterEnabled);

router.patch('/:id/shifter-enabled', requireAdminOrDelegate, handleSetStaffShifterEnabled);
router.put('/:id/shifter-enabled', requireAdminOrDelegate, handleSetStaffShifterEnabled);

router.get('/:id', async (req, res) => {
  const scope = requesterScope(req.session?.user?.id);
  const s = visibleStaffById(req.params.id, scope);
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
    const scope = requesterScope(req.session?.user?.id);
    const { participant_id } = req.body;
    if (!participant_id) return res.status(400).json({ error: 'participant_id required' });
    const staffId = req.params.id;
    const staffRow = visibleStaffById(staffId, scope);
    if (!staffRow) return res.status(404).json({ error: 'Staff not found' });
    const partRow = scope.orgId && !scope.superAdmin
      ? db.prepare('SELECT id FROM participants WHERE id = ? AND provider_org_id = ?').get(participant_id, scope.orgId)
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
    const s = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    const orgId = req.session?.user?.org_id || null;
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
    const shifts = db.prepare(`
      SELECT s.id, s.start_time, s.end_time, s.expenses,
        (SELECT pn.travel_time_min FROM progress_notes pn WHERE pn.shift_id = s.id LIMIT 1) as travel_time_min,
        (SELECT pn.travel_km FROM progress_notes pn WHERE pn.shift_id = s.id LIMIT 1) as travel_km
      FROM shifts s
      WHERE s.staff_id = ?
        AND s.status IN ('completed', 'completed_by_admin')
      ORDER BY s.start_time
    `).all(req.params.id);
    const summaryRows = computeHoursFromShifts(shifts);
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
    const scope = requesterScope(req.session?.user?.id);
    const s = visibleStaffById(id, scope);
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

// Start staff onboarding: create record, set token, send welcome email with form link and policy PDFs
router.post('/:id/start-onboarding', requireAdminOrDelegate, async (req, res) => {
  try {
    const staffId = req.params.id;
    const scope = requesterScope(req.session?.user?.id);
    const s = visibleStaffById(staffId, scope);
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

    const subject = `Complete your onboarding – ${orgName}`;
    let text = `Hi ${s.name},\n\nWelcome! Please complete your staff onboarding by filling out the form at the link below.\n\n`;
    text += `Onboarding form: ${formLink}\n\n`;
    text += `The form will collect your personal and employment details, compliance documents, and policy acknowledgements. Please sign to confirm you have read and acknowledged the company policies (attached).\n\n`;
    text += `If you have any questions, contact your manager.`;

    const attachments = [];
    const policyFiles = providerProfileId
      ? db.prepare('SELECT id, display_name, file_path FROM company_policy_files WHERE provider_profile_id = ?').all(providerProfileId)
      : [];
    for (const pf of policyFiles) {
      const fullPath = join(projectRoot, pf.file_path);
      if (existsSync(fullPath)) {
        try {
          const content = readFileSync(fullPath);
          const filename = (pf.display_name || pf.file_path).replace(/^.*[/\\]/, '') || 'policy.pdf';
          attachments.push({ filename, content, contentType: 'application/pdf' });
        } catch (e) {
          console.warn('[start-onboarding] Could not read policy file:', pf.file_path, e?.message);
        }
      }
    }
    // PLACEHOLDER: connect policy PDF upload to this list; policy files are attached from company_policy_files above

    const attachmentsForEmail = attachments.map((a) => ({
      ...a,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
    }));
    await sendEmailViaRelay(userId, s.email, subject, text, null, attachmentsForEmail);

    res.json({ ok: true, message: `Onboarding email sent to ${s.email}`, formLink });
  } catch (err) {
    console.error('[start-onboarding]', err);
    const msg = formatSmtpAuthError(err);
    res.status(400).json({ error: msg });
  }
});

router.get('/:id/compliance-documents/:docId/file', requireAdminOrDelegate, (req, res) => {
  try {
    const { id: staffId, docId } = req.params;
    const doc = db.prepare('SELECT id, document_type, file_path, onedrive_web_url, onedrive_item_id FROM staff_compliance_documents WHERE id = ? AND staff_id = ?').get(docId, staffId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const filename = (doc.file_path || '').split('/').pop() || `${doc.document_type}.pdf`;
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
    const list = db.prepare('SELECT id, document_type, file_path, expiry_date, status, uploaded_at FROM staff_compliance_documents WHERE staff_id = ? ORDER BY document_type').all(req.params.id);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/compliance-documents', requireAdminOrDelegate, complianceUpload.single('file'), async (req, res) => {
  try {
    const staffId = req.params.id;
    const s = db.prepare('SELECT id FROM staff WHERE id = ?').get(staffId);
    if (!s) return res.status(404).json({ error: 'Staff not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const documentType = req.body?.document_type || '';
    if (!DOCUMENT_TYPES.includes(documentType)) return res.status(400).json({ error: 'Invalid document_type' });
    const expiryDate = req.body?.expiry_date || null;
    const status = expiryDate ? computeDocStatus(expiryDate) : 'valid';
    const relPath = join('data', 'uploads', 'staff', staffId, req.file.filename);
    const id = uuidv4();
    db.prepare(`
      INSERT INTO staff_compliance_documents (id, staff_id, document_type, file_path, expiry_date, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, staffId, documentType, relPath, expiryDate, status);
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
          notes: `staff_compliance_document:${id}`
        });
        if (uploaded?.webUrl || uploaded?.itemId) {
          db.prepare(`
            UPDATE staff_compliance_documents
            SET onedrive_web_url = COALESCE(?, onedrive_web_url),
                onedrive_item_id = COALESCE(?, onedrive_item_id)
            WHERE id = ?
          `).run(uploaded?.webUrl || null, uploaded?.itemId || null, id);
        }
      }
    } catch (e) {
      console.warn('[staff] OneDrive push skipped:', e?.message);
    }
    const row = db.prepare('SELECT id, document_type, file_path, expiry_date, status, uploaded_at FROM staff_compliance_documents WHERE id = ?').get(id);
    res.status(201).json(row);
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
    const row = db.prepare('SELECT id, document_type, file_path, expiry_date, status, uploaded_at FROM staff_compliance_documents WHERE id = ?').get(docId);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/send-renewal-reminder', requireAdminOrDelegate, async (req, res) => {
  try {
    const scope = requesterScope(req.session?.user?.id);
    const s = visibleStaffById(req.params.id, scope);
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
    const scope = requesterScope(req.session?.user?.id);
    const s = visibleStaffById(req.params.id, scope);
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
    const scope = requesterScope(req.session?.user?.id);
    const targetOrgId = scope.superAdmin ? (req.body?.org_id || scope.orgId || null) : scope.orgId;
    if (!targetOrgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    const id = uuidv4();
    const { name, email, phone, notify_email, notify_sms, role, employment_type, hourly_rate } = req.body;
    const { present: availPresent, value: availabilityJson } = availabilityFromRequestBody(req.body);
    db.prepare(`
      INSERT INTO staff (id, org_id, name, email, phone, notify_email, notify_sms, role, employment_type, hourly_rate, onboarding_status, availability_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?)
    `).run(
      id,
      targetOrgId,
      name || '',
      email || null,
      phone || null,
      notify_email !== false ? 1 : 0,
      notify_sms ? 1 : 0,
      role || null,
      employment_type || null,
      hourly_rate != null ? Number(hourly_rate) : null,
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
    const scope = requesterScope(req.session?.user?.id);
    const existing = visibleStaffById(req.params.id, scope);
    if (!existing) return res.status(404).json({ error: 'Staff not found' });
    const { name, email, phone, notify_email, notify_sms, role, employment_type, hourly_rate } = req.body;
    const before = db.prepare('SELECT email, availability_json FROM staff WHERE id = ?').get(req.params.id);
    const emailBefore = normStaffEmail(before?.email);
    const emailAfter = normStaffEmail(email);
    const { present: availPresent, value: availabilityJson } = availabilityFromRequestBody(req.body);
    const availabilityToStore = availPresent ? availabilityJson : before?.availability_json ?? null;
    db.prepare(`
      UPDATE staff SET name = ?, email = ?, phone = ?, notify_email = ?, notify_sms = ?,
        role = ?, employment_type = ?, hourly_rate = ?, availability_json = ?, updated_at = datetime('now')
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
    const scope = requesterScope(req.session?.user?.id);
    const existing = visibleStaffById(req.params.id, scope);
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
    const scope = requesterScope(req.session?.user?.id);
    const existing = visibleStaffById(req.params.id, scope);
    if (!existing) return res.status(404).json({ error: 'Staff not found' });
    db.prepare('UPDATE staff SET archived_at = NULL WHERE id = ?').run(req.params.id);
    res.json({ id: req.params.id, archived: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdminOrDelegate, (req, res) => {
  const scope = requesterScope(req.session?.user?.id);
  const existing = visibleStaffById(req.params.id, scope);
  if (!existing) return res.status(404).json({ error: 'Staff not found' });
  const shiftIds = db.prepare('SELECT id FROM shifts WHERE staff_id = ?').all(req.params.id).map((r) => r.id);
  db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
  for (const sid of shiftIds) scheduleRemoveShiftFromNexusSupabase(sid);
  res.status(204).send();
});

export default router;
