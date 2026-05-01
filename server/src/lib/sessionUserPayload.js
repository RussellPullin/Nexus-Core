import { normalizeAppRole } from '../../../shared/appRoles.js';
import { isSuperAdminEmail } from './superAdmin.js';
import { getRelayConfigFromEnv } from './emailSendConfig.js';
import { tenantProductPayloadForUser } from '../services/tenantProduct.service.js';

/** Matches columns returned to the client after login /me (excludes password_hash). */
export const AUTH_USER_SELECT = `id, email, name, role, org_id, auth_uid, billing_interval_minutes, staff_id, signature_data,
  ollama_local_base_url,
  email_provider, email_connected_address, email_reconnect_required,
  coordination_access, agency_access`;

export function shapeSessionUser(row) {
  if (!row) return null;
  return {
    ...row,
    role: normalizeAppRole(row.role),
    billing_interval_minutes: row.billing_interval_minutes ?? 15,
    signature_data: row.signature_data || null,
    ollama_local_base_url: row.ollama_local_base_url || null,
    email_reconnect_required: !!row.email_reconnect_required,
    is_super_admin: isSuperAdminEmail(row.email)
  };
}

/**
 * Full `/auth/me`-style user JSON including Nexus Coordination / Agency fields.
 * @param {import('express').Request} req
 * @param {object} row — DB row including coordination_access, agency_access when present
 * @param {Record<string, unknown>} [extras]
 */
export function mergeProductIntoAuthMe(req, row, extras = {}) {
  const shaped = shapeSessionUser(row);
  const tp = tenantProductPayloadForUser(req, row);
  return {
    ...shaped,
    ...extras,
    ...tp,
    email_relay_configured: Boolean(getRelayConfigFromEnv()?.url)
  };
}
