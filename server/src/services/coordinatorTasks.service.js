/**
 * Coordinator Tasks Service - support coordinator activity logging and billing.
 * Tasks: email, meeting (f2f/non-f2f), phone, etc. with evidence and optional travel.
 */
import { db } from '../db/index.js';
import { getDefaultLineItemForParticipant } from './progressNoteMatcher.js';
import { getShiftDayType } from '../lib/ndisDay.js';
import { roundMoney } from '../lib/invoiceGst.js';
import { parseRegistrationGroup } from '../lib/travel.js';
import { getEffectiveNdisRate } from '../lib/ndisRates.js';

/**
 * Provider travel km (07_799_*) must match the participant's Support Coordination registration group
 * (e.g. 0132 standard SC, 0106 psychosocial). A bare LIKE '07_799%' is ambiguous in SQLite.
 */
export function resolveSupportCoordProviderTravelKmItem(db, tasks) {
  let regGroup = null;
  for (const t of tasks || []) {
    const sn = t?.support_item_number;
    if (!sn) continue;
    const s = String(sn).trim();
    if (s.includes('_799_')) continue;
    regGroup = parseRegistrationGroup(s);
    if (regGroup) break;
  }
  const pick = (pattern) =>
    db
      .prepare(
        `SELECT id, support_item_number, description, rate, unit FROM ndis_line_items
         WHERE support_item_number LIKE ? ORDER BY support_item_number LIMIT 1`
      )
      .get(pattern);
  if (regGroup) {
    const row = pick(`07_799_${regGroup}%`);
    if (row) return row;
  }
  return pick('07_799_0132%') || pick('07_799%');
}

/** NDIS 07_002_* — Support Coordination Level 2: Coordination of Supports (default for SC tasks). */
export const SC_LEVEL2_ITEM_PATTERN = '07_002%';

function isSupportCoordHourlyItem(nli) {
  if (!nli) return false;
  const sn = String(nli.support_item_number || '');
  if (sn.includes('_799_')) return false;
  return nli.support_category === '07' || sn.startsWith('07_');
}

function isSupportCoordLevel2Item(nli) {
  if (!isSupportCoordHourlyItem(nli)) return false;
  const sn = String(nli.support_item_number || '');
  if (sn.startsWith('07_002')) return true;
  return /level\s*2/i.test(String(nli.description || ''));
}

/** SQL fragment: prefer Level 2 SC line items when multiple 07 hourly items match. */
const SC_LEVEL2_ORDER_SQL = `
  (CASE WHEN nli.support_item_number LIKE '07_002%' THEN 0
        WHEN nli.description LIKE '%Level 2%' THEN 1
        ELSE 2 END),
  nli.support_item_number`;

/**
 * Get default support coordination line item for participant (category 07).
 * Uses participant remoteness for rate (standard vs remote). Falls back to catalogue 07 hourly.
 */
export function getSupportCoordLineItem(participantId, activityDate) {
  const dateStr = activityDate?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const dayType = getShiftDayType(`${dateStr}T09:00:00`);
  const participant = db.prepare('SELECT default_ndis_line_item_id, remoteness FROM participants WHERE id = ?').get(participantId);
  const remoteness = participant?.remoteness || 'standard';

  const toResult = (row) => ({
    id: row.ndis_line_item_id || row.id,
    rate: Number(getEffectiveNdisRate(row, remoteness)) || 0,
    unit: row.unit || 'hour',
    support_item_number: row.support_item_number
  });

  if (participant?.default_ndis_line_item_id) {
    const nli = db
      .prepare(
        `SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type, support_item_number, support_category, description
         FROM ndis_line_items WHERE id = ?`
      )
      .get(participant.default_ndis_line_item_id);
    if (isSupportCoordLevel2Item(nli)) {
      const itemRateType = nli.rate_type || 'weekday';
      if (itemRateType === dayType || !nli.rate_type) return toResult(nli);
    }
  }

  const fromPlan = db.prepare(`
    SELECT bli.ndis_line_item_id, nli.id, nli.rate, nli.rate_remote, nli.rate_very_remote, nli.unit, nli.rate_type, nli.support_item_number, nli.description
    FROM plan_budgets pb
    JOIN ndis_plans np ON np.id = pb.plan_id
    JOIN budget_line_items bli ON bli.budget_id = pb.id
    JOIN ndis_line_items nli ON nli.id = bli.ndis_line_item_id
    WHERE np.participant_id = ? AND np.start_date <= ? AND np.end_date >= ?
      AND pb.category = '07'
      AND nli.support_item_number NOT LIKE '07_799%'
      AND (nli.unit = 'hour' OR nli.unit = 'hr')
    ORDER BY ${SC_LEVEL2_ORDER_SQL}
    LIMIT 1
  `).get(participantId, dateStr, dateStr);

  if (fromPlan?.ndis_line_item_id) {
    const itemRateType = fromPlan.rate_type || 'weekday';
    if (itemRateType === dayType || !fromPlan.rate_type) return toResult(fromPlan);
  }

  const fromPlanBroad = db.prepare(`
    SELECT bli.ndis_line_item_id, nli.id, nli.rate, nli.rate_remote, nli.rate_very_remote, nli.unit, nli.rate_type, nli.support_item_number, nli.description
    FROM plan_budgets pb
    JOIN ndis_plans np ON np.id = pb.plan_id
    JOIN budget_line_items bli ON bli.budget_id = pb.id
    JOIN ndis_line_items nli ON nli.id = bli.ndis_line_item_id
    WHERE np.participant_id = ? AND np.start_date <= ? AND np.end_date >= ?
      AND (nli.support_category = '07' OR nli.support_item_number LIKE '07_%')
      AND nli.support_item_number NOT LIKE '07_799%'
      AND (nli.unit = 'hour' OR nli.unit = 'hr')
    ORDER BY ${SC_LEVEL2_ORDER_SQL}
    LIMIT 1
  `).get(participantId, dateStr, dateStr);

  if (fromPlanBroad?.ndis_line_item_id) {
    const itemRateType = fromPlanBroad.rate_type || 'weekday';
    if (itemRateType === dayType || !fromPlanBroad.rate_type) return toResult(fromPlanBroad);
  }

  const level2Catalogue = db.prepare(`
    SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type, support_item_number, description
    FROM ndis_line_items
    WHERE support_item_number LIKE '07_002%'
      AND support_item_number NOT LIKE '07_799%'
      AND (rate_type = ? OR rate_type IS NULL OR rate_type = 'weekday')
      AND (unit = 'hour' OR unit = 'hr')
    ORDER BY rate_type = ? DESC, support_item_number
    LIMIT 1
  `).get(dayType, dayType);

  if (level2Catalogue) return toResult(level2Catalogue);

  const fallback = db.prepare(`
    SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type, support_item_number, description
    FROM ndis_line_items
    WHERE (support_category = '07' OR support_item_number LIKE '07_%')
      AND support_item_number NOT LIKE '07_799%'
      AND (rate_type = ? OR rate_type IS NULL OR rate_type = 'weekday')
      AND (unit = 'hour' OR unit = 'hr')
    ORDER BY ${SC_LEVEL2_ORDER_SQL}, rate_type = ? DESC
    LIMIT 1
  `).get(dayType, dayType);

  if (fallback) return toResult(fallback);

  const fromParticipant = getDefaultLineItemForParticipant(participantId, `${dateStr}T09:00:00`, dateStr);
  if (fromParticipant) return fromParticipant;

  const anyHourly = db.prepare('SELECT id, rate, rate_remote, rate_very_remote, unit FROM ndis_line_items WHERE unit = ? AND rate > 0 LIMIT 1').get('hour');
  if (anyHourly) return toResult(anyHourly);

  return null;
}

/**
 * Resolve unit price for a coordinator task from catalogue row + participant remoteness.
 * @param {string} participantId
 * @param {{ id: string, rate?: number, rate_remote?: number, rate_very_remote?: number }} lineItemRow
 * @param {number|null|undefined} [overrideUnitPrice]
 */
export function resolveCoordinatorTaskUnitPrice(participantId, lineItemRow, overrideUnitPrice) {
  if (overrideUnitPrice != null && !Number.isNaN(Number(overrideUnitPrice))) {
    return roundMoney(Number(overrideUnitPrice));
  }
  const participant = db.prepare('SELECT remoteness FROM participants WHERE id = ?').get(participantId);
  return roundMoney(Number(getEffectiveNdisRate(lineItemRow, participant?.remoteness || 'standard')) || 0);
}

/**
 * Update unit_price on coordinator tasks linked to a Financial draft selection id.
 * @returns {number} tasks updated
 */
export function applyDraftSelectionUnitPrice(selectionId, unitPrice) {
  const price = roundMoney(Number(unitPrice));
  if (!(price >= 0)) throw new Error('Invalid unit_price');

  const parsed = parseTaskScDaySelectionId(selectionId);
  if (parsed) {
    const dayTasks = db
      .prepare(
        `SELECT id, task_type FROM coordinator_tasks
         WHERE participant_id = ? AND activity_date = ?
           AND task_invoice_id IS NULL AND billing_invoice_id IS NULL`
      )
      .all(parsed.participantId, parsed.lineDate);
    if (!dayTasks.length) return 0;

    let ids = dayTasks.map((t) => t.id);
    if (parsed.bucket === 'f2f') {
      ids = dayTasks.filter((t) => taskIsF2fCoordinatorTask(t)).map((t) => t.id);
    } else if (parsed.bucket === 'nonf2f') {
      ids = dayTasks.filter((t) => !taskIsF2fCoordinatorTask(t)).map((t) => t.id);
    } else if (parsed.bucket !== 'all') {
      return 0;
    }

    const upd = db.prepare(
      `UPDATE coordinator_tasks SET unit_price = ?, updated_at = datetime('now')
       WHERE id = ? AND task_invoice_id IS NULL AND billing_invoice_id IS NULL`
    );
    let n = 0;
    for (const id of ids) {
      const r = upd.run(price, id);
      n += r.changes;
    }
    return n;
  }

  if (selectionId.startsWith('task-') && !selectionId.startsWith('task-sc-day-') && !selectionId.startsWith('task-nf2f-')) {
    const taskId = selectionId.slice('task-'.length);
    const r = db
      .prepare(
        `UPDATE coordinator_tasks SET unit_price = ?, updated_at = datetime('now')
         WHERE id = ? AND task_invoice_id IS NULL AND billing_invoice_id IS NULL`
      )
      .run(price, taskId);
    return r.changes;
  }

  throw new Error('Not a support coordination task draft line');
}

/**
 * Round duration to billable units (interval minutes).
 * e.g. 17 min @ 15 min interval = 30 min (2 units of 0.25 hr)
 */
export function roundToBillableUnits(durationMinutes, intervalMinutes) {
  if (!intervalMinutes || intervalMinutes <= 0) return durationMinutes / 60;
  const units = Math.ceil(durationMinutes / intervalMinutes);
  return (units * intervalMinutes) / 60;
}

/** @typedef {'f2f' | 'nonf2f' | 'km' | 'traveltime' | 'all'} ScDayBucket */

export function taskIsF2fCoordinatorTask(t) {
  return t?.task_type === 'meeting_f2f';
}

/**
 * Draft / billing selection ids: task-sc-day-{f2f|nonf2f|km|traveltime}-{participantUuid}-{YYYY-MM-DD},
 * legacy task-sc-day-{participantUuid}-{YYYY-MM-DD} (all buckets), or task-nf2f-… (non-f2f hours only).
 * @returns {{ participantId: string, lineDate: string, bucket: ScDayBucket | 'all' } | null}
 */
export function parseTaskScDaySelectionId(id) {
  if (!id || typeof id !== 'string') return null;
  if (id.startsWith('task-nf2f-')) {
    const rest = id.slice('task-nf2f-'.length);
    const m = rest.match(/^([0-9a-f-]{36})-(\d{4}-\d{2}-\d{2})$/i);
    if (!m) return null;
    return { participantId: m[1], lineDate: m[2], bucket: 'nonf2f' };
  }
  if (!id.startsWith('task-sc-day-')) return null;
  const rest = id.slice('task-sc-day-'.length);
  const mBucket = rest.match(/^(f2f|nonf2f|km|traveltime)-([0-9a-f-]{36})-(\d{4}-\d{2}-\d{2})$/i);
  if (mBucket) {
    return { participantId: mBucket[2], lineDate: mBucket[3], bucket: /** @type {const} */ (mBucket[1]) };
  }
  const mLegacy = rest.match(/^([0-9a-f-]{36})-(\d{4}-\d{2}-\d{2})$/i);
  if (mLegacy) {
    return { participantId: mLegacy[1], lineDate: mLegacy[2], bucket: 'all' };
  }
  return null;
}

const ALL_BUCKETS = /** @type {const} */ (['f2f', 'nonf2f', 'km', 'traveltime']);

/**
 * One draft row for bulk billing (checkbox id + display fields).
 * @param {object} first - any task from the day group (participant_name, etc.)
 */
function makeDraftRow(base, extra) {
  return {
    source_type: 'task',
    participant_id: base.participant_id,
    participant_name: base.participant_name,
    ndis_number: base.ndis_number,
    ...extra
  };
}

/**
 * Build draft-batch line items for one participant-day group (all tasks that day).
 * @param {object[]} group - coordinator_tasks rows with participant_name, ndis_number, ndis_description
 * @param {object|null} travelKmItem - 07_799 row
 */
export function buildScDayDraftLineItems(group, travelKmItem, intervalMinutes = 15) {
  const interval = intervalMinutes > 0 ? intervalMinutes : 15;
  const first = group[0];
  const pid = first.participant_id;
  const actDate = first.activity_date;
  const dateStr = String(actDate || '').slice(0, 10);
  const out = [];

  const f2f = group.filter((t) => taskIsF2fCoordinatorTask(t));
  const nonF2f = group.filter((t) => !taskIsF2fCoordinatorTask(t));

  const pushHours = (bucketTasks, bucketKey, title) => {
    if (!bucketTasks.length) return;
    let totalQty = 0;
    let totalAmt = 0;
    for (const t of bucketTasks) {
      const q = Number(t.quantity) || 0;
      const up = Number(t.unit_price) || 0;
      totalQty += q;
      totalAmt += roundMoney(q * up);
    }
    totalAmt = roundMoney(totalAmt);
    if (totalQty <= 0 && totalAmt <= 0) return;
    const bf = bucketTasks[0];
    const unitPx = totalQty > 0 ? roundMoney(totalAmt / totalQty) : 0;
    out.push(
      makeDraftRow(first, {
        id: `task-sc-day-${bucketKey}-${pid}-${dateStr}`,
        source_task_ids: bucketTasks.map((t) => t.id),
        line_date: actDate,
        support_item_number: bf.support_item_number || '-',
        description: `${title} – ${dateStr}`,
        quantity: totalQty,
        unit_price: unitPx,
        unit: 'hour',
        total: totalAmt
      })
    );
  };

  pushHours(f2f, 'f2f', 'Face-to-face support coordination');
  pushHours(nonF2f, 'nonf2f', 'Non-face-to-face support coordination');

  let kmQty = 0;
  let kmAmt = 0;
  const kmTaskIds = [];
  for (const t of group) {
    if (!Number(t.includes_travel)) continue;
    const km = Number(t.travel_km);
    if (!km || km <= 0 || !travelKmItem) continue;
    kmQty += km;
    kmAmt += roundMoney(km * (Number(travelKmItem.rate) || 1));
    kmTaskIds.push(t.id);
  }
  kmAmt = roundMoney(kmAmt);
  if (kmQty > 0 && travelKmItem) {
    out.push(
      makeDraftRow(first, {
        id: `task-sc-day-km-${pid}-${dateStr}`,
        source_task_ids: kmTaskIds,
        line_date: actDate,
        support_item_number: travelKmItem.support_item_number || '-',
        description: `${travelKmItem.description || 'Provider travel – non-labour (km)'} – ${dateStr}`,
        quantity: kmQty,
        unit_price: Number(travelKmItem.rate) || 1,
        unit: travelKmItem.unit || 'km',
        total: kmAmt
      })
    );
  }

  let ttQty = 0;
  let ttAmt = 0;
  const ttTaskIds = [];
  for (const t of group) {
    const tm = Number(t.travel_time_min);
    if (!tm || tm <= 0) continue;
    const hrs = roundToBillableUnits(tm, interval);
    const up = Number(t.unit_price) || 0;
    ttQty += hrs;
    ttAmt += roundMoney(hrs * up);
    ttTaskIds.push(t.id);
  }
  ttAmt = roundMoney(ttAmt);
  if (ttQty > 0 && ttTaskIds.length) {
    const bf = group.find((t) => ttTaskIds.includes(t.id));
    const unitPx = ttQty > 0 ? roundMoney(ttAmt / ttQty) : 0;
    out.push(
      makeDraftRow(first, {
        id: `task-sc-day-traveltime-${pid}-${dateStr}`,
        source_task_ids: ttTaskIds,
        line_date: actDate,
        support_item_number: bf?.support_item_number || '-',
        description: `Provider travel – time – ${dateStr}`,
        quantity: ttQty,
        unit_price: unitPx,
        unit: 'hour',
        total: ttAmt
      })
    );
  }

  return out;
}

/**
 * Payload for INSERT billing_invoice_line_items for one bucket (or null if nothing to bill).
 * @param {object[]} dayTasks - tasks for one participant + day (same activity_date)
 * @param {ScDayBucket} bucket
 */
export function buildBillingLinePayloadForScDayBucket(dayTasks, bucket, travelKmItem, intervalMinutes = 15) {
  const interval = intervalMinutes > 0 ? intervalMinutes : 15;
  if (!dayTasks?.length) return null;

  if (bucket === 'f2f') {
    const bucketTasks = dayTasks.filter((t) => taskIsF2fCoordinatorTask(t));
    return buildHourBucketPayload(bucketTasks, 'Face-to-face support coordination (daily total)');
  }
  if (bucket === 'nonf2f') {
    const bucketTasks = dayTasks.filter((t) => !taskIsF2fCoordinatorTask(t));
    return buildHourBucketPayload(bucketTasks, 'Non-face-to-face support coordination (daily total)');
  }
  if (bucket === 'km') {
    if (!travelKmItem) return null;
    let kmQty = 0;
    let kmAmt = 0;
    const ids = [];
    for (const t of dayTasks) {
      if (!Number(t.includes_travel)) continue;
      const km = Number(t.travel_km);
      if (!km || km <= 0) continue;
      kmQty += km;
      kmAmt += roundMoney(km * (Number(travelKmItem.rate) || 1));
      ids.push(t.id);
    }
    kmAmt = roundMoney(kmAmt);
    if (kmQty <= 0 || !ids.length) return null;
    const first = dayTasks.find((t) => ids.includes(t.id)) || dayTasks[0];
    return {
      source_task_id: first.id,
      ndis_line_item_id: travelKmItem.id,
      support_item_number: travelKmItem.support_item_number || '-',
      description: `${travelKmItem.description || 'Provider travel – non-labour (km)'} (daily total)`,
      quantity: kmQty,
      unit_price: Number(travelKmItem.rate) || 1,
      unit: travelKmItem.unit || 'km',
      line_date: first.activity_date,
      source_task_ids: ids
    };
  }
  if (bucket === 'traveltime') {
    let ttQty = 0;
    let ttAmt = 0;
    const ids = [];
    for (const t of dayTasks) {
      const tm = Number(t.travel_time_min);
      if (!tm || tm <= 0) continue;
      const hrs = roundToBillableUnits(tm, interval);
      const up = Number(t.unit_price) || 0;
      ttQty += hrs;
      ttAmt += roundMoney(hrs * up);
      ids.push(t.id);
    }
    ttAmt = roundMoney(ttAmt);
    if (ttQty <= 0 || !ids.length) return null;
    const first = dayTasks.find((t) => ids.includes(t.id)) || dayTasks[0];
    const unitPx = ttQty > 0 ? roundMoney(ttAmt / ttQty) : 0;
    return {
      source_task_id: first.id,
      ndis_line_item_id: first.ndis_line_item_id,
      support_item_number: first.support_item_number || '-',
      description: 'Provider travel – time (daily total)',
      quantity: ttQty,
      unit_price: unitPx,
      unit: 'hour',
      line_date: first.activity_date,
      source_task_ids: ids
    };
  }
  return null;
}

function buildHourBucketPayload(bucketTasks, description) {
  if (!bucketTasks.length) return null;
  let totalQty = 0;
  let totalAmt = 0;
  for (const t of bucketTasks) {
    const q = Number(t.quantity) || 0;
    const up = Number(t.unit_price) || 0;
    totalQty += q;
    totalAmt += roundMoney(q * up);
  }
  totalAmt = roundMoney(totalAmt);
  if (totalQty <= 0 && totalAmt <= 0) return null;
  const first = bucketTasks[0];
  const unitPx = totalQty > 0 ? roundMoney(totalAmt / totalQty) : 0;
  return {
    source_task_id: first.id,
    ndis_line_item_id: first.ndis_line_item_id,
    support_item_number: first.support_item_number || '-',
    description,
    quantity: totalQty,
    unit_price: unitPx,
    unit: 'hour',
    line_date: first.activity_date,
    source_task_ids: bucketTasks.map((t) => t.id)
  };
}

export { ALL_BUCKETS };

/**
 * Task invoice JSON/PDF: per calendar day, separate lines for F2F hours, non-F2F hours,
 * provider travel time (hours), and provider travel km (07_799).
 * @param {object[]} tasks - coordinator_tasks with ndis join
 * @param {object|null} travelKmItem - 07_799
 * @param {number} [billingIntervalMinutes=15]
 * @returns {{ lineItems: object[], subtotal: number }}
 */
export function buildTaskInvoiceLineItems(tasks, travelKmItem, billingIntervalMinutes = 15) {
  const interval = billingIntervalMinutes > 0 ? billingIntervalMinutes : 15;
  const sorted = [...tasks].sort((a, b) => {
    const da = String(a.activity_date || '').localeCompare(String(b.activity_date || ''));
    if (da !== 0) return da;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });

  const dates = [...new Set(sorted.map((t) => String(t.activity_date || '').slice(0, 10)).filter(Boolean))].sort();

  const lineItems = [];
  let subtotal = 0;

  for (const d of dates) {
    const grp = sorted.filter((t) => String(t.activity_date || '').slice(0, 10) === d);
    const draftLines = buildScDayDraftLineItems(grp, travelKmItem, interval);
    for (const row of draftLines) {
      subtotal += roundMoney(row.total || 0);
      lineItems.push({
        support_item_number: row.support_item_number,
        description: row.description,
        quantity: row.quantity,
        unit: row.unit || 'hour',
        unit_price: row.unit_price,
        total: roundMoney(row.total || 0),
        task_type:
          row.id?.includes('-km-') ? 'travel_km' : row.id?.includes('traveltime') ? 'travel_time' : 'daily_bucket',
        activity_date: row.line_date
      });
    }
  }

  subtotal = roundMoney(subtotal);
  return { lineItems, subtotal };
}

