/**
 * Excel Pull Service - fetches shifts from the OneDrive Excel file created by
 * the Progress Notes App (Shifter). Used when CRM pulls from Excel instead of
 * receiving webhook pushes.
 */
import ExcelJS from 'exceljs';
import { resolveShiftExcelColumns } from './excelShiftParse.service.js';
import { getValidAccessToken } from './orgOnedriveSync.service.js';
import { resolveOnedriveExcelPathFromShifterForNexusOrg } from './supabaseStaffShifter.service.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

function getRequiredEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}. Configure OneDrive Excel pull in .env`);
  }
  return value;
}

const encodeDrivePath = (path) =>
  path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');

function buildItemByPathUrl(adminUserId, path) {
  return `${GRAPH_BASE_URL}/users/${encodeURIComponent(adminUserId)}/drive/root:/${encodeDrivePath(path)}`;
}

function buildContentUrl(adminUserId, itemId) {
  return `${GRAPH_BASE_URL}/users/${encodeURIComponent(adminUserId)}/drive/items/${itemId}/content`;
}

function buildMeItemByPathUrl(path) {
  return `${GRAPH_BASE_URL}/me/drive/root:/${encodeDrivePath(path)}`;
}

function buildMeContentUrl(itemId) {
  return `${GRAPH_BASE_URL}/me/drive/items/${itemId}/content`;
}

function defaultExcelPath() {
  return process.env.ONEDRIVE_EXCEL_PATH?.trim() || 'Progress Notes App/master progress notes.xlsx';
}

async function resolvedExcelPathForOrg(nexusOrgId, log) {
  const fallback = defaultExcelPath();
  if (!nexusOrgId) return fallback;
  try {
    const fromShifter = await resolveOnedriveExcelPathFromShifterForNexusOrg(String(nexusOrgId).trim());
    if (fromShifter) {
      log('Using OneDrive Excel path from Shifter admin profile', { path: fromShifter });
      return fromShifter;
    }
  } catch (e) {
    log('Shifter Excel path lookup skipped or failed', { message: e?.message || String(e) });
  }
  return fallback;
}

function hasLegacyAppOnlyCredentials() {
  const adminUserId = process.env.ONEDRIVE_ADMIN_USER_ID?.trim() || process.env.ADMIN_USER_ID?.trim();
  return Boolean(
    adminUserId &&
      process.env.AZURE_TENANT_ID?.trim() &&
      process.env.AZURE_CLIENT_ID?.trim() &&
      process.env.AZURE_CLIENT_SECRET?.trim(),
  );
}

/**
 * @param {{ organizationId?: string | null, log?: function }} options
 * @returns {Promise<Buffer>}
 */
async function fetchExcelBufferCore(options = {}) {
  const log = options.log || (() => {});
  const excelPath = await resolvedExcelPathForOrg(options.organizationId || null, log);

  if (options.organizationId) {
    const delegatedToken = await getValidAccessToken(options.organizationId);
    if (delegatedToken) {
      log('Fetching Excel via organisation OneDrive (delegated)', { path: excelPath });
      try {
        const itemUrl = buildMeItemByPathUrl(excelPath);
        const item = await graphJson('GET', itemUrl, delegatedToken);
        if (!item?.id) throw new Error('Item not found');
        const contentUrl = buildMeContentUrl(item.id);
        return await graphBuffer('GET', contentUrl, delegatedToken);
      } catch (e) {
        const msg = e?.message || String(e);
        throw new Error(
          `Could not read the Progress Notes Excel file from the connected OneDrive account (${msg}). Expected path: "${excelPath}". Set path on an Org Admin profile in Shifter (progress_notes_onedrive_path or folder + filename), or ONEDRIVE_EXCEL_PATH on the server.`,
        );
      }
    }
    log('Organisation has no OneDrive token; trying application credentials if configured');
  }

  if (!hasLegacyAppOnlyCredentials()) {
    if (options.organizationId) {
      throw new Error(
        'Connect Microsoft OneDrive in Settings for your organisation (same account as the Progress Notes Excel file), or set on the API server: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, ONEDRIVE_ADMIN_USER_ID (Microsoft 365 sign-in email / UPN of the file owner), and optionally ONEDRIVE_EXCEL_PATH. With SHIFTER_SUPABASE_URL set, the Excel path can come from Shifter profiles (Org Admin: progress_notes_onedrive_path or progress_notes_folder + progress_notes_filename). See repo root .env.example and supabase/shifter-migrations.',
      );
    }
    throw new Error(
      'ONEDRIVE_ADMIN_USER_ID (or ADMIN_USER_ID) is required: set the OneDrive owner’s Microsoft 365 sign-in email (UPN) in .env. Also required: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET. Optional: ONEDRIVE_EXCEL_PATH (default Progress Notes App/master progress notes.xlsx), or configure path on Shifter Org Admin profiles when SHIFTER_* env is set. See .env.example.',
    );
  }

  const adminUserId = process.env.ONEDRIVE_ADMIN_USER_ID?.trim() || process.env.ADMIN_USER_ID?.trim();
  log('Fetching Excel from OneDrive (application access)', { path: excelPath });
  const accessToken = await getAccessToken();
  const item = await graphJson('GET', buildItemByPathUrl(adminUserId, excelPath), accessToken);
  if (!item) {
    throw new Error(`Excel file not found at: ${excelPath}`);
  }
  const contentUrl = buildContentUrl(adminUserId, item.id);
  return graphBuffer('GET', contentUrl, accessToken);
}

async function getAccessToken() {
  const tenantId = getRequiredEnv('AZURE_TENANT_ID');
  const clientId = getRequiredEnv('AZURE_CLIENT_ID');
  const clientSecret = getRequiredEnv('AZURE_CLIENT_SECRET');
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
  if (!data.access_token) {
    throw new Error('Token request did not return an access token');
  }
  return data.access_token;
}

async function graphJson(method, url, accessToken) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph request failed: ${response.status} ${text}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function graphBuffer(method, url, accessToken) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph request failed: ${response.status} ${text}`);
  }
  const buf = await response.arrayBuffer();
  return Buffer.from(buf);
}

const normalizeHeader = (v) => String(v || '').trim().toLowerCase();

function normalizeDateForApp(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  let str = String(value).trim();
  if (str.startsWith("'")) str = str.slice(1);
  if (!str) return '';
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) {
    const excelEpoch = new Date(1899, 11, 30);
    const d = new Date(excelEpoch.getTime() + n * 86400000);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (str.includes('/')) {
    const parts = str.split('/');
    if (parts.length === 3) {
      const yyyy = String(parts[2]).trim();
      const mm = String(parts[1]).trim().padStart(2, '0');
      const dd = String(parts[0]).trim().padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
  }
  return str;
}

function normalizeTimeForApp(value) {
  if (value === null || value === undefined) return '';
  let str = String(value).trim();
  if (str.startsWith("'")) str = str.slice(1);
  if (!str) return '';
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0 && n < 1) {
    const totalMinutes = Math.round(n * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  if (Number.isFinite(n) && n >= 1) {
    const fraction = n % 1;
    const totalMinutes = Math.round(fraction * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  const timeMatch = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    if (Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  return str;
}

const BASE_HEADER_SET = new Set([
  'shift date', 'date', 'staff name', 'client name', 'start time', 'finish time',
  'duration', 'travel (km)', 'travel time (min)', 'expenses', 'incidents',
  'mood', 'session details', 'fortnight total hours', 'fortnight total kms',
  'total expenses', 'shift id',
]);

/** Same as Summary sheet: match columns case-insensitively (Excel often has Travel (KM), etc.). */
function buildHeaderNormToIndex(headers) {
  const map = new Map();
  headers.forEach((h, i) => {
    if (!h) return;
    const norm = normalizeHeader(h);
    if (!map.has(norm)) map.set(norm, i + 1);
  });
  return map;
}

function readCellAtCol(row, colIdx) {
  if (!colIdx) return '';
  const cell = row.getCell(colIdx);
  if (cell?.text) return String(cell.text).trim();
  if (cell?.value == null) return '';
  return String(cell.value).trim();
}

/**
 * @param {Buffer} buffer
 * @param {{ log?: function, useLlm?: boolean }} [options] - useLlm defaults true; set false to skip Ollama.
 */
async function parseWorkbookRows(buffer, options = {}) {
  const log = options.log || (() => {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Shifts') || workbook.worksheets[0];
  if (!sheet) return { rows: [], llmUsed: false };

  const headerRow = sheet.getRow(1);
  const headers = (headerRow.values || []).slice(1).map((v) => String(v || '').trim());
  const headerIndex = new Map();
  headers.forEach((h, i) => { if (h) headerIndex.set(h, i + 1); });
  const headerNormToIndex = buildHeaderNormToIndex(headers);

  const sampleRows = [];
  for (let ri = 2; ri <= (sheet.rowCount || 1) && sampleRows.length < 4; ri++) {
    const sampleRow = sheet.getRow(ri);
    const hasValues = (sampleRow.values || []).some(
      (v) => v !== null && v !== undefined && v !== ''
    );
    if (!hasValues) continue;
    sampleRows.push(
      headers.map((_, colIdx) => readCellAtCol(sampleRow, colIdx + 1))
    );
  }

  const { fieldToCol, llmUsed } = await resolveShiftExcelColumns(headers, sampleRows, {
    log,
    useLlm: options.useLlm !== false,
  });
  if (llmUsed) log('Excel Shifts sheet: Ollama assisted column mapping');

  const readField = (row, field) => readCellAtCol(row, fieldToCol[field]);

  const usedCols = new Set(Object.values(fieldToCol).filter(Boolean));
  const medicationColumns = headers.filter((h, i) => h && !usedCols.has(i + 1));

  const getCellText = (row, name) => {
    const idx = headerIndex.get(name) || headerNormToIndex.get(normalizeHeader(name));
    return readCellAtCol(row, idx);
  };

  const rows = [];
  for (let i = 2; i <= (sheet.rowCount || 1); i++) {
    const row = sheet.getRow(i);
    const hasValues = (row.values || []).some(
      (v) => v !== null && v !== undefined && v !== ''
    );
    if (!hasValues) continue;

    const medicationChecks = {};
    medicationColumns.forEach((col) => {
      const colIdx = headers.indexOf(col) + 1;
      const val = readCellAtCol(row, colIdx);
      if (val) medicationChecks[col] = val;
    });

    const dateRaw =
      readField(row, 'shift_date') ||
      getCellText(row, 'Shift Date') ||
      getCellText(row, 'Date');
    const travelKmRaw =
      readField(row, 'travel_km') ||
      getCellText(row, 'Travel (km)');

    rows.push({
      date: normalizeDateForApp(dateRaw),
      staffName: readField(row, 'staff_name') || getCellText(row, 'Staff Name'),
      clientName: readField(row, 'client_name') || getCellText(row, 'Client Name'),
      startTime: normalizeTimeForApp(readField(row, 'start_time') || getCellText(row, 'Start Time')),
      finishTime: normalizeTimeForApp(readField(row, 'finish_time') || getCellText(row, 'Finish Time')),
      travelKm: travelKmRaw,
      travelTimeMinutes:
        readField(row, 'travel_time_min') || getCellText(row, 'Travel Time (min)') || 0,
      expenses: readField(row, 'expenses') || getCellText(row, 'Expenses'),
      incidents: readField(row, 'incidents') || getCellText(row, 'Incidents'),
      mood: readField(row, 'mood') || getCellText(row, 'Mood'),
      sessionDetails: readField(row, 'session_details') || getCellText(row, 'Session Details'),
      shiftId: readField(row, 'shift_id') || getCellText(row, 'Shift ID'),
      medicationChecks,
    });
  }
  return { rows, llmUsed };
}

/**
 * Collapse duplicate Shifts-sheet rows so sync and Shifter-style totals stay correct.
 * 1) Same Shift ID → keep last row (newest edit).
 * 2) Same staff + client + date + start + finish (different IDs) → keep last (true duplicate visit).
 */
function normalizeNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function slotKeyFromRow(row) {
  return `${normalizeNameKey(row.staffName)}|${normalizeNameKey(row.clientName)}|${String(row.date || '').trim()}|${String(row.startTime || '').trim()}|${String(row.finishTime || '').trim()}`;
}

export function dedupeExcelShiftRows(rows) {
  if (!rows?.length) return [];
  const byShiftId = new Map();
  for (const r of rows) {
    const id = String(r.shiftId || '').trim();
    if (!id) continue;
    byShiftId.set(id, r);
  }
  const bySlot = new Map();
  for (const r of rows) {
    const id = String(r.shiftId || '').trim();
    if (!id || !r.date) continue;
    if (byShiftId.get(id) !== r) continue;
    bySlot.set(slotKeyFromRow(r), r);
  }
  return Array.from(bySlot.values());
}

function parseExcelNumericField(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim().replace(/,/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : s;
}

function rowToWebhookShift(row) {
  const startTime = row.startTime || '09:00';
  const finishTime = row.finishTime || '17:00';
  const startMins = startTime.match(/(\d+):(\d+)/);
  const endMins = finishTime.match(/(\d+):(\d+)/);
  let duration = null;
  if (startMins && endMins) {
    const sm = parseInt(startMins[1], 10) * 60 + parseInt(startMins[2], 10);
    const em = parseInt(endMins[1], 10) * 60 + parseInt(endMins[2], 10);
    duration = Math.max(0, (em - sm) / 60);
  }

  return {
    shiftId: row.shiftId || null,
    date: row.date,
    staffName: row.staffName || '',
    clientName: row.clientName || '',
    startTime,
    finishTime,
    duration,
    travelKm: parseExcelNumericField(row.travelKm),
    travelTimeMinutes: row.travelTimeMinutes ? parseInt(row.travelTimeMinutes, 10) : null,
    expenses: row.expenses ? parseFloat(row.expenses) : 0,
    incidents: row.incidents || null,
    mood: row.mood || null,
    sessionDetails: row.sessionDetails || null,
    medicationChecks: row.medicationChecks || {},
  };
}

/**
 * Pull shifts from the OneDrive Excel file.
 * Uses per-organisation delegated OneDrive (Settings → Microsoft) when options.organizationId is set and linked;
 * otherwise falls back to application credentials: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
 * ONEDRIVE_ADMIN_USER_ID, optional ONEDRIVE_EXCEL_PATH.
 * When organizationId is set and Shifter is configured, the path under OneDrive is read from Shifter Org Admin profiles first.
 * @param {object} [options] - { log, useLlm, organizationId } useLlm defaults true (Ollama refines columns when needed).
 * @returns {{ shifts: Array, llmUsed?: boolean, error?: string }}
 */
export async function pullShiftsFromExcel(options = {}) {
  const log = options.log || (() => {});
  const useLlm = options.useLlm !== false;

  const buffer = await fetchExcelBufferCore({
    organizationId: options.organizationId || null,
    log,
  });

  const { rows, llmUsed } = await parseWorkbookRows(buffer, { log, useLlm });

  const filtered = rows.filter((r) => r.shiftId && r.date);
  const deduped = dedupeExcelShiftRows(filtered);
  if (deduped.length < filtered.length) {
    log('Removed duplicate Shifts rows before import', {
      before: filtered.length,
      after: deduped.length,
    });
  }
  const shifts = deduped.map(rowToWebhookShift);

  log('Excel pull complete', { totalRows: rows.length, shiftsWithId: shifts.length, llmUsed: !!llmUsed });

  return { shifts, llmUsed: !!llmUsed };
}

async function getExcelBuffer(options = {}) {
  return fetchExcelBufferCore({
    organizationId: options.organizationId || null,
    log: options.log || (() => {}),
  });
}

function parseNumber(val) {
  if (val == null || val === '') return 0;
  const n = parseFloat(String(val).replace(/[,$]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function parseSummarySheet(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Summary');
  if (!sheet) return [];
  const headerRow = sheet.getRow(1);
  const headers = (headerRow.values || []).slice(1).map((v) => String(v || '').trim());
  const colIdx = (name) => {
    const i = headers.findIndex((h) => normalizeHeader(h) === normalizeHeader(name));
    return i >= 0 ? i + 1 : 0;
  };
  const rows = [];
  for (let i = 2; i <= (sheet.rowCount || 1); i++) {
    const row = sheet.getRow(i);
    const staffName = (row.getCell(colIdx('Staff Name'))?.value ?? '').toString().trim();
    if (!staffName) continue;
    const rawStart = row.getCell(colIdx('Pay Period Start'))?.value;
    const rawEnd = row.getCell(colIdx('Pay Period End'))?.value;
    rows.push({
      periodStart: normalizeDateForApp(rawStart) || (rawStart != null ? String(rawStart).trim() : ''),
      periodEnd: normalizeDateForApp(rawEnd) || (rawEnd != null ? String(rawEnd).trim() : ''),
      staffName,
      totalHours: parseNumber(row.getCell(colIdx('Total Hours'))?.value),
      totalKm: parseNumber(row.getCell(colIdx('Total Kms'))?.value),
      totalExpenses: parseNumber(row.getCell(colIdx('Total Expenses'))?.value),
      travelHours: parseNumber(row.getCell(colIdx('Travel Time'))?.value),
      weekdayHours: parseNumber(row.getCell(colIdx('Weekday Hours'))?.value),
      saturdayHours: parseNumber(row.getCell(colIdx('Saturday Hours'))?.value),
      sundayHours: parseNumber(row.getCell(colIdx('Sunday Hours'))?.value),
      holidayHours: parseNumber(row.getCell(colIdx('Public Holiday Hours'))?.value),
      eveningHours: parseNumber(row.getCell(colIdx('Evening Hours'))?.value),
    });
  }
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const key = `${normalizeNameKey(r.staffName)}|${String(r.periodStart || '').trim()}|${String(r.periodEnd || '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
}

/**
 * Pull Summary sheet from OneDrive Excel (staff hours by pay period).
 * Matches staff by name (case-insensitive).
 * @param {object} [options] - { log, staffName }
 * @returns {{ summaryRows: Array }}
 */
export async function pullSummaryFromExcel(options = {}) {
  const log = options.log || (() => {});
  log('Fetching Excel Summary from OneDrive');
  const buffer = await getExcelBuffer({
    organizationId: options.organizationId || null,
    log,
  });
  const rows = await parseSummarySheet(buffer);
  const staffName = (options.staffName || '').trim();
  const filtered = staffName
    ? rows.filter((r) => r.staffName && r.staffName.toLowerCase() === staffName.toLowerCase())
    : rows;
  log('Summary pull complete', { totalRows: rows.length, forStaff: filtered.length });
  return { summaryRows: filtered };
}
