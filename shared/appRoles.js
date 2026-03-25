/**
 * Canonical Nexus roles: admin | delegate | support_coordinator.
 * Used by server session/SQLite sync and client UI gates — keep one source of truth.
 */

const ADMIN_ALIASES = new Set([
  'admin',
  'administrator',
  'manager',
  'org admin',
  'organization admin',
  'organisation admin',
  'owner',
  'org owner',
  'organization owner',
  'organisation owner',
  'super admin',
  'superadmin',
  'global admin',
  'tenant admin',
  'account admin',
  'system admin',
  'sysadmin',
]);

/**
 * @param {unknown} roleRaw — from SQLite users.role or Supabase profiles.role
 * @returns {'admin' | 'delegate' | 'support_coordinator'}
 */
export function normalizeAppRole(roleRaw) {
  const r = String(roleRaw || '')
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');

  if (ADMIN_ALIASES.has(r)) return 'admin';
  if (r === 'delegate') return 'delegate';
  return 'support_coordinator';
}
