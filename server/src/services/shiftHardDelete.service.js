/**
 * Shared hard-delete for a shift and its dependent rows.
 * Used by the admin hard-delete route and the automatic duplicate cleanup.
 */
import { db } from '../db/index.js';
import { scheduleRemoveShiftFromNexusSupabase } from './nexusPublicShiftsSync.service.js';
import { recordSuppressedShifterShiftId } from './shiftImportSuppression.service.js';

/**
 * Permanently delete a shift row and everything that depends on it.
 *
 * @param {string} shiftId
 * @param {object} [opts]
 * @param {boolean} [opts.suppressShifterId=true] Block the external shifter_shift_id from re-import.
 *   Pass false for automatic cleanup so a later genuine completion of that same Shifter shift can
 *   still flow in.
 * @param {string|null} [opts.nexusOrgId=null] Org used when suppressing; falls back to the shift's
 *   participant provider org.
 * @param {string} [opts.reason='hard_delete']
 * @returns {{ ok: boolean, deleted: boolean, id: string }}
 */
export function hardDeleteShiftRow(shiftId, opts = {}) {
  const { suppressShifterId = true, nexusOrgId = null, reason = 'hard_delete' } = opts;
  if (!shiftId) return { ok: false, deleted: false, id: shiftId };

  const existing = db
    .prepare(
      `SELECT s.id, s.shifter_shift_id, p.provider_org_id AS participant_provider_org_id
       FROM shifts s
       JOIN participants p ON p.id = s.participant_id
       WHERE s.id = ?`,
    )
    .get(shiftId);
  if (!existing) return { ok: false, deleted: false, id: shiftId };

  if (suppressShifterId && existing.shifter_shift_id && String(existing.shifter_shift_id).trim()) {
    const org = String(nexusOrgId || existing.participant_provider_org_id || '').trim();
    recordSuppressedShifterShiftId(org, existing.shifter_shift_id, reason);
  }

  // Remove dependent rows so FK constraints don't block the shift delete.
  try {
    db.prepare('DELETE FROM billing_invoice_line_items WHERE source_shift_id = ?').run(shiftId);
  } catch (e) { /* table may not exist or no FK */ }
  try {
    db.prepare('DELETE FROM invoices WHERE shift_id = ?').run(shiftId);
  } catch (e) { /* table may not exist */ }
  try {
    db.prepare('UPDATE progress_notes SET shift_id = NULL WHERE shift_id = ?').run(shiftId);
  } catch (e) { /* table may not exist */ }
  try {
    db.prepare('DELETE FROM case_notes WHERE shift_id = ?').run(shiftId);
  } catch (e) { /* column may not exist on old DB */ }
  db.prepare('DELETE FROM shift_line_items WHERE shift_id = ?').run(shiftId);
  db.prepare('DELETE FROM shifts WHERE id = ?').run(shiftId);

  // Also remove mirrored copy from Nexus Supabase (if configured).
  scheduleRemoveShiftFromNexusSupabase(shiftId);
  return { ok: true, deleted: true, id: shiftId };
}
