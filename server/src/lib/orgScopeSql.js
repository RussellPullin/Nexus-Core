import { db } from '../db/index.js';
import {
  includeNullProviderParticipantsForUser,
  resolveFinancialDataOrgScope,
} from '../middleware/roles.js';

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

/** Same tenant as {@link tenantParticipantClause} plus staff.org_id (shifts, progress_notes, etc.). Open shifts (no staff) match on participant org only. */
export function tenantParticipantAndStaffClause(userId, pAlias = 'p', stAlias = 'st', sAlias = 's') {
  const base = tenantParticipantClause(userId, pAlias);
  if (!base.orgId) return { sql: '1=0', params: [], orgId: null };
  const st = stAlias;
  const s = sAlias;
  return {
    sql: `${base.sql} AND (${s}.staff_id IS NULL OR ${st}.org_id = ?)`,
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
  const c = tenantParticipantAndStaffClause(userId, 'p', 'st', 's');
  if (!c.orgId || !shiftId) return false;
  const row = db
    .prepare(
      `
    SELECT 1 AS x FROM shifts s
    JOIN participants p ON p.id = s.participant_id
    LEFT JOIN staff st ON st.id = s.staff_id
    WHERE s.id = ? AND (${c.sql})
  `
    )
    .get(shiftId, ...c.params);
  return !!row;
}

/**
 * SQL fragment for billing_invoices JOIN participants p — own org only; super admins cannot pivot org via query string.
 * @returns {{ empty: true } | { sql: string, params: unknown[] }}
 */
export function billingParticipantFilterFromRequest(req) {
  const scope = resolveFinancialDataOrgScope(req);
  if (scope.mode === 'none') return { empty: true };

  const orgId = scope.orgId;
  const dbUser = scope.dbUser;
  const legacy = includeNullProviderParticipantsForUser(dbUser);

  if (legacy) {
    return {
      sql: `(p.provider_org_id = ? OR p.provider_org_id IS NULL OR TRIM(COALESCE(p.provider_org_id, '')) = '')`,
      params: [orgId],
    };
  }
  return { sql: 'p.provider_org_id = ?', params: [orgId] };
}

/** True if this participant is in scope for billing APIs (matches list endpoints). */
export function isParticipantVisibleToBillingRequest(participantId, req) {
  if (!participantId || !req) return false;
  const bf = billingParticipantFilterFromRequest(req);
  if (bf.empty) return false;
  const row = db.prepare(`SELECT 1 AS x FROM participants p WHERE p.id = ? AND (${bf.sql})`).get(participantId, ...bf.params);
  return !!row;
}

/**
 * Filter staff by org (admin pay summary, etc.) — own org only; no super-admin cross-org view.
 * @returns {{ empty: true } | { sql: string, params: unknown[] }}
 */
export function staffTableOrgFilterFromRequest(req, tableAlias = 'st') {
  const scope = resolveFinancialDataOrgScope(req);
  if (scope.mode === 'none') return { empty: true };
  const a = tableAlias;
  return { sql: `${a}.org_id = ?`, params: [scope.orgId] };
}
