/**
 * Activity (health & safety) risk assessment templates per organisation.
 * Master blank PDF: data/forms/templates/activity-risk-assessment/master/
 * Per-org copies: data/forms/templates/activity-risk-assessment/by-org/<orgId>/
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { getDataRoot } from './formTemplatePath.service.js';
import { tryPushParticipantDocument } from './orgOnedriveSync.service.js';
import {
  bundledMasterPath,
  GENERIC_MASTER_FILENAME,
  fillActivityRiskPdfFields,
  listActivityRiskPdfFieldSchema,
  embedAdminSignatureInActivityRiskPdf,
  isActivityRiskAdminSignField,
  writeGenericActivityRiskMaster
} from './activityRiskAssessmentPdf.service.js';
import { assertNativeSignatureReady } from './libraryDocumentSignature.service.js';
import { sendMultiDocumentAgreement } from './nativeSignature.service.js';
import { buildRenderTokenMap, readLogoBytes } from './documentLibraryRender.service.js';
import { fillAcroFormWithTokens } from './formFill.service.js';

/** Brand a rendered risk-assessment PDF with the org's provider details + logo. */
async function brandActivityRiskPdf(buffer, orgId) {
  if (!orgId) return buffer;
  try {
    const tokens = buildRenderTokenMap({ orgId });
    const longDate = (d) =>
      d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    const effectiveOn = new Date();
    const reviewBy = new Date(effectiveOn.getTime() + 365 * 24 * 60 * 60 * 1000);
    return await fillAcroFormWithTokens(
      buffer,
      { ...tokens, EFFECTIVE_DATE: longDate(effectiveOn), REVIEW_DATE: longDate(reviewBy) },
      { logoBytes: readLogoBytes(orgId) }
    );
  } catch (err) {
    console.warn('[activityRiskAssessments] provider branding skipped:', err?.message);
    return buffer;
  }
}

const DEFAULT_ACTIVITY_NAME = 'Health & Safety Risk Assessment (blank)';

export const RISK_ASSESSMENT_DOC_CATEGORY = 'Risk assessment';

function activityRiskMasterPdfCandidates() {
  const bundled = bundledMasterPath();
  const dataRoot = join(getDataRoot(), 'forms', 'templates', 'activity-risk-assessment', 'master', GENERIC_MASTER_FILENAME);
  return { bundled, dataRoot };
}

function masterPdfPath() {
  const { bundled, dataRoot } = activityRiskMasterPdfCandidates();
  if (existsSync(bundled)) return bundled;
  if (existsSync(dataRoot)) return dataRoot;
  return null;
}

/** Generate the bundled master PDF (and copy to DATA_DIR) when missing — e.g. after deploy. */
export async function ensureActivityRiskMasterPdf() {
  const { bundled, dataRoot } = activityRiskMasterPdfCandidates();

  if (!existsSync(bundled)) {
    await writeGenericActivityRiskMaster(bundled);
    console.log('[activity-risk] Generated master PDF at', bundled);
  }

  if (!existsSync(dataRoot) && existsSync(bundled)) {
    mkdirSync(dirname(dataRoot), { recursive: true });
    copyFileSync(bundled, dataRoot);
    console.log('[activity-risk] Copied master PDF to', dataRoot);
  }

  clearActivityRiskFieldSchemaCache();
  return masterPdfPath();
}

/** Re-copy the generic master onto all org activity templates (blank + named activities). */
function refreshAllTemplateCopiesFromMaster(orgId) {
  const master = masterPdfPath();
  if (!master) return;
  const rows = db
    .prepare(
      `SELECT stored_filename FROM activity_risk_assessment_templates WHERE organisation_id = ?`
    )
    .all(orgId);
  for (const row of rows) {
    copyFileSync(master, templateFilePath(orgId, row.stored_filename));
  }
}

function orgTemplateDir(orgId) {
  const seg = String(orgId || '').trim();
  if (!seg || /[./\\]/.test(seg)) throw new Error('Invalid organisation id');
  const dir = join(getDataRoot(), 'forms', 'templates', 'activity-risk-assessment', 'by-org', seg);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function templateFilePath(orgId, storedFilename) {
  return join(orgTemplateDir(orgId), storedFilename);
}

function slugifyActivity(name) {
  return String(name || 'activity')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'activity';
}

/**
 * Ensure each org has the default blank template row (copied from master PDF).
 */
export function ensureOrgActivityRiskTemplates(orgId) {
  if (!orgId) return null;
  const existing = db
    .prepare(
      `SELECT id FROM activity_risk_assessment_templates
       WHERE organisation_id = ? AND is_default_blank = 1 LIMIT 1`
    )
    .get(orgId);
  if (existing?.id) {
    refreshAllTemplateCopiesFromMaster(orgId);
    return existing.id;
  }

  const master = masterPdfPath();
  if (!master) {
    throw new Error(
      'Activity risk assessment master PDF is missing. Run: node server/scripts/regenerate-activity-risk-master.mjs'
    );
  }

  const id = uuidv4();
  const storedFilename = `${id}.pdf`;
  copyFileSync(master, templateFilePath(orgId, storedFilename));

  db.prepare(
    `INSERT INTO activity_risk_assessment_templates (
       id, organisation_id, activity_name, stored_filename, is_default_blank, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
  ).run(id, orgId, DEFAULT_ACTIVITY_NAME, storedFilename);

  return id;
}

export function listActivityRiskTemplates(orgId) {
  ensureOrgActivityRiskTemplates(orgId);
  refreshAllTemplateCopiesFromMaster(orgId);
  return db
    .prepare(
      `SELECT id, organisation_id, activity_name, stored_filename, is_default_blank, created_at, updated_at
       FROM activity_risk_assessment_templates
       WHERE organisation_id = ?
       ORDER BY is_default_blank DESC, activity_name COLLATE NOCASE ASC`
    )
    .all(orgId);
}

/**
 * Create a new named activity template (copy of master blank PDF).
 */
export function createActivityRiskTemplate(orgId, activityName) {
  const name = String(activityName || '').trim();
  if (!name) throw new Error('Activity name is required.');
  if (name.length > 200) throw new Error('Activity name is too long (max 200 characters).');

  const dup = db
    .prepare(
      `SELECT id FROM activity_risk_assessment_templates
       WHERE organisation_id = ? AND lower(trim(activity_name)) = lower(trim(?))`
    )
    .get(orgId, name);
  if (dup?.id) throw new Error(`An activity risk assessment named "${name}" already exists.`);

  const master = masterPdfPath();
  if (!master) throw new Error('Activity risk assessment master PDF is missing on the server.');

  const id = uuidv4();
  const storedFilename = `${id}.pdf`;
  copyFileSync(master, templateFilePath(orgId, storedFilename));

  db.prepare(
    `INSERT INTO activity_risk_assessment_templates (
       id, organisation_id, activity_name, stored_filename, is_default_blank, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
  ).run(id, orgId, name, storedFilename);

  return db
    .prepare(
      `SELECT id, organisation_id, activity_name, stored_filename, is_default_blank, created_at, updated_at
       FROM activity_risk_assessment_templates WHERE id = ?`
    )
    .get(id);
}

export function deleteActivityRiskTemplate(orgId, templateId) {
  const row = db
    .prepare(
      `SELECT * FROM activity_risk_assessment_templates WHERE id = ? AND organisation_id = ?`
    )
    .get(templateId, orgId);
  if (!row) return false;
  if (row.is_default_blank) {
    throw new Error('The default blank template cannot be deleted.');
  }
  db.prepare('DELETE FROM activity_risk_assessment_templates WHERE id = ?').run(templateId);
  const path = templateFilePath(orgId, row.stored_filename);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore missing file */
  }
  return true;
}

export function getActivityRiskTemplateFilePath(orgId, templateId) {
  const row = db
    .prepare(
      `SELECT stored_filename FROM activity_risk_assessment_templates WHERE id = ? AND organisation_id = ?`
    )
    .get(templateId, orgId);
  if (!row) return null;
  const path = templateFilePath(orgId, row.stored_filename);
  return existsSync(path) ? path : null;
}

/**
 * Copy a template PDF into the participant's documents (and OneDrive when configured).
 */
export async function assignActivityRiskAssessmentToParticipant(participantId, templateId, { userId = null } = {}) {
  const participant = db
    .prepare(`SELECT id, name, provider_org_id FROM participants WHERE id = ?`)
    .get(participantId);
  if (!participant) throw new Error('Participant not found.');

  const orgId = participant.provider_org_id;
  if (!orgId) throw new Error('Participant has no organisation.');

  const template = db
    .prepare(
      `SELECT * FROM activity_risk_assessment_templates WHERE id = ? AND organisation_id = ?`
    )
    .get(templateId, orgId);
  if (!template) throw new Error('Activity risk assessment template not found.');

  const sourcePath = templateFilePath(orgId, template.stored_filename);
  if (!existsSync(sourcePath)) throw new Error('Template file is missing on disk.');

  const buffer = await brandActivityRiskPdf(readFileSync(sourcePath), orgId);
  const datePart = new Date().toISOString().slice(0, 10);
  const activitySlug = slugifyActivity(template.activity_name);
  const participantSlug = slugifyActivity(participant.name || 'participant');
  const downloadName = `health-safety-risk-assessment-${activitySlug}-${participantSlug}-${datePart}.pdf`;

  const uploadsDir = join(getDataRoot(), 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const storedFilename = `${uuidv4()}-${downloadName}`;
  const filePath = join(uploadsDir, storedFilename);
  writeFileSync(filePath, buffer);

  const docId = uuidv4();
  db.prepare(
    `INSERT INTO participant_documents (id, participant_id, filename, category, file_path, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    docId,
    participantId,
    downloadName,
    RISK_ASSESSMENT_DOC_CATEGORY,
    filePath,
    JSON.stringify({
      activity_risk_template_id: templateId,
      activity_name: template.activity_name,
      assigned_by_user_id: userId || null,
      assigned_at: new Date().toISOString()
    })
  );

  try {
    const uploaded = await tryPushParticipantDocument({
      participantId,
      category: RISK_ASSESSMENT_DOC_CATEGORY,
      buffer,
      originalFilename: downloadName,
      mimeType: 'application/pdf',
      notes: `activity_risk_assessment:${templateId}:${docId}`
    });
    if (uploaded?.webUrl || uploaded?.itemId) {
      db.prepare(
        `UPDATE participant_documents
         SET onedrive_web_url = COALESCE(?, onedrive_web_url),
             onedrive_item_id = COALESCE(?, onedrive_item_id)
         WHERE id = ?`
      ).run(uploaded.webUrl || null, uploaded.itemId || null, docId);
    }
  } catch (e) {
    console.warn('[activityRiskAssessments] OneDrive push skipped:', e?.message);
  }

  return {
    document_id: docId,
    participant_id: participantId,
    filename: downloadName,
    category: RISK_ASSESSMENT_DOC_CATEGORY,
    template_id: templateId,
    activity_name: template.activity_name
  };
}

function parseFieldValuesJson(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializeFieldValues(fieldValues) {
  return JSON.stringify(fieldValues && typeof fieldValues === 'object' ? fieldValues : {});
}

async function masterPdfBuffer() {
  let master = masterPdfPath();
  if (!master) {
    await ensureActivityRiskMasterPdf();
    master = masterPdfPath();
  }
  if (!master) throw new Error('Activity risk assessment master PDF is missing on the server.');
  return readFileSync(master);
}

let cachedFieldSchema = null;

export function clearActivityRiskFieldSchemaCache() {
  cachedFieldSchema = null;
}

export async function getActivityRiskFieldSchema() {
  if (cachedFieldSchema) return cachedFieldSchema;
  const buf = await masterPdfBuffer();
  cachedFieldSchema = await listActivityRiskPdfFieldSchema(buf);
  return cachedFieldSchema;
}

export async function getActivityRiskMasterPdfBuffer() {
  return masterPdfBuffer();
}

function recordHasFilledContent(fieldValues) {
  if (!fieldValues || typeof fieldValues !== 'object') return false;
  return Object.values(fieldValues).some((value) => {
    if (typeof value === 'boolean') return value;
    return String(value || '').trim().length > 0;
  });
}

export function listRecordAssignments(orgId, recordId) {
  const record = getActivityRiskRecord(orgId, recordId);
  if (!record) return [];

  return db
    .prepare(
      `SELECT pd.id AS document_id,
              pd.participant_id,
              pd.filename,
              pd.created_at AS assigned_at,
              p.name AS participant_name
       FROM participant_documents pd
       JOIN participants p ON p.id = pd.participant_id
       WHERE p.provider_org_id = ?
         AND pd.category = ?
         AND json_extract(pd.metadata_json, '$.activity_risk_record_id') = ?
       ORDER BY pd.created_at DESC`
    )
    .all(orgId, RISK_ASSESSMENT_DOC_CATEGORY, recordId);
}

export function listActivityRiskRecords(orgId) {
  ensureOrgActivityRiskTemplates(orgId);
  const rows = db
    .prepare(
      `SELECT r.id, r.organisation_id, r.template_id, r.title, r.field_values_json,
              r.created_by_user_id, r.updated_by_user_id, r.created_at, r.updated_at,
              r.admin_signed_at, r.admin_signed_by_user_id, r.signature_envelope_id, r.signed_document_path,
              t.activity_name AS template_activity_name
       FROM activity_risk_assessment_records r
       JOIN activity_risk_assessment_templates t ON t.id = r.template_id
       WHERE r.organisation_id = ?
       ORDER BY r.updated_at DESC, r.title COLLATE NOCASE ASC`
    )
    .all(orgId);
  return rows.map((row) => {
    const field_values = parseFieldValuesJson(row.field_values_json);
    const assignments = listRecordAssignments(orgId, row.id);
    return {
      ...row,
      field_values,
      is_complete: recordHasFilledContent(stripAdminSignFieldsFromValues(field_values)),
      is_admin_signed: Boolean(row.admin_signed_at),
      is_awaiting_signature: Boolean(row.signature_envelope_id) && !row.admin_signed_at,
      assignments,
      assignment_count: assignments.length
    };
  });
}

export function getActivityRiskRecord(orgId, recordId) {
  const row = db
    .prepare(
      `SELECT r.*, t.activity_name AS template_activity_name
       FROM activity_risk_assessment_records r
       JOIN activity_risk_assessment_templates t ON t.id = r.template_id
       WHERE r.id = ? AND r.organisation_id = ?`
    )
    .get(recordId, orgId);
  if (!row) return null;
  return {
    ...row,
    field_values: parseFieldValuesJson(row.field_values_json)
  };
}

export function getActivityRiskRecordForTemplate(orgId, templateId) {
  const row = db
    .prepare(
      `SELECT r.id
       FROM activity_risk_assessment_records r
       WHERE r.organisation_id = ? AND r.template_id = ?
       ORDER BY r.updated_at DESC
       LIMIT 1`
    )
    .get(orgId, templateId);
  return row ? getActivityRiskRecord(orgId, row.id) : null;
}

export function createActivityRiskRecord(orgId, templateId, { title = null, userId = null } = {}) {
  const template = db
    .prepare(
      `SELECT * FROM activity_risk_assessment_templates WHERE id = ? AND organisation_id = ?`
    )
    .get(templateId, orgId);
  if (!template) throw new Error('Activity risk assessment template not found.');

  const existing = getActivityRiskRecordForTemplate(orgId, templateId);
  if (existing) return existing;

  const recordTitle = String(title || template.activity_name || 'Risk assessment').trim();
  if (!recordTitle) throw new Error('Title is required.');

  const id = uuidv4();
  db.prepare(
    `INSERT INTO activity_risk_assessment_records (
       id, organisation_id, template_id, title, field_values_json,
       created_by_user_id, updated_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '{}', ?, ?, datetime('now'), datetime('now'))`
  ).run(id, orgId, templateId, recordTitle, userId || null, userId || null);

  return getActivityRiskRecord(orgId, id);
}

export function updateActivityRiskRecord(orgId, recordId, { title, field_values, userId = null } = {}) {
  const existing = getActivityRiskRecord(orgId, recordId);
  if (!existing) throw new Error('Risk assessment not found.');

  const nextTitle = title != null ? String(title).trim() : existing.title;
  if (!nextTitle) throw new Error('Title is required.');

  let nextValues =
    field_values != null ? field_values : parseFieldValuesJson(existing.field_values_json);
  nextValues = stripAdminSignFieldsFromValues(nextValues);
  if (existing.admin_signed_at) {
    nextValues = {
      ...nextValues,
      pre_activity_prepared_by: existing.field_values?.pre_activity_prepared_by || '',
      pre_activity_prepared_role: existing.field_values?.pre_activity_prepared_role || '',
      pre_activity_date_prepared: existing.field_values?.pre_activity_date_prepared || '',
      pre_activity_signature: ''
    };
  }

  db.prepare(
    `UPDATE activity_risk_assessment_records
     SET title = ?, field_values_json = ?, updated_by_user_id = ?, updated_at = datetime('now')
     WHERE id = ? AND organisation_id = ?`
  ).run(nextTitle, serializeFieldValues(nextValues), userId || null, recordId, orgId);

  return getActivityRiskRecord(orgId, recordId);
}

export function deleteActivityRiskRecord(orgId, recordId) {
  const res = db
    .prepare('DELETE FROM activity_risk_assessment_records WHERE id = ? AND organisation_id = ?')
    .run(recordId, orgId);
  return res.changes > 0;
}

export async function generateActivityRiskRecordPdfBuffer(orgId, recordId) {
  const record = getActivityRiskRecord(orgId, recordId);
  if (!record) throw new Error('Risk assessment not found.');
  if (record.signed_document_path && existsSync(record.signed_document_path)) {
    return readFileSync(record.signed_document_path);
  }
  const blank = await masterPdfBuffer();
  let buffer = await fillActivityRiskPdfFields(blank, record.field_values);
  buffer = await brandActivityRiskPdf(buffer, orgId);
  if (record.admin_signature_data) {
    const schema = await getActivityRiskFieldSchema();
    buffer = await embedAdminSignatureInActivityRiskPdf(buffer, record.admin_signature_data, schema);
  }
  return buffer;
}

function stripAdminSignFieldsFromValues(fieldValues) {
  const next = { ...(fieldValues || {}) };
  for (const key of Object.keys(next)) {
    if (isActivityRiskAdminSignField(key)) delete next[key];
  }
  return next;
}

/** Build signing fields for pre-activity native sign-off from the master PDF schema. */
async function buildActivityRiskPreActivitySignFields() {
  const schema = await getActivityRiskFieldSchema();
  const byName = new Map((schema || []).map((f) => [f.name, f]));
  const ROLE = 'Organisation admin';
  const fields = [];

  const signature = byName.get('pre_activity_signature');
  if (signature) {
    fields.push({
      name: 'pre_activity_signature',
      type: 'signature',
      role: ROLE,
      required: true,
      areas: [
        {
          x: signature.x,
          y: signature.y,
          w: signature.width,
          h: signature.height,
          page: (signature.pageIndex || 0) + 1
        }
      ]
    });
  }

  const dateField = byName.get('pre_activity_date_prepared');
  if (dateField) {
    fields.push({
      name: 'pre_activity_date_prepared',
      type: 'date',
      role: ROLE,
      required: true,
      areas: [
        {
          x: dateField.x,
          y: dateField.y,
          w: dateField.width,
          h: dateField.height,
          page: (dateField.pageIndex || 0) + 1
        }
      ]
    });
  }

  for (const name of ['consent_yes', 'consent_na']) {
    const cb = byName.get(name);
    if (!cb) continue;
    fields.push({
      name,
      type: 'checkbox',
      role: ROLE,
      required: false,
      areas: [{ x: cb.x, y: cb.y, w: cb.width, h: cb.height, page: (cb.pageIndex || 0) + 1 }]
    });
  }

  return fields;
}

/**
 * Open a native Nexus Core signing session for the pre-activity sign-off.
 * Returns a /sign/:token URL so the admin can sign in-app (no auto-stamp).
 */
export async function sendActivityRiskRecordForNativeSignature(orgId, recordId, { userId = null } = {}) {
  assertNativeSignatureReady(orgId);

  const record = getActivityRiskRecord(orgId, recordId);
  if (!record) throw new Error('Risk assessment not found.');
  if (record.admin_signed_at) {
    throw new Error('This assessment is already signed.');
  }

  const contentValues = stripAdminSignFieldsFromValues(record.field_values);
  if (!recordHasFilledContent(contentValues)) {
    throw new Error('Complete the assessment before signing.');
  }

  const org = db
    .prepare(
      `SELECT default_signatory_name, default_signatory_role, default_signatory_email
       FROM organisations WHERE id = ?`
    )
    .get(orgId);
  const user = userId
    ? db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId)
    : null;

  const signatoryName = String(org?.default_signatory_name || user?.name || '').trim();
  if (!signatoryName) {
    throw new Error('Set the default signatory name in Settings → Business before signing.');
  }
  const signerEmail = String(org?.default_signatory_email || user?.email || '').trim();
  if (!signerEmail) {
    throw new Error('Set the default signatory email in Settings → Business, or sign in with an account that has an email.');
  }

  const prefilled = {
    ...contentValues,
    pre_activity_prepared_by: signatoryName,
    pre_activity_prepared_role: String(org?.default_signatory_role || '').trim()
  };

  const blank = await masterPdfBuffer();
  const pdfBuffer = await fillActivityRiskPdfFields(blank, prefilled);
  const formFields = await buildActivityRiskPreActivitySignFields();
  if (!formFields.some((f) => f.type === 'signature')) {
    throw new Error('Could not locate the signature field on the risk assessment PDF. Regenerate the master PDF and try again.');
  }

  const envelopeId = uuidv4();
  const filename = `activity-risk-${slugifyActivity(record.template_activity_name || record.title)}.pdf`;
  const sendResult = await sendMultiDocumentAgreement(orgId, {
    envelopeId,
    notify: false,
    title: `Activity risk assessment – ${record.template_activity_name || record.title}`,
    signers: [
      {
        name: signatoryName,
        email: signerEmail,
        order: 0,
        role: 'Organisation admin'
      }
    ],
    documents: [
      {
        buffer: pdfBuffer,
        filename,
        formFields
      }
    ]
  });

  const rawToken = sendResult?.signers?.[0]?.raw_token;
  if (!rawToken) throw new Error('Could not create a signing session.');

  db.prepare(
    `UPDATE activity_risk_assessment_records
     SET field_values_json = ?,
         signature_envelope_id = ?,
         signed_document_path = NULL,
         admin_signed_at = NULL,
         admin_signed_by_user_id = NULL,
         admin_signature_data = NULL,
         updated_by_user_id = ?,
         updated_at = datetime('now')
     WHERE id = ? AND organisation_id = ?`
  ).run(serializeFieldValues(prefilled), envelopeId, userId || null, recordId, orgId);

  const baseUrl = (process.env.FRONTEND_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');
  const signingPath = `/sign/${rawToken}`;

  return {
    ...getActivityRiskRecord(orgId, recordId),
    envelope_id: envelopeId,
    signing_path: signingPath,
    signing_url: baseUrl ? `${baseUrl}${signingPath}` : signingPath
  };
}

/** @deprecated Use sendActivityRiskRecordForNativeSignature — kept as alias for the route. */
export async function signActivityRiskRecordByAdmin(orgId, recordId, opts = {}) {
  return sendActivityRiskRecordForNativeSignature(orgId, recordId, opts);
}

/**
 * Called when the native /sign/:token flow completes for an activity risk envelope.
 */
export function markActivityRiskRecordSignedFromEnvelope(envelopeId, { signedDocumentPath = null, signedByUserId = null } = {}) {
  if (!envelopeId) return false;
  const row = db
    .prepare(
      `SELECT id, organisation_id, field_values_json FROM activity_risk_assessment_records WHERE signature_envelope_id = ?`
    )
    .get(envelopeId);
  if (!row) return false;

  const fieldValues = parseFieldValuesJson(row.field_values_json);
  const today = new Date().toISOString().slice(0, 10);
  const nextValues = {
    ...fieldValues,
    pre_activity_date_prepared: fieldValues.pre_activity_date_prepared || today
  };

  db.prepare(
    `UPDATE activity_risk_assessment_records
     SET field_values_json = ?,
         admin_signed_at = datetime('now'),
         admin_signed_by_user_id = COALESCE(?, admin_signed_by_user_id),
         signed_document_path = COALESCE(?, signed_document_path),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(serializeFieldValues(nextValues), signedByUserId || null, signedDocumentPath || null, row.id);

  return true;
}

/**
 * Copy a saved (filled) risk assessment into the participant's documents.
 */
export async function assignActivityRiskRecordToParticipant(participantId, recordId, { userId = null } = {}) {
  const participant = db
    .prepare(`SELECT id, name, provider_org_id FROM participants WHERE id = ?`)
    .get(participantId);
  if (!participant) throw new Error('Participant not found.');

  const orgId = participant.provider_org_id;
  if (!orgId) throw new Error('Participant has no organisation.');

  const record = getActivityRiskRecord(orgId, recordId);
  if (!record) throw new Error('Risk assessment not found.');
  if (!record.admin_signed_at) {
    throw new Error('An admin must sign this assessment with Nexus Core before assigning to participants.');
  }

  const buffer = await generateActivityRiskRecordPdfBuffer(orgId, recordId);
  const datePart = new Date().toISOString().slice(0, 10);
  const activitySlug = slugifyActivity(record.template_activity_name || record.title);
  const participantSlug = slugifyActivity(participant.name || 'participant');
  const downloadName = `health-safety-risk-assessment-${activitySlug}-${participantSlug}-${datePart}.pdf`;

  const uploadsDir = join(getDataRoot(), 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const storedFilename = `${uuidv4()}-${downloadName}`;
  const filePath = join(uploadsDir, storedFilename);
  writeFileSync(filePath, buffer);

  const docId = uuidv4();
  db.prepare(
    `INSERT INTO participant_documents (id, participant_id, filename, category, file_path, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    docId,
    participantId,
    downloadName,
    RISK_ASSESSMENT_DOC_CATEGORY,
    filePath,
    JSON.stringify({
      activity_risk_record_id: recordId,
      activity_risk_template_id: record.template_id,
      activity_name: record.template_activity_name || record.title,
      assigned_by_user_id: userId || null,
      assigned_at: new Date().toISOString()
    })
  );

  try {
    const uploaded = await tryPushParticipantDocument({
      participantId,
      category: RISK_ASSESSMENT_DOC_CATEGORY,
      buffer,
      originalFilename: downloadName,
      mimeType: 'application/pdf',
      notes: `activity_risk_record:${recordId}:${docId}`
    });
    if (uploaded?.webUrl || uploaded?.itemId) {
      db.prepare(
        `UPDATE participant_documents
         SET onedrive_web_url = COALESCE(?, onedrive_web_url),
             onedrive_item_id = COALESCE(?, onedrive_item_id)
         WHERE id = ?`
      ).run(uploaded.webUrl || null, uploaded.itemId || null, docId);
    }
  } catch (e) {
    console.warn('[activityRiskAssessments] OneDrive push skipped:', e?.message);
  }

  return {
    document_id: docId,
    participant_id: participantId,
    filename: downloadName,
    category: RISK_ASSESSMENT_DOC_CATEGORY,
    record_id: recordId,
    template_id: record.template_id,
    activity_name: record.template_activity_name || record.title,
    title: record.title
  };
}
