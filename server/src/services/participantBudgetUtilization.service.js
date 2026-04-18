import { db } from '../db/index.js';
import { roundMoney } from '../lib/invoiceGst.js';

/**
 * Allocate a dollar amount to the first budget that lists this NDIS line item (same rule as legacy utilisation).
 */
function allocateCost(budgetById, budgetOrder, ndisLineItemId, cost, field) {
  if (ndisLineItemId == null || ndisLineItemId === '') return;
  const c = Number(cost);
  if (!Number.isFinite(c) || c === 0) return;
  const nid = String(ndisLineItemId);
  for (const bid of budgetOrder) {
    const b = budgetById[bid];
    if (b.line_item_ids.includes(nid)) {
      b[field] += c;
      return;
    }
  }
}

export function loadBudgetBucketsForPlan(planId) {
  const rows = db.prepare(`
    SELECT pb.id, pb.name, pb.category, pb.amount, pb.management_type, bli.ndis_line_item_id
    FROM plan_budgets pb
    LEFT JOIN budget_line_items bli ON bli.budget_id = pb.id
    WHERE pb.plan_id = ?
    ORDER BY pb.id
  `).all(planId);

  const budgetById = {};
  const budgetOrder = [];
  for (const row of rows) {
    if (!budgetById[row.id]) {
      budgetOrder.push(row.id);
      budgetById[row.id] = {
        id: row.id,
        name: row.name,
        category: row.category,
        amount: Number(row.amount) || 0,
        management_type: row.management_type || 'self',
        line_item_ids: [],
        invoiced: 0,
        pending_invoice: 0
      };
    }
    if (row.ndis_line_item_id) {
      budgetById[row.id].line_item_ids.push(String(row.ndis_line_item_id));
    }
  }
  return { budgetById, budgetOrder };
}

export function accumulateInvoicedForPlanWindow(participantId, planStart, planEndInclusive, budgetById, budgetOrder) {
  const rows = db.prepare(`
    SELECT bil.ndis_line_item_id, bil.quantity, bil.unit_price
    FROM billing_invoice_line_items bil
    INNER JOIN billing_invoices bi ON bi.id = bil.billing_invoice_id
    WHERE bi.participant_id = ?
      AND (bi.status IS NULL OR bi.status != 'void')
      AND bil.line_date >= ?
      AND bil.line_date <= ?
  `).all(participantId, planStart, planEndInclusive);

  for (const li of rows) {
    const cost = (Number(li.quantity) || 0) * (Number(li.unit_price) || 0);
    allocateCost(budgetById, budgetOrder, li.ndis_line_item_id, cost, 'invoiced');
  }
}

export function accumulatePendingForPlanWindow(participantId, planStart, planEndInclusive, budgetById, budgetOrder) {
  const shifts = db.prepare(`
    SELECT s.id
    FROM shifts s
    WHERE s.participant_id = ?
      AND s.start_time >= ? AND s.start_time <= ?
      AND (s.billing_invoice_id IS NULL OR TRIM(COALESCE(s.billing_invoice_id, '')) = '')
  `).all(participantId, `${planStart} 00:00:00`, `${planEndInclusive} 23:59:59`);

  const shiftIds = shifts.map((s) => s.id);
  if (shiftIds.length > 0) {
    const placeholders = shiftIds.map(() => '?').join(',');
    const lineItems = db.prepare(`
      SELECT sli.ndis_line_item_id, sli.quantity, sli.unit_price
      FROM shift_line_items sli
      WHERE sli.shift_id IN (${placeholders})
    `).all(...shiftIds);
    for (const li of lineItems) {
      const cost = (Number(li.quantity) || 0) * (Number(li.unit_price) || 0);
      allocateCost(budgetById, budgetOrder, li.ndis_line_item_id, cost, 'pending_invoice');
    }
  }

  const tasks = db.prepare(`
    SELECT ct.ndis_line_item_id, ct.quantity, ct.unit_price
    FROM coordinator_tasks ct
    WHERE ct.participant_id = ?
      AND ct.activity_date >= ? AND ct.activity_date <= ?
      AND (ct.billing_invoice_id IS NULL OR TRIM(COALESCE(ct.billing_invoice_id, '')) = '')
      AND (ct.task_invoice_id IS NULL OR TRIM(COALESCE(ct.task_invoice_id, '')) = '')
  `).all(participantId, planStart, planEndInclusive);

  for (const t of tasks) {
    const cost = (Number(t.quantity) || 0) * (Number(t.unit_price) || 0);
    allocateCost(budgetById, budgetOrder, t.ndis_line_item_id, cost, 'pending_invoice');
  }
}

/**
 * Rows for GET /participants/:id/budget-utilization
 */
export function computeBudgetUtilizationForPlan(participantId, plan) {
  const { budgetById, budgetOrder } = loadBudgetBucketsForPlan(plan.id);
  if (budgetOrder.length === 0) return [];

  accumulateInvoicedForPlanWindow(participantId, plan.start_date, plan.end_date, budgetById, budgetOrder);
  accumulatePendingForPlanWindow(participantId, plan.start_date, plan.end_date, budgetById, budgetOrder);

  return budgetOrder.map((bid) => {
    const b = budgetById[bid];
    const invoiced = roundMoney(b.invoiced);
    const pending_invoice = roundMoney(b.pending_invoice);
    const amount = roundMoney(b.amount);
    const remaining = roundMoney(Math.max(0, amount - invoiced));
    const percent_used = amount > 0 ? Math.round((invoiced / amount) * 100) : 0;
    return {
      id: b.id,
      name: b.name,
      category: b.category,
      amount,
      invoiced,
      pending_invoice,
      remaining,
      percent_used,
      used: invoiced
    };
  });
}

/**
 * Per-budget invoiced spend and remaining for plan refresh (split at today). Uses billing lines only; window is plan start through `asOfDate` (inclusive).
 */
export function computeInvoicedUsedRemainingForPlanRefresh(participantId, planId, planStart, asOfDate) {
  const { budgetById, budgetOrder } = loadBudgetBucketsForPlan(planId);
  accumulateInvoicedForPlanWindow(participantId, planStart, asOfDate, budgetById, budgetOrder);

  return budgetOrder.map((bid) => {
    const b = budgetById[bid];
    const used = roundMoney(b.invoiced);
    const amount = Number(b.amount) || 0;
    const remaining = Math.max(0, roundMoney(amount - used));
    return {
      id: b.id,
      name: b.name,
      category: b.category,
      management_type: b.management_type || 'self',
      amount,
      used,
      remaining,
      line_item_ids: [...b.line_item_ids]
    };
  });
}
