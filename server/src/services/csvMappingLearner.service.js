/**
 * CSV Mapping Learner service.
 * Remembers how CSV headers map to fields and improves over time.
 *
 * Algorithm:
 * 1. Exact match from csv_mapping_memory (highest confidence)
 * 2. Fuzzy match via Levenshtein-like token overlap
 * 3. Sample row type inference (dates, NDIS numbers, emails, phones)
 * 4. Combine scores; never auto-map sensitive fields without confirmation
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { recordEvent } from './learningEvent.service.js';

const SENSITIVE_FIELDS = new Set(['ndis_number', 'email', 'phone', 'date_of_birth', 'address']);

const KNOWN_FIELD_ALIASES = {
  name: ['name', 'participant', 'client', 'full name', 'fullname', 'client name', 'participant name'],
  first_name: ['first name', 'firstname', 'first', 'given name'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'telephone', 'contact number', 'phone number'],
  ndis_number: ['ndis', 'ndis number', 'ndis no', 'ndis #', 'participant number'],
  date_of_birth: ['dob', 'date of birth', 'birth date', 'birthdate'],
  address: ['address', 'street', 'street address'],
  support_item_number: ['support item number', 'support item no', 'item number', 'item no', 'code', 'support item'],
  description: ['description', 'desc', 'item description', 'support item description'],
  rate: ['rate', 'price', 'amount', 'max price', 'unit price', 'cost'],
  unit: ['unit', 'unit of measure'],
  category: ['category', 'support category', 'cat'],
  management_type: ['management', 'plan management', 'management type', 'funding type'],
  plan_manager_name: ['plan manager', 'plan manager name', 'fm name'],
  plan_start_date: ['plan start', 'plan start date', 'start date'],
  plan_end_date: ['plan end', 'plan end date', 'end date'],
};

/** Excel/CSV Shifts sheet (Progress Notes / Shifter) — used when import_type === 'shifts'. */
const SHIFTS_FIELD_ALIASES = {
  shift_date: ['shift date', 'visit date', 'service date', 'day', 'appointment date'],
  staff_name: ['staff name', 'support worker', 'worker', 'employee', 'carer', 'staff', 'therapist'],
  client_name: ['client name', 'participant name', 'participant', 'customer', 'client', 'service user'],
  start_time: ['start time', 'start', 'commence', 'from time', 'time in'],
  finish_time: ['finish time', 'end time', 'finish', 'to time', 'time out'],
  duration: ['duration', 'hours', 'visit length', 'length'],
  travel_km: ['travel (km)', 'travel km', 'travel kms', 'kilometres', 'kilometers', 'distance km', 'travel distance', 'participant travel'],
  travel_time_min: ['travel time (min)', 'travel time min', 'travel minutes', 'travel mins', 'travel time'],
  expenses: ['expenses', 'out of pocket', 'costs', 'claims'],
  incidents: ['incidents', 'incident'],
  mood: ['mood', 'presentation'],
  session_details: ['session details', 'notes', 'summary', 'activities', 'what we did'],
  shift_id: ['shift id', 'visit id', 'row id', 'uuid'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
}

function tokenOverlap(a, b) {
  const tokensA = new Set(a.split(/\s+/));
  const tokensB = new Set(b.split(/\s+/));
  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? overlap / union : 0;
}

function fuzzyMatchShiftsField(headerNorm) {
  let bestField = null;
  let bestScore = 0;
  for (const [field, aliases] of Object.entries(SHIFTS_FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (headerNorm === alias) return { field, score: 0.95 };
      if (headerNorm.includes(alias) || alias.includes(headerNorm)) {
        const score = 0.75;
        if (score > bestScore) { bestScore = score; bestField = field; }
      }
      const overlap = tokenOverlap(headerNorm, alias);
      if (overlap > bestScore) { bestScore = overlap; bestField = field; }
    }
  }
  if (headerNorm === 'date' && bestScore < 0.85) {
    return { field: 'shift_date', score: 0.72 };
  }
  return bestField ? { field: bestField, score: bestScore } : null;
}

function fuzzyMatchField(headerNorm) {
  let bestField = null;
  let bestScore = 0;
  for (const [field, aliases] of Object.entries(KNOWN_FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (headerNorm === alias) return { field, score: 0.9 };
      if (headerNorm.includes(alias) || alias.includes(headerNorm)) {
        const score = 0.7;
        if (score > bestScore) { bestScore = score; bestField = field; }
      }
      const overlap = tokenOverlap(headerNorm, alias);
      if (overlap > bestScore) { bestScore = overlap; bestField = field; }
    }
  }
  return bestField ? { field: bestField, score: bestScore } : null;
}

function inferTypeFromSamples(sampleValues) {
  if (!sampleValues || sampleValues.length === 0) return null;
  const vals = sampleValues.map(v => String(v || '').trim()).filter(Boolean);
  if (vals.length === 0) return null;

  const datePattern = /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$|^\d{4}-\d{2}-\d{2}$/;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phonePattern = /^[\d\s\+\(\)\-]{8,15}$/;
  const ndisPattern = /^\d{9,10}$/;
  const supportItemPattern = /^\d{2}_\d{3}_\d{4}_\d_\d$/;
  const currencyPattern = /^\$?[\d,]+\.?\d{0,2}$/;

  const checks = [
    { type: 'support_item_number', pattern: supportItemPattern },
    { type: 'email', pattern: emailPattern },
    { type: 'ndis_number', pattern: ndisPattern },
    { type: 'date', pattern: datePattern },
    { type: 'phone', pattern: phonePattern },
    { type: 'currency', pattern: currencyPattern },
  ];

  for (const { type, pattern } of checks) {
    const matchCount = vals.filter(v => pattern.test(v)).length;
    if (matchCount >= vals.length * 0.6) return type;
  }
  return null;
}

/**
 * Suggest CSV column mappings for the given headers and sample rows.
 *
 * @param {object} opts
 * @param {string} opts.import_type - 'ndis_line_items' | 'participants' | 'shifts'
 * @param {string[]} opts.headers - column headers from CSV
 * @param {string[][]} [opts.sample_rows] - first N data rows (array of arrays)
 * @returns {{ mappings: object[], warnings: string[] }}
 */
export function suggestMapping({ import_type, headers, sample_rows }) {
  const mappings = [];
  const warnings = [];
  const usedFields = new Set();

  for (let i = 0; i < headers.length; i++) {
    const headerRaw = headers[i];
    const headerNorm = normalizeHeader(headerRaw);
    const sampleVals = (sample_rows || []).map(row => row[i]).filter(v => v != null);

    let field = null;
    let confidence = 0;
    let source = 'none';

    // 1. Check memory for exact match
    try {
      const mem = db.prepare(`
        SELECT mapped_field, use_count, correction_count
        FROM csv_mapping_memory
        WHERE import_type = ? AND header_text = ?
        ORDER BY (use_count - correction_count) DESC
        LIMIT 1
      `).get(import_type, headerNorm);
      if (mem && mem.use_count > mem.correction_count) {
        field = mem.mapped_field;
        confidence = Math.min(0.95, 0.7 + (mem.use_count - mem.correction_count) * 0.05);
        source = 'memory';
      }
    } catch { /* ignore */ }

    // 2. Fuzzy match from known aliases (shifts vs participants / other)
    if (!field || confidence < 0.7) {
      const fuzzy = import_type === 'shifts'
        ? fuzzyMatchShiftsField(headerNorm)
        : fuzzyMatchField(headerNorm);
      if (fuzzy && fuzzy.score > confidence) {
        field = fuzzy.field;
        confidence = Math.round(fuzzy.score * 100) / 100;
        source = 'alias';
      }
    }

    // 3. Sample type inference
    if (!field && sampleVals.length > 0) {
      const inferred = inferTypeFromSamples(sampleVals);
      if (inferred) {
        const typeToField = import_type === 'shifts'
          ? {
              date: 'shift_date',
              currency: 'expenses',
              phone: null,
              email: null,
              ndis_number: null,
              support_item_number: null,
            }
          : {
              support_item_number: 'support_item_number',
              email: 'email',
              ndis_number: 'ndis_number',
              date: 'date_of_birth',
              phone: 'phone',
              currency: 'rate',
            };
        const mapped = typeToField[inferred];
        if (mapped && !usedFields.has(mapped)) {
          field = mapped;
          confidence = 0.5;
          source = 'inference';
        }
      }
    }

    if (field && SENSITIVE_FIELDS.has(field) && confidence < 0.8) {
      warnings.push(`"${headerRaw}" may map to sensitive field "${field}" (confidence ${confidence}). Please confirm.`);
    }

    if (field && usedFields.has(field)) {
      field = null;
      confidence = 0;
      source = 'none';
    }

    if (field) usedFields.add(field);

    mappings.push({
      column_index: i,
      header: headerRaw,
      mapped_field: field,
      confidence: Math.round(confidence * 100) / 100,
      source,
      is_sensitive: field ? SENSITIVE_FIELDS.has(field) : false
    });
  }

  return { mappings, warnings };
}

/**
 * Record a confirmed mapping (user accepted or manually set).
 */
export function recordMapping(importType, headerText, mappedField) {
  const norm = normalizeHeader(headerText);
  try {
    db.prepare(`
      INSERT INTO csv_mapping_memory (id, import_type, header_text, mapped_field, use_count, last_used)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(import_type, header_text, mapped_field)
      DO UPDATE SET use_count = use_count + 1, last_used = datetime('now')
    `).run(uuidv4(), importType, norm, mappedField);

    recordEvent({
      event_type: 'csv_mapping_chosen',
      field_name: norm,
      new_value: mappedField,
      metadata: { import_type: importType }
    });
  } catch (err) {
    console.warn('[csvMappingLearner] recordMapping error:', err.message);
  }
}

/**
 * Record a mapping correction (user changed an auto-suggested mapping).
 */
export function recordCorrection(importType, headerText, wrongField, correctField) {
  const norm = normalizeHeader(headerText);
  try {
    // Increment correction count on the wrong mapping
    db.prepare(`
      UPDATE csv_mapping_memory
      SET correction_count = correction_count + 1
      WHERE import_type = ? AND header_text = ? AND mapped_field = ?
    `).run(importType, norm, wrongField);

    // Record the correct mapping
    recordMapping(importType, headerText, correctField);

    recordEvent({
      event_type: 'csv_mapping_corrected',
      field_name: norm,
      old_value: wrongField,
      new_value: correctField,
      metadata: { import_type: importType }
    });
  } catch (err) {
    console.warn('[csvMappingLearner] recordCorrection error:', err.message);
  }
}

export default { suggestMapping, recordMapping, recordCorrection };
