/**
 * Billing - bulk invoice creation for a time period.
 * Combines unbilled tasks + shifts into one invoice per participant.
 * Draft batch shows all line items with checkboxes before confirming.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import {
  tryPushParticipantBinaryCategory,
  resolveOrgIdForBillingParticipant,
  billingInvoicePdfAlreadyInRegister
} from '../services/orgOnedriveSync.service.js';
import { getOnedriveLinkRow } from '../services/orgOnedriveTokens.service.js';
import { getDefaultLineItemForParticipant } from '../services/progressNoteMatcher.js';
import { getShiftLocalDateString } from '../lib/ndisDay.js';
import { syncShiftLineItemsWithProgressNote } from '../services/shiftLineItems.service.js';
import {
  participantInvoiceIncludesGst,
  roundMoney,
  gstBreakdownFromSubtotal,
  MONEY_ZERO_EPS
} from '../lib/invoiceGst.js';
import { sendBillingBatch } from '../services/billingBatchSend.service.js';
import { generateBillingInvoicePdfBuffer } from '../services/billingInvoicePdf.service.js';
import { rebuildBillingInvoiceLineItems } from '../services/billingInvoiceRepair.service.js';
import { syncBillingInvoiceFromXero } from '../services/xeroPaymentSync.service.js';
import { getProviderOrgIdForUser } from '../middleware/roles.js';
import {
  billingParticipantFilterFromRequest,
  isCoordinatorTaskInRequesterTenant,
  isParticipantInRequesterTenant,
  isParticipantVisibleToBillingRequest,
  isShiftInRequesterTenant,
  tenantParticipantAndStaffClause,
  tenantParticipantClause,
} from '../lib/orgScopeSql.js';
import {
  parseTaskScDaySelectionId,
  buildScDayDraftLineItems,
  buildBillingLinePayloadForScDayBucket,
  ALL_BUCKETS,
  resolveSupportCoordProviderTravelKmItem
} from '../services/coordinatorTasks.service.js';

const router = Router();

/** Draft keys are `shift-{shiftId}-{lineItemId}`; shiftId/lineItemId are UUIDs, so we must not split on the first hyphen. */
function parseShiftSelectionId(id) {
  if (!id || typeof id !== 'string' || !id.startsWith('shift-')) return null;
  const body = id.slice('shift-'.length);
  const m = body.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i);
  if (m) return { shift_id: m[1], line_item_id: m[2] };
  const dashIdx = body.indexOf('-');
  if (dashIdx < 0) return { shift_id: body, line_item_id: null };
  return { shift_id: body.slice(0, dashIdx), line_item_id: body.slice(dashIdx + 1) };
}

function billingLineSubtotal(dbConn, invoiceId) {
  const r = dbConn
    .prepare(
      `SELECT COALESCE(SUM(CAST(quantity AS REAL) * CAST(unit_price AS REAL)), 0) as s
       FROM billing_invoice_line_items WHERE billing_invoice_id = ?`
    )
    .get(invoiceId);
  return roundMoney(r?.s || 0);
}

function billingInvoiceTotalInclGst(dbConn, invoiceId, invoiceIncludesGstRaw) {
  const sub = billingLineSubtotal(dbConn, invoiceId);
  return gstBreakdownFromSubtotal(sub, participantInvoiceIncludesGst(invoiceIncludesGstRaw)).total_incl_gst;
}

function billingInvoicePaidSum(dbConn, invoiceId) {
  const r = dbConn
    .prepare('SELECT COALESCE(SUM(amount), 0) as s FROM billing_invoice_payments WHERE billing_invoice_id = ?')
    .get(invoiceId);
  return roundMoney(r?.s || 0);
}

/** Split one batch-level payment across invoices in that batch (proportional to totals incl. GST). */
function recordBatchPaymentProportional(batchRef, paidPool, paidAt, note, userId) {
  const pool = roundMoney(Number(paidPool) || 0);
  if (pool <= 0) return [];
  const pc = userId ? tenantParticipantClause(userId, 'p') : { sql: '1=1', params: [], orgId: true };
  if (userId && !pc.orgId) return [];
  const invRows = db
    .prepare(
      `
      SELECT bi.id, p.invoice_includes_gst
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      WHERE bi.invoice_number LIKE ? AND bi.status != 'void' AND (${pc.sql})
    `
    )
    .all(`BINV-${batchRef}-%`, ...pc.params);
  const totals = [];
  for (const inv of invRows) {
    const tincl = billingInvoiceTotalInclGst(db, inv.id, inv.invoice_includes_gst);
    if (tincl > 0) totals.push({ id: inv.id, total: tincl });
  }
  const sumT = totals.reduce((acc, x) => acc + x.total, 0);
  if (sumT <= 0) return [];
  const insertPay = db.prepare(`
    INSERT INTO billing_invoice_payments (id, billing_invoice_id, amount, paid_at, note)
    VALUES (?, ?, ?, ?, ?)
  `);
  const created = [];
  let remaining = pool;
  totals.forEach((t, idx) => {
    let alloc;
    if (idx === totals.length - 1) alloc = roundMoney(remaining);
    else {
      alloc = roundMoney(pool * (t.total / sumT));
      remaining = roundMoney(remaining - alloc);
    }
    if (alloc > 0.001) {
      const pid = uuidv4();
      insertPay.run(pid, t.id, alloc, paidAt, note || null);
      created.push({ id: pid, billing_invoice_id: t.id, amount: alloc });
      const invMeta = invRows.find((r) => r.id === t.id);
      const total = billingInvoiceTotalInclGst(db, t.id, invMeta?.invoice_includes_gst);
      const paid = billingInvoicePaidSum(db, t.id);
      const out = Math.max(0, roundMoney(total - paid));
      if (out <= MONEY_ZERO_EPS) {
        const st = db.prepare('SELECT status FROM billing_invoices WHERE id = ?').get(t.id);
        if (st?.status && st.status !== 'draft') {
          db.prepare(`UPDATE billing_invoices SET status = 'paid', updated_at = datetime('now') WHERE id = ?`).run(t.id);
        }
      }
    }
  });
  return created;
}

// Get draft batch: all unbilled tasks and shifts in date range, grouped by participant
router.get('/draft-batch', (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    if (!from_date || !to_date) {
      return res.status(400).json({ error: 'from_date and to_date required (YYYY-MM-DD)' });
    }

    const userId = req.session?.user?.id;
    const pc = tenantParticipantClause(userId, 'p');
    const shiftScope = tenantParticipantAndStaffClause(userId, 'p', 'st');
    if (!pc.orgId) {
      return res.json({
        from_date,
        to_date,
        participants: [],
        total_items: 0
      });
    }

    const tasks = db.prepare(`
      SELECT ct.id, ct.participant_id, ct.activity_date, ct.description, ct.task_type,
             ct.quantity, ct.unit_price, ct.ndis_line_item_id, ct.duration_minutes,
             ct.includes_travel, ct.travel_km, ct.travel_time_min,
             p.name as participant_name, p.ndis_number,
             nli.support_item_number, nli.description as ndis_description
      FROM coordinator_tasks ct
      JOIN participants p ON p.id = ct.participant_id
      LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
      WHERE (${pc.sql})
        AND ct.activity_date >= ? AND ct.activity_date <= ?
        AND ct.task_invoice_id IS NULL AND ct.billing_invoice_id IS NULL
      ORDER BY ct.participant_id, ct.activity_date
    `).all(...pc.params, from_date, to_date);

    const shifts = db.prepare(`
      SELECT s.id as shift_id, s.participant_id, s.start_time, s.end_time,
             p.name as participant_name, p.ndis_number
      FROM shifts s
      JOIN participants p ON p.id = s.participant_id
      JOIN staff st ON st.id = s.staff_id
      WHERE (${shiftScope.sql})
        AND s.status IN ('completed', 'completed_by_admin')
        AND s.billing_invoice_id IS NULL
        AND s.start_time >= ? AND s.start_time <= ?
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.shift_id = s.id)
      ORDER BY s.participant_id, s.start_time
    `).all(...shiftScope.params, `${from_date}T00:00:00`, `${to_date}T23:59:59`);

    const lineItems = [];

    /** Support coordination: up to four draft rows per participant per day (F2F, non-F2F, travel time, km). */
    const scByDay = {};
    tasks.forEach((t) => {
      const key = `${t.participant_id}|${t.activity_date}`;
      if (!scByDay[key]) scByDay[key] = [];
      scByDay[key].push(t);
    });
    Object.entries(scByDay).forEach(([, group]) => {
      const travelKmItemDraft = resolveSupportCoordProviderTravelKmItem(db, group);
      const rows = buildScDayDraftLineItems(group, travelKmItemDraft, 15);
      rows.forEach((row) => lineItems.push(row));
    });

    shifts.forEach((s) => {
      syncShiftLineItemsWithProgressNote(s.shift_id);
      const lineItemsForShift = db.prepare(`
        SELECT sli.id, sli.quantity, sli.unit_price, nli.support_item_number, nli.description, nli.unit
        FROM shift_line_items sli
        JOIN ndis_line_items nli ON nli.id = sli.ndis_line_item_id
        WHERE sli.shift_id = ?
      `).all(s.shift_id);

      if (lineItemsForShift.length === 0) {
        const supportDate = s.start_time ? getShiftLocalDateString(s.start_time) || s.start_time.slice(0, 10) : '';
        const defaultItem = getDefaultLineItemForParticipant(s.participant_id, s.start_time, supportDate, s.end_time);
        if (defaultItem) {
          const nli = db.prepare('SELECT support_item_number, description, unit FROM ndis_line_items WHERE id = ?').get(defaultItem.id);
          const hours = s.start_time && s.end_time
            ? (new Date(s.end_time) - new Date(s.start_time)) / (1000 * 60 * 60)
            : 1;
          const rawUnit = nli?.unit || 'hour';
          lineItemsForShift.push({
            id: s.shift_id,
            quantity: hours,
            unit_price: defaultItem.rate,
            support_item_number: nli?.support_item_number || '-',
            description: nli?.description || 'Support',
            unit: rawUnit === 'each' ? 'unit' : rawUnit
          });
        }
      }

      const supportDate = s.start_time ? getShiftLocalDateString(s.start_time) || s.start_time.slice(0, 10) : '';
      lineItemsForShift.forEach((li) => {
        const rawUnit = li.unit || 'hour';
        lineItems.push({
          id: `shift-${s.shift_id}-${li.id}`,
          source_type: 'shift',
          source_shift_id: s.shift_id,
          source_shift_line_item_id: li.id,
          participant_id: s.participant_id,
          participant_name: s.participant_name,
          ndis_number: s.ndis_number,
          line_date: supportDate,
          support_item_number: li.support_item_number || '-',
          description: li.description || 'Support',
          quantity: li.quantity,
          unit_price: li.unit_price,
          unit: rawUnit === 'each' ? 'unit' : rawUnit,
          total: (li.quantity || 0) * (li.unit_price || 0)
        });
      });
    });

    const byParticipant = {};
    lineItems.forEach((li) => {
      const pid = li.participant_id;
      if (!byParticipant[pid]) {
        byParticipant[pid] = {
          participant_id: pid,
          participant_name: li.participant_name,
          ndis_number: li.ndis_number,
          items: [],
          total: 0
        };
      }
      byParticipant[pid].items.push(li);
      byParticipant[pid].total += li.total;
    });

    res.json({
      from_date,
      to_date,
      participants: Object.values(byParticipant),
      total_items: lineItems.length
    });
  } catch (err) {
    console.error('[billing draft-batch]', err);
    res.status(500).json({ error: err.message });
  }
});

// Create billing batch from selected line items.
// One invoice per participant per batch; each invoice contains all selected line items for that participant.
router.post('/create-batch', (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!getProviderOrgIdForUser(userId)) {
      return res.status(403).json({ error: 'No organisation on your account.' });
    }

    const { from_date, to_date, selected_ids } = req.body;
    if (!from_date || !to_date || !Array.isArray(selected_ids) || selected_ids.length === 0) {
      return res.status(400).json({ error: 'from_date, to_date, and selected_ids (array) required' });
    }

    const scSelections = [];
    for (const id of selected_ids) {
      const p = parseTaskScDaySelectionId(id);
      if (p) scSelections.push(p);
    }
    const scDayBucketMap = new Map();
    for (const p of scSelections) {
      const k = `${p.participantId}|${p.lineDate}`;
      if (!scDayBucketMap.has(k)) scDayBucketMap.set(k, new Set());
      if (p.bucket === 'all') {
        ALL_BUCKETS.forEach((b) => scDayBucketMap.get(k).add(b));
      } else {
        scDayBucketMap.get(k).add(p.bucket);
      }
    }

    const singleTaskIds = selected_ids
      .filter(
        (id) =>
          id.startsWith('task-') &&
          !id.startsWith('task-nf2f-') &&
          !id.startsWith('task-sc-day-')
      )
      .map((id) => id.replace('task-', ''));
    const shiftLineKeys = selected_ids
      .filter((id) => id.startsWith('shift-'))
      .map((id) => {
        const parsed = parseShiftSelectionId(id);
        if (!parsed) return null;
        return { shift_id: parsed.shift_id, line_item_id: parsed.line_item_id, key: id };
      })
      .filter(Boolean);

    const shiftIds = [...new Set(shiftLineKeys.map((k) => k.shift_id))];

    for (const tid of singleTaskIds) {
      if (!isCoordinatorTaskInRequesterTenant(tid, userId)) {
        return res.status(403).json({ error: 'One or more selected tasks are not in your organisation.' });
      }
    }
    for (const sid of shiftIds) {
      if (!isShiftInRequesterTenant(sid, userId)) {
        return res.status(403).json({ error: 'One or more selected shifts are not in your organisation.' });
      }
    }
    for (const p of scSelections) {
      if (p.participantId && !isParticipantInRequesterTenant(p.participantId, userId)) {
        return res.status(403).json({ error: 'One or more selected items are not in your organisation.' });
      }
    }

    const participants = new Set();
    scSelections.forEach((p) => {
      if (p.lineDate?.length === 10 && p.participantId) participants.add(p.participantId);
    });
    const tasksStmt = db.prepare('SELECT id, participant_id FROM coordinator_tasks WHERE id = ?');
    singleTaskIds.forEach((tid) => {
      const t = tasksStmt.get(tid);
      if (t) participants.add(t.participant_id);
    });
    shiftIds.forEach((sid) => {
      const s = db.prepare('SELECT participant_id FROM shifts WHERE id = ?').get(sid);
      if (s) participants.add(s.participant_id);
    });

    // Build per-participant line item counts
    const participantLineCount = new Map();
    for (const participantId of participants) {
      let count = 0;
      count += scSelections.filter((p) => p.participantId === participantId).length;
      const participantTasks = singleTaskIds.filter((tid) => {
        const t = tasksStmt.get(tid);
        return t?.participant_id === participantId;
      });
      count += participantTasks.length;

      const participantShifts = shiftIds.filter((sid) => {
        const s = db.prepare('SELECT participant_id FROM shifts WHERE id = ?').get(sid);
        return s?.participant_id === participantId;
      });
      for (const sid of participantShifts) {
        const shiftLines = db.prepare(`
          SELECT sli.id FROM shift_line_items sli WHERE sli.shift_id = ?
        `).all(sid);
        let shiftSelected = false;
        for (const li of shiftLines) {
          if (selected_ids.includes(`shift-${sid}-${li.id}`)) shiftSelected = true;
        }
        if (shiftSelected) count += 1;
        else if (selected_ids.includes(`shift-${sid}-${sid}`)) count += 1;
      }
      participantLineCount.set(participantId, count);
    }

    const batchRef = Date.now();
    const created = [];
    let invoiceIndex = 0;

    for (const participantId of participants) {
      if (participantLineCount.get(participantId) === 0) continue;

      const invId = uuidv4();
      const invNum = `BINV-${batchRef}-${invoiceIndex}`;
      invoiceIndex += 1;

      db.prepare(`
        INSERT INTO billing_invoices (id, participant_id, invoice_number, period_from, period_to, status)
        VALUES (?, ?, ?, ?, ?, 'draft')
      `).run(invId, participantId, invNum, from_date, to_date);

      const participantTasks = singleTaskIds.filter((tid) => {
        const t = tasksStmt.get(tid);
        return t?.participant_id === participantId;
      });
      const participantShifts = shiftIds.filter((sid) => {
        const s = db.prepare('SELECT participant_id FROM shifts WHERE id = ?').get(sid);
        return s?.participant_id === participantId;
      });

      const insLine = db.prepare(`
        INSERT INTO billing_invoice_line_items (id, billing_invoice_id, source_type, source_task_id, source_shift_id, source_shift_line_item_id, ndis_line_item_id, support_item_number, description, quantity, unit_price, unit, line_date, source_task_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const updateTaskBilling = db.prepare('UPDATE coordinator_tasks SET billing_invoice_id = ? WHERE id = ?');
      for (const [dayKey, bucketSet] of scDayBucketMap) {
        const [pid, lineDate] = dayKey.split('|');
        if (pid !== participantId) continue;
        const dayGroup = db.prepare(`
          SELECT ct.id, ct.participant_id, ct.activity_date, ct.quantity, ct.unit_price, ct.ndis_line_item_id, ct.description, ct.task_type,
                 ct.includes_travel, ct.travel_km, ct.travel_time_min,
                 nli.support_item_number, nli.description as ndis_desc
          FROM coordinator_tasks ct
          LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
          WHERE ct.participant_id = ? AND ct.activity_date = ? AND ct.task_invoice_id IS NULL AND ct.billing_invoice_id IS NULL
        `).all(pid, lineDate);
        if (dayGroup.length === 0) continue;
        const travelKmItem = resolveSupportCoordProviderTravelKmItem(db, dayGroup);
        const touched = new Set();
        const orderedBuckets = ALL_BUCKETS.filter((b) => bucketSet.has(b));
        for (const b of orderedBuckets) {
          const payload = buildBillingLinePayloadForScDayBucket(dayGroup, b, travelKmItem, 15);
          if (!payload) continue;
          const lineDateStr = String(payload.line_date || lineDate).slice(0, 10);
          insLine.run(
            uuidv4(),
            invId,
            'task',
            payload.source_task_id,
            null,
            null,
            payload.ndis_line_item_id,
            payload.support_item_number || '-',
            payload.description,
            payload.quantity,
            payload.unit_price,
            payload.unit,
            lineDateStr,
            JSON.stringify(payload.source_task_ids)
          );
          payload.source_task_ids.forEach((tid) => touched.add(tid));
        }
        touched.forEach((tid) => updateTaskBilling.run(invId, tid));
      }

      participantTasks.forEach((tid) => {
        const t = db.prepare(`
          SELECT ct.*, nli.support_item_number, nli.description as ndis_desc
          FROM coordinator_tasks ct
          LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
          WHERE ct.id = ?
        `).get(tid);
        if (t) {
          const desc = t.description || t.task_type;
          insLine.run(uuidv4(), invId, 'task', tid, null, null, t.ndis_line_item_id, t.support_item_number || '-', desc, t.quantity, t.unit_price, 'hour', t.activity_date, null);
          db.prepare('UPDATE coordinator_tasks SET billing_invoice_id = ? WHERE id = ?').run(invId, tid);
        }
      });

      participantShifts.forEach((sid) => {
        syncShiftLineItemsWithProgressNote(sid);
        const shiftLines = db.prepare(`
          SELECT sli.*, nli.support_item_number, nli.description, nli.unit
          FROM shift_line_items sli
          JOIN ndis_line_items nli ON nli.id = sli.ndis_line_item_id
          WHERE sli.shift_id = ?
        `).all(sid);
        const shift = db.prepare('SELECT participant_id, start_time, end_time FROM shifts WHERE id = ?').get(sid);
        const lineDate = shift?.start_time
          ? getShiftLocalDateString(shift.start_time) || shift.start_time.slice(0, 10)
          : from_date;
        let addedAny = false;

        const toUnit = (u) => (u === 'each' ? 'unit' : (u || 'hour'));
        shiftLines.forEach((li) => {
          const key = `shift-${sid}-${li.id}`;
          if (selected_ids.includes(key)) {
            insLine.run(uuidv4(), invId, 'shift', null, sid, li.id, li.ndis_line_item_id, li.support_item_number, li.description, li.quantity, li.unit_price, toUnit(li.unit), lineDate, null);
            addedAny = true;
          }
        });
        if (!addedAny && selected_ids.includes(`shift-${sid}-${sid}`)) {
          const defaultItem = getDefaultLineItemForParticipant(
            shift?.participant_id,
            shift?.start_time,
            lineDate,
            shift?.end_time
          );
          if (defaultItem) {
            const nli = db.prepare('SELECT support_item_number, description, unit FROM ndis_line_items WHERE id = ?').get(defaultItem.id);
            const hours = shift?.start_time && shift?.end_time
              ? (new Date(shift.end_time) - new Date(shift.start_time)) / (1000 * 60 * 60)
              : 1;
            insLine.run(uuidv4(), invId, 'shift', null, sid, null, defaultItem.id, nli?.support_item_number || '-', nli?.description || 'Support', hours, defaultItem.rate, toUnit(nli?.unit), lineDate, null);
            addedAny = true;
          }
        }
        if (addedAny) {
          db.prepare('UPDATE shifts SET billing_invoice_id = ? WHERE id = ?').run(invId, sid);
        }
      });

      const inv = db.prepare(`
        SELECT bi.*, p.name as participant_name, p.ndis_number
        FROM billing_invoices bi
        JOIN participants p ON p.id = bi.participant_id
        WHERE bi.id = ?
      `).get(invId);
      created.push(inv);
    }

    if (created.length === 0) {
      return res.status(400).json({
        error:
          'No invoices were created. Line items may already be on another invoice, or shift/task keys could not be matched. Try reloading the draft.'
      });
    }

    res.status(201).json({ created });
  } catch (err) {
    console.error('[billing create-batch]', err);
    res.status(500).json({ error: err.message });
  }
});

// List billing invoices
router.get('/', (req, res) => {
  try {
    const bf = billingParticipantFilterFromRequest(req);
    if (bf.empty) return res.json([]);
    const rows = db.prepare(`
      SELECT bi.*, p.name as participant_name, p.ndis_number, p.invoice_emails, p.invoice_includes_gst,
             COALESCE(li_sum.line_sub, 0) as line_sub,
             COALESCE(pay.paid_sum, 0) as paid_sum
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      LEFT JOIN (
        SELECT billing_invoice_id,
               SUM(CAST(quantity AS REAL) * CAST(unit_price AS REAL)) as line_sub
        FROM billing_invoice_line_items
        GROUP BY billing_invoice_id
      ) li_sum ON li_sum.billing_invoice_id = bi.id
      LEFT JOIN (
        SELECT billing_invoice_id, SUM(amount) as paid_sum
        FROM billing_invoice_payments
        GROUP BY billing_invoice_id
      ) pay ON pay.billing_invoice_id = bi.id
      WHERE (${bf.sql})
      ORDER BY bi.created_at DESC
    `).all(...bf.params);
    const list = rows.map((inv) => {
      let emails = [];
      try { emails = JSON.parse(inv.invoice_emails || '[]'); } catch { emails = []; }
      const subtotal = roundMoney(inv.line_sub || 0);
      const { total_incl_gst: totalInclGst } = gstBreakdownFromSubtotal(
        subtotal,
        participantInvoiceIncludesGst(inv.invoice_includes_gst)
      );
      const paid = roundMoney(inv.paid_sum || 0);
      const outstanding = Math.max(0, roundMoney(totalInclGst - paid));
      const { line_sub, paid_sum, ...rest } = inv;
      return {
        ...rest,
        invoice_emails: Array.isArray(emails) ? emails : [],
        subtotal,
        total: totalInclGst,
        paid,
        outstanding
      };
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List invoice batches: one row per batch with total and outstanding (sum of per-invoice amounts incl. GST minus per-invoice payments)
// invoice_number format: BINV-{batchRef}-{index}
router.get('/batches', (req, res) => {
  try {
    const bf = billingParticipantFilterFromRequest(req);
    if (bf.empty) return res.json([]);
    const invoices = db.prepare(`
      SELECT bi.id, bi.invoice_number, bi.status, bi.created_at, p.invoice_includes_gst
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      WHERE (${bf.sql})
      ORDER BY bi.created_at DESC
    `).all(...bf.params);

    const batchMap = new Map();
    for (const inv of invoices) {
      const match = inv.invoice_number && inv.invoice_number.match(/^BINV-(\d+)-\d+$/);
      const batchRef = match ? match[1] : inv.id;
      if (!batchMap.has(batchRef)) {
        batchMap.set(batchRef, {
          batch_ref: batchRef,
          reference: `B-${batchRef}`,
          created: inv.created_at,
          total: 0,
          outstanding: 0,
          status: inv.status,
          invoice_ids: []
        });
      }
      const row = batchMap.get(batchRef);
      row.invoice_ids.push(inv.id);
      if (inv.created_at && (!row.created || inv.created_at < row.created)) row.created = inv.created_at;
      if (inv.status === 'draft') row.status = 'draft';
      if (inv.status === 'void') continue;
      const invTotal = billingInvoiceTotalInclGst(db, inv.id, inv.invoice_includes_gst);
      const invPaid = billingInvoicePaidSum(db, inv.id);
      const invOut = Math.max(0, roundMoney(invTotal - invPaid));
      row.total = roundMoney(row.total + invTotal);
      row.outstanding = roundMoney(row.outstanding + invOut);
    }

    const batches = Array.from(batchMap.values())
      .map((b) => ({
        reference: b.reference,
        batch_ref: b.batch_ref,
        created: b.created,
        total: b.total,
        outstanding: b.outstanding,
        status: b.status === 'draft' ? 'draft' : 'finalised',
        invoice_ids: b.invoice_ids
      }))
      .sort((a, b) => (b.created || '').localeCompare(a.created || ''));

    res.json(batches);
  } catch (err) {
    console.error('[billing batches]', err);
    res.status(500).json({ error: err.message });
  }
});

// Pull AmountPaid from Xero for this invoice and add a Nexus payment row if Xero shows more received than Nexus.
router.post('/:id/sync-from-xero', async (req, res) => {
  try {
    const invRow = db
      .prepare(
        `
      SELECT bi.id, p.id as participant_id
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      WHERE bi.id = ?
    `
      )
      .get(req.params.id);
    if (!invRow) {
      return res.status(404).json({ error: 'Invoice not found', code: 'NOT_FOUND' });
    }
    if (!isParticipantVisibleToBillingRequest(invRow.participant_id, req)) {
      return res.status(404).json({ error: 'Invoice not found', code: 'NOT_FOUND' });
    }
    const requester = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session?.user?.id);
    const result = await syncBillingInvoiceFromXero(req.params.id, requester?.org_id ?? null, null);
    res.json(result);
  } catch (err) {
    console.error('[billing sync-from-xero]', err);
    if (err.code === 'ORG_MISMATCH') {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    if (err.code === 'NO_XERO_LINK' || err.code === 'NOT_FOUND') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

// Email invoice PDFs to billing contacts; when Xero is linked, also create ACCREC invoices for reconciliation.
router.post('/batches/:batchRef/send', async (req, res) => {
  try {
    const { batchRef } = req.params;
    if (!batchRef) return res.status(400).json({ error: 'batch_ref required' });
    const requester = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session?.user?.id);
    const result = await sendBillingBatch(batchRef, requester?.org_id || null, req.session?.user?.id || null);
    const status =
      result.failed > 0 && result.sent === 0 ? 502 : result.failed > 0 ? 207 : 200;
    res.status(status).json({
      updated: result.sent,
      failed: result.failed,
      invoices: result.invoices,
      errors: result.errors,
      xero_warnings: result.xero_warnings,
      message: result.message
    });
  } catch (err) {
    console.error('[billing batch send]', err);
    if (err.code === 'ORG_MISMATCH') {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    if (err.code === 'EMAIL_NOT_CONNECTED') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err.code === 'USER_REQUIRED') {
      return res.status(401).json({ error: err.message, code: err.code });
    }
    if (err.code === 'BATCH_NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  }
});

// Record a payment split across all invoices in the batch (proportional to each invoice total). Prefer POST /:id/payments for per-invoice control.
router.post('/batches/:batchRef/payments', (req, res) => {
  try {
    const { batchRef } = req.params;
    const { amount, paid_at, note } = req.body;
    const amt = parseFloat(amount);
    if (!batchRef || isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'batch_ref and positive amount required' });
    }
    const paidAt = paid_at || new Date().toISOString().slice(0, 10);
    const created = recordBatchPaymentProportional(
      batchRef,
      amt,
      paidAt,
      note || null,
      req.session?.user?.id || null
    );
    if (created.length === 0) {
      return res.status(400).json({ error: 'No invoices found for this batch, or all invoice totals are zero' });
    }
    res.status(201).json({ batch_ref: batchRef, amount: roundMoney(amt), paid_at: paidAt, note: note || null, allocations: created });
  } catch (err) {
    console.error('[billing batch payment]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Void invoice: unlink shifts/tasks so work is billable again; remove lines and Xero link on record. */
router.post('/:id/void', (req, res) => {
  try {
    const id = req.params.id;
    const inv = db
      .prepare(
        `
      SELECT bi.id, bi.status, p.provider_org_id, bi.participant_id
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      WHERE bi.id = ?
    `
      )
      .get(id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!isParticipantVisibleToBillingRequest(inv.participant_id, req)) {
      return res.status(403).json({ error: 'Invoice does not belong to your organisation' });
    }
    if (inv.status === 'void') {
      return res.status(400).json({ error: 'Invoice is already void' });
    }
    const paid = billingInvoicePaidSum(db, id);
    if (paid > 0) {
      return res.status(400).json({
        error:
          'Cannot void an invoice that has recorded payments. Adjust or remove payment records first if appropriate.'
      });
    }
    const reason =
      typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : null;

    db.transaction(() => {
      db.prepare('UPDATE shifts SET billing_invoice_id = NULL WHERE billing_invoice_id = ?').run(id);
      db.prepare('UPDATE coordinator_tasks SET billing_invoice_id = NULL WHERE billing_invoice_id = ?').run(id);
      db.prepare('DELETE FROM billing_invoice_payments WHERE billing_invoice_id = ?').run(id);
      db.prepare('DELETE FROM billing_invoice_line_items WHERE billing_invoice_id = ?').run(id);
      db.prepare(
        `UPDATE billing_invoices
         SET status = 'void', xero_invoice_id = NULL, voided_at = datetime('now'), void_reason = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(reason || null, id);
    })();

    res.json({
      id,
      status: 'void',
      message:
        'Invoice voided. Linked shifts and tasks are available to bill again in a new batch for that period. If this invoice was sent to Xero, void or credit it there separately.'
    });
  } catch (err) {
    console.error('[billing void]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Rebuild line items from tasks/shifts still linked to this invoice (recovery when line rows were lost). */
router.post('/:id/rebuild-lines', (req, res) => {
  try {
    const invRow = db
      .prepare('SELECT participant_id FROM billing_invoices WHERE id = ?')
      .get(req.params.id);
    if (!invRow || !isParticipantVisibleToBillingRequest(invRow.participant_id, req)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const result = rebuildBillingInvoiceLineItems(req.params.id);
    if (!result.ok) {
      return res.status(404).json({ error: result.error || 'Not found' });
    }
    if (result.line_items === 0) {
      return res.status(400).json({
        error:
          'No line items could be rebuilt. Tasks and shifts are no longer linked to this invoice. Delete the invoice (if appropriate) and create a new batch from Batch invoices, or restore from backup.',
        line_items: 0
      });
    }
    res.json({
      message: `Rebuilt ${result.line_items} line item row(s). Refresh the list; totals and PDF should match the linked tasks and shifts.`,
      line_items: result.line_items
    });
  } catch (err) {
    console.error('[billing rebuild-lines]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/payments', (req, res) => {
  try {
    const inv = db
      .prepare(
        `
      SELECT bi.*, p.invoice_includes_gst
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      WHERE bi.id = ?
    `
      )
      .get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!isParticipantVisibleToBillingRequest(inv.participant_id, req)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (inv.status === 'void') {
      return res.status(400).json({ error: 'Cannot record payments on a void invoice.' });
    }
    const { amount, paid_at, note } = req.body;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Positive amount required' });
    }
    const payAmt = roundMoney(amt);
    const total = billingInvoiceTotalInclGst(db, inv.id, inv.invoice_includes_gst);
    const paidSoFar = billingInvoicePaidSum(db, inv.id);
    const outstanding = Math.max(0, roundMoney(total - paidSoFar));
    if (payAmt > outstanding + 0.01) {
      return res.status(400).json({ error: `Amount exceeds outstanding ($${outstanding.toFixed(2)})` });
    }
    const id = uuidv4();
    const paidAt = paid_at || new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO billing_invoice_payments (id, billing_invoice_id, amount, paid_at, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, inv.id, payAmt, paidAt, note || null);
    const newPaid = roundMoney(paidSoFar + payAmt);
    const newOut = Math.max(0, roundMoney(total - newPaid));
    let newStatus = inv.status;
    if (newOut <= MONEY_ZERO_EPS && inv.status !== 'draft') {
      db.prepare(`UPDATE billing_invoices SET status = 'paid', updated_at = datetime('now') WHERE id = ?`).run(inv.id);
      newStatus = 'paid';
    }
    res.status(201).json({
      id,
      billing_invoice_id: inv.id,
      amount: payAmt,
      paid_at: paidAt,
      note: note || null,
      total,
      paid: newPaid,
      outstanding: newOut,
      status: newStatus
    });
  } catch (err) {
    console.error('[billing invoice payment]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const inv = db.prepare(`
      SELECT bi.*, p.name as participant_name, p.ndis_number, p.address as participant_address,
             p.management_type, p.invoice_emails, p.invoice_includes_gst,
             o.name as plan_manager_name, o.abn as plan_manager_abn, o.email as plan_manager_email
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      LEFT JOIN organisations o ON p.plan_manager_id = o.id
      WHERE bi.id = ?
    `).get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!isParticipantVisibleToBillingRequest(inv.participant_id, req)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const items = db.prepare(`
      SELECT * FROM billing_invoice_line_items WHERE billing_invoice_id = ? ORDER BY line_date, created_at
    `).all(req.params.id);

    let subtotal = 0;
    items.forEach((li) => { subtotal += (li.quantity || 0) * (li.unit_price || 0); });
    const includesGst = participantInvoiceIncludesGst(inv.invoice_includes_gst);
    const { gst_amount: gstAmount, total_incl_gst: totalInclGst } = gstBreakdownFromSubtotal(subtotal, includesGst);

    let invoiceEmails = [];
    try { invoiceEmails = JSON.parse(inv.invoice_emails || '[]'); } catch { invoiceEmails = []; }
    if (!Array.isArray(invoiceEmails)) invoiceEmails = [];

    const payments = db
      .prepare(
        `
      SELECT id, amount, paid_at, note, created_at
      FROM billing_invoice_payments
      WHERE billing_invoice_id = ?
      ORDER BY paid_at DESC, created_at DESC
    `
      )
      .all(req.params.id);
    const paid = billingInvoicePaidSum(db, req.params.id);
    const outstanding = Math.max(0, roundMoney(totalInclGst - paid));

    res.json({
      ...inv,
      invoice_emails: invoiceEmails,
      line_items: items,
      subtotal: roundMoney(subtotal),
      gst_amount: gstAmount,
      total: totalInclGst,
      paid,
      outstanding,
      payments
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const inv = db
      .prepare(
        'SELECT id, invoice_number, participant_id FROM billing_invoices WHERE id = ?'
      )
      .get(req.params.id);
    if (!inv) return res.status(404).send('Invoice not found');
    if (!isParticipantVisibleToBillingRequest(inv.participant_id, req)) {
      return res.status(404).send('Invoice not found');
    }

    const buf = await generateBillingInvoicePdfBuffer(req.params.id);
    if (!buf) return res.status(404).send('Invoice not found');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${inv.invoice_number}.pdf"`);
    res.send(buf);

    const orgId = resolveOrgIdForBillingParticipant(inv.participant_id);
    if (orgId && getOnedriveLinkRow(orgId) && !billingInvoicePdfAlreadyInRegister(orgId, inv.id)) {
      void tryPushParticipantBinaryCategory({
        participantId: inv.participant_id,
        registerCategory: 'Invoice',
        folderSegment: 'Financial',
        buffer: buf,
        originalFilename: `invoice-${inv.invoice_number}.pdf`,
        mimeType: 'application/pdf',
        notes: `billing_invoice:${inv.id}`
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/status', (req, res) => {
  try {
    const existing = db
      .prepare('SELECT status, participant_id FROM billing_invoices WHERE id = ?')
      .get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    if (!isParticipantVisibleToBillingRequest(existing.participant_id, req)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (existing.status === 'void') {
      return res.status(400).json({ error: 'Cannot change status of a void invoice.' });
    }
    const { status } = req.body;
    db.prepare('UPDATE billing_invoices SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, req.params.id);
    res.json({ id: req.params.id, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const inv = db.prepare('SELECT id, participant_id FROM billing_invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!isParticipantVisibleToBillingRequest(inv.participant_id, req)) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const id = req.params.id;
    const run = db.transaction(() => {
      db.prepare('UPDATE shifts SET billing_invoice_id = NULL WHERE billing_invoice_id = ?').run(id);
      db.prepare('UPDATE coordinator_tasks SET billing_invoice_id = NULL WHERE billing_invoice_id = ?').run(id);
      db.prepare('DELETE FROM billing_invoice_line_items WHERE billing_invoice_id = ?').run(id);
      db.prepare('DELETE FROM billing_invoices WHERE id = ?').run(id);
    });
    run();
    return res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
