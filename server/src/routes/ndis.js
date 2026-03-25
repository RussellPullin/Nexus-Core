import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { db } from '../db/index.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { recordMapping } from '../services/csvMappingLearner.service.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Parse rate_type from description (saturday, sunday, public_holiday, weekday)
function parseRateTypeFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return 'weekday';
  const d = desc.toLowerCase();
  if (d.includes('saturday') || d.includes('sat ')) return 'saturday';
  if (d.includes('sunday') || d.includes('sun ')) return 'sunday';
  if (d.includes('public holiday') || d.includes(' ph ') || d.includes('public hol')) return 'public_holiday';
  return 'weekday';
}

// Parse time_band from description (daytime, evening, night)
function parseTimeBandFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return 'daytime';
  const d = desc.toLowerCase();
  if (d.includes('evening')) return 'evening';
  if (d.includes('night') || d.includes('night-time') || d.includes('nighttime')) return 'night';
  if (d.includes('daytime') || d.includes('day time')) return 'daytime';
  return 'daytime';
}

// Extract support category (01-15) from support_item_number
function getSupportCategory(supportItem) {
  if (!supportItem || typeof supportItem !== 'string') return null;
  const parts = supportItem.trim().split('_');
  const prefix = parts[0] || supportItem.slice(0, 2);
  return /^\d{2}$/.test(prefix) ? prefix : null;
}

router.get('/', (req, res) => {
  try {
    const { category, support_category, support_categories, line_item_ids, search } = req.query;
    let items = db.prepare('SELECT * FROM ndis_line_items ORDER BY support_item_number').all();
    if (line_item_ids) {
      const ids = String(line_item_ids).split(',').map(x => x.trim()).filter(Boolean);
      if (ids.length > 0) {
        items = items.filter(i => ids.includes(i.id));
      }
    }
    if (support_category) {
      items = items.filter(i => (i.support_category || getSupportCategory(i.support_item_number)) === support_category);
    }
    if (support_categories) {
      const cats = String(support_categories).split(',').map(c => c.trim()).filter(Boolean);
      if (cats.length > 0) {
        items = items.filter(i => {
          const sc = i.support_category || getSupportCategory(i.support_item_number);
          return sc && cats.includes(sc);
        });
      }
    }
    if (category) {
      items = items.filter(i => i.category === category);
    }
    if (search) {
      const s = search.toLowerCase();
      items = items.filter(i =>
        (i.support_item_number && i.support_item_number.toLowerCase().includes(s)) ||
        (i.description && i.description.toLowerCase().includes(s))
      );
    }
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/categories', (req, res) => {
  const cats = db.prepare('SELECT DISTINCT category FROM ndis_line_items WHERE category IS NOT NULL ORDER BY category').all();
  res.json(cats.map(c => c.category));
});

// Travel items for quick-add. Returns non-provider km, non-provider time (07_001), provider km (XX_799), provider time uses main line (client-side).
// km = non-provider (travel with participant); excludes XX_799 and 02_051.
router.get('/travel-items', (req, res) => {
  try {
    const category = (req.query.category || '').toString().trim();
    const catMatch = category.match(/^(\d{2})$/);
    const cat = catMatch ? catMatch[1] : null;
    // Non-provider km (travel with participant) – same category, exclude 799 and 02_051
    const nonProviderKm = !cat || cat === '07'
      ? []
      : db.prepare(`
          SELECT * FROM ndis_line_items
          WHERE support_item_number LIKE ? AND support_item_number NOT LIKE '%_799_%'
            AND support_item_number NOT LIKE '02_051%'
            AND (unit = 'km' OR unit = 'kilometre' OR description LIKE '%travel%')
          ORDER BY support_item_number
        `).all(cat + '_%');
    // Non-provider time: 07_001 (Support Coordination travel); other categories use main line on client
    const nonProviderTime = db.prepare(`
      SELECT * FROM ndis_line_items
      WHERE support_item_number LIKE '07_001%' AND (unit = 'hour' OR unit = 'hr' OR description LIKE '%travel%')
      ORDER BY support_item_number
    `).all();
    // Provider km (XX_799) – per category when 02, 04, or 07
    const providerKm = cat && (cat === '02' || cat === '04' || cat === '07')
      ? db.prepare(`
          SELECT * FROM ndis_line_items
          WHERE support_item_number LIKE ? AND (unit = 'km' OR unit = 'kilometre' OR description LIKE '%travel%' OR description LIKE '%799%')
          ORDER BY support_item_number
        `).all(cat + '_799%')
      : [];
    res.json({
      km: nonProviderKm,
      time: nonProviderTime,
      provider_km: providerKm,
      non_provider_km: nonProviderKm,
      non_provider_time: nonProviderTime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NDIS Support Categories (01-15)
router.get('/support-categories', (req, res) => {
  try {
    const cats = db.prepare('SELECT id, name FROM ndis_support_categories ORDER BY id').all();
    res.json(cats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/bulk', (req, res) => {
  try {
    db.prepare('DELETE FROM shift_line_items').run();
    const result = db.prepare('DELETE FROM ndis_line_items').run();
    res.json({ deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/delete-selected', (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No items selected' });
    }
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM shift_line_items WHERE ndis_line_item_id IN (${placeholders})`).run(...ids);
    const result = db.prepare(`DELETE FROM ndis_line_items WHERE id IN (${placeholders})`).run(...ids);
    res.json({ deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore support item number when Excel parses "01_002_0107_1_1" as number (1.002010711)
function normalizeSupportItemNumber(val) {
  if (val == null || val === '') return '';
  const s = String(val).trim();
  if (s.includes('_')) return s; // Already correct format
  const n = parseFloat(s);
  if (isNaN(n) || n < 1 || n >= 2) return s;
  // Excel treats 01_002_0107_1_1 as number 1.002010711; reconstruct as XX_YYY_ZZZZ_N_N
  const digits = String(Math.round(n * 1e9)).padStart(11, '0').slice(0, 11);
  if (digits.length >= 11) {
    return `${digits.slice(0, 2)}_${digits.slice(2, 5)}_${digits.slice(5, 9)}_${digits[9]}_${digits[10]}`;
  }
  return s;
}

// Parse CSV file to rows (array of arrays)
function fileToRows(buffer) {
  const text = decodeCsvBuffer(buffer);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const delimiter = detectCsvDelimiter(lines[0]);
  return lines.map(line => parseCSVLine(line, delimiter));
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

// Preview import (no save) - returns headers and sample parsed rows for debugging (admin/delegate only)
router.post('/import-preview', requireAdminOrDelegate, upload.single('file'), (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const ext = (req.file.originalname || '').toLowerCase();
    if (!ext.endsWith('.csv')) {
      return res.status(400).json({ error: 'Only CSV files are supported. Please export your data as CSV.' });
    }
    let rows = fileToRows(req.file.buffer);
    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSV must have header and at least one row' });
    }
    const headerRowIdx = rows.findIndex(row => {
      const arr = Array.isArray(row) ? row : Object.values(row || {});
      const joined = arr.map(c => String(c ?? '')).join(' ').toLowerCase();
      return joined.includes('support item number') || joined.includes('support item no') || joined.includes('support item');
    });
    if (headerRowIdx >= 0 && headerRowIdx > 0) {
      rows = rows.slice(headerRowIdx);
    }
    const headers = rows[0].map(h => String(h || '').trim());
    const isOfficial = isOfficialNdisFormat(headers);
    let sample = [];
    try {
      if (isOfficial) {
        sample = runOfficialImportPreview(rows);
      } else {
        const headersLower = headers.map(h => h.toLowerCase());
        const supportIdx = headersLower.findIndex(h => h.includes('support') || h.includes('item') || h === 'code');
        const descIdx = headersLower.findIndex(h => h.includes('desc'));
        const rateIdx = headersLower.findIndex(h => h.includes('rate') || h.includes('price') || h.includes('amount') || h.includes('max'));
        sample = rows.slice(1, 6).map((row, i) => {
          let supportItem = supportIdx >= 0 ? row[supportIdx] : row[0];
          supportItem = normalizeSupportItemNumber(supportItem);
          return {
            support_item_number: supportItem,
            description: descIdx >= 0 ? row[descIdx] : row[1] || '',
            rate: parseRate(rateIdx >= 0 ? row[rateIdx] : row[2]),
            raw: row
          };
        });
      }
    } catch (e) {
      sample = [{ error: e.message }];
    }
    res.json({ headers, isOfficial, sampleRows: rows.slice(1, 6), sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import route MUST be before /:id so "import" is not matched as id (admin/delegate only)
router.post('/import', requireAdminOrDelegate, upload.single('file'), (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const ext = (req.file.originalname || '').toLowerCase();
    if (!ext.endsWith('.csv')) {
      return res.status(400).json({ error: 'Only CSV files are supported. Please export your data as CSV.' });
    }
    let rows = fileToRows(req.file.buffer);
    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSV must have header and at least one row' });
    }
    // Find header row (in case file has title rows at top)
    const headerRowIdx = rows.findIndex(row => {
      const arr = Array.isArray(row) ? row : Object.values(row || {});
      const joined = arr.map(c => String(c ?? '')).join(' ').toLowerCase();
      return joined.includes('support item number') || joined.includes('support item no');
    });
    if (headerRowIdx >= 0 && headerRowIdx > 0) {
      rows = rows.slice(headerRowIdx);
    }
    const headers = rows[0].map(h => String(h || '').trim());
    if (isOfficialNdisFormat(headers)) {
      const result = runOfficialImport(rows);
      return res.json(result);
    }
    const headersLower = headers.map(h => h.toLowerCase());
    const supportIdx = headersLower.findIndex(h => h.includes('support') || h.includes('item') || h === 'code');
    const descIdx = headersLower.findIndex(h => h.includes('desc'));
    const rateIdx = headersLower.findIndex(h => h.includes('rate') || h.includes('price') || h.includes('amount') || h.includes('max'));
    const unitIdx = headersLower.findIndex(h => h === 'unit');
    const catIdx = headersLower.findIndex(h => h.includes('cat'));

    const importedIds = [];
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i];
      let supportItem = supportIdx >= 0 ? cols[supportIdx] : cols[0];
      supportItem = normalizeSupportItemNumber(supportItem);
      const description = descIdx >= 0 ? cols[descIdx] : cols[1] || '';
      const rateRaw = rateIdx >= 0 ? cols[rateIdx] : cols[2];
      const rate = parseRate(rateRaw);
      const unit = unitIdx >= 0 ? cols[unitIdx] : 'hour';
      const category = catIdx >= 0 ? cols[catIdx] : null;
      const regGroupIdx = headersLower.findIndex(h => h.includes('registration group') && h.includes('number'));
      const registrationGroup = regGroupIdx >= 0 && cols[regGroupIdx] ? String(cols[regGroupIdx]).trim() : parseRegistrationGroup(supportItem);
      if (!supportItem) continue;

      const supportCategory = getSupportCategory(supportItem);
      const rateType = parseRateTypeFromDescription(description);
      const timeBand = parseTimeBandFromDescription(description);
      const id = uuidv4();
      try {
        db.prepare(`
          INSERT INTO ndis_line_items (id, support_item_number, support_category, description, rate, rate_type, time_band, unit, category, registration_group_number)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, supportItem, supportCategory, description, rate, rateType, timeBand, unit, category, registrationGroup || null);
        importedIds.push(id);
      } catch (e) {
        // Skip duplicates
      }
    }
    try {
      const mappingsUsed = [];
      if (supportIdx >= 0) mappingsUsed.push({ header: headers[supportIdx], field: 'support_item_number' });
      if (descIdx >= 0) mappingsUsed.push({ header: headers[descIdx], field: 'description' });
      if (rateIdx >= 0) mappingsUsed.push({ header: headers[rateIdx], field: 'rate' });
      if (unitIdx >= 0) mappingsUsed.push({ header: headers[unitIdx], field: 'unit' });
      if (catIdx >= 0) mappingsUsed.push({ header: headers[catIdx], field: 'category' });
      for (const m of mappingsUsed) {
        recordMapping('ndis_line_items', m.header, m.field);
      }
    } catch (e) { console.warn('[ndis] mapping learning error:', e.message); }

    res.json({ imported: importedIds.length, total: rows.length - 1, importedIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM ndis_line_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Line item not found' });
  res.json(item);
});

router.post('/', (req, res) => {
  try {
    const id = uuidv4();
    const { support_item_number, description, rate, rate_remote, rate_very_remote, rate_type, time_band, unit, category, registration_group_number } = req.body;
    const regGroup = registration_group_number ?? parseRegistrationGroup(support_item_number);
    const supportCategory = getSupportCategory(support_item_number);
    const rt = ['weekday', 'saturday', 'sunday', 'public_holiday'].includes(rate_type) ? rate_type : parseRateTypeFromDescription(description);
    const tb = ['daytime', 'evening', 'night'].includes(time_band) ? time_band : parseTimeBandFromDescription(description);
    db.prepare(`
      INSERT INTO ndis_line_items (id, support_item_number, support_category, description, rate, rate_remote, rate_very_remote, rate_type, time_band, unit, category, registration_group_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, support_item_number, supportCategory, description, parseFloat(rate), rate_remote != null ? parseFloat(rate_remote) : null, rate_very_remote != null ? parseFloat(rate_very_remote) : null, rt, tb, unit || 'hour', category || null, regGroup || null);
    res.status(201).json({ id, support_item_number, support_category: supportCategory, description, rate, rate_remote, rate_very_remote, rate_type: rt, unit, category, registration_group_number: regGroup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const { support_item_number, description, rate, rate_remote, rate_very_remote, rate_type, time_band, unit, category, registration_group_number } = req.body;
  const regGroup = registration_group_number ?? (support_item_number ? parseRegistrationGroup(support_item_number) : null);
  const supportCategory = support_item_number ? getSupportCategory(support_item_number) : null;
  const rt = rate_type && ['weekday', 'saturday', 'sunday', 'public_holiday'].includes(rate_type) ? rate_type : (description ? parseRateTypeFromDescription(description) : null);
  const tb = time_band && ['daytime', 'evening', 'night'].includes(time_band) ? time_band : (description ? parseTimeBandFromDescription(description) : null);
  const updates = [support_item_number, supportCategory, description, rate, rate_remote != null ? parseFloat(rate_remote) : null, rate_very_remote != null ? parseFloat(rate_very_remote) : null, unit, category, regGroup || null];
  if (rt) updates.push(rt);
  if (tb) updates.push(tb);
  let setClause = 'support_item_number = ?, support_category = ?, description = ?, rate = ?, rate_remote = ?, rate_very_remote = ?, unit = ?, category = ?, registration_group_number = ?';
  if (rt) setClause += ', rate_type = ?';
  if (tb) setClause += ', time_band = ?';
  setClause += ', updated_at = datetime(\'now\')';
  db.prepare(`UPDATE ndis_line_items SET ${setClause} WHERE id = ?`).run(...updates, req.params.id);
  res.json({ id: req.params.id, ...req.body, support_category: supportCategory, registration_group_number: regGroup, rate_type: rt });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM ndis_line_items WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// Parse a CSV line handling quoted fields (e.g. "Assistance, 1:1")
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

// Parse rate from string - handles $, commas, spaces, AUD, etc.
function parseRate(val) {
  if (val == null || val === '') return 0;
  const str = String(val).replace(/[\s$€£AUD]/gi, '').replace(/,(\d{3})/g, '$1').replace(',', '.');
  const n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

// Map NDIS unit codes to app units
const UNIT_MAP = { H: 'hour', E: 'each', D: 'day', WK: 'week', YR: 'year' };
function mapUnit(ndisUnit) {
  const u = (ndisUnit || 'H').trim().toUpperCase();
  return UNIT_MAP[u] || 'hour';
}

// Parse registration group from support item (format XX_YYY_ZZZZ_* where ZZZZ = registration group)
function parseRegistrationGroup(supportItem) {
  if (!supportItem || typeof supportItem !== 'string') return null;
  const parts = supportItem.trim().split('_');
  return parts.length >= 3 ? parts[2] : null;
}

// Detect if CSV is official NDIS Support Catalogue format (has Support Item Number + rate columns)
function isOfficialNdisFormat(headers) {
  const h = headers.map(x => String(x || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const hasSupportItem = h.some(x => x.includes('support item number') || x.includes('support item no') || x.includes('support item'));
  const hasRateColumns = h.some(x =>
    x === 'act' || x === 'nsw' || x === 'vic' || x === 'qld' || x === 'sa' || x === 'wa' || x === 'tas' || x === 'nt' ||
    x.includes('remote') || x.includes('standard') || x.includes('metropolitan')
  );
  return hasSupportItem && hasRateColumns;
}

// Parse official format and return parsed items (for preview). runOfficialImport uses same logic and saves.
function runOfficialImportPreview(rows) {
  const result = parseOfficialImportRows(rows);
  return result.parsed.slice(0, 5);
}

function parseOfficialImportRows(rows) {
  const parsed = [];
  if (rows.length < 2) return { parsed, importedIds: [] };

  const headers = rows[0].map(h => String(h || '').trim());
  const headersLower = headers.map(h => h.toLowerCase());
  const getCol = (row, ...names) => {
    for (const n of names) {
      const idx = headers.findIndex(h => h.toLowerCase().includes(n.toLowerCase()));
      if (idx >= 0 && row[idx] !== undefined) return row[idx];
    }
    return null;
  };
  let supportNumIdx = headers.findIndex(h => h.toLowerCase().includes('support item number') || h.toLowerCase().includes('support item no'));
  if (supportNumIdx < 0) {
    supportNumIdx = headers.findIndex(h => h.toLowerCase().includes('support item'));
  }
  const remoteIdx = headersLower.findIndex(h => {
    const t = String(h || '').trim();
    return t.includes('remote') && !t.includes('very');
  });
  const veryRemoteIdx = headersLower.findIndex(h => String(h || '').trim().includes('very remote'));
  const regGroupIdx = headers.findIndex(h => h.toLowerCase().includes('registration group') && h.toLowerCase().includes('number'));

  if (supportNumIdx < 0) {
    throw new Error('Not a valid NDIS Support Catalogue format. Expected column: Support Item Number.');
  }

  const STANDARD_RATE_NAMES = ['act', 'nsw', 'vic', 'qld', 'sa', 'wa', 'tas', 'nt', 'standard', 'metropolitan', 'metro'];
  const standardRateIdx = headersLower.findIndex((h) => {
    const t = String(h || '').trim();
    if (t.includes('remote') || t.includes('very')) return false;
    return STANDARD_RATE_NAMES.some(r => t === r || t.startsWith(r + ' ') || t.startsWith(r + '\t'));
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

  const MIN_RATE_COL = 3; // First rate can be early; we skip reg group via looksLikePrice

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
    const registrationGroup = getCol(cols, 'registration group number')?.trim() || parseRegistrationGroup(supportItem);

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

    // Quotable items (Quote=Yes) have no set price; import with rate 0 so they appear in the guide
    if (isQuotable) {
      rate = 0;
    } else {
      if (rate === 0 && (!rateRemote || rateRemote === 0) && (!rateVeryRemote || rateVeryRemote === 0)) continue;
      if (rate === 0) rate = rateRemote || rateVeryRemote || 0;
    }

    const rateType = parseRateTypeFromDescription(description);
    const timeBand = parseTimeBandFromDescription(description);
    parsed.push({ support_item_number: supportItem, description, rate, rate_remote: rateRemote, rate_very_remote: rateVeryRemote, rate_type: rateType, time_band: timeBand, unit, category, registration_group_number: registrationGroup });
  }
  return { parsed };
}

// Run official NDIS Support Catalogue import
function runOfficialImport(rows) {
  const { parsed } = parseOfficialImportRows(rows);
  const importedIds = [];
  for (const item of parsed) {
    const id = uuidv4();
    try {
      db.prepare(`
        INSERT INTO ndis_line_items (id, support_item_number, support_category, description, rate, rate_remote, rate_very_remote, rate_type, time_band, unit, category, registration_group_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, item.support_item_number, getSupportCategory(item.support_item_number), item.description, item.rate, item.rate_remote || null, item.rate_very_remote || null, item.rate_type || 'weekday', item.time_band || 'daytime', item.unit, item.category, item.registration_group_number || null);
      importedIds.push(id);
    } catch (e) {
      // Skip duplicates
    }
  }
  return { imported: importedIds.length, total: rows.length - 1, importedIds };
}

export default router;
