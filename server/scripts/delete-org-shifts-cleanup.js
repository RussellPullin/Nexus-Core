#!/usr/bin/env node
/**
 * One-off: remove problematic shifts for a provider org so you can re-sync from Shifter / Excel
 * with correct participant links, charges, and travel.
 *
 * Default mode deletes **tenant-mismatched** rows: shifts where participant + staff are not both
 * valid for your org (same rules as the API’s tenantParticipantAndStaffClause). Typical causes:
 * wrong participant org after import, staff from another org, or legacy NULL participant org with
 * multi-tenant DB.
 *
 * `--all-for-org` deletes **every** shift tied to your org: staff in this org OR participant in
 * this org (plus legacy NULL participants when this DB is single-tenant). Use before a full
 * re-pull from Shifter. Always pair with `--execute`.
 *
 * Usage (from repo root, same DB as server — DATABASE_PATH / data/schedule.db):
 *
 *   # Preview (no changes)
 *   node server/scripts/delete-org-shifts-cleanup.js info@yourdomain.com
 *
 *   # Apply (only wrong participant/staff org links)
 *   node server/scripts/delete-org-shifts-cleanup.js info@yourdomain.com --execute
 *
 *   # Wipe every shift for your org, then re-sync (what you usually want for a clean re-pull)
 *   node server/scripts/delete-org-shifts-cleanup.js info@yourdomain.com --all-for-org --execute
 *
 * Or set org explicitly:
 *   NEXUS_ORG_ID=<uuid> node server/scripts/delete-org-shifts-cleanup.js --execute
 *
 * Extra:
 *   --dedupe-shifter-id   After main delete, remove duplicate rows with the same shifter_shift_id
 *                         (keeps earliest start_time, then smallest id).
 *
 * Unmatched / “unlinked” rows on Shifts (Progress Notes webhook) live in **app_shifts**, not shifts.
 *   --all-for-org         Also deletes those app_shifts rows for your org (same as --delete-app-shifts).
 *   --delete-app-shifts   Only clear app_shifts for this org (no changes to shifts unless combined).
 *   --purge-all-app-shifts  DELETE every row in app_shifts (nuclear). Use when rows have NULL/mismatched
 *                         source_org_id (webhook without org_id, or UUID typo vs users.org_id).
 */
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

import { db } from '../src/db/index.js';
import { getSingleDistinctUserOrgId } from '../src/middleware/roles.js';

db.pragma('foreign_keys = ON');

function parseArgs(argv) {
  const execute = argv.includes('--execute');
  const allForOrg = argv.includes('--all-for-org') || argv.includes('--wipe-org-shifts');
  const purgeAllAppShifts = argv.includes('--purge-all-app-shifts');
  const deleteAppShifts = allForOrg || argv.includes('--delete-app-shifts') || purgeAllAppShifts;
  const dedupeShifter = argv.includes('--dedupe-shifter-id');
  const emailArg = argv.find((a) => !a.startsWith('--') && a.includes('@'));
  return { execute, allForOrg, deleteAppShifts, purgeAllAppShifts, dedupeShifter, emailArg: emailArg ? String(emailArg).trim().toLowerCase() : '' };
}

function resolveOrgId(emailFromArg) {
  const envOrg = (process.env.NEXUS_ORG_ID || '').trim();
  if (envOrg) return envOrg;

  const email = emailFromArg || (process.env.NEXUS_CLEANUP_USER_EMAIL || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('Set NEXUS_ORG_ID, or pass a Nexus user email (e.g. info@...) who belongs to the org.');
    process.exit(1);
  }
  const user = db.prepare('SELECT id, email, org_id FROM users WHERE lower(trim(email)) = ?').get(email);
  if (!user?.org_id || String(user.org_id).trim() === '') {
    console.error(`No org_id for user ${email}. Fix the user row or set NEXUS_ORG_ID.`);
    process.exit(1);
  }
  return String(user.org_id).trim();
}

/** Same semantics as tenantParticipantClause + staff org (see server/src/lib/orgScopeSql.js). */
function goodScopedShiftWhere(orgId) {
  const single = getSingleDistinctUserOrgId();
  const legacy = Boolean(single && single === orgId);

  if (legacy) {
    return {
      sql: `(
          p.provider_org_id = ? OR p.provider_org_id IS NULL OR TRIM(COALESCE(p.provider_org_id, '')) = ''
        ) AND st.org_id = ?`,
      params: [orgId, orgId],
      legacy: true,
    };
  }
  return {
    sql: `p.provider_org_id = ? AND st.org_id = ?`,
    params: [orgId, orgId],
    legacy: false,
  };
}

/** Shift “touches” this org on at least one side (participant or staff). */
function touchesOrgWhere(orgId, legacy) {
  if (legacy) {
    return {
      sql: `(
        st.org_id = ? OR p.provider_org_id = ? OR p.provider_org_id IS NULL OR TRIM(COALESCE(p.provider_org_id, '')) = ''
      )`,
      params: [orgId, orgId],
    };
  }
  return {
    sql: `(st.org_id = ? OR p.provider_org_id = ?)`,
    params: [orgId, orgId],
  };
}

function tableExists(name) {
  const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(r);
}

/**
 * Clear all known FK paths into shifts before DELETE (billing lines can reference shift_line_items too).
 */
function detachShiftReferences(ids) {
  const empty = {
    billingLinesCleared: 0,
    shiftsBillingInvoiceNull: 0,
    invoicesDeleted: 0,
    shiftLineItemsDeleted: 0,
    progressNotesNulled: 0,
    caseNotesNulled: 0,
    participantDocsNulled: 0,
    learningEventsNulled: 0,
    suggestionHistoryNulled: 0,
  };
  if (!ids.length) return empty;

  const ph = ids.map(() => '?').join(',');
  const stats = { ...empty };

  if (tableExists('billing_invoice_line_items')) {
    const hasSli = tableExists('shift_line_items');
    const r = hasSli
      ? db
          .prepare(
            `
        UPDATE billing_invoice_line_items
        SET source_shift_id = NULL, source_shift_line_item_id = NULL
        WHERE source_shift_id IN (${ph})
           OR source_shift_line_item_id IN (SELECT id FROM shift_line_items WHERE shift_id IN (${ph}))
      `
          )
          .run(...ids, ...ids)
      : db
          .prepare(
            `
        UPDATE billing_invoice_line_items
        SET source_shift_id = NULL, source_shift_line_item_id = NULL
        WHERE source_shift_id IN (${ph})
      `
          )
          .run(...ids);
    stats.billingLinesCleared = r.changes ?? 0;
  }

  const shiftCols = db.prepare('PRAGMA table_info(shifts)').all();
  if (shiftCols.some((c) => c.name === 'billing_invoice_id')) {
    const r = db.prepare(`UPDATE shifts SET billing_invoice_id = NULL WHERE id IN (${ph})`).run(...ids);
    stats.shiftsBillingInvoiceNull = r.changes ?? 0;
  }

  if (tableExists('invoices')) {
    const r = db.prepare(`DELETE FROM invoices WHERE shift_id IN (${ph})`).run(...ids);
    stats.invoicesDeleted = r.changes ?? 0;
  }

  if (tableExists('shift_line_items')) {
    const r = db.prepare(`DELETE FROM shift_line_items WHERE shift_id IN (${ph})`).run(...ids);
    stats.shiftLineItemsDeleted = r.changes ?? 0;
  }

  if (tableExists('progress_notes')) {
    const r = db.prepare(`UPDATE progress_notes SET shift_id = NULL WHERE shift_id IN (${ph})`).run(...ids);
    stats.progressNotesNulled = r.changes ?? 0;
  }

  if (tableExists('case_notes')) {
    const cnCols = db.prepare('PRAGMA table_info(case_notes)').all();
    if (cnCols.some((c) => c.name === 'shift_id')) {
      const r = db.prepare(`UPDATE case_notes SET shift_id = NULL WHERE shift_id IN (${ph})`).run(...ids);
      stats.caseNotesNulled = r.changes ?? 0;
    }
  }

  if (tableExists('participant_documents')) {
    const pdCols = db.prepare('PRAGMA table_info(participant_documents)').all();
    if (pdCols.some((c) => c.name === 'shift_id')) {
      const r = db.prepare(`UPDATE participant_documents SET shift_id = NULL WHERE shift_id IN (${ph})`).run(...ids);
      stats.participantDocsNulled = r.changes ?? 0;
    }
  }

  if (tableExists('learning_events')) {
    const leCols = db.prepare('PRAGMA table_info(learning_events)').all();
    if (leCols.some((c) => c.name === 'shift_id')) {
      const r = db.prepare(`UPDATE learning_events SET shift_id = NULL WHERE shift_id IN (${ph})`).run(...ids);
      stats.learningEventsNulled = r.changes ?? 0;
    }
  }

  if (tableExists('suggestion_history')) {
    const shCols = db.prepare('PRAGMA table_info(suggestion_history)').all();
    if (shCols.some((c) => c.name === 'shift_id')) {
      const r = db.prepare(`UPDATE suggestion_history SET shift_id = NULL WHERE shift_id IN (${ph})`).run(...ids);
      stats.suggestionHistoryNulled = r.changes ?? 0;
    }
  }

  return stats;
}

function mergeDetachStats(a, b) {
  if (!a) return b ? { ...b } : {};
  if (!b) return { ...a };
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = (out[k] || 0) + (b[k] || 0);
  }
  return out;
}

/**
 * Webhook “unmatched” rows (Shifts page → unmatched section).
 * Rows often have source_org_id NULL (webhook body is a raw array) or must match case-insensitively.
 * When this DB has only one distinct users.org_id and it equals orgId, NULL/blank rows are treated as that org.
 */
function appShiftsMatchSingleTenant(orgId) {
  const single = getSingleDistinctUserOrgId();
  return Boolean(single && String(single).trim() === String(orgId).trim());
}

/** @param {boolean} purgeAll DELETE entire table */
function countAppShiftsForOrg(orgId, purgeAll) {
  if (!tableExists('app_shifts')) return 0;
  if (purgeAll) return db.prepare('SELECT COUNT(*) AS c FROM app_shifts').get()?.c ?? 0;
  if (appShiftsMatchSingleTenant(orgId)) {
    return (
      db
        .prepare(
          `
      SELECT COUNT(*) AS c FROM app_shifts
      WHERE lower(trim(coalesce(source_org_id,''))) = lower(trim(?))
         OR source_org_id IS NULL OR trim(coalesce(source_org_id,'')) = ''
    `
        )
        .get(orgId)?.c ?? 0
    );
  }
  return (
    db
      .prepare(
        `
    SELECT COUNT(*) AS c FROM app_shifts
    WHERE lower(trim(coalesce(source_org_id,''))) = lower(trim(?))
  `
      )
      .get(orgId)?.c ?? 0
  );
}

function deleteAppShiftsForOrg(orgId, purgeAll) {
  if (!tableExists('app_shifts')) return 0;
  if (purgeAll) {
    return db.prepare('DELETE FROM app_shifts').run().changes ?? 0;
  }
  if (appShiftsMatchSingleTenant(orgId)) {
    return (
      db
        .prepare(
          `
      DELETE FROM app_shifts
      WHERE lower(trim(coalesce(source_org_id,''))) = lower(trim(?))
         OR source_org_id IS NULL OR trim(coalesce(source_org_id,'')) = ''
    `
        )
        .run(orgId).changes ?? 0
    );
  }
  return (
    db
      .prepare(
        `
    DELETE FROM app_shifts WHERE lower(trim(coalesce(source_org_id,''))) = lower(trim(?))
  `
      )
      .run(orgId).changes ?? 0
  );
}

function selectIdsToDeleteMismatched(orgId) {
  const good = goodScopedShiftWhere(orgId);
  const touch = touchesOrgWhere(orgId, good.legacy);
  const sql = `
    SELECT s.id
    FROM shifts s
    JOIN participants p ON p.id = s.participant_id
    JOIN staff st ON st.id = s.staff_id
    WHERE (${touch.sql}) AND NOT (${good.sql})
  `;
  const params = [...touch.params, ...good.params];
  return db.prepare(sql).all(...params).map((r) => r.id);
}

/**
 * Every shift tied to this org on either side (staff.org_id or participant.provider_org_id).
 * Broader than {@link goodScopedShiftWhere} (which requires both). Use for a full wipe before re-sync.
 */
function selectIdsToDeleteAllTouchingOrg(orgId) {
  const sql = `
    SELECT s.id
    FROM shifts s
    JOIN participants p ON p.id = s.participant_id
    JOIN staff st ON st.id = s.staff_id
    WHERE st.org_id = ? OR p.provider_org_id = ?
  `;
  return db.prepare(sql).all(orgId, orgId).map((r) => r.id);
}

function selectIdsToDeleteAllForOrg(orgId) {
  return selectIdsToDeleteAllTouchingOrg(orgId);
}

function detachAndDeleteShifts(ids) {
  if (!ids.length) return { deleted: 0, detach: null };
  const detach = detachShiftReferences(ids);
  const ph = ids.map(() => '?').join(',');
  const deleted = db.prepare(`DELETE FROM shifts WHERE id IN (${ph})`).run(...ids).changes ?? 0;
  return { deleted, detach };
}

/**
 * Duplicate shifter_shift_id among org-scoped “good” shifts: keep one per id, drop the rest.
 */
function dedupeShifterShiftIds(orgId) {
  const good = goodScopedShiftWhere(orgId);
  const dupes = db
    .prepare(
      `
    SELECT TRIM(s.shifter_shift_id) AS sid
    FROM shifts s
    JOIN participants p ON p.id = s.participant_id
    JOIN staff st ON st.id = s.staff_id
    WHERE ${good.sql}
      AND s.shifter_shift_id IS NOT NULL AND TRIM(s.shifter_shift_id) != ''
    GROUP BY TRIM(s.shifter_shift_id)
    HAVING COUNT(*) > 1
  `
    )
    .all(...good.params)
    .map((r) => r.sid)
    .filter(Boolean);

  const toDelete = [];
  for (const sid of dupes) {
    const rows = db
      .prepare(
        `
      SELECT s.id, s.start_time
      FROM shifts s
      JOIN participants p ON p.id = s.participant_id
      JOIN staff st ON st.id = s.staff_id
      WHERE ${good.sql} AND TRIM(s.shifter_shift_id) = ?
      ORDER BY s.start_time ASC, s.id ASC
    `
      )
      .all(...good.params, sid);
    for (let i = 1; i < rows.length; i++) toDelete.push(rows[i].id);
  }
  return toDelete;
}

const { execute, allForOrg, deleteAppShifts, purgeAllAppShifts, dedupeShifter, emailArg } = parseArgs(
  process.argv.slice(2)
);

/** Full wipe of app_shifts only — no org resolution (rows often have NULL source_org_id). */
if (purgeAllAppShifts) {
  const totalApp = countAppShiftsForOrg('', true);
  if (!execute) {
    console.log(`Would DELETE ALL ${totalApp} row(s) from app_shifts. Re-run with --execute.`);
    process.exit(0);
  }
  const n = deleteAppShiftsForOrg('', true);
  console.log(`Deleted ${n} row(s) from app_shifts (full purge).`);
  process.exit(0);
}

const orgId = resolveOrgId(emailArg);

const good = goodScopedShiftWhere(orgId);
console.log('Organisation id:', orgId);
console.log('Legacy single-tenant NULL participants:', good.legacy ? 'yes' : 'no');
console.log(
  'Mode:',
  allForOrg ? 'ALL shifts touching this org (staff or participant) — nuclear wipe' : 'Mismatched tenant rows only'
);
if (deleteAppShifts) {
  const st = appShiftsMatchSingleTenant(orgId)
    ? ' (includes NULL/blank source_org_id — single org in users table)'
    : ' (strict source_org_id match, case-insensitive)';
  console.log('Unmatched app_shifts (webhook queue): will be cleared for this org' + st);
}

let ids = allForOrg ? selectIdsToDeleteAllForOrg(orgId) : selectIdsToDeleteMismatched(orgId);

console.log(`Selected ${ids.length} shift(s).`);
if (ids.length && ids.length <= 50) {
  for (const id of ids) console.log('  ', id);
} else if (ids.length > 50) {
  console.log('  (first 10)', ids.slice(0, 10).join(', '), '...');
}

if (!execute) {
  console.log('\nDry run only. Re-run with --execute to delete.');
  if (deleteAppShifts) {
    const n = countAppShiftsForOrg(orgId, false);
    console.log(`Unmatched app_shifts rows (would delete): ${n}`);
  }
  if (!allForOrg && ids.length === 0 && !deleteAppShifts) {
    console.log(
      '\nNote: Default mode only removes broken participant/staff org links. If every shift looks ' +
        '"valid" to Nexus, this count stays 0 — nothing is removed.\n' +
        'To clear all shifts for your org and re-pull from Shifter, use:\n' +
        '  --all-for-org --execute'
    );
  }
  if (!allForOrg && ids.length === 0 && deleteAppShifts) {
    console.log(
      '\nNote: The “unlinked” list on Shifts is **app_shifts** (not the shifts table). Use --delete-app-shifts --execute to clear it, or --all-for-org --execute for shifts + app_shifts.'
    );
  }
  if (dedupeShifter) {
    const d = dedupeShifterShiftIds(orgId);
    console.log(`\n[preview] --dedupe-shifter-id would remove ${d.length} duplicate row(s).`);
  }
  process.exit(0);
}

const run = db.transaction(() => {
  let total = 0;
  let detachTotals = null;

  if (ids.length) {
    const r = detachAndDeleteShifts(ids);
    total += r.deleted;
    detachTotals = r.detach;
  }

  let deduped = 0;
  if (dedupeShifter) {
    const dupIds = dedupeShifterShiftIds(orgId);
    if (dupIds.length) {
      const r = detachAndDeleteShifts(dupIds);
      deduped = r.deleted;
      detachTotals = detachTotals ? mergeDetachStats(detachTotals, r.detach) : r.detach;
    }
  }

  let appShiftsDeleted = 0;
  if (deleteAppShifts) {
    appShiftsDeleted = deleteAppShiftsForOrg(orgId, false);
  }

  return { total, detachTotals, deduped, appShiftsDeleted };
});

const result = run();
console.log('\nDone.');
console.log('Shifts deleted:', result.total);
if (result.appShiftsDeleted) console.log('app_shifts (unmatched / unlinked) deleted:', result.appShiftsDeleted);
if (result.deduped) console.log('Extra duplicate shifter_shift_id rows removed:', result.deduped);
if (result.detachTotals) {
  const d = result.detachTotals;
  const lines = [];
  if (d.billingLinesCleared) lines.push(`billing_invoice_line_items refs cleared: ${d.billingLinesCleared}`);
  if (d.shiftsBillingInvoiceNull) lines.push(`shifts.billing_invoice_id nulled: ${d.shiftsBillingInvoiceNull}`);
  if (d.invoicesDeleted) lines.push(`legacy invoices deleted: ${d.invoicesDeleted}`);
  if (d.shiftLineItemsDeleted) lines.push(`shift_line_items deleted: ${d.shiftLineItemsDeleted}`);
  if (d.progressNotesNulled) lines.push(`progress_notes.shift_id nulled: ${d.progressNotesNulled}`);
  if (d.caseNotesNulled) lines.push(`case_notes.shift_id nulled: ${d.caseNotesNulled}`);
  if (d.participantDocsNulled) lines.push(`participant_documents.shift_id nulled: ${d.participantDocsNulled}`);
  if (d.learningEventsNulled) lines.push(`learning_events.shift_id nulled: ${d.learningEventsNulled}`);
  if (d.suggestionHistoryNulled) lines.push(`suggestion_history.shift_id nulled: ${d.suggestionHistoryNulled}`);
  if (lines.length) console.log('Dependency cleanup:', lines.join('; '));
}

