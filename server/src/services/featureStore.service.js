/**
 * Feature Store service.
 * Maintains pre-computed aggregates in learning_aggregates with recency weighting.
 *
 * Scopes: 'participant' (per-client), 'staff' (per-worker), 'org' (global fallback).
 * Feature keys encode context: "start_time:tuesday:standard", "line_item:standard:morning", etc.
 *
 * Recency weighting: score = sum(0.97^days_ago) — half-life ~23 days.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

const DECAY_RATE = 0.97;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function dayName(dayOfWeek) {
  return DAY_NAMES[dayOfWeek] || 'unknown';
}

const upsertStmt = db.prepare(`
  INSERT INTO learning_aggregates (id, scope, scope_id, feature_key, feature_value, count, recency_score, last_seen, updated_at)
  VALUES (?, ?, ?, ?, ?, 1, 1.0, datetime('now'), datetime('now'))
  ON CONFLICT(scope, scope_id, feature_key, feature_value)
  DO UPDATE SET
    count = count + 1,
    recency_score = recency_score + 1.0,
    last_seen = datetime('now'),
    updated_at = datetime('now')
`);

/**
 * Increment a single aggregate counter.
 */
export function incrementAggregate(scope, scopeId, featureKey, featureValue) {
  if (!featureKey || featureValue == null) return;
  try {
    upsertStmt.run(uuidv4(), scope, scopeId || null, featureKey, String(featureValue));
  } catch (err) {
    console.warn('[featureStore] increment error:', err.message);
  }
}

/**
 * Process a shift event and update all relevant aggregates.
 * Called after each shift_created / shift_edited event.
 */
export function updateAggregatesForShift({ participant_id, staff_id, day_of_week, time_bucket, start_time, end_time, duration_minutes, shift_type, line_items }) {
  const dow = day_of_week != null ? dayName(day_of_week) : null;
  const sType = shift_type || 'standard';

  const scopes = [];
  if (participant_id) scopes.push({ scope: 'participant', id: participant_id });
  if (staff_id) scopes.push({ scope: 'staff', id: staff_id });
  scopes.push({ scope: 'org', id: null });

  for (const { scope, id } of scopes) {
    if (dow && start_time) {
      const startVal = typeof start_time === 'string' ? start_time.match(/(\d{2}:\d{2})/)?.[1] : null;
      if (startVal) incrementAggregate(scope, id, `start_time:${dow}:${sType}`, startVal);
    }
    if (dow && end_time) {
      const endVal = typeof end_time === 'string' ? end_time.match(/(\d{2}:\d{2})/)?.[1] : null;
      if (endVal) incrementAggregate(scope, id, `end_time:${dow}:${sType}`, endVal);
    }
    if (dow && duration_minutes) {
      incrementAggregate(scope, id, `duration:${dow}:${sType}`, String(duration_minutes));
    }
    if (Array.isArray(line_items)) {
      for (const li of line_items) {
        const itemId = li.ndis_line_item_id || li.id;
        if (itemId) {
          incrementAggregate(scope, id, `line_item:${sType}:${time_bucket || 'any'}`, itemId);
          if (dow) {
            incrementAggregate(scope, id, `line_item:${dow}:${sType}`, itemId);
          }
        }
      }
    }
  }
}

/**
 * Refresh recency scores for all aggregates by applying exponential decay.
 * Called by scheduled job (hourly or daily).
 */
export function refreshRecencyScores() {
  try {
    const rows = db.prepare(`
      SELECT id, last_seen,
             julianday('now') - julianday(last_seen) AS days_ago
      FROM learning_aggregates
      WHERE last_seen IS NOT NULL
    `).all();

    const update = db.prepare('UPDATE learning_aggregates SET recency_score = ?, updated_at = datetime(\'now\') WHERE id = ?');
    const txn = db.transaction(() => {
      for (const row of rows) {
        const daysAgo = row.days_ago || 0;
        const newScore = Math.pow(DECAY_RATE, daysAgo) * row.count;
        update.run(Math.max(0.001, newScore), row.id);
      }
    });
    txn();
    return rows.length;
  } catch (err) {
    console.warn('[featureStore] refreshRecencyScores error:', err.message);
    return 0;
  }
}

/**
 * Prune old learning events beyond retention period.
 */
export function pruneOldEvents(retentionDays) {
  if (!retentionDays || retentionDays <= 0) return 0;
  try {
    const result = db.prepare(`
      DELETE FROM learning_events
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
    return result.changes;
  } catch (err) {
    console.warn('[featureStore] pruneOldEvents error:', err.message);
    return 0;
  }
}

/**
 * Prune aggregates with very low recency scores (effectively forgotten).
 */
export function pruneStaleAggregates(minScore = 0.01) {
  try {
    const result = db.prepare('DELETE FROM learning_aggregates WHERE recency_score < ?').run(minScore);
    return result.changes;
  } catch (err) {
    console.warn('[featureStore] pruneStaleAggregates error:', err.message);
    return 0;
  }
}

/**
 * Get aggregates for a feature key, searching through the scope hierarchy:
 * participant -> staff -> org.
 * Returns array of { feature_value, count, recency_score } sorted by recency_score desc.
 */
export function getAggregates(featureKey, { participant_id, staff_id, minCount = 1 } = {}) {
  const tryScope = (scope, scopeId) => {
    return db.prepare(`
      SELECT feature_value, count, recency_score, last_seen
      FROM learning_aggregates
      WHERE scope = ? AND scope_id IS ? AND feature_key = ? AND count >= ?
      ORDER BY recency_score DESC
      LIMIT 20
    `).all(scope, scopeId || null, featureKey, minCount);
  };

  if (participant_id) {
    const rows = tryScope('participant', participant_id);
    if (rows.length > 0) return { rows, source: 'participant' };
  }
  if (staff_id) {
    const rows = tryScope('staff', staff_id);
    if (rows.length > 0) return { rows, source: 'staff' };
  }
  const rows = tryScope('org', null);
  return { rows, source: 'org' };
}

/**
 * Get the top value for a feature key (most common weighted by recency).
 */
export function getTopValue(featureKey, opts = {}) {
  const { rows, source } = getAggregates(featureKey, opts);
  if (!rows || rows.length === 0) return null;
  return { value: rows[0].feature_value, count: rows[0].count, recency_score: rows[0].recency_score, source };
}

/**
 * Compute metrics for the learning system dashboard.
 */
export function computeMetrics() {
  try {
    const total = db.prepare("SELECT COUNT(*) as c FROM suggestion_history").get()?.c || 0;
    const accepted = db.prepare("SELECT COUNT(*) as c FROM suggestion_history WHERE outcome = 'accepted'").get()?.c || 0;
    const rejected = db.prepare("SELECT COUNT(*) as c FROM suggestion_history WHERE outcome = 'rejected'").get()?.c || 0;
    const suppressed = db.prepare("SELECT COUNT(*) as c FROM suggestion_history WHERE dont_suggest_again = 1").get()?.c || 0;
    const eventCount = db.prepare("SELECT COUNT(*) as c FROM learning_events").get()?.c || 0;
    const aggregateCount = db.prepare("SELECT COUNT(*) as c FROM learning_aggregates").get()?.c || 0;

    const csvTotal = db.prepare("SELECT COUNT(*) as c FROM csv_mapping_memory").get()?.c || 0;
    const csvCorrected = db.prepare("SELECT SUM(correction_count) as c FROM csv_mapping_memory").get()?.c || 0;

    return {
      suggestions: { total, accepted, rejected, suppressed, acceptance_rate: total > 0 ? accepted / total : 0 },
      events: { total: eventCount },
      aggregates: { total: aggregateCount },
      csv_mappings: { total: csvTotal, corrections: csvCorrected || 0 }
    };
  } catch (err) {
    console.warn('[featureStore] computeMetrics error:', err.message);
    return { suggestions: {}, events: {}, aggregates: {}, csv_mappings: {} };
  }
}

export default {
  incrementAggregate, updateAggregatesForShift,
  refreshRecencyScores, pruneOldEvents, pruneStaleAggregates,
  getAggregates, getTopValue, computeMetrics, dayName
};
