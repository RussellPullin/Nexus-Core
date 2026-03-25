/**
 * Learning Event capture service.
 * Append-only event stream recording user behaviour for the Learning Layer.
 * Every event auto-extracts context features (day_of_week, time_bucket, etc.)
 * so downstream aggregation can build rich, context-aware suggestions.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

const SCHEMA_VERSION = 1;

const TIME_BUCKETS = [
  { name: 'night',     start: 0,  end: 6  },
  { name: 'morning',   start: 6,  end: 12 },
  { name: 'afternoon', start: 12, end: 17 },
  { name: 'evening',   start: 17, end: 21 },
  { name: 'night',     start: 21, end: 24 },
];

export function getTimeBucket(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    const dateMatch = timeStr.match(/T(\d{2}):(\d{2})/);
    if (!dateMatch) return null;
    const hour = parseInt(dateMatch[1], 10);
    return TIME_BUCKETS.find(b => hour >= b.start && hour < b.end)?.name || 'morning';
  }
  const hour = parseInt(match[1], 10);
  return TIME_BUCKETS.find(b => hour >= b.start && hour < b.end)?.name || 'morning';
}

export function getDayOfWeek(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.getDay();
}

function computeDurationMinutes(startTime, endTime) {
  if (!startTime || !endTime) return null;
  const extract = (t) => {
    const m = t.match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  const s = extract(startTime);
  const e = extract(endTime);
  if (s == null || e == null) return null;
  const diff = e - s;
  return diff > 0 ? diff : null;
}

function getFundingType(participantId) {
  if (!participantId) return null;
  try {
    const p = db.prepare('SELECT management_type FROM participants WHERE id = ?').get(participantId);
    return p?.management_type || null;
  } catch { return null; }
}

function isLearningEnabled() {
  try {
    const row = db.prepare("SELECT value FROM learning_config WHERE key = 'learning_enabled'").get();
    return row?.value !== 'false';
  } catch { return true; }
}

const insertStmt = db.prepare(`
  INSERT INTO learning_events (
    id, schema_version, event_type,
    participant_id, staff_id, shift_id,
    day_of_week, time_bucket, duration_minutes,
    shift_type, service_category, funding_type,
    field_name, old_value, new_value,
    suggestion_id, confidence, metadata_json, created_at
  ) VALUES (
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, datetime('now')
  )
`);

/**
 * Record a learning event. Context features are derived automatically from
 * the provided data so callers don't need to compute them.
 *
 * @param {object} opts
 * @param {string} opts.event_type - shift_created | shift_edited | line_item_selected |
 *   suggestion_accepted | suggestion_rejected | csv_mapping_chosen |
 *   csv_mapping_corrected | invoice_generated | anomaly_dismissed |
 *   excel_shift_column_map (Shifts sheet header resolution: memory / Ollama / deterministic)
 * @param {string} [opts.participant_id]
 * @param {string} [opts.staff_id]
 * @param {string} [opts.shift_id]
 * @param {string} [opts.date]        - shift date for day_of_week
 * @param {string} [opts.start_time]  - for time_bucket
 * @param {string} [opts.end_time]    - for duration
 * @param {string} [opts.shift_type]
 * @param {string} [opts.service_category]
 * @param {string} [opts.field_name]
 * @param {string} [opts.old_value]
 * @param {string} [opts.new_value]
 * @param {string} [opts.suggestion_id]
 * @param {number} [opts.confidence]
 * @param {object} [opts.metadata]
 */
export function recordEvent(opts) {
  if (!isLearningEnabled()) return null;
  if (!opts?.event_type) return null;

  const id = uuidv4();
  try {
    insertStmt.run(
      id,
      SCHEMA_VERSION,
      opts.event_type,
      opts.participant_id || null,
      opts.staff_id || null,
      opts.shift_id || null,
      getDayOfWeek(opts.date || opts.start_time) ?? null,
      getTimeBucket(opts.start_time) || null,
      computeDurationMinutes(opts.start_time, opts.end_time) ?? null,
      opts.shift_type || null,
      opts.service_category || null,
      opts.funding_type || getFundingType(opts.participant_id),
      opts.field_name || null,
      opts.old_value != null ? String(opts.old_value) : null,
      opts.new_value != null ? String(opts.new_value) : null,
      opts.suggestion_id || null,
      opts.confidence ?? null,
      opts.metadata ? JSON.stringify(opts.metadata) : null
    );
    return id;
  } catch (err) {
    console.warn('[learningEvent] recordEvent error:', err.message);
    return null;
  }
}

/**
 * Record a batch of learning events (e.g. multiple line items in one shift).
 */
export function recordEvents(eventsArray) {
  if (!Array.isArray(eventsArray)) return [];
  return eventsArray.map(e => recordEvent(e)).filter(Boolean);
}

export default { recordEvent, recordEvents, getTimeBucket, getDayOfWeek };
