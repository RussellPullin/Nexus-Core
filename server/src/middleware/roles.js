import { normalizeAppRole } from '../../../shared/appRoles.js';
import { db } from '../db/index.js';

/** Provider tenant org for new participants / scoping (SQLite organisations.id, same UUID as Supabase public.organizations). */
export function getProviderOrgIdForUser(userId) {
  if (!userId) return null;
  const row = db.prepare('SELECT org_id FROM users WHERE id = ?').get(userId);
  return row?.org_id || null;
}

/**
 * When every user with an org_id shares the same value, returns that org id; otherwise null.
 * Used to attach legacy participants with NULL provider_org_id to the only provider tenant on this DB.
 */
export function getSingleDistinctUserOrgId() {
  const r = db.prepare('SELECT COUNT(DISTINCT org_id) AS c FROM users WHERE org_id IS NOT NULL').get();
  if (!r || r.c !== 1) return null;
  const row = db.prepare('SELECT org_id FROM users WHERE org_id IS NOT NULL LIMIT 1').get();
  return row?.org_id || null;
}

/**
 * True if this user should see participants whose provider_org_id is still NULL (legacy rows).
 * Strict: only when every user row with an org_id shares the same org_id (true single-tenant).
 * Broader heuristics were removed — they leaked NULL rows across tenants when multiple provider orgs existed.
 */
export function includeNullProviderParticipantsForUser(user) {
  if (!user?.org_id) return false;
  const single = getSingleDistinctUserOrgId();
  return Boolean(single && single === user.org_id);
}

/** Legacy NULL provider rows are visible only when this DB has a single tenant and it matches scopeOrgId. */
export function includeNullProviderParticipantsForOrgId(scopeOrgId) {
  if (!scopeOrgId) return false;
  const single = getSingleDistinctUserOrgId();
  return Boolean(single && single === scopeOrgId);
}

/**
 * Same rules as staff list: tenants are isolated; super admins with users.org_id default to that tenant;
 * ?all_orgs=1 or ?org_id= for overrides (super admin only).
 */
export function resolveParticipantListScope(req) {
  const userId = req.session?.user?.id;
  if (!userId) return { mode: 'none' };
  const dbUser = db.prepare('SELECT role, org_id, email FROM users WHERE id = ?').get(userId);
  if (!dbUser) return { mode: 'none' };

  const superA = isSuperAdminEmail(dbUser.email);
  const allOrgs = req.query?.all_orgs === 'true' || req.query?.all_orgs === '1';
  const rawQ = req.query?.org_id;
  const qOrg = typeof rawQ === 'string' && rawQ.trim() !== '' ? rawQ.trim() : null;

  if (!superA && !dbUser.org_id) return { mode: 'none' };

  if (superA) {
    if (allOrgs) return { mode: 'all', dbUser };
    if (qOrg) return { mode: 'scoped', orgId: qOrg, dbUser };
    if (dbUser.org_id) return { mode: 'scoped', orgId: dbUser.org_id, dbUser };
    return { mode: 'all', dbUser };
  }

  return { mode: 'scoped', orgId: dbUser.org_id, dbUser };
}

/**
 * Financial / billing / pay data: always the signed-in user's own organisation only.
 * Ignores super-admin ?org_id= and ?all_orgs= (super admins manage features elsewhere, not other orgs' money).
 * Users without users.org_id (typical global super admin) see no financial rows.
 */
export function resolveFinancialDataOrgScope(req) {
  const userId = req.session?.user?.id;
  if (!userId) return { mode: 'none' };
  const dbUser = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(userId);
  if (!dbUser) return { mode: 'none' };
  if (!dbUser.org_id) return { mode: 'none' };
  return { mode: 'scoped', orgId: dbUser.org_id, dbUser };
}

/**
 * Require user to have one of the given roles.
 * Use after requireAuth.
 */
export function requireRole(roles) {
  return (req, res, next) => {
    const role = req.session?.user?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    return next();
  };
}

/**
 * Require admin role.
 */
export function requireAdmin(req, res, next) {
  const role = normalizeAppRole(req.session?.user?.role);
  if (role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Admin access required' });
}

/**
 * Require coordinator or admin access (admin, delegate with grant, or support_coordinator).
 * Used for coordinator-only features like case tasks.
 */
export function requireCoordinatorOrAdmin(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const role = user.role || db.prepare('SELECT role FROM users WHERE id = ?').get(user.id)?.role;
  if (!role) return res.status(403).json({ error: 'Coordinator or admin access required' });

  if (role === 'admin') return next();
  if (role === 'support_coordinator') return next();
  if (role === 'delegate') {
    const now = new Date().toISOString().slice(0, 10);
    const grant = db.prepare(`
      SELECT 1 FROM delegate_grants
      WHERE user_id = ? AND full_control = 1
        AND (expires_at IS NULL OR expires_at >= ?)
    `).get(user.id, now);
    if (grant) return next();
  }

  return res.status(403).json({ error: 'Coordinator or admin access required' });
}

/**
 * Require admin OR delegate with active grant.
 * Delegate must have delegate_grants entry with full_control=1 and expires_at null or future.
 */
export function requireAdminOrDelegate(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  let role = normalizeAppRole(user.role);
  if (!role) {
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(user.id);
    role = normalizeAppRole(row?.role || 'support_coordinator');
    req.session.user.role = role;
  }

  if (role === 'admin') return next();

  if (role === 'delegate') {
    const now = new Date().toISOString().slice(0, 10);
    const grant = db.prepare(`
      SELECT 1 FROM delegate_grants
      WHERE user_id = ? AND full_control = 1
        AND (expires_at IS NULL OR expires_at >= ?)
    `).get(user.id, now);
    if (grant) return next();
  }

  return res.status(403).json({ error: 'Admin or delegate access required' });
}

/** True when session user is admin or delegate with an active full_control grant. */
export function sessionIsAdminOrDelegate(session) {
  const user = session?.user;
  if (!user?.id) return false;

  let role = normalizeAppRole(user.role);
  if (!role) {
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(user.id);
    role = normalizeAppRole(row?.role || 'support_coordinator');
  }
  if (role === 'admin') return true;
  if (role === 'delegate') {
    const now = new Date().toISOString().slice(0, 10);
    const grant = db.prepare(`
      SELECT 1 FROM delegate_grants
      WHERE user_id = ? AND full_control = 1
        AND (expires_at IS NULL OR expires_at >= ?)
    `).get(user.id, now);
    return Boolean(grant);
  }
  return false;
}

/**
 * Check if user can access a participant.
 * Returns true for admin, delegate with active grant, or user with user_participants assignment.
 */
export function canAccessParticipant(userId, participantId) {
  const user = db.prepare('SELECT role, org_id, email FROM users WHERE id = ?').get(userId);
  if (!user) return false;

  const participant = db.prepare('SELECT provider_org_id FROM participants WHERE id = ?').get(participantId);
  if (!participant) return false;
  const enforceOrgMatch = Boolean(user.org_id);
  if (enforceOrgMatch) {
    const po = participant.provider_org_id;
    const poEmpty = po == null || String(po).trim() === '';
    if (!poEmpty && po !== user.org_id) return false;
    if (poEmpty && !includeNullProviderParticipantsForUser(user) && normalizeAppRole(user.role) !== 'admin') {
      return false;
    }
  }

  const effectiveRole = normalizeAppRole(user.role);
  if (effectiveRole === 'admin') return true;
  if (effectiveRole === 'delegate') {
    const now = new Date().toISOString().slice(0, 10);
    const grant = db.prepare(`
      SELECT 1 FROM delegate_grants
      WHERE user_id = ? AND full_control = 1
        AND (expires_at IS NULL OR expires_at >= ?)
    `).get(userId, now);
    if (grant) return true;
  }
  const assigned = db.prepare(
    'SELECT 1 FROM user_participants WHERE user_id = ? AND participant_id = ?'
  ).get(userId, participantId);
  return !!assigned;
}

/**
 * Participant IDs visible for assignment-style filtering (cases, tasks, list).
 * Returns null when the caller should not filter by this list (non-org-scoped admin/delegate).
 * Org-scoped admin/delegate: IDs in this org, plus legacy rows with NULL provider_org_id when single-tenant.
 * Support coordinators: assigned IDs that belong to this org (or legacy NULL when single-tenant).
 * @param {{ includeOrgOrphans?: boolean }} [opts] — org-scoped admin only: also include NULL/empty provider_org_id rows (list query param include_org_orphans).
 */
export function getAssignedParticipantIds(userId, opts = {}) {
  const user = db.prepare('SELECT role, org_id, email FROM users WHERE id = ?').get(userId);
  if (!user) return [];

  const orgScoped = Boolean(user.org_id);
  const legacyNull = includeNullProviderParticipantsForUser(user);
  const includeOrgOrphans = Boolean(opts.includeOrgOrphans);

  const now = new Date().toISOString().slice(0, 10);
  const effectiveRole = normalizeAppRole(user.role);
  const delegateGrant =
    effectiveRole === 'delegate'
      ? db
          .prepare(`
      SELECT 1 FROM delegate_grants
      WHERE user_id = ? AND full_control = 1
        AND (expires_at IS NULL OR expires_at >= ?)
    `)
          .get(userId, now)
      : null;

  if (effectiveRole === 'admin' || (effectiveRole === 'delegate' && delegateGrant)) {
    if (!orgScoped) return null;
    if (includeOrgOrphans && effectiveRole === 'admin') {
      const sql = `SELECT id FROM participants WHERE provider_org_id = ? OR provider_org_id IS NULL OR TRIM(COALESCE(provider_org_id, '')) = ''`;
      return db.prepare(sql).all(user.org_id).map((r) => r.id);
    }
    const sql = legacyNull
      ? 'SELECT id FROM participants WHERE provider_org_id = ? OR provider_org_id IS NULL'
      : 'SELECT id FROM participants WHERE provider_org_id = ?';
    return db.prepare(sql).all(user.org_id).map((r) => r.id);
  }

  const rows = db.prepare('SELECT participant_id FROM user_participants WHERE user_id = ?').all(userId);
  let ids = rows.map((r) => r.participant_id);
  if (orgScoped) {
    ids = ids.filter((pid) => {
      const p = db.prepare('SELECT provider_org_id FROM participants WHERE id = ?').get(pid);
      if (!p) return false;
      if (p.provider_org_id === user.org_id) return true;
      return legacyNull && (p.provider_org_id == null || p.provider_org_id === '');
    });
  }
  return ids;
}
