/**
 * Per-organisation OneDrive (Microsoft Graph delegated OAuth).
 * Creates Nexus Core / Staff / Participants / Register tree; uploads documents; SQLite register.
 */

import { v4 as uuidv4 } from 'uuid';
import ExcelJS from 'exceljs';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { db } from '../db/index.js';
import {
  getOnedriveLinkRow,
  getRefreshToken,
  getCachedAccessToken,
  updateOnedriveTokens,
  setNexusCoreFolderId
} from './orgOnedriveTokens.service.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

const ROOT_NAME = 'Nexus Core';
const FOLDER_STAFF = 'Staff';
const FOLDER_PARTICIPANTS = 'Participants';
const FOLDER_REGISTER = 'Register';
const REGISTER_WORKBOOK_NAME = 'Document Register.xlsx';
const REGISTERS_TEMPLATE_PATH =
  process.env.ONEDRIVE_REGISTERS_TEMPLATE_PATH?.trim() ||
  '/Users/pristinelifestylesolutions/Library/CloudStorage/OneDrive-PristineLifestyleSolutions/Pristine Lifestyle Solutions/Policies and procedures_/Registers/Registers.xlsx';
const registerSyncTimers = new Map();

function sanitizeSegment(s) {
  return String(s || 'unknown')
    .replace(/[/\\?*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72);
}

function entityFolderName(name, id) {
  const short = id ? String(id).replace(/-/g, '').slice(0, 8) : '';
  const base = sanitizeSegment(name) || 'item';
  return short ? `${base}_${short}` : base;
}

function participantCategoryFolder(category) {
  const c = String(category || '').toLowerCase();
  if (c.includes('plan') || c.includes('ndis plan')) return 'Plans';
  if (c.includes('archive')) return 'Archived';
  if (c.includes('service') || c.includes('agreement') || c.includes('consent')) return 'Service agreements';
  return 'Other';
}

function staffCategoryFolder(category) {
  const c = String(category || '').toLowerCase();
  if (c.includes('contract') || c.includes('employment')) return 'Contracts';
  if (
    c.includes('cert') ||
    c.includes('license') ||
    c.includes('licence') ||
    c.includes('wwcc') ||
    c.includes('police') ||
    c.includes('card') ||
    c.includes('first_aid') ||
    c.includes('insurance') ||
    c.includes('drivers')
  ) {
    return 'Certificates';
  }
  if (c.includes('archive')) return 'Archived';
  return 'Other';
}

async function graphJson(accessToken, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });
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

export async function getValidAccessToken(organizationId) {
  const cached = getCachedAccessToken(organizationId);
  if (cached) return cached;

  const row = getOnedriveLinkRow(organizationId);
  const refresh = getRefreshToken(organizationId);
  if (!row || !refresh) return null;

  const tenant = row.azure_tenant_id || process.env.MICROSOFT_OAUTH_TENANT || 'common';
  const cid = process.env.MICROSOFT_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim();
  if (!cid || !secret) return null;

  const body = new URLSearchParams({
    client_id: cid,
    client_secret: secret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
    scope: 'offline_access openid profile User.Read Files.ReadWrite.All'
  });
  const tokRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tokRes.ok || !tok.access_token) {
    console.warn('[orgOnedrive] token refresh failed', tok.error || tokRes.status);
    return null;
  }
  updateOnedriveTokens(organizationId, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || undefined,
    expiresInSec: tok.expires_in
  });
  return tok.access_token;
}

function encodeGraphPath(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/**
 * Ensure folder path under /me/drive/root exists. Returns the deepest folder item id.
 */
async function ensureFolderPath(accessToken, pathSegments) {
  const built = [];
  for (const seg of pathSegments) {
    built.push(seg);
    const pathStr = built.join('/');
    const enc = encodeGraphPath(pathStr);
    const itemUrl = `${GRAPH}/me/drive/root:/${enc}`;
    try {
      const item = await graphJson(accessToken, itemUrl);
      if (item.folder) continue;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const parentBuilt = built.slice(0, -1);
    const parentEnc = parentBuilt.length ? encodeGraphPath(parentBuilt.join('/')) : null;
    const createUrl = parentEnc
      ? `${GRAPH}/me/drive/root:/${parentEnc}:/children`
      : `${GRAPH}/me/drive/root/children`;
    try {
      await graphJson(accessToken, createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: seg,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename'
        })
      });
    } catch (err) {
      if (err.status === 409) {
        const again = await graphJson(accessToken, itemUrl);
        if (!again.folder) throw err;
      } else throw err;
    }
  }
  const finalEnc = encodeGraphPath(pathSegments.join('/'));
  const final = await graphJson(accessToken, `${GRAPH}/me/drive/root:/${finalEnc}`);
  return final.id;
}

export async function ensureNexusCoreLayout(organizationId) {
  const accessToken = await getValidAccessToken(organizationId);
  if (!accessToken) return null;

  const nexusId = await ensureFolderPath(accessToken, [ROOT_NAME]);
  setNexusCoreFolderId(organizationId, nexusId);

  await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_STAFF]);
  await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_PARTICIPANTS]);
  await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_REGISTER]);

  const readme = `Nexus Core document root\nCreated automatically. Staff and participant files are organised in subfolders. Nothing is deleted from here by Nexus—new versions use new filenames; use Archived folders for superseded files.\n`;
  const regPath = [ROOT_NAME, FOLDER_REGISTER, 'README.txt'];
  try {
    const enc = encodeGraphPath(regPath.join('/'));
    await graphJson(accessToken, `${GRAPH}/me/drive/root:/${enc}:/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: readme
    });
  } catch (e) {
    console.warn('[orgOnedrive] README upload skipped', e.message);
  }
  try {
    await syncRegisterWorkbookNow(organizationId, accessToken);
  } catch (e) {
    console.warn('[orgOnedrive] register workbook init skipped', e.message);
  }
  try {
    await syncTemplateRegistersNow(organizationId, accessToken);
  } catch (e) {
    console.warn('[orgOnedrive] template registers init skipped', e.message);
  }

  return nexusId;
}

async function uploadByPath(accessToken, pathSegments, filename, buffer, contentType) {
  const folderPath = pathSegments.join('/');
  const folderEnc = encodeGraphPath(folderPath);
  const safeName = filename.replace(/[/\\?*:|"<>]/g, '_');
  const stamped = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeName}`;
  const url = `${GRAPH}/me/drive/root:/${folderEnc}/${encodeURIComponent(stamped)}:/content`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: buffer
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || text || `Upload ${res.status}`);
  }
  return { itemId: data.id, webUrl: data.webUrl || null, filename: stamped };
}

async function putFileByPath(accessToken, pathSegments, filename, buffer, contentType) {
  const folderPath = pathSegments.join('/');
  const folderEnc = encodeGraphPath(folderPath);
  const safeName = String(filename || 'file').replace(/[/\\?*:|"<>]/g, '_');
  const url = `${GRAPH}/me/drive/root:/${folderEnc}/${encodeURIComponent(safeName)}:/content`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: buffer
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || text || `Upload ${res.status}`);
  }
  return { itemId: data.id, webUrl: data.webUrl || null, filename: safeName };
}

function buildWorkbookRows(organizationId) {
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_id, category, filename, graph_item_id, web_url, mime_type, created_at, notes
       FROM onedrive_document_register
       WHERE organization_id = ?
       ORDER BY datetime(created_at) DESC`
    )
    .all(organizationId);
  const participantNames = new Map(
    db.prepare('SELECT id, name FROM participants').all().map((r) => [r.id, r.name])
  );
  const staffNames = new Map(
    db.prepare('SELECT id, name FROM staff').all().map((r) => [r.id, r.name])
  );
  return rows.map((r) => ({
    created_at: r.created_at || '',
    entity_type: r.entity_type || '',
    entity_name:
      r.entity_type === 'participant'
        ? participantNames.get(r.entity_id) || ''
        : r.entity_type === 'staff'
          ? staffNames.get(r.entity_id) || ''
          : '',
    entity_id: r.entity_id || '',
    category: r.category || '',
    filename: r.filename || '',
    mime_type: r.mime_type || '',
    web_url: r.web_url || '',
    graph_item_id: r.graph_item_id || '',
    notes: r.notes || ''
  }));
}

function writeRegisterSheet(ws, rows) {
  ws.columns = [
    { header: 'Created At', key: 'created_at', width: 22 },
    { header: 'Entity Type', key: 'entity_type', width: 14 },
    { header: 'Entity Name', key: 'entity_name', width: 28 },
    { header: 'Entity ID', key: 'entity_id', width: 40 },
    { header: 'Category', key: 'category', width: 22 },
    { header: 'Filename', key: 'filename', width: 46 },
    { header: 'MIME Type', key: 'mime_type', width: 24 },
    { header: 'OneDrive URL', key: 'web_url', width: 70 },
    { header: 'Graph Item ID', key: 'graph_item_id', width: 40 },
    { header: 'Notes', key: 'notes', width: 36 }
  ];
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = 'A1:J1';
}

async function buildRegisterWorkbookBuffer(organizationId) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexus Core';
  wb.created = new Date();

  const allRows = buildWorkbookRows(organizationId);
  const participantRows = allRows.filter((r) => r.entity_type === 'participant');
  const staffRows = allRows.filter((r) => r.entity_type === 'staff');

  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Field', key: 'field', width: 28 },
    { header: 'Value', key: 'value', width: 40 }
  ];
  summary.addRows([
    { field: 'Generated At (UTC)', value: new Date().toISOString() },
    { field: 'Organisation ID', value: organizationId },
    { field: 'Total Documents', value: allRows.length },
    { field: 'Participant Documents', value: participantRows.length },
    { field: 'Staff Documents', value: staffRows.length }
  ]);
  summary.getRow(1).font = { bold: true };

  writeRegisterSheet(wb.addWorksheet('All Documents'), allRows);
  writeRegisterSheet(wb.addWorksheet('Participants'), participantRows);
  writeRegisterSheet(wb.addWorksheet('Staff'), staffRows);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

export async function syncRegisterWorkbookNow(organizationId, suppliedAccessToken = null) {
  const accessToken = suppliedAccessToken || (await getValidAccessToken(organizationId));
  if (!accessToken) return null;
  await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_REGISTER]);
  const workbook = await buildRegisterWorkbookBuffer(organizationId);
  return putFileByPath(
    accessToken,
    [ROOT_NAME, FOLDER_REGISTER],
    REGISTER_WORKBOOK_NAME,
    workbook,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

function scheduleRegisterWorkbookSync(organizationId) {
  if (!organizationId) return;
  const existing = registerSyncTimers.get(organizationId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    try {
      await syncRegisterWorkbookNow(organizationId);
      await syncTemplateRegistersNow(organizationId);
    } catch (e) {
      console.warn('[orgOnedrive] register workbook sync failed', e.message);
    } finally {
      registerSyncTimers.delete(organizationId);
    }
  }, 4000);
  registerSyncTimers.set(organizationId, timer);
}

function copyWorksheetTemplate(source, target) {
  source.columns.forEach((col, idx) => {
    const t = target.getColumn(idx + 1);
    t.width = col.width;
    t.hidden = col.hidden;
    if (col.style) t.style = { ...col.style };
  });
  source.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const tRow = target.getRow(rowNumber);
    tRow.height = row.height;
    if (row.style) tRow.style = { ...row.style };
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const tCell = tRow.getCell(colNumber);
      tCell.value = cell.value;
      if (cell.style) tCell.style = { ...cell.style };
      if (cell.numFmt) tCell.numFmt = cell.numFmt;
      if (cell.alignment) tCell.alignment = { ...cell.alignment };
      if (cell.border) tCell.border = { ...cell.border };
      if (cell.fill) tCell.fill = { ...cell.fill };
      if (cell.font) tCell.font = { ...cell.font };
    });
  });
  for (const merge of Object.keys(source._merges || {})) target.mergeCells(merge);
}

function clearRows(ws, startRow) {
  const maxCol = Math.max(40, ws.columnCount || 40);
  for (let r = startRow; r <= ws.rowCount; r++) {
    for (let c = 1; c <= maxCol; c++) {
      ws.getRow(r).getCell(c).value = null;
    }
  }
}

function replaceBrandingInCellValue(value, orgName) {
  const from = /Pristine Lifestyle Solutions(?: Pty Ltd)?/gi;
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(from, orgName);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value?.richText && Array.isArray(value.richText)) {
    return {
      ...value,
      richText: value.richText.map((part) => ({
        ...part,
        text: typeof part?.text === 'string' ? part.text.replace(from, orgName) : part?.text
      }))
    };
  }
  if (value?.text && typeof value.text === 'string') {
    return { ...value, text: value.text.replace(from, orgName) };
  }
  return value;
}

function replaceTemplateBranding(ws, orgName) {
  if (!orgName) return;
  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.value = replaceBrandingInCellValue(cell.value, orgName);
    });
  });
}

function writeRows(ws, startRow, rows) {
  let rowNum = startRow;
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) ws.getRow(rowNum).getCell(c + 1).value = row[c];
    rowNum += 1;
  }
}

function fmtDate(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(v);
  }
}

function buildTemplateDataBySheet(organizationId) {
  const byIdParticipant = new Map(
    db
      .prepare('SELECT id, name, phone, email, address, management_type FROM participants WHERE provider_org_id = ?')
      .all(organizationId)
      .map((p) => [p.id, p])
  );
  const byIdStaff = new Map(
    db.prepare('SELECT id, name, role, email FROM staff WHERE org_id = ?').all(organizationId).map((s) => [s.id, s])
  );

  const docRows = db
    .prepare(
      `SELECT entity_type, entity_id, category, filename, created_at
       FROM onedrive_document_register
       WHERE organization_id = ?
       ORDER BY datetime(created_at) DESC`
    )
    .all(organizationId)
    .map((r) => {
      const name =
        r.entity_type === 'participant'
          ? byIdParticipant.get(r.entity_id)?.name || 'Participant'
          : r.entity_type === 'staff'
            ? byIdStaff.get(r.entity_id)?.name || 'Staff'
            : 'General';
      const label = `${name} - ${r.category || 'Other'} - ${r.filename}`;
      return [label, label, label, 1, 'Nexus Core', 'Nexus Core', fmtDate(r.created_at), fmtDate(r.created_at), ''];
    });

  const incidentRows = db
    .prepare(
      `SELECT pn.id, pn.support_date, pn.start_time, pn.incidents, pn.session_details, pn.created_at,
              p.name AS participant_name, p.email AS participant_email, s.name AS staff_name
       FROM progress_notes pn
       JOIN participants p ON p.id = pn.participant_id
       LEFT JOIN staff s ON s.id = pn.staff_id
       WHERE p.provider_org_id = ?
         AND pn.incidents IS NOT NULL
         AND trim(pn.incidents) <> ''
       ORDER BY datetime(pn.created_at) DESC`
    )
    .all(organizationId)
    .map((r, i) => {
      const when = `${fmtDate(r.support_date)}${r.start_time ? ` ${r.start_time}` : ''}`.trim();
      const persons = `${r.participant_name || ''}${r.participant_email ? ` (${r.participant_email})` : ''}`;
      return [
        i + 1,
        i + 1,
        when,
        persons,
        'Y',
        r.staff_name || '',
        r.incidents || '',
        'N',
        r.session_details || '',
        'Logged from Nexus progress notes',
        '',
        '',
        '',
        '',
        '',
        fmtDate(r.created_at),
        r.staff_name || 'Nexus Core',
        '',
        '',
        ''
      ];
    });

  const trainingRows = db
    .prepare(
      `SELECT scd.document_type, scd.uploaded_at, scd.expiry_date, scd.status, s.name AS staff_name
       FROM staff_compliance_documents scd
       JOIN staff s ON s.id = scd.staff_id
       WHERE s.org_id = ?
       ORDER BY datetime(scd.uploaded_at) DESC`
    )
    .all(organizationId)
    .map((r) => [
      `${r.document_type} (${r.staff_name})`,
      `Compliance evidence for ${r.staff_name}`,
      'Internal',
      '',
      'Nexus Core',
      fmtDate(r.expiry_date),
      fmtDate(r.uploaded_at),
      '',
      r.status || '',
      fmtDate(r.expiry_date),
      '',
      '',
      ''
    ]);

  const hrRoleRows = Array.from(new Set(
    db
      .prepare("SELECT COALESCE(NULLIF(trim(role), ''), 'Staff') AS role_name FROM staff WHERE org_id = ?")
      .all(organizationId)
      .map((r) => r.role_name)
  )).map((role) => [
    role,
    role,
    role,
    role,
    'Direct support role',
    'Direct support role',
    'Direct support role',
    'Direct support role',
    'Direct support role',
    'Direct support role',
    'Direct support role',
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    fmtDate(new Date().toISOString()),
    fmtDate(new Date().toISOString()),
    'Nexus Core',
    'Nexus Core',
    'Nexus Core',
    'Nexus Core'
  ]);

  const sigRiskRows = db
    .prepare(
      `SELECT id, name, address, phone, email
       FROM participants
       WHERE provider_org_id = ?
       ORDER BY name`
    )
    .all(organizationId)
    .map((p) => [
      p.name || '',
      p.name || '',
      p.name || '',
      p.name || '',
      p.name || '',
      p.address || '',
      `${p.phone || ''} ${p.email || ''}`.trim(),
      `${p.phone || ''} ${p.email || ''}`.trim(),
      `${p.phone || ''} ${p.email || ''}`.trim(),
      `${p.phone || ''} ${p.email || ''}`.trim(),
      `${p.phone || ''} ${p.email || ''}`.trim(),
      'Refer participant profile and risk details in Nexus Core',
      'Refer participant profile and risk details in Nexus Core',
      '',
      '',
      '',
      '',
      '',
      'Managed in Nexus Core'
    ]);

  const policyRows = db
    .prepare(
      `SELECT cpf.display_name, cpf.created_at
       FROM company_policy_files cpf
       JOIN provider_profiles pp ON pp.id = cpf.provider_profile_id
       WHERE pp.organisation_id = ?
       ORDER BY datetime(cpf.created_at) DESC`
    )
    .all(organizationId)
    .map((r) => [
      r.display_name,
      r.display_name,
      r.display_name,
      1,
      'Nexus Core',
      'Nexus Core',
      fmtDate(r.created_at),
      ''
    ]);

  const complaintsRows = db
    .prepare(
      `SELECT cn.id, cn.contact_date, cn.contact_type, cn.notes, p.name, p.phone, p.email
       FROM case_notes cn
       JOIN participants p ON p.id = cn.participant_id
       WHERE p.provider_org_id = ?
         AND (lower(coalesce(cn.contact_type,'')) LIKE '%complaint%' OR lower(coalesce(cn.notes,'')) LIKE '%complaint%')
       ORDER BY datetime(cn.created_at) DESC`
    )
    .all(organizationId)
    .map((r, i) => [
      i + 1,
      i + 1,
      i + 1,
      fmtDate(r.contact_date),
      fmtDate(r.contact_date),
      r.contact_type || '',
      'Y',
      `${r.name || ''} ${r.phone || ''} ${r.email || ''}`.trim(),
      `${r.name || ''} ${r.phone || ''} ${r.email || ''}`.trim(),
      `${r.name || ''} ${r.phone || ''} ${r.email || ''}`.trim(),
      r.notes || '',
      r.notes || '',
      r.notes || '',
      '',
      fmtDate(r.contact_date),
      '',
      'Logged from Nexus case notes',
      'Y',
      '',
      'Nexus Core'
    ]);

  const feedbackRows = db
    .prepare(
      `SELECT cn.contact_date, cn.contact_type, cn.notes, p.name, p.phone, p.email
       FROM case_notes cn
       JOIN participants p ON p.id = cn.participant_id
       WHERE p.provider_org_id = ?
         AND (lower(coalesce(cn.contact_type,'')) LIKE '%feedback%' OR lower(coalesce(cn.contact_type,'')) LIKE '%compliment%' OR lower(coalesce(cn.notes,'')) LIKE '%feedback%' OR lower(coalesce(cn.notes,'')) LIKE '%compliment%')
       ORDER BY datetime(cn.created_at) DESC`
    )
    .all(organizationId)
    .map((r) => [
      fmtDate(r.contact_date),
      fmtDate(r.contact_date),
      r.contact_type || '',
      `${r.name || ''} ${r.phone || ''} ${r.email || ''}`.trim(),
      r.notes || '',
      r.notes || '',
      r.notes || '',
      '',
      '',
      fmtDate(r.contact_date),
      '',
      'Logged from Nexus case notes',
      '',
      'Nexus Core'
    ]);

  return {
    Complaints: complaintsRows,
    'Document Register': docRows,
    'Feedback and complaints': feedbackRows,
    'HR role register': hrRoleRows,
    'Significant risk factor': sigRiskRows,
    'Training and Development': trainingRows,
    'Policy register': policyRows,
    'Incident register': incidentRows
  };
}

export async function syncTemplateRegistersNow(organizationId, suppliedAccessToken = null) {
  if (!REGISTERS_TEMPLATE_PATH || !existsSync(REGISTERS_TEMPLATE_PATH)) return null;
  const accessToken = suppliedAccessToken || (await getValidAccessToken(organizationId));
  if (!accessToken) return null;

  const templateBuffer = await readFile(REGISTERS_TEMPLATE_PATH);
  const templateWb = new ExcelJS.Workbook();
  await templateWb.xlsx.load(templateBuffer);
  const org = db.prepare('SELECT name FROM organisations WHERE id = ?').get(organizationId);
  const orgName = (org?.name || 'Nexus Core organisation').trim();
  await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_REGISTER]);

  const sheetData = buildTemplateDataBySheet(organizationId);
  const dataStartBySheet = {
    Complaints: 4,
    'Document Register': 3,
    'Feedback and complaints': 4,
    'HR role register': 9,
    'Significant risk factor': 4,
    'Training and Development': 6,
    'Policy register': 3,
    'Conflict of interest register': 3,
    'Collection and storage of Med': 4,
    'Continuous improvment': 3,
    'Emergency test register': 3,
    'Incident register': 4,
    'Waste removal Register': 4
  };

  for (const src of templateWb.worksheets) {
    const outWb = new ExcelJS.Workbook();
    const outWs = outWb.addWorksheet(src.name);
    copyWorksheetTemplate(src, outWs);
    replaceTemplateBranding(outWs, orgName);
    const startRow = dataStartBySheet[src.name];
    const rows = sheetData[src.name] || [];
    if (startRow) {
      clearRows(outWs, startRow);
    }
    if (startRow && rows.length) {
      writeRows(outWs, startRow, rows);
    }
    const out = await outWb.xlsx.writeBuffer();
    const fileName = `${src.name}.xlsx`;
    await putFileByPath(
      accessToken,
      [ROOT_NAME, FOLDER_REGISTER],
      fileName,
      Buffer.isBuffer(out) ? out : Buffer.from(out),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  }
  return { ok: true, fileCount: templateWb.worksheets.length };
}

function insertRegisterRow({
  organizationId,
  entityType,
  entityId,
  category,
  filename,
  graphItemId,
  webUrl,
  mimeType,
  notes
}) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO onedrive_document_register (
      id, organization_id, entity_type, entity_id, category, filename,
      graph_item_id, web_url, mime_type, created_at, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    id,
    organizationId,
    entityType,
    entityId || null,
    category,
    filename,
    graphItemId || null,
    webUrl || null,
    mimeType || null,
    notes || null
  );
  scheduleRegisterWorkbookSync(organizationId);
  return id;
}

export function resolveOrgIdForParticipant(participantId) {
  if (!participantId) return null;
  const p = db.prepare('SELECT provider_org_id FROM participants WHERE id = ?').get(participantId);
  if (p?.provider_org_id) return p.provider_org_id;
  const single = db.prepare('SELECT id FROM organisations LIMIT 2').all();
  if (single.length === 1) return single[0].id;
  return null;
}

export function resolveOrgIdForStaff(staffId) {
  const linked = db.prepare('SELECT organization_id FROM organization_onedrive_link LIMIT 1').get();
  if (linked?.organization_id) {
    const multi = db.prepare('SELECT COUNT(*) as c FROM organization_onedrive_link').get();
    if (multi?.c === 1) return linked.organization_id;
  }
  const single = db.prepare('SELECT id FROM organisations LIMIT 2').all();
  if (single.length === 1) return single[0].id;
  const any = db.prepare('SELECT organization_id FROM organization_onedrive_link').get();
  return any?.organization_id || null;
}

export function resolveOrgIdForBillingParticipant(participantId) {
  return resolveOrgIdForParticipant(participantId);
}

export function billingInvoicePdfAlreadyInRegister(organizationId, billingInvoiceId) {
  if (!organizationId || !billingInvoiceId) return false;
  const marker = `billing_invoice:${billingInvoiceId}`;
  const r = db
    .prepare(
      `SELECT 1 FROM onedrive_document_register WHERE organization_id = ? AND notes = ? LIMIT 1`
    )
    .get(organizationId, marker);
  return !!r;
}

/**
 * Fire-and-forget safe push; logs errors only.
 */
export async function tryPushParticipantDocument({
  participantId,
  category,
  buffer,
  originalFilename,
  mimeType,
  notes
}) {
  try {
    const orgId = resolveOrgIdForParticipant(participantId);
    if (!orgId || !getOnedriveLinkRow(orgId)) return;
    const accessToken = await getValidAccessToken(orgId);
    if (!accessToken) return;

    const p = db.prepare('SELECT id, name FROM participants WHERE id = ?').get(participantId);
    if (!p) return;

    const leaf = participantCategoryFolder(category);
    const path = [ROOT_NAME, FOLDER_PARTICIPANTS, entityFolderName(p.name, p.id), leaf];
    await ensureFolderPath(accessToken, path);

    const out = await uploadByPath(accessToken, path, originalFilename || 'document', buffer, mimeType);
    insertRegisterRow({
      organizationId: orgId,
      entityType: 'participant',
      entityId: participantId,
      category: leaf,
      filename: out.filename,
      graphItemId: out.itemId,
      webUrl: out.webUrl,
      mimeType,
      notes: notes || category || null
    });
    return out;
  } catch (e) {
    console.warn('[orgOnedrive] participant push failed', e.message);
    return null;
  }
}

export async function tryPushStaffDocument({
  staffId,
  category,
  buffer,
  originalFilename,
  mimeType,
  notes
}) {
  try {
    const orgId = resolveOrgIdForStaff(staffId);
    if (!orgId || !getOnedriveLinkRow(orgId)) return;
    const accessToken = await getValidAccessToken(orgId);
    if (!accessToken) return;

    const s = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(staffId);
    if (!s) return;

    const leaf = staffCategoryFolder(category || notes);
    const path = [ROOT_NAME, FOLDER_STAFF, entityFolderName(s.name, s.id), leaf];
    await ensureFolderPath(accessToken, path);

    const out = await uploadByPath(accessToken, path, originalFilename || 'document', buffer, mimeType);
    insertRegisterRow({
      organizationId: orgId,
      entityType: 'staff',
      entityId: staffId,
      category: leaf,
      filename: out.filename,
      graphItemId: out.itemId,
      webUrl: out.webUrl,
      mimeType,
      notes: notes || category || null
    });
    return out;
  } catch (e) {
    console.warn('[orgOnedrive] staff push failed', e.message);
    return null;
  }
}

export async function tryPushParticipantBinaryCategory({
  participantId,
  registerCategory,
  folderSegment,
  buffer,
  originalFilename,
  mimeType,
  notes
}) {
  try {
    const orgId = resolveOrgIdForParticipant(participantId);
    if (!orgId || !getOnedriveLinkRow(orgId)) return;
    const accessToken = await getValidAccessToken(orgId);
    if (!accessToken) return;

    const p = db.prepare('SELECT id, name FROM participants WHERE id = ?').get(participantId);
    if (!p) return;

    const leaf = folderSegment || 'Other';
    const path = [ROOT_NAME, FOLDER_PARTICIPANTS, entityFolderName(p.name, p.id), leaf];
    await ensureFolderPath(accessToken, path);

    const out = await uploadByPath(accessToken, path, originalFilename || 'file', buffer, mimeType);
    insertRegisterRow({
      organizationId: orgId,
      entityType: 'participant',
      entityId: participantId,
      category: registerCategory || leaf,
      filename: out.filename,
      graphItemId: out.itemId,
      webUrl: out.webUrl,
      mimeType,
      notes: notes || null
    });
  } catch (e) {
    console.warn('[orgOnedrive] participant binary push failed', e.message);
  }
}

export function listRegister(organizationId, { entityType, entityId, limit = 200 } = {}) {
  let sql = `
    SELECT * FROM onedrive_document_register
    WHERE organization_id = ?
  `;
  const params = [organizationId];
  if (entityType) {
    sql += ' AND entity_type = ?';
    params.push(entityType);
  }
  if (entityId) {
    sql += ' AND entity_id = ?';
    params.push(entityId);
  }
  sql += ' ORDER BY datetime(created_at) DESC LIMIT ?';
  params.push(Math.min(500, Number(limit) || 200));
  return db.prepare(sql).all(...params);
}

/**
 * Pre-create the full folder tree in OneDrive so staff/participant folders exist
 * before any files are uploaded.
 */
export async function ensureFullOrgDirectoryTree(organizationId) {
  const accessToken = await getValidAccessToken(organizationId);
  if (!accessToken) {
    throw new Error('No valid OneDrive token for this organisation');
  }

  await ensureNexusCoreLayout(organizationId);

  const participantLeaves = ['Plans', 'Service agreements', 'Archived', 'Other'];
  const staffLeaves = ['Contracts', 'Certificates', 'Archived', 'Other'];

  const participants = db
    .prepare('SELECT id, name FROM participants WHERE provider_org_id = ? ORDER BY name')
    .all(organizationId);
  const staff = db
    .prepare('SELECT id, name FROM staff WHERE org_id = ? ORDER BY name')
    .all(organizationId);

  let participantFolderCount = 0;
  let staffFolderCount = 0;

  for (const p of participants) {
    const pFolder = entityFolderName(p.name, p.id);
    await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_PARTICIPANTS, pFolder]);
    participantFolderCount += 1;
    for (const leaf of participantLeaves) {
      await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_PARTICIPANTS, pFolder, leaf]);
      participantFolderCount += 1;
    }
  }

  for (const s of staff) {
    const sFolder = entityFolderName(s.name, s.id);
    await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_STAFF, sFolder]);
    staffFolderCount += 1;
    for (const leaf of staffLeaves) {
      await ensureFolderPath(accessToken, [ROOT_NAME, FOLDER_STAFF, sFolder, leaf]);
      staffFolderCount += 1;
    }
  }

  return {
    organizationId,
    participantsProcessed: participants.length,
    staffProcessed: staff.length,
    participantFoldersEnsured: participantFolderCount,
    staffFoldersEnsured: staffFolderCount
  };
}
