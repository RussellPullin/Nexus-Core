/**
 * Suggestion Engine service.
 * Generates explainable suggestions for shift times, line items, and anomaly flags.
 *
 * MVP: frequency counts + recency weighting (no ML).
 * Every suggestion includes a confidence score and human-readable explanations.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { getAggregates, getTopValue, dayName } from './featureStore.service.js';
import { getDayOfWeek, getTimeBucket } from './learningEvent.service.js';

const SPECIFICITY_BONUS = { participant: 1.0, staff: 0.8, org: 0.6 };
const CONFIDENCE_DIVISOR = 10;

function confidenceFromCount(count, source) {
  const base = Math.min(1.0, count / CONFIDENCE_DIVISOR);
  return Math.round(base * (SPECIFICITY_BONUS[source] || 0.6) * 100) / 100;
}

function getConfidenceThreshold() {
  try {
    const row = db.prepare("SELECT value FROM learning_config WHERE key = 'suggestion_confidence_threshold'").get();
    return parseFloat(row?.value) || 0.3;
  } catch { return 0.3; }
}

function isSuppressed(suggestionType, participantId, value) {
  try {
    const row = db.prepare(`
      SELECT 1 FROM suggestion_history
      WHERE suggestion_type = ? AND participant_id IS ?
        AND suggested_value = ? AND dont_suggest_again = 1
      LIMIT 1
    `).get(suggestionType, participantId || null, String(value));
    return !!row;
  } catch { return false; }
}

function recordSuggestion(type, participantId, staffId, value, confidence, explanation) {
  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO suggestion_history (id, suggestion_type, participant_id, staff_id, suggested_value, confidence, explanation)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, type, participantId || null, staffId || null, String(value), confidence, JSON.stringify(explanation));
  } catch (err) {
    console.warn('[suggestionEngine] recordSuggestion error:', err.message);
  }
  return id;
}

/**
 * Get shift time and line-item suggestions.
 *
 * @param {object} opts
 * @param {string} opts.participant_id
 * @param {string} [opts.staff_id]
 * @param {string} [opts.date] - YYYY-MM-DD for day-of-week context
 * @param {string} [opts.shift_type] - defaults to 'standard'
 * @returns {object} suggestions with confidence and explanations
 */
export function getShiftSuggestions({ participant_id, staff_id, date, shift_type }) {
  const threshold = getConfidenceThreshold();
  const dow = date ? getDayOfWeek(date) : new Date().getDay();
  const dowName = dayName(dow);
  const sType = shift_type || 'standard';
  const scopeOpts = { participant_id, staff_id };

  const explanations = [];
  const result = {
    start_time: null,
    end_time: null,
    duration_hours: null,
    line_items: [],
    anomalies: [],
    explanations,
    suggestion_ids: []
  };

  // Start time
  const startAgg = getTopValue(`start_time:${dowName}:${sType}`, scopeOpts);
  if (startAgg && !isSuppressed('shift_time', participant_id, `start:${startAgg.value}`)) {
    const conf = confidenceFromCount(startAgg.count, startAgg.source);
    if (conf >= threshold) {
      const sid = recordSuggestion('shift_time', participant_id, staff_id, `start:${startAgg.value}`, conf, [`Start time ${startAgg.value} used ${startAgg.count} times (${startAgg.source}-level, ${dowName}s)`]);
      result.start_time = { value: startAgg.value, confidence: conf, source: startAgg.source, suggestion_id: sid };
      explanations.push(`Start time ${startAgg.value} was used in ${startAgg.count} ${dowName} shifts (${startAgg.source}-level pattern)`);
      result.suggestion_ids.push(sid);
    }
  }

  // End time
  const endAgg = getTopValue(`end_time:${dowName}:${sType}`, scopeOpts);
  if (endAgg && !isSuppressed('shift_time', participant_id, `end:${endAgg.value}`)) {
    const conf = confidenceFromCount(endAgg.count, endAgg.source);
    if (conf >= threshold) {
      const sid = recordSuggestion('shift_time', participant_id, staff_id, `end:${endAgg.value}`, conf, [`End time ${endAgg.value} used ${endAgg.count} times (${endAgg.source}-level, ${dowName}s)`]);
      result.end_time = { value: endAgg.value, confidence: conf, source: endAgg.source, suggestion_id: sid };
      explanations.push(`End time ${endAgg.value} was used in ${endAgg.count} ${dowName} shifts (${endAgg.source}-level pattern)`);
      result.suggestion_ids.push(sid);
    }
  }

  // Duration
  const durAgg = getTopValue(`duration:${dowName}:${sType}`, scopeOpts);
  if (durAgg) {
    const mins = parseInt(durAgg.value, 10);
    if (mins > 0) {
      const hours = Math.round((mins / 60) * 100) / 100;
      const conf = confidenceFromCount(durAgg.count, durAgg.source);
      if (conf >= threshold) {
        result.duration_hours = { value: hours, confidence: conf, source: durAgg.source };
      }
    }
  }

  // Line items — look up aggregates for this weekday + shift type
  const timeBucket = getTimeBucket(result.start_time?.value || '09:00');
  const lineItemAgg = getAggregates(`line_item:${dowName}:${sType}`, scopeOpts);
  if (lineItemAgg.rows.length === 0) {
    const fallback = getAggregates(`line_item:${sType}:${timeBucket || 'any'}`, scopeOpts);
    lineItemAgg.rows = fallback.rows;
    lineItemAgg.source = fallback.source;
  }

  if (lineItemAgg.rows.length > 0) {
    const seen = new Set();
    for (const row of lineItemAgg.rows.slice(0, 5)) {
      const ndisId = row.feature_value;
      if (seen.has(ndisId)) continue;
      seen.add(ndisId);

      if (isSuppressed('line_item', participant_id, ndisId)) continue;

      const conf = confidenceFromCount(row.count, lineItemAgg.source);
      if (conf < threshold) continue;

      const ndis = db.prepare('SELECT id, support_item_number, description, rate, unit FROM ndis_line_items WHERE id = ?').get(ndisId);
      if (!ndis) continue;

      const sid = recordSuggestion('line_item', participant_id, staff_id, ndisId, conf, [`${ndis.support_item_number} used ${row.count} times for ${lineItemAgg.source} on ${dowName}s`]);
      result.line_items.push({
        ndis_line_item_id: ndis.id,
        support_item_number: ndis.support_item_number,
        description: ndis.description,
        unit_price: ndis.rate,
        unit: ndis.unit,
        confidence: conf,
        source: lineItemAgg.source,
        suggestion_id: sid
      });
      explanations.push(`Line item ${ndis.support_item_number} was used in ${row.count} similar shifts (${lineItemAgg.source}-level)`);
      result.suggestion_ids.push(sid);
    }
  }

  if (explanations.length === 0) {
    explanations.push('Not enough shift history yet to make suggestions. Patterns will emerge as more shifts are logged.');
  }

  return result;
}

/**
 * Detect anomalies for a specific shift.
 */
export function detectAnomalies({ shift_id, participant_id, staff_id, start_time, end_time, line_items, date }) {
  const anomalies = [];

  // Overlapping shifts: same staff, overlapping time window
  if (staff_id && start_time && end_time) {
    try {
      const overlaps = db.prepare(`
        SELECT s.id, p.name as participant_name, s.start_time, s.end_time
        FROM shifts s
        JOIN participants p ON s.participant_id = p.id
        WHERE s.staff_id = ? AND s.id != ?
          AND s.start_time < ? AND s.end_time > ?
        LIMIT 3
      `).all(staff_id, shift_id || '', end_time, start_time);

      for (const o of overlaps) {
        anomalies.push({
          type: 'overlap',
          severity: 'warning',
          message: `Overlaps with shift for ${o.participant_name} (${o.start_time} - ${o.end_time})`,
          related_shift_id: o.id
        });
      }
    } catch { /* ignore */ }
  }

  // Missing break: shift > 5 hours
  if (start_time && end_time) {
    const extract = (t) => { const m = t.match(/(\d{1,2}):(\d{2})/); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; };
    const s = extract(start_time);
    const e = extract(end_time);
    if (s != null && e != null && (e - s) > 300) {
      anomalies.push({
        type: 'missing_break',
        severity: 'info',
        message: `Shift is ${Math.round((e - s) / 60 * 10) / 10} hours with no break noted. Ensure break compliance.`
      });
    }
  }

  // Unusual line item: never used for this participant before
  if (participant_id && Array.isArray(line_items)) {
    for (const li of line_items) {
      const ndisId = li.ndis_line_item_id || li.id;
      if (!ndisId) continue;
      try {
        const used = db.prepare(`
          SELECT COUNT(*) as c FROM learning_aggregates
          WHERE scope = 'participant' AND scope_id = ? AND feature_key LIKE 'line_item:%' AND feature_value = ?
        `).get(participant_id, ndisId);
        if (used && used.c === 0) {
          const ndis = db.prepare('SELECT support_item_number, description FROM ndis_line_items WHERE id = ?').get(ndisId);
          if (ndis) {
            anomalies.push({
              type: 'unusual_code',
              severity: 'info',
              message: `${ndis.support_item_number} has not been used for this participant before. Verify it's correct.`,
              ndis_line_item_id: ndisId
            });
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Weekend/holiday rate check
  if (date && Array.isArray(line_items)) {
    const dow = getDayOfWeek(date);
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend) {
      for (const li of line_items) {
        const ndisId = li.ndis_line_item_id || li.id;
        if (!ndisId) continue;
        try {
          const ndis = db.prepare('SELECT rate_type, description FROM ndis_line_items WHERE id = ?').get(ndisId);
          if (ndis && ndis.rate_type === 'weekday') {
            anomalies.push({
              type: 'rate_mismatch',
              severity: 'warning',
              message: `Shift is on ${dow === 0 ? 'Sunday' : 'Saturday'} but line item "${ndis.description?.slice(0, 60)}" uses weekday rate.`
            });
          }
        } catch { /* ignore */ }
      }
    }
  }

  return anomalies;
}

export default { getShiftSuggestions, detectAnomalies };
