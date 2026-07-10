/**
 * Import register rows from org OneDrive Register/*.xlsx files (or the master Registers.xlsx template).
 */

import ExcelJS from 'exceljs';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { db } from '../db/index.js';
import {
  ONEDRIVE_LINKED_REGISTER_SHEETS,
  REGISTER_SHEET_DATA_START,
  REGISTER_SHEET_COLUMN_MAP,
  ONEDRIVE_LINKED_REGISTER_UI_HEADERS
} from './registerSheetConfig.js';
import {
  getCachedAccessToken,
  getOnedriveLinkRow,
  getRefreshToken,
  updateOnedriveTokens
} from './orgOnedriveTokens.service.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const ROOT_NAME = 'Nexus Core';
const FOLDER_REGISTER = 'Register';
const REGISTERS_TEMPLATE_PATH =
  process.env.ONEDRIVE_REGISTERS_TEMPLATE_PATH?.trim() ||
  '/Users/pristinelifestylesolutions/Library/CloudStorage/OneDrive-PristineLifestyleSolutions/Pristine Lifestyle Solutions/Policies and procedures_/Registers/Registers.xlsx';

function encodeGraphPath(pathStr) {
  return pathStr
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function cellPlainText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value.richText) return value.richText.map((t) => t.text).join('');
  if (value.text) return String(value.text);
  if (value.result != null) return String(value.result);
  return '';
}

function cellStr(v) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return String(v).trim();
}

function normalizeImportedRows(rows, sheetKey) {
  const width = (ONEDRIVE_LINKED_REGISTER_UI_HEADERS[sheetKey] || []).length;
  return (rows || []).map((row) => {
    const out = [];
    for (let i = 0; i < width; i++) out.push(cellStr(row[i]));
    return out;
  });
}

function shouldSkipImportedRow(sheetKey, row) {
  const joined = row.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return true;
  const lower = joined.toLowerCase();
  if (lower.includes('disposer signature')) return true;
  if (lower.includes('approved by:')) return true;
  if (lower.includes('approval date:')) return true;
  if (lower.includes('next scheduled review')) return true;
  if (joined.startsWith('(') && joined.length > 100) return true;
  if (joined.includes('Pristine Lifestyle Solutions ABN')) return true;
  if (joined.includes('The Board of Pristine Lifestyle Solutions')) return true;
  const first = String(row[0] ?? '').trim();
  if (first === 'Date Added' || first === 'Date of Notification') return true;
  if (first === 'Date' && String(row[1] ?? '').trim() === 'Time') return true;
  return false;
}

function isValidDataRow(sheetKey, row) {
  if (shouldSkipImportedRow(sheetKey, row)) return false;
  const first = String(row[0] ?? '').trim();
  switch (sheetKey) {
    case 'Continuous improvment':
      return /^\d+$/.test(first) && String(row[3] ?? '').trim().length > 1;
    case 'Conflict of interest register':
      return Boolean(first || String(row[1] ?? '').trim());
    case 'Collection and storage of Med':
      return Boolean(first || String(row[4] ?? '').trim() || String(row[3] ?? '').trim());
    case 'Emergency test register':
      return /^\d+$/.test(first);
    case 'Waste removal Register':
      return Boolean(first || String(row[4] ?? '').trim() || String(row[7] ?? '').trim());
    default:
      return row.some(Boolean);
  }
}

function parseWorksheetRows(ws, sheetKey) {
  const startRow = REGISTER_SHEET_DATA_START[sheetKey];
  const colMap = REGISTER_SHEET_COLUMN_MAP[sheetKey];
  if (!ws || !startRow || !colMap?.length) return [];

  const rows = [];
  const scanTo = Math.max(ws.rowCount || 0, startRow + 120);
  for (let r = startRow; r <= scanTo; r += 1) {
    const row = colMap.map((col) => cellPlainText(ws.getRow(r).getCell(col).value).trim());
    if (!row.some(Boolean)) {
      if (rows.length) break;
      continue;
    }
    if (!isValidDataRow(sheetKey, row)) continue;
    rows.push(row);
  }
  return normalizeImportedRows(rows, sheetKey);
}

async function getValidAccessToken(organizationId) {
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
  if (!tokRes.ok || !tok.access_token) return null;
  updateOnedriveTokens(organizationId, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || undefined,
    expiresInSec: tok.expires_in
  });
  return tok.access_token;
}

async function downloadOrgRegisterWorkbook(organizationId, sheetKey) {
  const accessToken = await getValidAccessToken(organizationId);
  if (!accessToken) return null;
  const path = `${ROOT_NAME}/${FOLDER_REGISTER}/${sheetKey}.xlsx`;
  const url = `${GRAPH}/me/drive/root:/${encodeGraphPath(path)}:/content`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function loadTemplateWorkbookBuffer() {
  if (!REGISTERS_TEMPLATE_PATH || !existsSync(REGISTERS_TEMPLATE_PATH)) return null;
  return readFile(REGISTERS_TEMPLATE_PATH);
}

async function parseRowsFromBuffer(buffer, sheetKey, worksheetName = sheetKey) {
  if (!buffer) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(worksheetName) || wb.worksheets[0];
  return parseWorksheetRows(ws, sheetKey);
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function readCachedRows(organizationId, sheetKey) {
  if (!tableExists('register_onedrive_sheet_cache')) return null;
  const row = db
    .prepare('SELECT rows_json FROM register_onedrive_sheet_cache WHERE org_id = ? AND sheet_key = ?')
    .get(organizationId, sheetKey);
  if (!row?.rows_json) return null;
  try {
    const parsed = JSON.parse(row.rows_json);
    return Array.isArray(parsed) ? parsed.map((r) => r.map(cellStr)) : null;
  } catch {
    return null;
  }
}

function writeCachedRows(organizationId, sheetKey, rows) {
  if (!tableExists('register_onedrive_sheet_cache')) return;
  db.prepare(
    `INSERT INTO register_onedrive_sheet_cache (org_id, sheet_key, rows_json, imported_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, sheet_key)
     DO UPDATE SET rows_json = excluded.rows_json, imported_at = datetime('now')`
  ).run(organizationId, sheetKey, JSON.stringify(rows || []));
}

export async function importOnedriveRegisterSheet(organizationId, sheetKey) {
  if (!ONEDRIVE_LINKED_REGISTER_SHEETS.has(sheetKey)) return [];

  let rows = [];
  const orgBuffer = await downloadOrgRegisterWorkbook(organizationId, sheetKey);
  if (orgBuffer) {
    rows = (await parseRowsFromBuffer(orgBuffer, sheetKey)).filter((row) => isValidDataRow(sheetKey, row));
  }
  if (!rows.length) {
    const templateBuffer = await loadTemplateWorkbookBuffer();
    if (templateBuffer) {
      rows = (await parseRowsFromBuffer(templateBuffer, sheetKey, sheetKey)).filter((row) =>
        isValidDataRow(sheetKey, row)
      );
    }
  }
  writeCachedRows(organizationId, sheetKey, rows);
  return rows;
}

export async function importAllOnedriveLinkedRegisters(organizationId) {
  const out = {};
  for (const sheetKey of ONEDRIVE_LINKED_REGISTER_SHEETS) {
    out[sheetKey] = await importOnedriveRegisterSheet(organizationId, sheetKey);
  }
  return out;
}

export function getOnedriveLinkedRegisterRows(organizationId, sheetKey) {
  if (!ONEDRIVE_LINKED_REGISTER_SHEETS.has(sheetKey)) return [];
  return readCachedRows(organizationId, sheetKey) || [];
}

export async function ensureOnedriveLinkedRegistersImported(organizationId) {
  if (!tableExists('register_onedrive_sheet_cache')) return;
  const missing = [];
  for (const sheetKey of ONEDRIVE_LINKED_REGISTER_SHEETS) {
    if (readCachedRows(organizationId, sheetKey) == null) missing.push(sheetKey);
  }
  if (!missing.length) return;
  for (const sheetKey of missing) {
    await importOnedriveRegisterSheet(organizationId, sheetKey);
  }
}

export async function refreshOnedriveLinkedRegisters(organizationId) {
  for (const sheetKey of ONEDRIVE_LINKED_REGISTER_SHEETS) {
    await importOnedriveRegisterSheet(organizationId, sheetKey);
  }
}
