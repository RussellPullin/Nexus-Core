import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { db } from '../db/index.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { requireSuperAdmin } from '../middleware/superAdmin.js';
import { recordMapping } from '../services/csvMappingLearner.service.js';
import {
  getSupportCategory,
  parseRateTypeFromDescription,
  parseTimeBandFromDescription,
  isOfficialNdisFormat,
  parseOfficialImportRows,
  parseGenericImportRows,
  normalizeCatalogueRows,
  fileBufferToCatalogueRows,
  importCatalogueFromBuffer,
} from '../lib/ndisCatalogueImport.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

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

router.get('/travel-items', (req, res) => {
  try {
    const category = (req.query.category || '').toString().trim();
    const catMatch = category.match(/^(\d{2})$/);
    const cat = catMatch ? catMatch[1] : null;
    const nonProviderKm = !cat || cat === '07'
      ? []
      : db.prepare(`
          SELECT * FROM ndis_line_items
          WHERE support_item_number LIKE ? AND support_item_number NOT LIKE '%_799_%'
            AND support_item_number NOT LIKE '02_051%'
            AND (
              unit = 'km' OR unit = 'kilometre' OR LOWER(description) LIKE '%travel%'
              OR LOWER(COALESCE(description, '')) LIKE '%activity based transport%'
            )
          ORDER BY CASE
            WHEN LOWER(COALESCE(description, '')) LIKE '%activity based transport%' THEN 0
            ELSE 1
          END, support_item_number
        `).all(cat + '_%');
    const nonProviderTime = db.prepare(`
      SELECT * FROM ndis_line_items
      WHERE support_item_number LIKE '07_001%' AND (unit = 'hour' OR unit = 'hr' OR description LIKE '%travel%')
      ORDER BY support_item_number
    `).all();
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

router.get('/support-categories', (req, res) => {
  try {
    const cats = db.prepare('SELECT id, name FROM ndis_support_categories ORDER BY id').all();
    res.json(cats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/bulk', requireSuperAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM shift_line_items').run();
    const result = db.prepare('DELETE FROM ndis_line_items').run();
    res.json({ deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/delete-selected', requireSuperAdmin, (req, res) => {
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

router.post('/import-preview', requireSuperAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const filename = req.file.originalname || '';
    const ext = filename.toLowerCase();
    if (!ext.endsWith('.csv') && !ext.endsWith('.xlsx') && !ext.endsWith('.xlsm')) {
      return res.status(400).json({ error: 'Upload the official NDIS Support Catalogue as .xlsx or .csv.' });
    }

    let rows = await fileBufferToCatalogueRows(req.file.buffer, filename);
    rows = normalizeCatalogueRows(rows);
    if (rows.length < 2) {
      return res.status(400).json({ error: 'File must have a header row and at least one data row' });
    }

    const headers = rows[0].map(h => String(h || '').trim());
    const isOfficial = isOfficialNdisFormat(headers);
    let sample = [];
    try {
      sample = isOfficial
        ? parseOfficialImportRows(rows).parsed.slice(0, 5)
        : parseGenericImportRows(rows).parsed.slice(0, 5);
    } catch (e) {
      sample = [{ error: e.message }];
    }
    res.json({ headers, isOfficial, sampleRows: rows.slice(1, 6), sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/import', requireSuperAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const filename = req.file.originalname || '';
    const ext = filename.toLowerCase();
    if (!ext.endsWith('.csv') && !ext.endsWith('.xlsx') && !ext.endsWith('.xlsm')) {
      return res.status(400).json({ error: 'Upload the official NDIS Support Catalogue as .xlsx or .csv.' });
    }

    const result = await importCatalogueFromBuffer(db, req.file.buffer, filename);

    try {
      const rows = normalizeCatalogueRows(await fileBufferToCatalogueRows(req.file.buffer, filename));
      const headers = rows[0].map(h => String(h || '').trim());
      const headersLower = headers.map(h => h.toLowerCase());
      const supportIdx = headersLower.findIndex(h => h.includes('support') || h.includes('item') || h === 'code');
      const descIdx = headersLower.findIndex(h => h.includes('desc'));
      const rateIdx = headersLower.findIndex(h => h.includes('rate') || h.includes('price') || h.includes('amount') || h.includes('max'));
      const unitIdx = headersLower.findIndex(h => h === 'unit');
      const catIdx = headersLower.findIndex(h => h.includes('cat'));
      const mappingsUsed = [];
      if (supportIdx >= 0) mappingsUsed.push({ header: headers[supportIdx], field: 'support_item_number' });
      if (descIdx >= 0) mappingsUsed.push({ header: headers[descIdx], field: 'description' });
      if (rateIdx >= 0) mappingsUsed.push({ header: headers[rateIdx], field: 'rate' });
      if (unitIdx >= 0) mappingsUsed.push({ header: headers[unitIdx], field: 'unit' });
      if (catIdx >= 0) mappingsUsed.push({ header: headers[catIdx], field: 'category' });
      for (const m of mappingsUsed) {
        recordMapping('ndis_line_items', m.header, m.field);
      }
    } catch (e) {
      console.warn('[ndis] mapping learning error:', e.message);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM ndis_line_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Line item not found' });
  res.json(item);
});

router.post('/', requireAdminOrDelegate, (req, res) => {
  try {
    const id = uuidv4();
    const { support_item_number, description, rate, rate_remote, rate_very_remote, rate_type, time_band, unit, category, registration_group_number } = req.body;
    const existing = db.prepare('SELECT id FROM ndis_line_items WHERE support_item_number = ?').get(support_item_number);
    if (existing) {
      return res.status(409).json({ error: 'A line item with this support item number already exists. Contact your platform administrator to update official NDIS rates.' });
    }
    const regGroup = registration_group_number ?? parseRegistrationGroupFromNumber(support_item_number);
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

router.put('/:id', requireSuperAdmin, (req, res) => {
  const { support_item_number, description, rate, rate_remote, rate_very_remote, rate_type, time_band, unit, category, registration_group_number } = req.body;
  const regGroup = registration_group_number ?? (support_item_number ? parseRegistrationGroupFromNumber(support_item_number) : null);
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

router.delete('/:id', requireSuperAdmin, (req, res) => {
  db.prepare('DELETE FROM ndis_line_items WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

function parseRegistrationGroupFromNumber(supportItem) {
  if (!supportItem || typeof supportItem !== 'string') return null;
  const parts = supportItem.trim().split('_');
  return parts.length >= 3 ? parts[2] : null;
}

export default router;
