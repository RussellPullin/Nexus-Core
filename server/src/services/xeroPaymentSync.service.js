/**
 * Pull payment totals from Xero (ACCREC) and align Nexus billing_invoice_payments when Xero shows more received.
 */
import { randomUUID } from 'crypto';
import { db } from '../db/index.js';
import {
  getXeroAccessToken,
  parseXeroApiBodyOrThrow,
  XERO_API_BASE
} from '../routes/settings.js';
import {
  participantInvoiceIncludesGst,
  roundMoney,
  gstBreakdownFromSubtotal,
  MONEY_ZERO_EPS
} from '../lib/invoiceGst.js';
import { resolveOrgIdForBillingParticipant } from './orgOnedriveSync.service.js';

function xeroHeaders(accessToken, tenantId) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId
  };
}

function lineSubtotal(invoiceId) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(quantity AS REAL) * CAST(unit_price AS REAL)), 0) as s
       FROM billing_invoice_line_items WHERE billing_invoice_id = ?`
    )
    .get(invoiceId);
  return roundMoney(r?.s || 0);
}

function totalInclGstForInvoice(inv) {
  const sub = lineSubtotal(inv.id);
  return gstBreakdownFromSubtotal(sub, participantInvoiceIncludesGst(inv.invoice_includes_gst)).total_incl_gst;
}

function paidSum(invoiceId) {
  const r = db
    .prepare('SELECT COALESCE(SUM(amount), 0) as s FROM billing_invoice_payments WHERE billing_invoice_id = ?')
    .get(invoiceId);
  return roundMoney(r?.s || 0);
}

/**
 * Fetch ACCREC from Xero and insert a Nexus payment row when AmountPaid exceeds recorded payments (incl. GST).
 *
 * @param {string} billingInvoiceId
 * @param {string | null} requesterOrgId — users.org_id for ORG_MISMATCH checks (optional for webhooks)
 * @param {string | null} note — optional payment note (e.g. webhook vs manual sync)
 * @returns {Promise<object>}
 */
export async function syncBillingInvoiceFromXero(billingInvoiceId, requesterOrgId, note = null) {
  const inv = db
    .prepare(
      `
    SELECT bi.*, p.invoice_includes_gst, p.provider_org_id, p.id as participant_id
    FROM billing_invoices bi
    JOIN participants p ON p.id = bi.participant_id
    WHERE bi.id = ?
  `
    )
    .get(billingInvoiceId);

  if (!inv) {
    const err = new Error('Invoice not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (requesterOrgId && inv.provider_org_id && String(inv.provider_org_id) !== String(requesterOrgId)) {
    const err = new Error('Invoice does not belong to your organisation');
    err.code = 'ORG_MISMATCH';
    throw err;
  }

  const xeroInvoiceId = String(inv.xero_invoice_id || '').trim();
  if (!xeroInvoiceId) {
    const err = new Error('This invoice is not linked to Xero yet. Send the batch from Nexus first.');
    err.code = 'NO_XERO_LINK';
    throw err;
  }

  if (inv.status === 'void') {
    return { ok: true, skipped: true, reason: 'void_invoice' };
  }

  const targetOrgId =
    inv.provider_org_id || requesterOrgId || resolveOrgIdForBillingParticipant(inv.participant_id) || null;

  let accessToken;
  let tenantId;
  try {
    ({ accessToken, tenantId } = await getXeroAccessToken(targetOrgId));
  } catch (e) {
    const err = new Error(e?.message || 'Xero is not linked');
    err.code = 'NO_XERO_LINK';
    throw err;
  }

  const url = `${XERO_API_BASE}/Invoices/${encodeURIComponent(xeroInvoiceId)}`;
  const res = await fetch(url, { headers: xeroHeaders(accessToken, tenantId) });
  const text = await res.text();
  let data;
  try {
    data = parseXeroApiBodyOrThrow(text, 'Xero invoice GET', res.status);
  } catch (e) {
    const err = new Error(e?.message || 'Invalid Xero response');
    err.code = 'XERO_ERROR';
    throw err;
  }

  if (!res.ok) {
    const err = new Error(data?.Message || text?.slice(0, 400) || `Xero invoice GET failed (${res.status})`);
    err.code = 'XERO_ERROR';
    throw err;
  }

  const xi = data?.Invoices?.[0];
  if (!xi) {
    const err = new Error('Xero returned no invoice');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const xeroTotal = roundMoney(Number(xi.Total) || 0);
  const xeroInvoiceNumber = xi.InvoiceNumber != null ? String(xi.InvoiceNumber) : null;

  const status = String(xi.Status || '').toUpperCase();
  if (status === 'VOIDED') {
    return {
      ok: true,
      skipped: true,
      reason: 'xero_voided',
      xero_status: status,
      xero_total: xeroTotal,
      xero_invoice_number: xeroInvoiceNumber
    };
  }

  const xeroPaid = roundMoney(Number(xi.AmountPaid) || 0);
  const nexusPaid = paidSum(inv.id);
  const total = roundMoney(totalInclGstForInvoice(inv));
  const outstanding = Math.max(0, roundMoney(total - nexusPaid));

  const delta = roundMoney(xeroPaid - nexusPaid);

  if (delta < MONEY_ZERO_EPS) {
    const rem = Math.max(0, roundMoney(total - nexusPaid));
    let syncStatus = inv.status;
    if (inv.status !== 'draft' && rem <= MONEY_ZERO_EPS && inv.status !== 'paid') {
      db.prepare(`UPDATE billing_invoices SET status = 'paid', updated_at = datetime('now') WHERE id = ?`).run(inv.id);
      syncStatus = 'paid';
    }
    return {
      ok: true,
      skipped: true,
      reason: 'already_in_sync',
      xero_amount_paid: xeroPaid,
      nexus_paid: nexusPaid,
      total_incl_gst: total,
      xero_total: xeroTotal,
      xero_invoice_number: xeroInvoiceNumber,
      xero_status: status,
      outstanding_after: rem,
      status: syncStatus
    };
  }

  const amountToAdd = roundMoney(Math.min(delta, Math.max(outstanding, 0) + MONEY_ZERO_EPS * 2));
  if (amountToAdd < MONEY_ZERO_EPS) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_allocatable_outstanding',
      xero_amount_paid: xeroPaid,
      nexus_paid: nexusPaid,
      total_incl_gst: total,
      xero_total: xeroTotal,
      outstanding,
      delta,
      xero_invoice_number: xeroInvoiceNumber,
      xero_status: status
    };
  }

  const payNote = note || 'Synced from Xero';
  const paidAt = new Date().toISOString().slice(0, 10);
  const payId = randomUUID();

  db.prepare(
    `
    INSERT INTO billing_invoice_payments (id, billing_invoice_id, amount, paid_at, note)
    VALUES (?, ?, ?, ?, ?)
  `
  ).run(payId, inv.id, amountToAdd, paidAt, payNote);

  const newPaid = roundMoney(nexusPaid + amountToAdd);
  const newOut = Math.max(0, roundMoney(total - newPaid));
  let newStatus = inv.status;
  if (newOut <= MONEY_ZERO_EPS && inv.status !== 'draft') {
    db.prepare(`UPDATE billing_invoices SET status = 'paid', updated_at = datetime('now') WHERE id = ?`).run(inv.id);
    newStatus = 'paid';
  }

  return {
    ok: true,
    payment_id: payId,
    amount_added: amountToAdd,
    xero_amount_paid: xeroPaid,
    nexus_paid_before: nexusPaid,
    nexus_paid_after: newPaid,
    total_incl_gst: total,
    xero_total: xeroTotal,
    xero_invoice_number: xeroInvoiceNumber,
    outstanding_after: newOut,
    status: newStatus,
    xero_status: status
  };
}

/**
 * Used by webhooks: resolve Nexus billing invoice id from Xero invoice UUID and sync payments.
 */
export async function syncBillingInvoiceFromXeroByXeroId(xeroInvoiceUuid, _tenantId, note) {
  const xid = String(xeroInvoiceUuid || '').trim();
  if (!xid) return { ok: false, skipped: true, reason: 'no_xero_id' };

  const row = db.prepare('SELECT id FROM billing_invoices WHERE xero_invoice_id = ?').get(xid);
  if (!row?.id) {
    return { ok: false, skipped: true, reason: 'no_matching_nexus_invoice' };
  }

  // Do not pass tenant org as requesterOrgId — invoice is already matched by Xero id; avoid false ORG_MISMATCH.
  return syncBillingInvoiceFromXero(row.id, null, note || 'Synced from Xero (webhook)');
}
