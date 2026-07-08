import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';

export function parseRateTypeFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return 'weekday';
  const d = desc.toLowerCase();
  if (d.includes('saturday') || d.includes('sat ')) return 'saturday';
  if (d.includes('sunday') || d.includes('sun ')) return 'sunday';
  if (d.includes('public holiday') || d.includes(' ph ') || d.includes('public hol')) return 'public_holiday';
  return 'weekday';
}

export function parseTimeBandFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return 'daytime';
  const d = desc.toLowerCase();
  if (d.includes('evening')) return 'evening';
  if (d.includes('night') || d.includes('night-time') || d.includes('nighttime')) return 'night';
  if (d.includes('daytime') || d.includes('day time')) return 'daytime';
  return 'daytime';
}

export function getSupportCategory(supportItem) {
  if (!supportItem || typeof supportItem !== 'string') return null;
  const parts = supportItem.trim().split('_');
  const prefix = parts[0] || supportItem.slice(0, 2);
  return /^\d{2}$/.test(prefix) ? prefix : null;
}

export function normalizeSupportItemNumber(val) {
  if (val == null || val === '') return '';
  const s = String(val).trim();
  if (s.includes('_')) return s;
  const n = parseFloat(s);
  if (isNaN(n) || n < 1 || n >= 2) return s;
  const digits = String(Math.round(n * 1e9)).padStart(11, '0').slice(0, 11);
  if (digits.length >= 11) {
    return `${digits.slice(0, 2)}_${digits.slice(2, 5)}_${digits.slice(5, 9)}_${digits[9]}_${digits[10]}`;
  }
  return s;
}

function decodeCsvBuffer(buffer) {
  let text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD')) {
    text = buffer.toString('latin1');
  }
  return text;
}

function detectCsvDelimiter(firstLine) {
  if (!firstLine) return ',';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ';' : ',';
}

function parseCSVLine(line, delimiter = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === delimiter && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}

export function csvBufferToRows(buffer) {
  const text = decodeCsvBuffer(buffer);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const delimiter = detectCsvDelimiter(lines[0]);
  return lines.map((line) => parseCSVLine(line, delimiter));
}

function cellToImportValue(cell) {
  if (cell == null) return '';
  if (typeof cell === 'object' && cell.text != null) return String(cell.text).trim();
  if (typeof cell === 'number') {
    if (Number.isInteger(cell) && cell >= 100000 && cell < 99999999999) return String(cell);
    return String(cell);
  }
  if (cell instanceof Date) return cell.toISOString().slice(0, 10).replace(/-/g, '');
  return String(cell).trim();
}

async function xlsxBufferToRows(buffer, preferredSheet = 'Current Support Items') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  let ws = preferredSheet ? wb.getWorksheet(preferredSheet) : null;
  if (!ws) {
    ws = wb.worksheets.find((sheet) => {
      const first = sheet.getRow(1);
      const joined = first.values
        .slice(1)
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      return joined.includes('support item number') || joined.includes('support item no');
    }) || wb.worksheets[0];
  }
  if (!ws) throw new Error('Workbook has no worksheets');

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      vals[colNumber - 1] = cellToImportValue(cell.value);
    });
    const trimmed = vals.map((v) => (v == null ? '' : String(v)));
    if (trimmed.some((v) => v !== '')) rows.push(trimmed);
  });
  return rows;
}

export async function fileBufferToCatalogueRows(buffer, filename = '') {
  const ext = String(filename).toLowerCase();
  if (ext.endsWith('.xlsx') || ext.endsWith('.xlsm')) {
    return xlsxBufferToRows(buffer);
  }
  if (ext.endsWith('.csv') || ext.endsWith('.txt') || !ext.includes('.')) {
    return csvBufferToRows(buffer);
  }
  throw new Error('Unsupported file type. Upload the official NDIS Support Catalogue as .xlsx or .csv.');
}

export function findCatalogueHeaderRowIndex(rows) {
  return rows.findIndex((row) => {
    const arr = Array.isArray(row) ? row : Object.values(row || {});
    const joined = arr.map((c) => String(c ?? '')).join(' ').toLowerCase();
    return joined.includes('support item number') || joined.includes('support item no') || joined.includes('support item');
  });
}

export function normalizeCatalogueRows(rows) {
  if (!rows?.length) return rows;
  const headerRowIdx = findCatalogueHeaderRowIndex(rows);
  if (headerRowIdx >= 0 && headerRowIdx > 0) {
    return rows.slice(headerRowIdx);
  }
  return rows;
}

export function parseRate(val) {
  if (val == null || val === '') return 0;
  const str = String(val).replace(/[\s$€£AUD]/gi, '').replace(/,(\d{3})/g, '$1').replace(',', '.');
  const n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

const UNIT_MAP = { H: 'hour', E: 'each', D: 'day', WK: 'week', YR: 'year' };

function mapUnit(ndisUnit) {
  const u = (ndisUnit || 'H').trim().toUpperCase();
  return UNIT_MAP[u] || 'hour';
}

function parseRegistrationGroup(supportItem) {
  if (!supportItem || typeof supportItem !== 'string') return null;
  const parts = supportItem.trim().split('_');
  return parts.length >= 3 ? parts[2] : null;
}

export function isOfficialNdisFormat(headers) {
  const h = headers.map((x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const hasSupportItem = h.some((x) => x.includes('support item number') || x.includes('support item no') || x.includes('support item'));
  const hasRateColumns = h.some((x) =>
    x === 'act' || x === 'nsw' || x === 'vic' || x === 'qld' || x === 'sa' || x === 'wa' || x === 'tas' || x === 'nt' ||
    x === 'national' || x.includes('remote') || x.includes('standard') || x.includes('metropolitan')
  );
  return hasSupportItem && hasRateColumns;
}

export function parseOfficialImportRows(rows) {
  const parsed = [];
  if (rows.length < 2) return { parsed };

  const headers = rows[0].map((h) => String(h || '').trim());
  const headersLower = headers.map((h) => h.toLowerCase());
  const getCol = (row, ...names) => {
    for (const n of names) {
      const idx = headers.findIndex((h) => h.toLowerCase().includes(n.toLowerCase()));
      if (idx >= 0 && row[idx] !== undefined) return row[idx];
    }
    return null;
  };
  let supportNumIdx = headers.findIndex((h) => h.toLowerCase().includes('support item number') || h.toLowerCase().includes('support item no'));
  if (supportNumIdx < 0) {
    supportNumIdx = headers.findIndex((h) => h.toLowerCase().includes('support item'));
  }
  const remoteIdx = headersLower.findIndex((h) => {
    const t = String(h || '').trim();
    return t.includes('remote') && !t.includes('very');
  });
  const veryRemoteIdx = headersLower.findIndex((h) => String(h || '').trim().includes('very remote'));
  const regGroupIdx = headers.findIndex((h) => h.toLowerCase().includes('registration group') && h.toLowerCase().includes('number'));

  if (supportNumIdx < 0) {
    throw new Error('Not a valid NDIS Support Catalogue format. Expected column: Support Item Number.');
  }

  const STANDARD_RATE_NAMES = ['national', 'act', 'nsw', 'vic', 'qld', 'sa', 'wa', 'tas', 'nt', 'standard', 'metropolitan', 'metro'];
  const standardRateIdx = headersLower.findIndex((h) => {
    const t = String(h || '').trim();
    if (t.includes('remote') || t.includes('very')) return false;
    return STANDARD_RATE_NAMES.some((r) => t === r || t.startsWith(`${r} `) || t.startsWith(`${r}\t`));
  });

  const looksLikePrice = (val, skipColIdx) => {
    const s = String(val || '').trim();
    if (!s) return false;
    if (s.includes('$')) return true;
    const num = s.replace(/[$,]/g, '');
    if (!/^\d+\.\d{2}$/.test(num) && !(num.includes('.') && parseFloat(num) > 1 && parseFloat(num) < 10000)) return false;
    const n = parseFloat(num);
    if (skipColIdx === regGroupIdx && n >= 100 && n < 2000) return false;
    return true;
  };

  const MIN_RATE_COL = 3;

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    let supportItem = cols[supportNumIdx];
    if (supportItem != null) supportItem = normalizeSupportItemNumber(supportItem);
    supportItem = String(supportItem || '').trim();
    if (!supportItem) continue;

    const quote = getCol(cols, 'quote');
    const isQuotable = String(quote).toLowerCase() === 'yes';

    const description = getCol(cols, 'support item name') || '';
    const ndisUnit = getCol(cols, 'unit');
    const unit = mapUnit(ndisUnit);
    const category = getCol(cols, 'support category name') || getCol(cols, 'registration group name') || null;
    const registrationGroup = String(getCol(cols, 'registration group number') || '').trim() || parseRegistrationGroup(supportItem);

    let rate = 0;
    if (standardRateIdx >= 0 && cols[standardRateIdx] && looksLikePrice(cols[standardRateIdx], standardRateIdx)) {
      rate = parseRate(cols[standardRateIdx]);
    }
    if (rate === 0) {
      for (let c = Math.max(MIN_RATE_COL, regGroupIdx + 1); c < Math.min(cols.length, remoteIdx >= 0 ? remoteIdx : cols.length); c++) {
        if (cols[c] && looksLikePrice(cols[c], c)) {
          rate = parseRate(cols[c]);
          break;
        }
      }
    }
    const rateRemote = remoteIdx >= 0 && cols[remoteIdx] && String(cols[remoteIdx]).trim() ? parseRate(cols[remoteIdx]) : null;
    const rateVeryRemote = veryRemoteIdx >= 0 && cols[veryRemoteIdx] && String(cols[veryRemoteIdx]).trim() ? parseRate(cols[veryRemoteIdx]) : null;

    if (isQuotable) {
      rate = 0;
    } else {
      if (rate === 0 && (!rateRemote || rateRemote === 0) && (!rateVeryRemote || rateVeryRemote === 0)) continue;
      if (rate === 0) rate = rateRemote || rateVeryRemote || 0;
    }

    const rateType = parseRateTypeFromDescription(description);
    const timeBand = parseTimeBandFromDescription(description);
    parsed.push({
      support_item_number: supportItem,
      description,
      rate,
      rate_remote: rateRemote,
      rate_very_remote: rateVeryRemote,
      rate_type: rateType,
      time_band: timeBand,
      unit,
      category,
      registration_group_number: registrationGroup,
    });
  }
  return { parsed };
}

export function parseGenericImportRows(rows) {
  if (rows.length < 2) return { parsed: [] };
  const headers = rows[0].map((h) => String(h || '').trim());
  const headersLower = headers.map((h) => h.toLowerCase());
  const supportIdx = headersLower.findIndex((h) => h.includes('support') || h.includes('item') || h === 'code');
  const descIdx = headersLower.findIndex((h) => h.includes('desc'));
  const rateIdx = headersLower.findIndex((h) => h.includes('rate') || h.includes('price') || h.includes('amount') || h.includes('max'));
  const unitIdx = headersLower.findIndex((h) => h === 'unit');
  const catIdx = headersLower.findIndex((h) => h.includes('cat'));
  const regGroupIdx = headersLower.findIndex((h) => h.includes('registration group') && h.includes('number'));

  const parsed = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    let supportItem = supportIdx >= 0 ? cols[supportIdx] : cols[0];
    supportItem = normalizeSupportItemNumber(supportItem);
    const description = descIdx >= 0 ? cols[descIdx] : cols[1] || '';
    const rate = parseRate(rateIdx >= 0 ? cols[rateIdx] : cols[2]);
    const unit = unitIdx >= 0 ? cols[unitIdx] : 'hour';
    const category = catIdx >= 0 ? cols[catIdx] : null;
    const registrationGroup = regGroupIdx >= 0 && cols[regGroupIdx] ? String(cols[regGroupIdx]).trim() : parseRegistrationGroup(supportItem);
    if (!supportItem) continue;

    parsed.push({
      support_item_number: String(supportItem).trim(),
      description: String(description || ''),
      rate,
      rate_remote: null,
      rate_very_remote: null,
      rate_type: parseRateTypeFromDescription(description),
      time_band: parseTimeBandFromDescription(description),
      unit: unit || 'hour',
      category,
      registration_group_number: registrationGroup,
    });
  }
  return { parsed };
}

/**
 * Upsert catalogue rows by support_item_number (preserves existing UUIDs for shift references).
 */
export function upsertCatalogueItems(db, parsedItems) {
  const findStmt = db.prepare('SELECT id FROM ndis_line_items WHERE support_item_number = ?');
  const insertStmt = db.prepare(`
    INSERT INTO ndis_line_items (id, support_item_number, support_category, description, rate, rate_remote, rate_very_remote, rate_type, time_band, unit, category, registration_group_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE ndis_line_items SET
      support_category = ?,
      description = ?,
      rate = ?,
      rate_remote = ?,
      rate_very_remote = ?,
      rate_type = ?,
      time_band = ?,
      unit = ?,
      category = ?,
      registration_group_number = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  let inserted = 0;
  let updated = 0;
  const importedIds = [];

  const tx = db.transaction((items) => {
    for (const item of items) {
      const supportCategory = getSupportCategory(item.support_item_number);
      const existing = findStmt.get(item.support_item_number);
      if (existing) {
        updateStmt.run(
          supportCategory,
          item.description,
          item.rate,
          item.rate_remote || null,
          item.rate_very_remote || null,
          item.rate_type || 'weekday',
          item.time_band || 'daytime',
          item.unit,
          item.category,
          item.registration_group_number || null,
          existing.id
        );
        updated += 1;
        importedIds.push(existing.id);
      } else {
        const id = randomUUID();
        insertStmt.run(
          id,
          item.support_item_number,
          supportCategory,
          item.description,
          item.rate,
          item.rate_remote || null,
          item.rate_very_remote || null,
          item.rate_type || 'weekday',
          item.time_band || 'daytime',
          item.unit,
          item.category,
          item.registration_group_number || null
        );
        inserted += 1;
        importedIds.push(id);
      }
    }
  });

  tx(parsedItems);
  return { inserted, updated, imported: inserted + updated, importedIds };
}

export async function importCatalogueFromBuffer(db, buffer, filename) {
  let rows = await fileBufferToCatalogueRows(buffer, filename);
  rows = normalizeCatalogueRows(rows);
  if (rows.length < 2) {
    throw new Error('File must have a header row and at least one data row.');
  }

  const headers = rows[0].map((h) => String(h || '').trim());
  let parsed;
  let format;
  if (isOfficialNdisFormat(headers)) {
    ({ parsed } = parseOfficialImportRows(rows));
    format = 'official';
  } else {
    ({ parsed } = parseGenericImportRows(rows));
    format = 'generic';
  }

  const result = upsertCatalogueItems(db, parsed);
  return {
    ...result,
    total: rows.length - 1,
    parsedCount: parsed.length,
    format,
  };
}
