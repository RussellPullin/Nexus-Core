/**
 * Legacy OneDrive / Microsoft Graph "admin" identity from env (same aliases as .env.example).
 */

export function getLegacyOnedriveAdminUserId() {
  const id =
    process.env.ONEDRIVE_ADMIN_USER_ID?.trim() ||
    process.env.ADMIN_USER_ID?.trim() ||
    process.env.ONEDRIVE_USER_EMAIL?.trim() ||
    process.env.MICROSOFT_GRAPH_USER_ID?.trim() ||
    '';
  return id || null;
}

export function isLegacyOnedriveAdminConfigured() {
  return Boolean(getLegacyOnedriveAdminUserId());
}
