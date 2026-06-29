/**
 * Automatic cleanup of empty duplicate shifts.
 *
 * Problem: a worker sometimes creates a new shift instead of completing the scheduled one, or a
 * scheduled placeholder is left behind, so the planner shows a $0 / no-notes shift sitting next to
 * the real (noted) shift for the same worker + client at the same time. These empties are tedious
 * to remove by hand.
 *
 * Rule (conservative, only acts on unambiguous duplicates):
 *   Delete a shift when ALL of the following hold:
 *     - the whole day it falls on has already passed (start date < today), AND
 *     - it has NO completion evidence (no progress note / notes / expenses / admin completion), AND
 *     - it is NOT on an invoice (no billing_invoice_id and no legacy invoice row), AND
 *     - it is not cancelled, AND
 *     - another shift exists for the SAME participant + SAME worker whose time OVERLAPS it and which
 *       DOES have completion evidence.
 *
 * A lone scheduled shift that simply never went ahead (no noted counterpart) is left untouched.
 * The external shifter_shift_id is NOT suppressed, so if that shift is genuinely completed later it
 * can still flow back in.
 */
import { db } from '../db/index.js';
import { shiftCompletionEvidenceSql } from '../lib/shiftBillingEligibility.js';
import { hardDeleteShiftRow } from './shiftHardDelete.service.js';

/** Local 'YYYY-MM-DD' for "today" (server local time). */
function todayDateStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Find ids of empty duplicate shifts that are safe to delete.
 * @param {{ orgId?: string|null, now?: Date }} [opts]
 * @returns {Array<{ id: string, participant_id: string, staff_id: string, start_time: string, end_time: string }>}
 */
export function findDuplicateUnworkedShifts(opts = {}) {
  const orgId = opts.orgId ? String(opts.orgId).trim() : null;
  const today = todayDateStr(opts.now || new Date());

  // Normalised time expression so 'YYYY-MM-DD HH:MM:SS' and 'YYYY-MM-DDTHH:MM:SS' compare correctly.
  const norm = (col) => `REPLACE(${col}, ' ', 'T')`;

  const params = [];
  let orgClause = '';
  if (orgId) {
    orgClause = 'AND p.provider_org_id = ?';
    params.push(orgId);
  }
  // start date (first 10 chars of normalised start) strictly before today
  params.push(today);

  const candidates = db
    .prepare(
      `
      SELECT s.id, s.participant_id, s.staff_id, s.start_time, s.end_time
      FROM shifts s
      JOIN participants p ON p.id = s.participant_id
      WHERE 1 = 1
        ${orgClause}
        AND s.billing_invoice_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.shift_id = s.id)
        AND LOWER(COALESCE(s.status, '')) NOT IN ('cancelled', 'canceled')
        AND NOT ${shiftCompletionEvidenceSql('s')}
        AND substr(${norm('s.start_time')}, 1, 10) < ?
        AND EXISTS (
          SELECT 1 FROM shifts s2
          WHERE s2.id <> s.id
            AND s2.participant_id = s.participant_id
            AND s2.staff_id = s.staff_id
            AND ${norm('s2.start_time')} < ${norm('s.end_time')}
            AND ${norm('s2.end_time')} > ${norm('s.start_time')}
            AND ${shiftCompletionEvidenceSql('s2')}
        )
      ORDER BY s.start_time
    `,
    )
    .all(...params);

  return candidates;
}

/**
 * Delete empty duplicate shifts. Safe to call repeatedly (idempotent).
 * @param {{ orgId?: string|null, now?: Date, log?: Function }} [opts]
 * @returns {{ deleted: number, ids: string[] }}
 */
export function cleanupDuplicateUnworkedShifts(opts = {}) {
  const log = opts.log || (() => {});
  let rows;
  try {
    rows = findDuplicateUnworkedShifts(opts);
  } catch (e) {
    log('duplicate cleanup query failed', { message: e?.message || String(e) });
    return { deleted: 0, ids: [] };
  }

  const deletedIds = [];
  for (const row of rows) {
    try {
      const r = hardDeleteShiftRow(row.id, {
        suppressShifterId: false,
        nexusOrgId: opts.orgId || null,
        reason: 'duplicate_unworked_cleanup',
      });
      if (r.deleted) deletedIds.push(row.id);
    } catch (e) {
      log('duplicate cleanup delete failed', { id: row.id, message: e?.message || String(e) });
    }
  }

  if (deletedIds.length) {
    log('Removed empty duplicate shifts', { count: deletedIds.length });
  }
  return { deleted: deletedIds.length, ids: deletedIds };
}
