/**
 * Import company documents from a OneDrive folder (Microsoft Graph delegated OAuth).
 */
import { db } from '../db/index.js';
import { getOnedriveLinkRow } from './orgOnedriveTokens.service.js';
import { getValidAccessToken } from './orgOnedriveSync.service.js';
import {
  ingestCompanyDocumentFile,
  companyDocsRoot,
  relPathFromAbs
} from './companyDocuments.service.js';
import { syncAllOnboardingPoliciesForOrg } from './companyDocumentsOnboardingSync.service.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const GRAPH = 'https://graph.microsoft.com/v1.0';

function encodeGraphPath(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

async function graphJson(accessToken, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || text || `Graph ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function listFolderChildren(accessToken, folderPath) {
  const enc = encodeGraphPath(folderPath);
  const url = `${GRAPH}/me/drive/root:/${enc}:/children?$select=id,name,file,folder,@microsoft.graph.downloadUrl&$top=200`;
  const data = await graphJson(accessToken, url);
  return data?.value || [];
}

async function downloadItem(accessToken, item) {
  if (item['@microsoft.graph.downloadUrl']) {
    const res = await fetch(item['@microsoft.graph.downloadUrl']);
    if (!res.ok) throw new Error(`Download failed for ${item.name}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  }
  const url = `${GRAPH}/me/drive/items/${item.id}/content`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Download failed for ${item.name}`);
  return Buffer.from(await res.arrayBuffer());
}

export function getOnedriveImportSettings(orgId) {
  const row = getOnedriveLinkRow(orgId);
  return {
    connected: Boolean(row?.refresh_token_encrypted),
    import_enabled: Boolean(row?.import_enabled),
    import_source_path: row?.import_source_path || '',
    import_last_synced_at: row?.import_last_synced_at || null
  };
}

export function setOnedriveImportSettings(orgId, { import_enabled, import_source_path }) {
  const row = getOnedriveLinkRow(orgId);
  if (!row) throw new Error('OneDrive is not connected for this organisation.');

  const path = import_source_path != null ? String(import_source_path).trim().replace(/^\/+|\/+$/g, '') : row.import_source_path;
  const enabled = import_enabled != null ? (import_enabled ? 1 : 0) : row.import_enabled;

  db.prepare(
    `
    UPDATE organization_onedrive_link
    SET import_enabled = ?, import_source_path = ?
    WHERE organization_id = ?
  `
  ).run(enabled, path || null, orgId);

  return getOnedriveImportSettings(orgId);
}

/**
 * Walk OneDrive folder (one level of subfolders + root files) and import PDF/DOCX.
 */
export async function syncCompanyDocumentsFromOnedrive(orgId, options = {}) {
  const settings = getOnedriveImportSettings(orgId);
  if (!settings.connected) throw new Error('Connect Microsoft OneDrive under Settings first.');
  const folderPath = (options.source_path || settings.import_source_path || '').trim();
  if (!folderPath) throw new Error('Set an import folder path (e.g. Policies and procedures).');

  const accessToken = await getValidAccessToken(orgId);
  if (!accessToken) throw new Error('Could not refresh OneDrive access token.');

  const imported = [];
  const skipped = [];
  const errors = [];

  async function importItem(item, subpath) {
    const name = item.name || 'document';
    const lower = name.toLowerCase();
    if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) {
      skipped.push({ name, reason: 'unsupported type' });
      return;
    }
    try {
      const buffer = await downloadItem(accessToken, item);
      const displayName = name.replace(/\.(pdf|docx)$/i, '');
      const existing = db
        .prepare('SELECT id FROM org_company_documents WHERE org_id = ? AND onedrive_item_id = ?')
        .get(orgId, item.id);

      if (existing?.id) {
        const docRow = db.prepare('SELECT * FROM org_company_documents WHERE id = ?').get(existing.id);
        if (docRow?.source === 'library_master') {
          skipped.push({ name, reason: 'library master (skipped)' });
          return;
        }
        const dir = join(companyDocsRoot(orgId), docRow.slug);
        mkdirSync(dir, { recursive: true });
        const ext = name.toLowerCase().endsWith('.docx') ? '.docx' : '.pdf';
        const templateFilename = `template${ext}`;
        const absPath = join(dir, templateFilename);
        writeFileSync(absPath, buffer);
        db.prepare(
          `
          UPDATE org_company_documents
          SET display_name = ?, template_filename = ?, file_path = ?, onedrive_path = ?, updated_at = datetime('now')
          WHERE id = ?
        `
        ).run(displayName, templateFilename, relPathFromAbs(absPath), subpath, existing.id);
        imported.push({ id: existing.id, name: displayName, updated: true });
        return;
      }

      const row = ingestCompanyDocumentFile(
        orgId,
        { originalname: name, buffer },
        {
          source: 'onedrive',
          onedrive_item_id: item.id,
          onedrive_path: subpath
        }
      );
      imported.push({ id: row.id, name: row.display_name });
    } catch (e) {
      errors.push({ name, error: e.message });
    }
  }

  const rootItems = await listFolderChildren(accessToken, folderPath);
  for (const item of rootItems) {
    if (item.folder) {
      const subPath = `${folderPath}/${item.name}`;
      const children = await listFolderChildren(accessToken, subPath);
      for (const child of children) {
        if (child.folder) continue;
        await importItem(child, `${subPath}/${child.name}`);
      }
    } else {
      await importItem(item, `${folderPath}/${item.name}`);
    }
  }

  db.prepare(`UPDATE organization_onedrive_link SET import_last_synced_at = datetime('now') WHERE organization_id = ?`).run(
    orgId
  );

  let onboarding = null;
  if (options.sync_onboarding !== false) {
    onboarding = await syncAllOnboardingPoliciesForOrg(orgId);
  }

  return {
    folder_path: folderPath,
    imported_count: imported.length,
    imported,
    skipped,
    errors,
    onboarding
  };
}
