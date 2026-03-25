import { db } from '../src/db/index.js';
import ExcelJS from 'exceljs';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const tenant = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;
const adminUserId = process.env.ONEDRIVE_ADMIN_USER_ID;

if (!tenant || !clientId || !clientSecret || !adminUserId) {
  throw new Error('Missing required env vars: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, ONEDRIVE_ADMIN_USER_ID');
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const REGISTERS_TEMPLATE_PATH =
  process.env.ONEDRIVE_REGISTERS_TEMPLATE_PATH?.trim() ||
  '/Users/pristinelifestylesolutions/Library/CloudStorage/OneDrive-PristineLifestyleSolutions/Pristine Lifestyle Solutions/Policies and procedures_/Registers/Registers.xlsx';

function encodePath(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

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

async function getAccessToken() {
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default'
    })
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.access_token) {
    throw new Error(`Failed to get Graph token: ${tok?.error_description || tok?.error || tokenRes.status}`);
  }
  return tok.access_token;
}

async function graphJson(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
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

async function ensureFolderPath(token, pathSegments) {
  const built = [];
  for (const seg of pathSegments) {
    built.push(seg);
    const pathStr = built.join('/');
    const itemUrl = `${GRAPH}/users/${encodeURIComponent(adminUserId)}/drive/root:/${encodePath(pathStr)}`;
    try {
      const item = await graphJson(token, itemUrl);
      if (item.folder) continue;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const parentBuilt = built.slice(0, -1);
    const parentEnc = parentBuilt.length ? encodePath(parentBuilt.join('/')) : null;
    const createUrl = parentEnc
      ? `${GRAPH}/users/${encodeURIComponent(adminUserId)}/drive/root:/${parentEnc}:/children`
      : `${GRAPH}/users/${encodeURIComponent(adminUserId)}/drive/root/children`;
    await graphJson(token, createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: seg,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename'
      })
    });
  }
}

async function putFileByPath(token, pathSegments, filename, buffer, contentType) {
  const folderPath = pathSegments.join('/');
  const url = `${GRAPH}/users/${encodeURIComponent(adminUserId)}/drive/root:/${encodePath(folderPath)}/${encodeURIComponent(filename)}:/content`;
  await graphJson(token, url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: buffer
  });
}

async function buildRegisterWorkbookBuffer() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexus Core';
  wb.created = new Date();

  const rows = db
    .prepare(
      `SELECT entity_type, entity_id, category, filename, graph_item_id, web_url, mime_type, created_at, notes
       FROM onedrive_document_register
       ORDER BY datetime(created_at) DESC`
    )
    .all();
  const participantNames = new Map(
    db.prepare('SELECT id, name FROM participants').all().map((r) => [r.id, r.name])
  );
  const staffNames = new Map(
    db.prepare('SELECT id, name FROM staff').all().map((r) => [r.id, r.name])
  );
  const normalized = rows.map((r) => ({
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

  const ws = wb.addWorksheet('All Documents');
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
  ws.addRows(normalized);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = 'A1:J1';

  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
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

async function main() {
  const token = await getAccessToken();

  const participantLeaves = ['Plans', 'Service agreements', 'Archived', 'Other'];
  const staffLeaves = ['Contracts', 'Certificates', 'Archived', 'Other'];

  await ensureFolderPath(token, ['Nexus Core']);
  await ensureFolderPath(token, ['Nexus Core', 'Staff']);
  await ensureFolderPath(token, ['Nexus Core', 'Participants']);
  await ensureFolderPath(token, ['Nexus Core', 'Register']);
  const registerWorkbook = await buildRegisterWorkbookBuffer();
  await putFileByPath(
    token,
    ['Nexus Core', 'Register'],
    'Document Register.xlsx',
    registerWorkbook,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  let separateRegistersCreated = 0;
  if (REGISTERS_TEMPLATE_PATH && existsSync(REGISTERS_TEMPLATE_PATH)) {
    const templateBuffer = await readFile(REGISTERS_TEMPLATE_PATH);
    const templateWb = new ExcelJS.Workbook();
    await templateWb.xlsx.load(templateBuffer);
    for (const src of templateWb.worksheets) {
      const outWb = new ExcelJS.Workbook();
      const outWs = outWb.addWorksheet(src.name);
      copyWorksheetTemplate(src, outWs);
      const out = await outWb.xlsx.writeBuffer();
      await putFileByPath(
        token,
        ['Nexus Core', 'Register'],
        `${src.name}.xlsx`,
        Buffer.isBuffer(out) ? out : Buffer.from(out),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      separateRegistersCreated += 1;
    }
  }

  const participants = db.prepare('SELECT id, name FROM participants ORDER BY name').all();
  const staff = db.prepare('SELECT id, name FROM staff ORDER BY name').all();

  let participantFoldersEnsured = 0;
  let staffFoldersEnsured = 0;

  for (const p of participants) {
    const folder = entityFolderName(p.name, p.id);
    await ensureFolderPath(token, ['Nexus Core', 'Participants', folder]);
    participantFoldersEnsured += 1;
    for (const leaf of participantLeaves) {
      await ensureFolderPath(token, ['Nexus Core', 'Participants', folder, leaf]);
      participantFoldersEnsured += 1;
    }
  }

  for (const s of staff) {
    const folder = entityFolderName(s.name, s.id);
    await ensureFolderPath(token, ['Nexus Core', 'Staff', folder]);
    staffFoldersEnsured += 1;
    for (const leaf of staffLeaves) {
      await ensureFolderPath(token, ['Nexus Core', 'Staff', folder, leaf]);
      staffFoldersEnsured += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        root: 'Nexus Core',
        participants: participants.length,
        staff: staff.length,
        participantFoldersEnsured,
        staffFoldersEnsured,
        separateRegistersCreated
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('[bootstrapOnedriveTree] failed:', e.message);
  process.exit(1);
});
