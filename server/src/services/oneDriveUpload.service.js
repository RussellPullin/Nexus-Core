/**
 * OneDrive upload service - push files to a staff folder for onboarding documents.
 * Uses same Microsoft Graph client credentials as excelPull.service.js.
 * PLACEHOLDER: configure base path for staff documents (STAFF_ONBOARDING_ONEDRIVE_BASE_PATH).
 */

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

function getEnv(key) {
  return process.env[key] || null;
}

// PLACEHOLDER: configure base path for staff documents; e.g. "Staff Onboarding" or "Nexus/Staff"
const STAFF_BASE_PATH = getEnv('STAFF_ONBOARDING_ONEDRIVE_BASE_PATH') || 'Staff Onboarding';

async function getAccessToken() {
  const tenantId = getEnv('AZURE_TENANT_ID');
  const clientId = getEnv('AZURE_CLIENT_ID');
  const clientSecret = getEnv('AZURE_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('OneDrive upload requires AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET');
  }
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('No access token in response');
  return data.access_token;
}

function encodePath(path) {
  return path.split('/').filter(Boolean).map((s) => encodeURIComponent(s)).join('/');
}

/**
 * Get or create folder at path under admin user's drive. Returns folder item id.
 */
async function ensureFolder(adminUserId, relativePath, accessToken) {
  const fullPath = [STAFF_BASE_PATH, relativePath].filter(Boolean).join('/');
  const pathUrl = `${GRAPH_BASE_URL}/users/${encodeURIComponent(adminUserId)}/drive/root:/${encodePath(fullPath)}`;
  const res = await fetch(pathUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok) {
    const item = await res.json();
    return item.id;
  }
  if (res.status !== 404) {
    const text = await res.text();
    throw new Error(`OneDrive folder check failed: ${res.status} ${text}`);
  }
  const parts = fullPath.split('/').filter(Boolean);
  let parentId = null;
  const rootRes = await fetch(
    `${GRAPH_BASE_URL}/users/${encodeURIComponent(adminUserId)}/drive/root`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!rootRes.ok) throw new Error('Failed to get drive root');
  let current = await rootRes.json();
  parentId = current.id;
  for (const segment of parts) {
    const childrenRes = await fetch(
      `${GRAPH_BASE_URL}/users/${encodeURIComponent(adminUserId)}/drive/items/${parentId}/children?$filter=name eq '${encodeURIComponent(segment)}'`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!childrenRes.ok) throw new Error('Failed to list children');
    const children = await childrenRes.json();
    const existing = children.value && children.value[0];
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const createRes = await fetch(
      `${GRAPH_BASE_URL}/users/${encodeURIComponent(adminUserId)}/drive/items/${parentId}/children`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: segment, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
      }
    );
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`OneDrive create folder failed: ${createRes.status} ${text}`);
    }
    const created = await createRes.json();
    parentId = created.id;
  }
  return parentId;
}

/**
 * Upload a file to the given folder path. localPath is full path to file; filename is display name.
 * Returns uploaded item id or null if OneDrive not configured.
 */
export async function uploadFileToStaffFolder(staffName, relativeFilePath, localPath, filename) {
  const adminUserId = getEnv('ONEDRIVE_ADMIN_USER_ID');
  if (!adminUserId) {
    console.warn('[oneDriveUpload] ONEDRIVE_ADMIN_USER_ID not set; skipping upload');
    return null;
  }
  if (!existsSync(localPath)) {
    console.warn('[oneDriveUpload] File not found:', localPath);
    return null;
  }
  const accessToken = await getAccessToken();
  const safeStaffName = (staffName || 'Staff').replace(/[/\\?*:|"]/g, '_');
  const folderPath = safeStaffName;
  const folderId = await ensureFolder(adminUserId, folderPath, accessToken);
  const content = readFileSync(localPath);
  const name = filename || basename(relativeFilePath || localPath);
  const uploadUrl = `${GRAPH_BASE_URL}/users/${encodeURIComponent(adminUserId)}/drive/items/${folderId}:/${encodeURIComponent(name)}:/content`;
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' },
    body: content,
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`OneDrive upload failed: ${putRes.status} ${text}`);
  }
  const item = await putRes.json();
  return item.id;
}
