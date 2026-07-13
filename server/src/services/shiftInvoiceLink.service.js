/**
 * Validates and repairs links between shifts and billing invoices.
 *
 * A shift must only show as invoiced when its billing_invoice_id points to an invoice for the
 * same participant, the invoice is not void, and that shift appears on the invoice line items
 * for the shift's support date. Stale links are left when Shifter/Excel re-import overwrites an
 * invoiced shift row (participant/date) without clearing billing_invoice_id.
 */
import { db } from '../db/index.js';
import { getShiftLocalDateString } from '../lib/ndisDay.js';

/** SQL fragment: shift local date YYYY-MM-DD from start_time. */
export const SHIFT_LOCAL_DATE_SQL = `substr(REPLACE(s.start_time, ' ', 'T'), 1, 10)`;

/**
 * SQL predicates (reference shifts as `s`, billing invoice join as `bi_inv`) for a valid batch link.
 */
export const VALID_BATCH_INVOICE_LINK_SQL = `
  s.billing_invoice_id IS NOT NULL AND TRIM(s.billing_invoice_id) != ''
  AND bi_inv.id IS NOT NULL
  AND bi_inv.participant_id = s.participant_id
  AND COALESCE(bi_inv.status, '') != 'void'
  AND EXISTS (
    SELECT 1 FROM billing_invoice_line_items bil
    WHERE bil.billing_invoice_id = s.billing_invoice_id
      AND bil.source_type = 'shift'
      AND bil.source_shift_id = s.id
      AND bil.line_date = ${SHIFT_LOCAL_DATE_SQL}
  )
`;

/**
 * Resolved invoice fields for shift list/detail API — only when the batch or legacy link is valid.
 */
export const SHIFT_INVOICE_RESOLVE_SQL = `
  CASE
    WHEN ${VALID_BATCH_INVOICE_LINK_SQL} THEN bi_inv.invoice_number
    ELSE (
      SELECT inv_r.invoice_number FROM invoices inv_r WHERE inv_r.shift_id = s.id LIMIT 1
    )
  END AS invoice_number,
  CASE
    WHEN ${VALID_BATCH_INVOICE_LINK_SQL} THEN bi_inv.status
    ELSE (
      SELECT inv_r.status FROM invoices inv_r WHERE inv_r.shift_id = s.id LIMIT 1
    )
  END AS invoice_status
`;

function shiftLocalDate(startTime) {
  return getShiftLocalDateString(startTime) || (startTime ? String(startTime).slice(0, 10) : null);
}

/**
 * True when an import row describes the same participant, staff, and support day as the shift.
 * @param {object | null | undefined} shift
 * @param {{ participantId: string, staffId: string, startDateTime: string }} incoming
 */
export function shiftImportIdentityMatches(shift, { participantId, staffId, startDateTime }) {
  if (!shift || !participantId || !staffId || !startDateTime) return false;
  if (String(shift.participant_id) !== String(participantId)) return false;
  if (String(shift.staff_id) !== String(staffId)) return false;
  const existingDay = shiftLocalDate(shift.start_time);
  const incomingDay = shiftLocalDate(startDateTime);
  if (existingDay && incomingDay && existingDay !== incomingDay) return false;
  return true;
}

function hasBillingLink(shift) {
  return shift?.billing_invoice_id != null && String(shift.billing_invoice_id).trim() !== '';
}

/**
 * Whether a shift row may be merged with an incoming import (same logical visit).
 * Billed shifts only match when participant, staff, and day align.
 */
export function canImportMergeIntoShift(shift, incoming) {
  if (!shift) return false;
  if (!hasBillingLink(shift)) return true;
  return shiftImportIdentityMatches(shift, incoming);
}

/**
 * @param {string} reason
 * @param {object} row
 */
function invalidRow(reason, row) {
  return {
    reason,
    shift_id: row.id,
    start_time: row.start_time,
    participant_name: row.participant_name,
    invoice_number: row.invoice_number,
    invoice_participant_name: row.invoice_participant_name,
    billing_invoice_id: row.billing_invoice_id,
  };
}

/**
 * Find shifts whose billing_invoice_id is stale or invalid.
 * @param {{ orgId?: string | null }} [opts]
 */
export function findInvalidShiftInvoiceLinks(opts = {}) {
  const orgId = opts.orgId ? String(opts.orgId).trim() : null;
  const params = [];
  let orgClause = '';
  if (orgId) {
    orgClause = 'AND p.provider_org_id = ?';
    params.push(orgId);
  }

  const rows = db
    .prepare(
      `
      SELECT s.id, s.participant_id, s.start_time, s.billing_invoice_id,
             p.name AS participant_name,
             bi.id AS invoice_id, bi.participant_id AS invoice_participant_id,
             bi.invoice_number, bi.status AS invoice_status,
             bp.name AS invoice_participant_name
      FROM shifts s
      JOIN participants p ON p.id = s.participant_id
      LEFT JOIN billing_invoices bi ON bi.id = s.billing_invoice_id
      LEFT JOIN participants bp ON bp.id = bi.participant_id
      WHERE s.billing_invoice_id IS NOT NULL AND TRIM(s.billing_invoice_id) != ''
        ${orgClause}
      ORDER BY s.start_time DESC
    `,
    )
    .all(...params);

  const invalid = [];
  for (const row of rows) {
    if (!row.invoice_id) {
      invalid.push(invalidRow('invoice_missing', row));
      continue;
    }
    if (String(row.invoice_status || '').toLowerCase() === 'void') {
      invalid.push(invalidRow('invoice_void', row));
      continue;
    }
    if (String(row.participant_id) !== String(row.invoice_participant_id)) {
      invalid.push(invalidRow('participant_mismatch', row));
      continue;
    }
    const shiftDay = shiftLocalDate(row.start_time);
    const lineCount = db
      .prepare(
        `
        SELECT COUNT(*) AS c FROM billing_invoice_line_items
        WHERE billing_invoice_id = ? AND source_type = 'shift' AND source_shift_id = ?
          AND line_date = ?
      `,
      )
      .get(row.billing_invoice_id, row.id, shiftDay);
    if (!lineCount?.c) {
      const anyLines = db
        .prepare(
          `
          SELECT COUNT(*) AS c FROM billing_invoice_line_items
          WHERE billing_invoice_id = ? AND source_type = 'shift' AND source_shift_id = ?
        `,
        )
        .get(row.billing_invoice_id, row.id);
      invalid.push(
        invalidRow(anyLines?.c ? 'line_date_mismatch' : 'no_line_items', row),
      );
    }
  }
  return invalid;
}

/**
 * Clear invalid billing_invoice_id values on shifts. Idempotent.
 * @param {{ orgId?: string | null, log?: (msg: string, data?: object) => void }} [opts]
 */
export function repairInvalidShiftInvoiceLinks(opts = {}) {
  const log = opts.log || (() => {});
  const invalid = findInvalidShiftInvoiceLinks({ orgId: opts.orgId });
  if (!invalid.length) {
    return { cleared: 0, shift_ids: [], items: [] };
  }
  const clear = db.prepare(
    `UPDATE shifts SET billing_invoice_id = NULL, updated_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction((items) => {
    for (const item of items) {
      clear.run(item.shift_id);
    }
  });
  tx(invalid);
  log('Cleared invalid shift billing_invoice_id links', { count: invalid.length });
  return {
    cleared: invalid.length,
    shift_ids: invalid.map((i) => i.shift_id),
    items: invalid,
  };
}
