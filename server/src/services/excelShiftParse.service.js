/**
 * Excel Shifts sheet: combine learning-layer column hints, deterministic Shifter labels,
 * and Ollama (when available) so visit rows parse reliably; records learning events for audit.
 */

import * as llm from './llm.service.js';
import { suggestMapping } from './csvMappingLearner.service.js';
import { recordEvent } from './learningEvent.service.js';

const CORE_FIELDS = [
  'shift_date',
  'staff_name',
  'client_name',
  'start_time',
  'finish_time',
  'travel_km',
  'travel_time_min',
  'expenses',
  'incidents',
  'mood',
  'session_details',
  'shift_id',
];

function normalizeHeader(v) {
  return String(v || '').trim().toLowerCase();
}

function buildNormToIndex(headers) {
  const map = new Map();
  headers.forEach((h, i) => {
    if (!h) return;
    const n = normalizeHeader(h);
    if (!map.has(n)) map.set(n, i + 1);
  });
  return map;
}

/** Prefer per-visit travel km; skip fortnight / summary columns. */
function findTravelKmColumnIndex(headers, normToIndex) {
  const normKeys = [
    'travel (km)',
    'travel km',
    'travel kms',
    'travel distance (km)',
    'participant travel (km)',
  ];
  for (const k of normKeys) {
    const idx = normToIndex.get(k);
    if (idx) return idx;
  }
  for (let i = 0; i < headers.length; i++) {
    const n = normalizeHeader(headers[i] || '');
    if (!n) continue;
    if (n.includes('fortnight') || n.includes('total hours')) continue;
    if (n.includes('total') && n.includes('km') && !n.includes('travel')) continue;
    if (/\btravel\b/.test(n) && /\bkm/.test(n)) return i + 1;
  }
  return 0;
}

function tryAssign(fieldToCol, colToField, field, col, source) {
  if (!col || col < 1) return false;
  if (!CORE_FIELDS.includes(field)) return false;
  if (fieldToCol[field] != null) return false;
  if (colToField[col] != null) return false;
  fieldToCol[field] = col;
  colToField[col] = field;
  return true;
}

function applyDeterministicGaps(headers, fieldToCol, colToField) {
  const norm = buildNormToIndex(headers);
  const pick = (...labels) => {
    for (const lab of labels) {
      const idx = norm.get(normalizeHeader(lab));
      if (idx) return idx;
    }
    return 0;
  };
  const tryDet = (field, ...labels) => {
    const col = pick(...labels);
    if (col) tryAssign(fieldToCol, colToField, field, col);
  };
  tryDet('shift_date', 'Shift Date', 'Date');
  tryDet('staff_name', 'Staff Name');
  tryDet('client_name', 'Client Name');
  tryDet('start_time', 'Start Time');
  tryDet('finish_time', 'Finish Time');
  tryDet('travel_time_min', 'Travel Time (min)', 'Travel Time');
  tryDet('expenses', 'Expenses');
  tryDet('incidents', 'Incidents');
  tryDet('mood', 'Mood');
  tryDet('session_details', 'Session Details');
  tryDet('shift_id', 'Shift ID');
  if (fieldToCol.travel_km == null) {
    const tk = findTravelKmColumnIndex(headers, norm);
    if (tk) tryAssign(fieldToCol, colToField, 'travel_km', tk);
  }
}

/**
 * @param {string[]} headers - row 1 labels
 * @param {string[][]} sampleRows - up to N data rows, each array parallel to headers
 * @param {{ log?: function, useLlm?: boolean }} options
 * @returns {Promise<{ fieldToCol: Record<string, number>, sources: Record<string, string>, llmUsed: boolean }>}
 */
export async function resolveShiftExcelColumns(headers, sampleRows, options = {}) {
  const log = options.log || (() => {});
  const useLlm = options.useLlm !== false;
  const fieldToCol = {};
  const colToField = {};
  const sources = {};
  let llmUsed = false;

  const { mappings } = suggestMapping({
    import_type: 'shifts',
    headers,
    sample_rows: sampleRows || [],
  });

  const byColumnOrder = [...mappings].sort((a, b) => a.column_index - b.column_index);
  for (const m of byColumnOrder) {
    if (!m.mapped_field || m.confidence < 0.45) continue;
    const col = m.column_index + 1;
    if (tryAssign(fieldToCol, colToField, m.mapped_field, col, m.source)) {
      sources[m.mapped_field] = m.source === 'memory' ? 'memory' : m.source;
    }
  }

  applyDeterministicGaps(headers, fieldToCol, colToField);
  for (const f of CORE_FIELDS) {
    if (fieldToCol[f] != null && sources[f] == null) sources[f] = 'deterministic';
  }

  const enrichAlways = process.env.EXCEL_SHIFTS_LLM_ENRICH === 'true';
  const needLlm =
    useLlm &&
    (await llm.isAvailable()) &&
    (enrichAlways ||
      fieldToCol.shift_id == null ||
      fieldToCol.shift_date == null ||
      fieldToCol.staff_name == null ||
      fieldToCol.client_name == null ||
      fieldToCol.travel_km == null);

  if (needLlm) {
    const prompt = `You map Excel column headers from a disability support "Shifts" roster to canonical fields.

Headers (exact strings, preserve spelling): ${JSON.stringify(headers)}
Sample data rows (same column order, first cells may be empty): ${JSON.stringify((sampleRows || []).slice(0, 3))}

Return ONLY a JSON object: keys MUST be exact header strings from the list above; values MUST be one of:
shift_date, staff_name, client_name, start_time, finish_time, travel_km, travel_time_min, expenses, incidents, mood, session_details, shift_id
OR null for columns that are medications, fortnight totals, unrelated metadata, or blank.

Rules:
- shift_date = day of the visit (not pay period / fortnight).
- travel_km = per-visit travel distance only (not "total kms" for a fortnight).
- shift_id = unique row / visit identifier if present.
- Map "Support Worker", "Employee" style columns to staff_name; participant-style names to client_name.

Example: {"Shift Date":"shift_date","Staff Name":"staff_name","Travel (KM)":"travel_km"}`;

    const mapping = await llm.completeJson(prompt, { maxTokens: 1200, temperature: 0.1 });
    if (mapping && typeof mapping === 'object') {
      llmUsed = true;
      for (const [headerKey, rawField] of Object.entries(mapping)) {
        const field = rawField == null ? null : String(rawField).trim();
        if (!field || field === 'null' || !CORE_FIELDS.includes(field)) continue;
        const exactIdx = headers.findIndex((h) => h === headerKey);
        const idx = exactIdx >= 0 ? exactIdx + 1 : headers.findIndex((h) => normalizeHeader(h) === normalizeHeader(headerKey)) + 1;
        if (idx < 1) continue;
        if (fieldToCol[field] != null) continue;
        if (colToField[idx] != null) continue;
        if (tryAssign(fieldToCol, colToField, field, idx, 'ollama')) {
          sources[field] = 'ollama';
        }
      }
      log('Ollama shift header mapping applied', { fields: Object.keys(sources).filter((k) => sources[k] === 'ollama') });
    }
  }

  applyDeterministicGaps(headers, fieldToCol, colToField);
  for (const f of CORE_FIELDS) {
    if (fieldToCol[f] != null && sources[f] == null) sources[f] = 'deterministic';
  }

  try {
    recordEvent({
      event_type: 'excel_shift_column_map',
      metadata: {
        llm_used: llmUsed,
        sources,
        header_count: headers.filter(Boolean).length,
      },
    });
  } catch (e) {
    log('learning event excel_shift_column_map skipped', e?.message);
  }

  return { fieldToCol, sources, llmUsed };
}

export default { resolveShiftExcelColumns };
