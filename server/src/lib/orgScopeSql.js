import { db } from '../db/index.js';
import { includeNullProviderParticipantsForUser } from '../middleware/roles.js';

/**
 * Returns SQL + params so queries only return rows for the user's provider org.
 * When the user has no org_id, use sql `1=0` so lists are empty.
 */
export function tenantParticipantClause(userId, tableAlias = 'p') {
  const user = userId ? db.prepare('SELECT id, org_id, email FROM users WHERE id = ?').get(userId) : null;
  const orgId = user?.org_id || null;
  const a = tableAlias;
  if (!orgId) {
    return { sql: '1=0', params: [], orgId: null };
  }
  const legacy = includeNullProviderParticipantsForUser(user);
  if (legacy) {
    return {
      sql: `(${a}.provider_org_id = ? OR ${a}.provider_org_id IS NULL OR TRIM(COALESCE(${a}.provider_org_id, '')) = '')`,
      params: [orgId],
      orgId
    };
  }
  return { sql: `${a}.provider_org_id = ?`, params: [orgId], orgId };
}

/** Same tenant as {@link tenantParticipantClause} plus staff.org_id (shifts, progress_notes, etc.). */
export function tenantParticipantAndStaffClause(userId, pAlias = 'p', stAlias = 'st') {
  const base = tenantParticipantClause(userId, pAlias);
  if (!base.orgId) return { sql: '1=0', params: [], orgId: null };
  const st = stAlias;
  return {
    sql: `${base.sql} AND ${st}.org_id = ?`,
    params: [...base.params, base.orgId],
    orgId: base.orgId
  };
}

export function isParticipantInRequesterTenant(participantId, userId) {
  const c = tenantParticipantClause(userId, 'p');
  if (!c.orgId || !participantId) return false;
  const row = db.prepare(`SELECT 1 AS x FROM participants p WHERE p.id = ? AND (${c.sql})`).get(participantId, ...c.params);
  return !!row;
}

export function isCoordinatorTaskInRequesterTenant(taskId, userId) {
  const c = tenantParticipantClause(userId, 'p');
  if (!c.orgId || !taskId) return false;
  const row = db
    .prepare(
      `
    SELECT 1 AS x FROM coordinator_tasks ct
    JOIN participants p ON p.id = ct.participant_id
    WHERE ct.id = ? AND (${c.sql})
  `
    )
    .get(taskId, ...c.params);
  return !!row;
}

export function isShiftInRequesterTenant(shiftId, userId) {
  const c = tenantParticipantAndStaffClause(userId, 'p', 'st');
  if (!c.orgId || !shiftId) return false;
  const row = db
    .prepare(
      `
    SELECT 1 AS x FROM shifts s
    JOIN participants p ON p.id = s.participant_id
    JOIN staff st ON st.id = s.staff_id
    WHERE s.id = ? AND (${c.sql})
  `
    )
    .get(shiftId, ...c.params);
  return !!row;
}
