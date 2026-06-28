/**
 * Billing eligibility for shifts.
 *
 * A shift may only be auto-billed (included in invoice batches) when there is real
 * evidence the support was delivered. A scheduled placeholder that was never worked —
 * e.g. a roster shift echoed back from Shifter, or a duplicate the worker created instead
 * of completing the scheduled one — must stay $0 and out of every batch.
 *
 * Evidence is any of:
 *  - a linked progress note with content (session details / mood / incidents / travel), OR
 *  - worker-recorded expenses on the shift, OR
 *  - free-text notes saved on the shift, OR
 *  - an explicit admin completion (status = 'completed_by_admin'), OR
 *  - coordinator-curated charges (line_items_locked = 1).
 *
 * Mirrors hasWorkerCompletionEvidence() used at import time (webhookProcessor.js).
 */

/**
 * SQL predicate (no leading AND) that is true only for shifts with completion evidence.
 * Reference the shifts table with the alias passed in (default `s`).
 * @param {string} [alias]
 * @returns {string}
 */
export function shiftCompletionEvidenceSql(alias = 's') {
  const a = alias;
  return `(
    ${a}.status = 'completed_by_admin'
    OR ${a}.line_items_locked = 1
    OR (${a}.notes IS NOT NULL AND TRIM(${a}.notes) <> '')
    OR (${a}.expenses IS NOT NULL AND ${a}.expenses > 0)
    OR EXISTS (
      SELECT 1 FROM progress_notes pn
      WHERE pn.shift_id = ${a}.id
        AND (
          (pn.session_details IS NOT NULL AND TRIM(pn.session_details) <> '')
          OR (pn.mood IS NOT NULL AND TRIM(pn.mood) <> '')
          OR (pn.incidents IS NOT NULL AND TRIM(pn.incidents) <> '')
          OR (pn.travel_km IS NOT NULL AND pn.travel_km > 0)
          OR (pn.travel_time_min IS NOT NULL AND pn.travel_time_min > 0)
        )
    )
  )`;
}

/**
 * Runtime check for a single shift id (used when building/finalising invoices).
 * @param {import('better-sqlite3').Database} db
 * @param {string} shiftId
 * @returns {boolean}
 */
export function shiftHasCompletionEvidence(db, shiftId) {
  if (!db || !shiftId) return false;
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM shifts s WHERE s.id = ? AND ${shiftCompletionEvidenceSql('s')} LIMIT 1`
    )
    .get(shiftId);
  return !!row;
}
