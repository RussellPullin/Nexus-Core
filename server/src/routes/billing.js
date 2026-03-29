/**
 * Billing - bulk invoice creation for a time period.
 * Combines unbilled tasks + shifts into one invoice per participant.
 * Draft batch shows all line items with checkboxes before confirming.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { join } from 'path';
import { existsSync } from 'fs';
import { db } from '../db/index.js';
import PDFDocument from 'pdfkit';
import {
  tryPushParticipantBinaryCategory,
  resolveOrgIdForBillingParticipant,
  billingInvoicePdfAlreadyInRegister
} from '../services/orgOnedriveSync.service.js';
import { getOnedriveLinkRow } from '../services/orgOnedriveTokens.service.js';
import { getDefaultLineItemForParticipant } from '../services/progressNoteMatcher.js';
import { syncShiftLineItemsWithProgressNote } from '../services/shiftLineItems.service.js';
import { getBusinessSettings, mergeWithEnv, uploadsDir } from './settings.js';
import { isNf2fTask, NF2F_TASK_TYPES } from '../lib/billingConstants.js';
import { participantInvoiceIncludesGst, roundMoney, gstBreakdownFromSubtotal } from '../lib/invoiceGst.js';
import { sanitizePdfText } from '../lib/pdfInvoiceText.js';
import { sendBillingBatchToXero } from '../services/xeroBillingPush.service.js';

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
      'SELECT COALESCE(SUM(quantity * unit_price), 0) as s FROM billing_invoice_line_items WHERE billing_invoice_id = ?'
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
function recordBatchPaymentProportional(batchRef, paidPool, paidAt, note) {
  const pool = roundMoney(Number(paidPool) || 0);
  if (pool <= 0) return [];
  const invRows = db
    .prepare(
      `
      SELECT bi.id, p.invoice_includes_gst
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      WHERE bi.invoice_number LIKE ?
    `
    )
    .all(`BINV-${batchRef}-%`);
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
      if (out <= 0.005) {
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

    const tasks = db.prepare(`
      SELECT ct.id, ct.participant_id, ct.activity_date, ct.description, ct.task_type,
             ct.quantity, ct.unit_price, ct.ndis_line_item_id, ct.duration_minutes,
             p.name as participant_name, p.ndis_number,
             nli.support_item_number, nli.description as ndis_description
      FROM coordinator_tasks ct
      JOIN participants p ON p.id = ct.participant_id
      LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
      WHERE ct.activity_date >= ? AND ct.activity_date <= ?
        AND ct.task_invoice_id IS NULL AND ct.billing_invoice_id IS NULL
      ORDER BY ct.participant_id, ct.activity_date
    `).all(from_date, to_date);

    const shifts = db.prepare(`
      SELECT s.id as shift_id, s.participant_id, s.start_time, s.end_time,
             p.name as participant_name, p.ndis_number
      FROM shifts s
      JOIN participants p ON p.id = s.participant_id
      WHERE s.status IN ('completed', 'completed_by_admin')
        AND s.billing_invoice_id IS NULL
        AND s.start_time >= ? AND s.start_time <= ?
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.shift_id = s.id)
      ORDER BY s.participant_id, s.start_time
    `).all(`${from_date}T00:00:00`, `${to_date}T23:59:59`);

    const lineItems = [];
    const TASK_TYPE_LABELS = { email: 'Email', meeting_f2f: 'Meeting f2f', meeting_non_f2f: 'Meeting', phone: 'Phone', other: 'Other' };

    const nf2fTasks = tasks.filter((t) => isNf2fTask(t.task_type));
    const nonNf2fTasks = tasks.filter((t) => !isNf2fTask(t.task_type));

    const nf2fByKey = {};
    nf2fTasks.forEach((t) => {
      const key = `${t.participant_id}|${t.activity_date}`;
      if (!nf2fByKey[key]) nf2fByKey[key] = [];
      nf2fByKey[key].push(t);
    });
    Object.entries(nf2fByKey).forEach(([, group]) => {
      const first = group[0];
      const totalQty = group.reduce((s, t) => s + (t.quantity || 0), 0);
      const totalAmt = group.reduce((s, t) => s + (t.quantity || 0) * (t.unit_price || 0), 0);
      lineItems.push({
        id: `task-nf2f-${first.participant_id}-${first.activity_date}`,
        source_type: 'task',
        source_task_ids: group.map((t) => t.id),
        participant_id: first.participant_id,
        participant_name: first.participant_name,
        ndis_number: first.ndis_number,
        line_date: first.activity_date,
        support_item_number: first.support_item_number || '-',
        description: 'Non-face-to-face (consolidated)',
        quantity: totalQty,
        unit_price: first.unit_price,
        unit: 'hour',
        total: totalAmt
      });
    });

    nonNf2fTasks.forEach((t) => {
      const desc = t.description || TASK_TYPE_LABELS[t.task_type] || t.task_type;
      lineItems.push({
        id: `task-${t.id}`,
        source_type: 'task',
        source_id: t.id,
        participant_id: t.participant_id,
        participant_name: t.participant_name,
        ndis_number: t.ndis_number,
        line_date: t.activity_date,
        support_item_number: t.support_item_number || '-',
        description: desc,
        quantity: t.quantity,
        unit_price: t.unit_price,
        unit: 'hour',
        total: (t.quantity || 0) * (t.unit_price || 0)
      });
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
        const supportDate = s.start_time ? s.start_time.slice(0, 10) : '';
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

      const supportDate = s.start_time ? s.start_time.slice(0, 10) : '';
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
    const { from_date, to_date, selected_ids } = req.body;
    if (!from_date || !to_date || !Array.isArray(selected_ids) || selected_ids.length === 0) {
      return res.status(400).json({ error: 'from_date, to_date, and selected_ids (array) required' });
    }

    const nf2fSelectedIds = selected_ids.filter((id) => id.startsWith('task-nf2f-'));
    const singleTaskIds = selected_ids.filter((id) => id.startsWith('task-') && !id.startsWith('task-nf2f-')).map((id) => id.replace('task-', ''));
    const shiftLineKeys = selected_ids
      .filter((id) => id.startsWith('shift-'))
      .map((id) => {
        const parsed = parseShiftSelectionId(id);
        if (!parsed) return null;
        return { shift_id: parsed.shift_id, line_item_id: parsed.line_item_id, key: id };
      })
      .filter(Boolean);

    const shiftIds = [...new Set(shiftLineKeys.map((k) => k.shift_id))];

    const participants = new Set();
    nf2fSelectedIds.forEach((id) => {
      const rest = id.replace('task-nf2f-', '');
      const date = rest.slice(-10);
      const participantId = rest.slice(0, -11);
      if (date.length === 10 && participantId) participants.add(participantId);
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
      const nf2fForParticipant = nf2fSelectedIds.filter((id) => {
        const rest = id.replace('task-nf2f-', '');
        return rest.slice(0, -11) === participantId;
      });
      count += nf2fForParticipant.length;
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

      const participantNf2fIds = nf2fSelectedIds.filter((id) => {
        const rest = id.replace('task-nf2f-', '');
        return rest.slice(0, -11) === participantId;
      });
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

      participantNf2fIds.forEach((nf2fId) => {
        const rest = nf2fId.replace('task-nf2f-', '');
        const lineDate = rest.slice(-10);
        const nf2fParticipantId = rest.slice(0, -11);
        if (nf2fParticipantId !== participantId || lineDate.length !== 10) return;
        const placeholders = NF2F_TASK_TYPES.map(() => '?').join(',');
        const nf2fGroup = db.prepare(`
          SELECT ct.id, ct.participant_id, ct.activity_date, ct.quantity, ct.unit_price, ct.ndis_line_item_id, ct.description, ct.task_type,
                 nli.support_item_number
          FROM coordinator_tasks ct
          LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
          WHERE ct.participant_id = ? AND ct.activity_date = ? AND ct.task_invoice_id IS NULL AND ct.billing_invoice_id IS NULL
            AND ct.task_type IN (${placeholders})
        `).all(nf2fParticipantId, lineDate, ...NF2F_TASK_TYPES);
        if (nf2fGroup.length === 0) return;
        const first = nf2fGroup[0];
        const totalQty = nf2fGroup.reduce((s, t) => s + (t.quantity || 0), 0);
        const taskIds = nf2fGroup.map((t) => t.id);
        insLine.run(uuidv4(), invId, 'task', first.id, null, null, first.ndis_line_item_id, first.support_item_number || '-', 'Non-face-to-face (consolidated)', totalQty, first.unit_price, 'hour', lineDate, JSON.stringify(taskIds));
        const updateTask = db.prepare('UPDATE coordinator_tasks SET billing_invoice_id = ? WHERE id = ?');
        taskIds.forEach((tid) => updateTask.run(invId, tid));
      });

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
        const lineDate = shift?.start_time ? shift.start_time.slice(0, 10) : from_date;
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
    const rows = db.prepare(`
      SELECT bi.*, p.name as participant_name, p.ndis_number, p.invoice_emails, p.invoice_includes_gst,
             COALESCE(li_sum.line_sub, 0) as line_sub,
             COALESCE(pay.paid_sum, 0) as paid_sum
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      LEFT JOIN (
        SELECT billing_invoice_id, SUM(quantity * unit_price) as line_sub
        FROM billing_invoice_line_items
        GROUP BY billing_invoice_id
      ) li_sum ON li_sum.billing_invoice_id = bi.id
      LEFT JOIN (
        SELECT billing_invoice_id, SUM(amount) as paid_sum
        FROM billing_invoice_payments
        GROUP BY billing_invoice_id
      ) pay ON pay.billing_invoice_id = bi.id
      ORDER BY bi.created_at DESC
    `).all();
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
    const invoices = db.prepare(`
      SELECT bi.id, bi.invoice_number, bi.status, bi.created_at, p.invoice_includes_gst
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      ORDER BY bi.created_at DESC
    `).all();

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
      const invTotal = billingInvoiceTotalInclGst(db, inv.id, inv.invoice_includes_gst);
      const invPaid = billingInvoicePaidSum(db, inv.id);
      const invOut = Math.max(0, roundMoney(invTotal - invPaid));
      row.total = roundMoney(row.total + invTotal);
      row.outstanding = roundMoney(row.outstanding + invOut);
      if (inv.created_at && (!row.created || inv.created_at < row.created)) row.created = inv.created_at;
      if (inv.status === 'draft') row.status = 'draft';
      row.invoice_ids.push(inv.id);
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

// Create AUTHORISED sales invoices in Xero for every draft in the batch, then mark sent and store xero_invoice_id.
router.post('/batches/:batchRef/send', async (req, res) => {
  try {
    const { batchRef } = req.params;
    if (!batchRef) return res.status(400).json({ error: 'batch_ref required' });
    const requester = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session?.user?.id);
    const result = await sendBillingBatchToXero(batchRef, requester?.org_id || null);
    const status =
      result.failed > 0 && result.sent === 0 ? 502 : result.failed > 0 ? 207 : 200;
    res.status(status).json({
      updated: result.sent,
      failed: result.failed,
      invoices: result.invoices,
      errors: result.errors,
      message: result.message
    });
  } catch (err) {
    console.error('[billing batch send]', err);
    if (err.code === 'ORG_MISMATCH') {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    if (err.code === 'XERO_NOT_LINKED') {
      return res.status(400).json({ error: err.message, code: err.code });
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
    const created = recordBatchPaymentProportional(batchRef, amt, paidAt, note || null);
    if (created.length === 0) {
      return res.status(400).json({ error: 'No invoices found for this batch, or all invoice totals are zero' });
    }
    res.status(201).json({ batch_ref: batchRef, amount: roundMoney(amt), paid_at: paidAt, note: note || null, allocations: created });
  } catch (err) {
    console.error('[billing batch payment]', err);
    res.status(500).json({ error: err.message });
  }
});

// Record a payment against one billing invoice (amount ≤ outstanding)
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
    if (newOut <= 0.005 && inv.status !== 'draft') {
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
    const inv = db.prepare(`
      SELECT bi.*, p.name as participant_name, p.ndis_number, p.address as participant_address,
             p.management_type, p.invoice_emails, p.invoice_includes_gst,
             o.name as plan_manager_name, o.abn as plan_manager_abn, o.email as plan_manager_email
      FROM billing_invoices bi
      JOIN participants p ON p.id = bi.participant_id
      LEFT JOIN organisations o ON p.plan_manager_id = o.id
      WHERE bi.id = ?
    `).get(req.params.id);
    if (!inv) return res.status(404).send('Invoice not found');

    let invoiceEmails = [];
    try { invoiceEmails = JSON.parse(inv.invoice_emails || '[]'); } catch { invoiceEmails = []; }
    if (!Array.isArray(invoiceEmails)) invoiceEmails = [];

    const items = db.prepare('SELECT * FROM billing_invoice_line_items WHERE billing_invoice_id = ? ORDER BY line_date, created_at').all(req.params.id);
    const includesGst = participantInvoiceIncludesGst(inv.invoice_includes_gst);
    let subtotal = 0;
    items.forEach((li) => { subtotal += (li.quantity || 0) * (li.unit_price || 0); });
    subtotal = roundMoney(subtotal);
    const { gst_amount: totalGst, total_incl_gst: grandTotal } = gstBreakdownFromSubtotal(subtotal, includesGst);

    const doc = new PDFDocument({ margin: 50 });
    doc.font('Helvetica');
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      const buf = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="invoice-${inv.invoice_number}.pdf"`);
      res.send(buf);
      const orgId = resolveOrgIdForBillingParticipant(inv.participant_id);
      if (
        orgId &&
        getOnedriveLinkRow(orgId) &&
        !billingInvoicePdfAlreadyInRegister(orgId, inv.id)
      ) {
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
    });
    doc.on('error', (err) => res.status(500).json({ error: err.message }));

    const billingOrgId = resolveOrgIdForBillingParticipant(inv.participant_id);
    const bizRow = getBusinessSettings(billingOrgId);
    const biz = mergeWithEnv(bizRow, { noOrgRowYet: Boolean(billingOrgId) && !bizRow });
    const companyName = sanitizePdfText(biz.company_name || 'Provider');
    const companyEmail = sanitizePdfText(biz.company_email || '');
    const companyAbn = sanitizePdfText(biz.company_abn || '');
    const companyAcn = sanitizePdfText(biz.company_acn || '');
    const ndisProviderNumber = sanitizePdfText(biz.ndis_provider_number || '');
    const companyRegistration = sanitizePdfText(process.env.COMPANY_REGISTRATION || '');
    const paymentTermsDays = String(biz.payment_terms_days || 7);
    const companyBsb = sanitizePdfText(biz.bsb || '');
    const companyAccount = sanitizePdfText(biz.account_number || '');
    const accountName = sanitizePdfText(biz.account_name || companyName);
    const logoPath = biz.logo_path ? join(uploadsDir, biz.logo_path) : null;

    const invDate = new Date(inv.created_at);
    const dueDate = new Date(invDate);
    dueDate.setDate(dueDate.getDate() + parseInt(paymentTermsDays, 10) || 7);
    const formatDate = (d) => d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const participantType = (inv.management_type === 'plan' || inv.plan_manager_id)
      ? 'Plan Managed'
      : 'Self Managed';

    // Logo (top-left)
    let startY = 50;
    if (logoPath && existsSync(logoPath)) {
      try {
        doc.image(logoPath, 50, 50, { width: 120 });
        startY = 50 + 80;
      } catch (e) {
        console.warn('[billing pdf] logo load failed:', e?.message);
      }
    }
    doc.y = startY;

    // Title (Tax Invoice only when GST is charged)
    doc.fontSize(18).text(includesGst ? 'Tax Invoice' : 'Invoice', { align: 'center' });
    doc.moveDown();

    // Top-right: Invoice meta
    const metaY = doc.y;
    doc.fontSize(10);
    doc.text(`Invoice Number ${sanitizePdfText(inv.invoice_number)}`, 350, metaY);
    doc.text(`Invoice Date ${formatDate(invDate)}`, 350, metaY + 14);
    doc.text(`Due Date ${formatDate(dueDate)}`, 350, metaY + 28);
    doc.text(`Total $${grandTotal.toFixed(2)}`, 350, metaY + 42);
    doc.text(`Amount Due $${grandTotal.toFixed(2)}`, 350, metaY + 56);
    doc.y = metaY + 70;

    // From block
    doc.text('From', { continued: false });
    doc.moveDown(0.3);
    doc.text(companyName);
    if (companyEmail) doc.text(companyEmail);
    if (companyAbn) doc.text(`ABN ${companyAbn}`);
    if (companyAcn) doc.text(`ACN ${companyAcn}`);
    if (ndisProviderNumber) doc.text(`NDIS Provider # ${ndisProviderNumber}`);
    if (companyRegistration) doc.text(`Registration # ${companyRegistration}`);
    doc.moveDown();

    // To block
    doc.text('To');
    doc.moveDown(0.3);
    const pName = sanitizePdfText(inv.participant_name);
    const pNdis = sanitizePdfText(inv.ndis_number || 'N/A');
    const pAddr = inv.participant_address ? sanitizePdfText(inv.participant_address) : '';
    const pmName = inv.plan_manager_name ? sanitizePdfText(inv.plan_manager_name) : '';
    const emailsJoined = sanitizePdfText(invoiceEmails.map((e) => sanitizePdfText(e)).join(', '));

    doc.text(pName);
    doc.text(`Participant ${pName}`);
    doc.text(`NDIS Number ${pNdis}`);
    doc.text(`Type ${participantType}`);
    if (pAddr) doc.text(`Address ${pAddr}`);
    if (pmName) doc.text(`Plan Manager ${pmName}`);
    if (invoiceEmails.length > 0) doc.text(`Invoice To ${emailsJoined}`);
    doc.moveDown();

    // Table header
    const tableTop = doc.y;
    doc.fontSize(9);
    doc.text('Item', 50, tableTop);
    doc.text('Details', 120, tableTop);
    doc.text('Quantity', 380, tableTop);
    doc.text('Price', 430, tableTop);
    doc.text('GST', 480, tableTop);
    doc.text('Total', 520, tableTop);
    doc.moveDown(0.5);

    let rowY = doc.y;
    items.forEach((li) => {
      const lineTotal = roundMoney((li.quantity || 0) * (li.unit_price || 0));
      const lineGst = includesGst ? roundMoney(lineTotal * 0.1) : 0;
      const lineDate = li.line_date ? new Date(li.line_date).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
      const claimType = li.source_task_ids ? 'Non-Face-to-Face' : 'Direct Service';
      const itemCell = sanitizePdfText(`${li.support_item_number || '-'} ${lineDate}`.trim());
      const descBlock = `${sanitizePdfText(li.description || 'Support')}\nClaim Type: ${claimType}`;

      doc.fontSize(9);
      const hLeft = doc.heightOfString(itemCell, { width: 65 });
      const hDetail = doc.heightOfString(descBlock, { width: 250 });
      const rowH = Math.max(hLeft, hDetail, 14);

      doc.text(itemCell, 50, rowY, { width: 65 });
      doc.text(descBlock, 120, rowY, { width: 250 });
      doc.text(String(li.quantity ?? ''), 380, rowY, { width: 45, align: 'right' });
      doc.text((li.unit_price ?? 0).toFixed(2), 430, rowY, { width: 45, align: 'right' });
      doc.text(includesGst ? lineGst.toFixed(2) : '0.00', 480, rowY, { width: 35, align: 'right' });
      doc.text(lineTotal.toFixed(2), 520, rowY, { width: 45, align: 'right' });

      rowY += rowH + 6;
    });
    doc.y = rowY + 8;

    // GST and Total
    const summaryY = doc.y;
    if (includesGst) {
      doc.text(`Subtotal (ex GST) ${subtotal.toFixed(2)}`, 380, summaryY, { width: 170, align: 'right' });
      doc.text(`GST (10%) ${totalGst.toFixed(2)}`, 380, summaryY + 14, { width: 170, align: 'right' });
      doc.text(`Total ${grandTotal.toFixed(2)}`, 380, summaryY + 28, { width: 170, align: 'right' });
      doc.text(`Amount Due $${grandTotal.toFixed(2)}`, 380, summaryY + 42, { width: 170, align: 'right' });
      doc.y = summaryY + 58;
    } else {
      doc.text('GST 0.00', 380, summaryY, { width: 170, align: 'right' });
      doc.text(`Total ${grandTotal.toFixed(2)}`, 380, summaryY + 14, { width: 170, align: 'right' });
      doc.text(`Amount Due $${grandTotal.toFixed(2)}`, 380, summaryY + 28, { width: 170, align: 'right' });
      doc.y = summaryY + 50;
    }

    doc.moveDown(0.5);
    doc.fontSize(8).text(
      includesGst
        ? `Amounts are ex GST unless noted. Total includes GST of $${totalGst.toFixed(2)}.`
        : 'GST does not apply to these supports (GST-free).',
      50,
      doc.y,
      { width: 500 }
    );
    doc.moveDown(1.2);

    // Payment Details
    doc.fontSize(9);
    const payY = doc.y;
    doc.text('Payment Details', 50, payY);
    doc.text(`Payment Terms: ${paymentTermsDays} days`, 50, payY + 18);
    doc.text(`Account Name: ${accountName}`, 50, payY + 32);
    doc.text(`BSB ${companyBsb || '-'}`, 50, payY + 46);
    doc.text(`Account ${companyAccount || '-'}`, 50, payY + 60);
    doc.text(`Reference ${sanitizePdfText(inv.invoice_number)}`, 50, payY + 74);
    doc.y = payY + 90;

    doc.fontSize(8).text('Page 1 of 1', { align: 'center' });
    doc.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    db.prepare('UPDATE billing_invoices SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, req.params.id);
    res.json({ id: req.params.id, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const inv = db.prepare('SELECT id FROM billing_invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
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
