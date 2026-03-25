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
