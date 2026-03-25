/**
 * Scheduled jobs for the Learning Layer.
 * Uses setInterval since the app runs as a single Express process (no cron infra).
 *
 * - Hourly: refresh recency scores (exponential decay)
 * - Daily: prune old events + stale aggregates, compute metrics
 */

import { db } from '../db/index.js';
import {
  refreshRecencyScores,
  pruneOldEvents,
  pruneStaleAggregates,
  computeMetrics
} from '../services/featureStore.service.js';

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

let hourlyTimer = null;
let dailyTimer = null;

function getRetentionDays() {
  try {
    const row = db.prepare("SELECT value FROM learning_config WHERE key = 'event_retention_days'").get();
    return parseInt(row?.value) || 730;
  } catch { return 730; }
}

function runHourlyJob() {
  try {
    const updated = refreshRecencyScores();
    if (updated > 0) {
      console.log(`[learningJobs] hourly: refreshed ${updated} aggregate recency scores`);
    }
  } catch (err) {
    console.warn('[learningJobs] hourly error:', err.message);
  }
}

function runDailyJob() {
  try {
    const retentionDays = getRetentionDays();
    const pruned = pruneOldEvents(retentionDays);
    const stale = pruneStaleAggregates(0.01);
    const metrics = computeMetrics();

    console.log(`[learningJobs] daily: pruned ${pruned} old events, ${stale} stale aggregates`);
    console.log(`[learningJobs] daily metrics:`, JSON.stringify(metrics.suggestions));
  } catch (err) {
    console.warn('[learningJobs] daily error:', err.message);
  }
}

/**
 * Start the scheduled learning jobs.
 * Safe to call multiple times (idempotent).
 */
export function startLearningJobs() {
  if (hourlyTimer) return;

  console.log('[learningJobs] Starting learning layer scheduled jobs');

  // Run initial refresh after a short delay (let the DB settle)
  setTimeout(() => {
    runHourlyJob();
    runDailyJob();
  }, 5000);

  hourlyTimer = setInterval(runHourlyJob, ONE_HOUR);
  dailyTimer = setInterval(runDailyJob, ONE_DAY);
}

/**
 * Stop the scheduled jobs (for graceful shutdown / tests).
 */
export function stopLearningJobs() {
  if (hourlyTimer) { clearInterval(hourlyTimer); hourlyTimer = null; }
  if (dailyTimer) { clearInterval(dailyTimer); dailyTimer = null; }
}

export default { startLearningJobs, stopLearningJobs };
