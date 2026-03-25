import { db } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';

export function getOnedriveLinkRow(organizationId) {
  if (!organizationId) return null;
  return db.prepare('SELECT * FROM organization_onedrive_link WHERE organization_id = ?').get(organizationId);
}

export function saveOnedriveLink({
  organizationId,
  graphUserId,
  azureTenantId,
  refreshToken,
  accessToken,
  expiresInSec,
  connectedByUserId
}) {
  const now = Date.now();
  const expiresAt = expiresInSec ? now + expiresInSec * 1000 : null;
  db.prepare(`
    INSERT INTO organization_onedrive_link (
      organization_id, graph_user_id, azure_tenant_id,
      refresh_token_encrypted, access_token_encrypted, token_expires_at,
      nexus_core_folder_id, connected_at, connected_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, datetime('now'), ?)
    ON CONFLICT(organization_id) DO UPDATE SET
      graph_user_id = excluded.graph_user_id,
      azure_tenant_id = excluded.azure_tenant_id,
      refresh_token_encrypted = excluded.refresh_token_encrypted,
      access_token_encrypted = excluded.access_token_encrypted,
      token_expires_at = excluded.token_expires_at,
      nexus_core_folder_id = NULL,
      connected_at = datetime('now'),
      connected_by_user_id = excluded.connected_by_user_id
  `).run(
    organizationId,
    graphUserId,
    azureTenantId || null,
    encrypt(refreshToken),
    accessToken ? encrypt(accessToken) : null,
    expiresAt,
    connectedByUserId || null
  );
}

export function updateOnedriveTokens(organizationId, { accessToken, refreshToken, expiresInSec }) {
  const row = getOnedriveLinkRow(organizationId);
  if (!row) return;
  const now = Date.now();
  const expiresAt = expiresInSec ? now + expiresInSec * 1000 : row.token_expires_at;
  db.prepare(`
    UPDATE organization_onedrive_link SET
      access_token_encrypted = ?,
      refresh_token_encrypted = COALESCE(?, refresh_token_encrypted),
      token_expires_at = ?
    WHERE organization_id = ?
  `).run(
    accessToken ? encrypt(accessToken) : row.access_token_encrypted,
    refreshToken ? encrypt(refreshToken) : null,
    expiresAt,
    organizationId
  );
}

export function setNexusCoreFolderId(organizationId, folderId) {
  db.prepare('UPDATE organization_onedrive_link SET nexus_core_folder_id = ? WHERE organization_id = ?').run(
    folderId,
    organizationId
  );
}

export function clearOnedriveLink(organizationId) {
  db.prepare('DELETE FROM organization_onedrive_link WHERE organization_id = ?').run(organizationId);
}

export function getRefreshToken(organizationId) {
  const row = getOnedriveLinkRow(organizationId);
  if (!row?.refresh_token_encrypted) return null;
  try {
    return decrypt(row.refresh_token_encrypted);
  } catch {
    return null;
  }
}

export function getCachedAccessToken(organizationId) {
  const row = getOnedriveLinkRow(organizationId);
  if (!row?.access_token_encrypted || !row.token_expires_at) return null;
  if (Number(row.token_expires_at) < Date.now() + 120000) return null;
  try {
    return decrypt(row.access_token_encrypted);
  } catch {
    return null;
  }
}
