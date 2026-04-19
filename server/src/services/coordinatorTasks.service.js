/**
 * Coordinator Tasks Service - support coordinator activity logging and billing.
 * Tasks: email, meeting (f2f/non-f2f), phone, etc. with evidence and optional travel.
 */
import { db } from '../db/index.js';
import { getDefaultLineItemForParticipant } from './progressNoteMatcher.js';
import { getShiftDayType } from '../lib/ndisDay.js';
import { roundMoney } from '../lib/invoiceGst.js';

/**
 * Get default support coordination line item for participant (category 07).
 * Falls back to getDefaultLineItemForParticipant if no 07 item in plan.
 */
export function getSupportCoordLineItem(participantId, activityDate) {
  const dateStr = activityDate?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const dayType = getShiftDayType(`${dateStr}T09:00:00`);

  const fromPlan = db.prepare(`
    SELECT bli.ndis_line_item_id, nli.rate, nli.rate_remote, nli.rate_very_remote, nli.unit, nli.rate_type, nli.support_item_number
    FROM plan_budgets pb
    JOIN ndis_plans np ON np.id = pb.plan_id
    JOIN budget_line_items bli ON bli.budget_id = pb.id
    JOIN ndis_line_items nli ON nli.id = bli.ndis_line_item_id
    WHERE np.participant_id = ? AND np.start_date <= ? AND np.end_date >= ?
      AND (nli.support_category = '07' OR nli.support_item_number LIKE '07_%')
    ORDER BY pb.category
    LIMIT 1
  `).get(participantId, dateStr, dateStr);

  if (fromPlan?.ndis_line_item_id) {
    const rate = fromPlan.rate_remote ?? fromPlan.rate_very_remote ?? fromPlan.rate;
    const itemRateType = fromPlan.rate_type || 'weekday';
    if (itemRateType === dayType || !fromPlan.rate_type) {
      return {
        id: fromPlan.ndis_line_item_id,
        rate: Number(rate) || 0,
        unit: fromPlan.unit || 'hour'
      };
    }
  }

  const fallback = db.prepare(`
    SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type
    FROM ndis_line_items
    WHERE (support_category = '07' OR support_item_number LIKE '07_%')
      AND support_item_number NOT LIKE '07_799%'
      AND (rate_type = ? OR rate_type IS NULL OR rate_type = 'weekday')
    ORDER BY rate_type = ? DESC
    LIMIT 1
  `).get(dayType, dayType);

  if (fallback) {
    const rate = fallback.rate_remote ?? fallback.rate_very_remote ?? fallback.rate;
    return { id: fallback.id, rate: Number(rate) || 0, unit: fallback.unit || 'hour' };
  }

  const fromParticipant = getDefaultLineItemForParticipant(participantId, `${dateStr}T09:00:00`, dateStr);
  if (fromParticipant) return fromParticipant;

  const anyHourly = db.prepare('SELECT id, rate, unit FROM ndis_line_items WHERE unit = ? AND rate > 0 LIMIT 1').get('hour');
  if (anyHourly) return { id: anyHourly.id, rate: Number(anyHourly.rate) || 0, unit: 'hour' };

  return null;
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

