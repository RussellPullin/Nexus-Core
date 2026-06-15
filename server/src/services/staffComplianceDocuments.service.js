import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

function cleanStr(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Standard compliance document types are current-state records, so a new upload
 * replaces the latest row for that staff/type. "Other" documents use the
 * display name as part of their identity.
 */
export function findExistingStaffComplianceDocument(staffId, documentType, displayName) {
  if (!staffId || !documentType) return null;

  if (documentType === 'other') {
    const name = cleanStr(displayName);
    if (!name) return null;
    return db
      .prepare(
        `SELECT *
         FROM staff_compliance_documents
         WHERE staff_id = ?
           AND document_type = 'other'
           AND lower(COALESCE(display_name, '')) = lower(?)
         ORDER BY datetime(uploaded_at) DESC, datetime(created_at) DESC
         LIMIT 1`
      )
      .get(staffId, name);
  }

  return db
    .prepare(
      `SELECT *
       FROM staff_compliance_documents
       WHERE staff_id = ?
         AND document_type = ?
       ORDER BY datetime(uploaded_at) DESC, datetime(created_at) DESC
       LIMIT 1`
    )
    .get(staffId, documentType);
}

export function upsertStaffComplianceDocument({
  staffId,
  documentType,
  displayName,
  filePath,
  expiryDate = null,
  status = 'valid'
}) {
  const existing = findExistingStaffComplianceDocument(staffId, documentType, displayName);

  if (existing) {
    db.prepare(
      `UPDATE staff_compliance_documents
       SET display_name = ?,
           file_path = ?,
           expiry_date = ?,
           status = ?,
           uploaded_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(displayName || null, filePath, expiryDate || null, status || 'valid', existing.id);

    return {
      id: existing.id,
      created: false,
      replaced_file_path: existing.file_path || null,
      row: db.prepare('SELECT * FROM staff_compliance_documents WHERE id = ?').get(existing.id)
    };
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO staff_compliance_documents (id, staff_id, document_type, display_name, file_path, expiry_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, staffId, documentType, displayName || null, filePath, expiryDate || null, status || 'valid');

  return {
    id,
    created: true,
    replaced_file_path: null,
    row: db.prepare('SELECT * FROM staff_compliance_documents WHERE id = ?').get(id)
  };
}

