/**
 * External shift ids from Shifter are stable UUIDs.
 * Excel often uses the worksheet row number ("25"), which is reused for
 * different visits and must never be a merge key.
 */

/** Excel-style row numbers: 1–99999, digits only. */
const UNSTABLE_ROW_NUMBER = /^\d{1,5}$/;

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isStableExternalShiftId(id) {
  const s = String(id || '').trim();
  if (!s) return false;
  if (UNSTABLE_ROW_NUMBER.test(s)) return false;
  return true;
}

/**
 * @param {unknown} id
 * @returns {string} Stable id, or empty string when it must not be stored/matched.
 */
export function normalizeExternalShiftId(id) {
  const s = String(id || '').trim();
  return isStableExternalShiftId(s) ? s : '';
}
