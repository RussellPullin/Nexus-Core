/**
 * Automatic cleanup of duplicate shifts:
 * 1) Empty past duplicates when a noted shift exists at the same time (legacy rule).
 * 2) Exact same-slot copies (usually scheduled roster placeholders) — keep one, remove extras.
 */
import { db } from '../db/index.js';
import { shiftCompletionEvidenceSql } from '../lib/shiftBillingEligibility.js';
import { hardDeleteShiftRow } from './shiftHardDelete.service.js';
import { normalizeShiftDateTimePrefix } from './progressNoteMatcher.js';

/** Local 'YYYY-MM-DD' for "today" (server local time). */
function todayDateStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sameSlotKey(row) {
  return [
    row.participant_id,
    row.staff_id,
    normalizeShiftDateTimePrefix(row.start_time),
    normalizeShiftDateTimePrefix(row.end_time),
  ].join('|');
}

/** Lower score = preferred keeper when deduplicating an identical slot. */
function keeperScore(row) {
  const st = String(row.status || '').trim().toLowerCase();
  let score = 0;
  if (st === 'completed_by_admin') score -= 1000;
  else if (st === 'completed') score -= 500;
  if (row.recurring_group_id) score -= 100;
  if (row.roster_sent_at) score -= 50;
  if (row.notes && String(row.notes).trim()) score -= 25;
  if (row.shifter_shift_id && String(row.shifter_shift_id).trim()) score -= 10;
  return score;
}

function shiftIsBilled(row) {
  return (
    (row.billing_invoice_id != null && String(row.billing_invoice_id).trim() !== '') ||
    Number(row.has_legacy_invoice) === 1
  );
}

function shiftIsDeletableDuplicate(row) {
  const st = String(row.status || '').trim().toLowerCase();
  if (st === 'cancelled' || st === 'canceled') return false;
  if (shiftIsBilled(row)) return false;
  if (Number(row.has_completion_evidence) === 1) return false;
  return true;
}

/**
 * Find ids of empty duplicate shifts that are safe to delete.
 * @param {{ orgId?: string|null, now?: Date }} [opts]
 * @returns {Array<{ id: string, participant_id: string, staff_id: string, start_time: string, end_time: string }>}
 */
export function findDuplicateUnworkedShifts(opts = {}) {
  const orgId = opts.orgId ? String(opts.orgId).trim() : null;
  const today = todayDateStr(opts.now || new Date());

  // Normalised time expression so 'YYYY-MM-DD HH:MM:SS' and 'YYYY-MM-DDTHH:MM:SS' compare correctly.
  const norm = (col) => `REPLACE(${col}, ' ', 'T')`;

  const params = [];
  let orgClause = '';
  if (orgId) {
    orgClause = 'AND p.provider_org_id = ?';
    params.push(orgId);
  }
  // start date (first 10 chars of normalised start) strictly before today
  params.push(today);

  const candidates = db
    .prepare(
      `
      SELECT s.id, s.participant_id, s.staff_id, s.start_time, s.end_time
      FROM shifts s
      JOIN participants p ON p.id = s.participant_id
      WHERE 1 = 1
        ${orgClause}
        AND s.billing_invoice_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.shift_id = s.id)
        AND LOWER(COALESCE(s.status, '')) NOT IN ('cancelled', 'canceled')
        AND NOT ${shiftCompletionEvidenceSql('s')}
        AND substr(${norm('s.start_time')}, 1, 10) < ?
        AND EXISTS (
          SELECT 1 FROM shifts s2
          WHERE s2.id <> s.id
            AND s2.participant_id = s.participant_id
            AND s2.staff_id = s.staff_id
            AND ${norm('s2.start_time')} < ${norm('s.end_time')}
            AND ${norm('s2.end_time')} > ${norm('s.start_time')}
            AND ${shiftCompletionEvidenceSql('s2')}
        )
      ORDER BY s.start_time
    `,
    )
    .all(...params);

  return candidates;
}

/**
 * Delete empty duplicate shifts. Safe to call repeatedly (idempotent).
 * @param {{ orgId?: string|null, now?: Date, log?: Function }} [opts]
 * @returns {{ deleted: number, ids: string[] }}
 */
export function cleanupDuplicateUnworkedShifts(opts = {}) {
  const log = opts.log || (() => {});
  let rows;
  try {
    rows = findDuplicateUnworkedShifts(opts);
  } catch (e) {
    log('duplicate cleanup query failed', { message: e?.message || String(e) });
    return { deleted: 0, ids: [] };
  }

  const deletedIds = [];
  for (const row of rows) {
    try {
      const r = hardDeleteShiftRow(row.id, {
        suppressShifterId: false,
        nexusOrgId: opts.orgId || null,
        reason: 'duplicate_unworked_cleanup',
      });
      if (r.deleted) deletedIds.push(row.id);
    } catch (e) {
      log('duplicate cleanup delete failed', { id: row.id, message: e?.message || String(e) });
    }
  }

  if (deletedIds.length) {
    log('Removed empty duplicate shifts', { count: deletedIds.length });
  }
  return { deleted: deletedIds.length, ids: deletedIds };
}

/**
 * Find exact same-slot duplicate shifts (same participant, staff, start, end).
 * @param {{ orgId?: string|null }} [opts]
 */
export function findDuplicateSameSlotShifts(opts = {}) {
  const orgId = opts.orgId ? String(opts.orgId).trim() : null;
  const params = [];
  let orgClause = '';
  if (orgId) {
    orgClause = 'AND p.provider_org_id = ?';
    params.push(orgId);
  }

  const rows = db
    .prepare(
      `
      SELECT s.id, s.participant_id, s.staff_id, s.start_time, s.end_time, s.status, s.notes,
             s.recurring_group_id, s.roster_sent_at, s.shifter_shift_id, s.billing_invoice_id,
             s.created_at,
             CASE WHEN ${shiftCompletionEvidenceSql('s')} THEN 1 ELSE 0 END AS has_completion_evidence,
             CASE WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.shift_id = s.id) THEN 1 ELSE 0 END AS has_legacy_invoice
      FROM shifts s
      JOIN participants p ON p.id = s.participant_id
      WHERE 1 = 1
        ${orgClause}
      ORDER BY s.start_time, s.created_at
    `,
    )
    .all(...params);

  const groups = new Map();
  for (const row of rows) {
    const key = sameSlotKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const toDelete = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const scoreDiff = keeperScore(a) - keeperScore(b);
      if (scoreDiff !== 0) return scoreDiff;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    const keeper = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const row = sorted[i];
      if (!shiftIsDeletableDuplicate(row)) continue;
      if (row.id === keeper.id) continue;
      toDelete.push(row);
    }
  }
  return toDelete;
}

/**
 * Remove extra copies of the exact same roster slot (keeps the best single row per slot).
 * @param {{ orgId?: string|null, log?: Function }} [opts]
 */
export function cleanupDuplicateSameSlotShifts(opts = {}) {
  const log = opts.log || (() => {});
  let rows;
  try {
    rows = findDuplicateSameSlotShifts(opts);
  } catch (e) {
    log('same-slot duplicate cleanup query failed', { message: e?.message || String(e) });
    return { deleted: 0, ids: [] };
  }

  const deletedIds = [];
  for (const row of rows) {
    try {
      const r = hardDeleteShiftRow(row.id, {
        suppressShifterId: false,
        nexusOrgId: opts.orgId || null,
        reason: 'duplicate_same_slot_cleanup',
      });
      if (r.deleted) deletedIds.push(row.id);
    } catch (e) {
      log('same-slot duplicate cleanup delete failed', { id: row.id, message: e?.message || String(e) });
    }
  }

  if (deletedIds.length) {
    log('Removed same-slot duplicate shifts', { count: deletedIds.length });
  }
  return { deleted: deletedIds.length, ids: deletedIds };
}

/**
 * Run all duplicate-shift cleanup passes (unworked empties + same-slot copies).
 * @param {{ orgId?: string|null, now?: Date, log?: Function }} [opts]
 */
export function cleanupAllDuplicateShifts(opts = {}) {
  const unworked = cleanupDuplicateUnworkedShifts(opts);
  const sameSlot = cleanupDuplicateSameSlotShifts(opts);
  return {
    deleted: unworked.deleted + sameSlot.deleted,
    ids: [...unworked.ids, ...sameSlot.ids],
    unworked_removed: unworked.deleted,
    same_slot_removed: sameSlot.deleted,
  };
}
