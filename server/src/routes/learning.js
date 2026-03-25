/**
 * Learning Layer API routes.
 * Suggestions, feedback, CSV mapping, config, audit, and metrics.
 */

import { Router } from 'express';
import multer from 'multer';
import { db } from '../db/index.js';
import { recordEvent } from '../services/learningEvent.service.js';
import { getShiftSuggestions, detectAnomalies } from '../services/suggestionEngine.service.js';
import { suggestMapping, recordMapping, recordCorrection } from '../services/csvMappingLearner.service.js';
import { computeMetrics } from '../services/featureStore.service.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ─── Suggestions ────────────────────────────────────────────────────────────

/**
 * GET /api/suggestions/shifts?participant_id=&staff_id=&date=&shift_type=
 */
router.get('/suggestions/shifts', (req, res) => {
  try {
    const { participant_id, staff_id, date, shift_type } = req.query;
    if (!participant_id) return res.status(400).json({ error: 'participant_id is required' });

    const suggestions = getShiftSuggestions({ participant_id, staff_id, date, shift_type });
    res.json(suggestions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/suggestions/anomalies/:shift_id
 */
router.get('/suggestions/anomalies/:shift_id', (req, res) => {
  try {
    const shift = db.prepare(`
      SELECT s.*, p.management_type FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      WHERE s.id = ?
    `).get(req.params.shift_id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });

    const lineItems = db.prepare('SELECT * FROM shift_line_items WHERE shift_id = ?').all(req.params.shift_id);

    const anomalies = detectAnomalies({
      shift_id: shift.id,
      participant_id: shift.participant_id,
      staff_id: shift.staff_id,
      start_time: shift.start_time,
      end_time: shift.end_time,
      line_items: lineItems,
      date: shift.start_time
    });

    res.json({ anomalies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Feedback ───────────────────────────────────────────────────────────────

/**
 * POST /api/feedback/suggestions
 * Body: { suggestion_id, outcome: 'accepted'|'rejected', rejection_reason?, dont_suggest_again? }
 */
router.post('/feedback/suggestions', (req, res) => {
  try {
    const { suggestion_id, outcome, rejection_reason, dont_suggest_again } = req.body;
    if (!suggestion_id || !outcome) {
      return res.status(400).json({ error: 'suggestion_id and outcome are required' });
    }
    if (!['accepted', 'rejected', 'ignored'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be accepted, rejected, or ignored' });
    }

    const existing = db.prepare('SELECT * FROM suggestion_history WHERE id = ?').get(suggestion_id);
    if (!existing) return res.status(404).json({ error: 'Suggestion not found' });

    db.prepare(`
      UPDATE suggestion_history
      SET outcome = ?, rejection_reason = ?, dont_suggest_again = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(outcome, rejection_reason || null, dont_suggest_again ? 1 : 0, suggestion_id);

    recordEvent({
      event_type: outcome === 'accepted' ? 'suggestion_accepted' : 'suggestion_rejected',
      participant_id: existing.participant_id,
      staff_id: existing.staff_id,
      shift_id: existing.shift_id,
      suggestion_id,
      confidence: existing.confidence,
      field_name: existing.suggestion_type,
      new_value: existing.suggested_value,
      metadata: { rejection_reason, dont_suggest_again: !!dont_suggest_again }
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CSV Mapping ────────────────────────────────────────────────────────────

/**
 * POST /api/imports/csv/preview-mapping
 * Body: { import_type, headers: string[], sample_rows?: string[][] }
 * Or multipart with file + import_type field.
 */
router.post('/imports/csv/preview-mapping', upload.single('file'), (req, res) => {
  try {
    let headers = req.body.headers;
    let sampleRows = req.body.sample_rows;
    const importType = req.body.import_type || 'participants';

    if (req.file) {
      const text = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 1) return res.status(400).json({ error: 'Empty CSV' });
      headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      sampleRows = lines.slice(1, 21).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    }

    if (!headers || !Array.isArray(headers)) {
      if (typeof headers === 'string') {
        try { headers = JSON.parse(headers); } catch { return res.status(400).json({ error: 'headers must be an array' }); }
      } else {
        return res.status(400).json({ error: 'headers array is required' });
      }
    }
    if (typeof sampleRows === 'string') {
      try { sampleRows = JSON.parse(sampleRows); } catch { sampleRows = []; }
    }

    const result = suggestMapping({ import_type: importType, headers, sample_rows: sampleRows || [] });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/imports/csv/mapping-feedback
 * Body: { import_type, mappings: [{ header, mapped_field, was_corrected?, original_field? }] }
 */
router.post('/imports/csv/mapping-feedback', (req, res) => {
  try {
    const { import_type, mappings } = req.body;
    if (!import_type || !Array.isArray(mappings)) {
      return res.status(400).json({ error: 'import_type and mappings array required' });
    }
    for (const m of mappings) {
      if (!m.header || !m.mapped_field) continue;
      if (m.was_corrected && m.original_field) {
        recordCorrection(import_type, m.header, m.original_field, m.mapped_field);
      } else {
        recordMapping(import_type, m.header, m.mapped_field);
      }
    }
    res.json({ ok: true, recorded: mappings.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Config (admin only) ───────────────────────────────────────────────────

router.get('/learning/config', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value, updated_at FROM learning_config').all();
    const config = {};
    for (const r of rows) config[r.key] = r.value;
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/learning/config', (req, res) => {
  try {
    const allowed = new Set([
      'learning_enabled', 'per_user_learning', 'event_retention_days',
      'suggestion_confidence_threshold', 'csv_mapping_auto_threshold'
    ]);
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Request body must be an object of key-value pairs' });
    }
    let count = 0;
    for (const [k, v] of Object.entries(updates)) {
      if (!allowed.has(k)) continue;
      db.prepare(`
        INSERT INTO learning_config (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `).run(k, String(v));
      count++;
    }
    res.json({ ok: true, updated: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Audit ──────────────────────────────────────────────────────────────────

router.get('/learning/audit', (req, res) => {
  try {
    const { type, outcome, participant_id, limit: lim, offset: off } = req.query;
    const limit = Math.min(parseInt(lim) || 50, 200);
    const offset = parseInt(off) || 0;

    let sql = 'SELECT * FROM suggestion_history WHERE 1=1';
    const params = [];
    if (type) { sql += ' AND suggestion_type = ?'; params.push(type); }
    if (outcome) { sql += ' AND outcome = ?'; params.push(outcome); }
    if (participant_id) { sql += ' AND participant_id = ?'; params.push(participant_id); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params);
    const total = db.prepare('SELECT COUNT(*) as c FROM suggestion_history').get()?.c || 0;
    res.json({ rows, total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Metrics ────────────────────────────────────────────────────────────────

router.get('/learning/metrics', (req, res) => {
  try {
    const metrics = computeMetrics();
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
