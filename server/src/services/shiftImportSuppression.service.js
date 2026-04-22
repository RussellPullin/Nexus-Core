/**
 * When a user hard-deletes an imported shift, the next Excel/Shifter pull will re-insert the same
 * row if it still exists in the source. Track suppressed external shift ids (Shifter/Progress "shiftId")
 * per Nexus org so import pipelines skip them.
 */
import { db } from '../db/index.js';

function normId(s) {
  return String(s || '').trim();
}

/**
 * @param {string|null|undefined} nexusOrgId - participants.provider_org_id / users.org_id (UUID string)
 * @param {string|null|undefined} shifterShiftId - external id from Progress / Excel (shiftId)
 * @param {string} [reason]
 */
export function recordSuppressedShifterShiftId(nexusOrgId, shifterShiftId, reason = 'hard_delete') {
  const org = normId(nexusOrgId);
  const sid = normId(shifterShiftId);
  if (!org || !sid) return { ok: false, skipped: true };

  try {
    db.prepare(
      `
      INSERT INTO shift_import_suppressed_shifter_ids (nexus_org_id, shifter_shift_id, reason, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(nexus_org_id, shifter_shift_id) DO UPDATE SET
        reason = excluded.reason,
        created_at = datetime('now')
    `,
    ).run(org, sid, reason);
    return { ok: true };
  } catch (e) {
    console.warn('[shift-import-suppression] record failed', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

export function isShifterShiftIdSuppressedForOrg(nexusOrgId, shifterShiftId) {
  const org = normId(nexusOrgId);
  const sid = normId(shifterShiftId);
  if (!org || !sid) return false;
  const row = db
    .prepare(
      `
    SELECT 1 AS ok
    FROM shift_import_suppressed_shifter_ids
    WHERE nexus_org_id = ? AND shifter_shift_id = ?
    LIMIT 1
  `,
    )
    .get(org, sid);
  return Boolean(row?.ok);
}
