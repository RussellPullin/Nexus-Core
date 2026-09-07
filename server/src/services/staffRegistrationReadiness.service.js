/**
 * Registration readiness for independent support workers (Shifter Pro / sole traders).
 * Tracks Yellow Card, Blue Card, and other required certificates with in-date status.
 */
import { db } from '../db/index.js';
import {
  INDEPENDENT_WORKER_REQUIRED_DOC_TYPES,
  STAFF_COMPLIANCE_DOCUMENT_LABELS,
  STAFF_COMPLIANCE_DOCUMENT_SHORT_LABELS,
  computeComplianceDocStatus,
  documentTypeLabel,
  isIndependentSupportWorker
} from '../../../shared/staffComplianceDocs.js';

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function latestDocsByType(staffId) {
  const rows = db
    .prepare(
      `SELECT id, document_type, display_name, expiry_date, status, uploaded_at
       FROM staff_compliance_documents
       WHERE staff_id = ?
       ORDER BY datetime(uploaded_at) DESC, datetime(created_at) DESC`
    )
    .all(staffId);

  /** @type {Map<string, object>} */
  const byType = new Map();
  const other = [];
  for (const row of rows) {
    if (row.document_type === 'other') {
      other.push(row);
      continue;
    }
    if (!byType.has(row.document_type)) byType.set(row.document_type, row);
  }
  return { byType, other, all: rows };
}

/**
 * @param {{ id: string, name?: string, employment_type?: string|null }} staff
 * @returns {object}
 */
export function buildStaffRegistrationReadiness(staff) {
  const today = todayYmd();
  const independent = isIndependentSupportWorker(staff?.employment_type);
  const { byType, other } = latestDocsByType(staff.id);

  const required = INDEPENDENT_WORKER_REQUIRED_DOC_TYPES.map((documentType) => {
    const doc = byType.get(documentType) || null;
    const liveStatus = doc
      ? doc.expiry_date
        ? computeComplianceDocStatus(doc.expiry_date, today)
        : 'missing_expiry'
      : 'missing';
    const ok = liveStatus === 'valid' || liveStatus === 'expiring_soon';
    return {
      document_type: documentType,
      label: STAFF_COMPLIANCE_DOCUMENT_LABELS[documentType] || documentType,
      short_label: STAFF_COMPLIANCE_DOCUMENT_SHORT_LABELS[documentType] || documentType,
      present: !!doc,
      document_id: doc?.id || null,
      expiry_date: doc?.expiry_date || null,
      status: liveStatus,
      ok,
      uploaded_at: doc?.uploaded_at || null
    };
  });

  const optionalStored = [];
  for (const [documentType, doc] of byType.entries()) {
    if (INDEPENDENT_WORKER_REQUIRED_DOC_TYPES.includes(documentType)) continue;
    const liveStatus = doc.expiry_date
      ? computeComplianceDocStatus(doc.expiry_date, today)
      : 'missing_expiry';
    optionalStored.push({
      document_type: documentType,
      label: documentTypeLabel(documentType, doc.display_name),
      present: true,
      document_id: doc.id,
      expiry_date: doc.expiry_date || null,
      status: liveStatus,
      ok: liveStatus === 'valid' || liveStatus === 'expiring_soon' || liveStatus === 'missing_expiry',
      uploaded_at: doc.uploaded_at || null
    });
  }
  for (const doc of other) {
    const liveStatus = doc.expiry_date
      ? computeComplianceDocStatus(doc.expiry_date, today)
      : 'missing_expiry';
    optionalStored.push({
      document_type: 'other',
      label: documentTypeLabel('other', doc.display_name),
      present: true,
      document_id: doc.id,
      expiry_date: doc.expiry_date || null,
      status: liveStatus,
      ok: liveStatus === 'valid' || liveStatus === 'expiring_soon' || liveStatus === 'missing_expiry',
      uploaded_at: doc.uploaded_at || null
    });
  }

  const missing = required.filter((r) => !r.present);
  const expired = required.filter((r) => r.status === 'expired');
  const missingExpiry = required.filter((r) => r.present && r.status === 'missing_expiry');
  const expiringSoon = [...required, ...optionalStored].filter((r) => r.status === 'expiring_soon');
  const ready =
    independent &&
    missing.length === 0 &&
    expired.length === 0 &&
    missingExpiry.length === 0;

  let summary = 'Not an independent support worker';
  if (independent) {
    if (ready) {
      summary =
        expiringSoon.length > 0
          ? `Registration ready — ${expiringSoon.length} certificate(s) expiring soon`
          : 'Registration ready — required certificates on file and in date';
    } else if (missing.length) {
      summary = `Missing ${missing.map((m) => m.short_label).join(', ')}`;
    } else if (expired.length) {
      summary = `Expired: ${expired.map((m) => m.short_label).join(', ')}`;
    } else if (missingExpiry.length) {
      summary = `Add expiry dates for: ${missingExpiry.map((m) => m.short_label).join(', ')}`;
    } else {
      summary = 'Not registration ready';
    }
  }

  return {
    applicable: independent,
    ready,
    summary,
    required,
    additional_certificates: optionalStored,
    counts: {
      required_total: required.length,
      required_ok: required.filter((r) => r.ok && r.present && r.status !== 'missing_expiry').length,
      missing: missing.length,
      expired: expired.length,
      missing_expiry: missingExpiry.length,
      expiring_soon: expiringSoon.length,
      additional: optionalStored.length
    }
  };
}

/**
 * Batch readiness for a list of staff ids (list views).
 * @param {Array<{ id: string, employment_type?: string|null }>} staffRows
 */
export function buildRegistrationReadinessMap(staffRows) {
  /** @type {Record<string, object>} */
  const map = {};
  for (const s of staffRows || []) {
    if (!s?.id) continue;
    if (!isIndependentSupportWorker(s.employment_type)) continue;
    map[s.id] = buildStaffRegistrationReadiness(s);
  }
  return map;
}
