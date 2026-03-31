/**
 * Comma- or semicolon-separated login emails that may manage org feature flags and other super-admin routes.
 * Example: NEXUS_SUPER_ADMIN_EMAILS=you@company.com,ops@company.com
 */
export function isSuperAdminEmail(email) {
  const raw = process.env.NEXUS_SUPER_ADMIN_EMAILS || '';
  const allowed = new Set(
    raw
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const e = String(email || '')
    .trim()
    .toLowerCase();
  return allowed.size > 0 && allowed.has(e);
}

/**
 * When true, super-admin feature-flag routes only load/update flags for their own org (see orgFeatures routes).
 * Participant, staff, and user data are always org-scoped when the account has an org_id — super admins are not exempt.
 * Supports legacy env name NEXUS_SUPER_ADMIN_FEATURE_FLAGS_SCOPED_TO_OWN_ORG.
 */
export function isSuperAdminScopedToOwnOrg() {
  return (
    process.env.NEXUS_SUPER_ADMIN_SCOPED_TO_OWN_ORG === 'true' ||
    process.env.NEXUS_SUPER_ADMIN_FEATURE_FLAGS_SCOPED_TO_OWN_ORG === 'true'
  );
}

/** SQLite tenant filter for list/detail APIs (participants, users, etc.) — same rules for all roles including super admin. */
export function shouldApplyOrgDataScopeForUser(user) {
  return Boolean(user?.org_id);
}
