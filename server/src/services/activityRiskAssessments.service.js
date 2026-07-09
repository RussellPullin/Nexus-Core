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
import { bundledMasterPath, GENERIC_MASTER_FILENAME, fillActivityRiskPdfFields, listActivityRiskPdfFieldSchema } from './activityRiskAssessmentPdf.service.js';

const DEFAULT_ACTIVITY_NAME = 'Health & Safety Risk Assessment (blank)';

export const RISK_ASSESSMENT_DOC_CATEGORY = 'Risk assessment';

function masterPdfPath() {
  const bundled = bundledMasterPath();
  const dataRoot = join(getDataRoot(), 'forms', 'templates', 'activity-risk-assessment', 'master', GENERIC_MASTER_FILENAME);
  if (existsSync(bundled)) return bundled;
  if (existsSync(dataRoot)) return dataRoot;
  return null;
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

  const buffer = readFileSync(sourcePath);
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
  const master = masterPdfPath();
  if (!master) throw new Error('Activity risk assessment master PDF is missing on the server.');
  return readFileSync(master);
}

let cachedFieldSchema = null;

export async function getActivityRiskFieldSchema() {
  if (cachedFieldSchema) return cachedFieldSchema;
  const buf = await masterPdfBuffer();
  cachedFieldSchema = await listActivityRiskPdfFieldSchema(buf);
  return cachedFieldSchema;
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
      is_complete: recordHasFilledContent(field_values),
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

  const nextValues =
    field_values != null ? field_values : parseFieldValuesJson(existing.field_values_json);

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
  const blank = await masterPdfBuffer();
  return fillActivityRiskPdfFields(blank, record.field_values);
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
