/**
 * Nexus Core SaaS billing dashboard — vendor-only.
 * GET  /api/saas/billing/dashboard?secret=<BILLING_AUTH_SECRET>
 * POST /api/saas/billing/invoice-now  { secret, orgId }
 * POST /api/saas/billing/mark-paid    { secret, invoiceId }
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createSaasInvoice } from '../services/saasInvoiceService.js';
import { createCombinedInvoice } from '../services/combinedInvoiceService.js';
import { MONTHLY_FLAT_RATE } from '../lib/saasBillingTiers.js';

const router = Router();

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set');
  return createClient(url, key);
}

function getShifterSupabase() {
  const url = (process.env.SHIFTER_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SHIFTER_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SHIFTER_SUPABASE_URL and SHIFTER_SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function checkSecret(req, res) {
  const secret = process.env.BILLING_AUTH_SECRET;
  const provided = req.query.secret || req.body?.secret;
  if (!secret || provided !== secret) { res.status(401).send('Unauthorized'); return false; }
  return true;
}

function currency(n) { return `$${Number(n || 0).toFixed(2)}`; }

function statusBadge(status) {
  const colours = { trialing: '#6366f1', active: '#22c55e', past_due: '#f59e0b', cancelled: '#ef4444', pending: '#94a3b8', paid: '#22c55e', overdue: '#ef4444', voided: '#6b7280' };
  return `<span style="background:${colours[status]||'#94a3b8'};color:#fff;padding:2px 8px;border-radius:9999px;font-size:12px;font-weight:600">${status}</span>`;
}

function daysSince(d) { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }

function nextReminderLabel(daysOld) {
  if (daysOld < 7)  return `Day 7 reminder in ${7  - daysOld}d`;
  if (daysOld < 14) return `Due-date notice in ${14 - daysOld}d`;
  if (daysOld < 21) return `<span style="color:#f59e0b">Overdue warning in ${21 - daysOld}d</span>`;
  return `<span style="color:#ef4444">Overdue — access suspended</span>`;
}

// GET /api/saas/billing/dashboard
router.get('/dashboard', async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    const supabase = getSupabase();
    const secret = req.query.secret;

    const [{ data: orgs }, { data: invoices }] = await Promise.all([
      supabase.from('organizations')
        .select('id, name, subscription_status, trial_ends_at, billing_anchor_date, subscription_expires_at, locked_at, billing_email')
        .order('name'),
      supabase.from('saas_invoices')
        .select('*')
        .order('issued_at', { ascending: false })
        .limit(500),
    ]);

    const invoicesByOrg = {};
    for (const inv of invoices || []) {
      if (!invoicesByOrg[inv.org_id]) invoicesByOrg[inv.org_id] = [];
      invoicesByOrg[inv.org_id].push(inv);
    }

    const activeCount  = (orgs || []).filter(o => o.subscription_status === 'active').length;
    const trialCount   = (orgs || []).filter(o => o.subscription_status === 'trialing').length;
    const pastDueCount = (orgs || []).filter(o => o.subscription_status === 'past_due').length;
    const mrr          = activeCount * MONTHLY_FLAT_RATE;
    const outstanding  = (invoices || []).filter(i => i.status === 'overdue' || i.status === 'pending').reduce((s, i) => s + Number(i.total), 0);
    const totalPaid    = (invoices || []).filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0);

    // --- Org rows ---
    const orgRows = (orgs || []).map(org => {
      const orgInvoices = invoicesByOrg[org.id] || [];
      const unpaid = orgInvoices.filter(i => i.status === 'pending' || i.status === 'overdue');
      const nextDate = org.subscription_expires_at
        ? new Date(org.subscription_expires_at).toLocaleDateString('en-AU')
        : org.trial_ends_at ? `Trial ends ${new Date(org.trial_ends_at).toLocaleDateString('en-AU')}` : '—';

      const unpaidRows = unpaid.map(inv => {
        const days = daysSince(inv.issued_at);
        const markPaidBtn = `<form method="POST" action="/api/saas/billing/mark-paid" style="display:inline;margin-left:4px">
          <input type="hidden" name="secret" value="${secret}">
          <input type="hidden" name="invoiceId" value="${inv.id}">
          <button type="submit" style="font-size:10px;padding:2px 8px;background:#22c55e;color:#fff;border:none;border-radius:4px;cursor:pointer">✓ Paid</button>
        </form>`;
        const voidBtn = `<form method="POST" action="/api/saas/billing/void-invoice" style="display:inline;margin-left:4px" onsubmit="return confirm('Void invoice ${inv.invoice_number}?')">
          <input type="hidden" name="secret" value="${secret}">
          <input type="hidden" name="invoiceId" value="${inv.id}">
          <button type="submit" style="font-size:10px;padding:2px 8px;background:#475569;color:#fff;border:none;border-radius:4px;cursor:pointer">✕ Void</button>
        </form>`;
        return `<tr style="font-size:12px">
          <td style="padding:4px 8px;color:#94a3b8">${inv.invoice_number || '—'}</td>
          <td style="padding:4px 8px">${currency(inv.total)}</td>
          <td style="padding:4px 8px">${statusBadge(inv.status)}${markPaidBtn}${voidBtn}</td>
          <td style="padding:4px 8px;color:#94a3b8">${inv.due_at ? `Due ${new Date(inv.due_at).toLocaleDateString('en-AU')}` : '—'}</td>
          <td style="padding:4px 8px;color:#64748b">${nextReminderLabel(days)}</td>
        </tr>`;
      }).join('');

      return `<tr>
        <td style="padding:10px 12px;font-weight:600">${org.name || org.id}</td>
        <td style="padding:10px 12px">${statusBadge(org.subscription_status || 'trialing')}</td>
        <td style="padding:10px 12px">${currency(MONTHLY_FLAT_RATE)}/mo</td>
        <td style="padding:10px 12px">${nextDate}</td>
        <td style="padding:10px 12px">
          ${unpaid.length ? `<table width="100%"><thead><tr style="font-size:11px;color:#475569"><th style="padding:2px 8px">Invoice</th><th>Amount</th><th>Status</th><th>Due</th><th>Next reminder</th></tr></thead><tbody>${unpaidRows}</tbody></table>` : '<span style="color:#22c55e;font-size:12px">✓ All paid</span>'}
          <form method="POST" action="/api/saas/billing/invoice-now" style="margin-top:6px;display:inline-block">
            <input type="hidden" name="secret" value="${secret}">
            <input type="hidden" name="orgId" value="${org.id}">
            <button type="submit" style="font-size:11px;padding:3px 10px;background:#6366f1;color:#fff;border:none;border-radius:4px;cursor:pointer">+ Invoice now</button>
          </form>
          ${org.subscription_status === 'cancelled'
            ? `<form method="POST" action="/api/saas/billing/reactivate-org" style="display:inline-block;margin-left:6px">
                <input type="hidden" name="secret" value="${secret}">
                <input type="hidden" name="orgId" value="${org.id}">
                <button type="submit" style="font-size:11px;padding:3px 10px;background:#22c55e;color:#fff;border:none;border-radius:4px;cursor:pointer">↺ Reactivate</button>
               </form>`
            : `<form method="POST" action="/api/saas/billing/cancel-org" style="display:inline-block;margin-left:6px" onsubmit="return confirm('Cancel billing for ${org.name}? No more invoices will be sent.')">
                <input type="hidden" name="secret" value="${secret}">
                <input type="hidden" name="orgId" value="${org.id}">
                <button type="submit" style="font-size:11px;padding:3px 10px;background:#475569;color:#fff;border:none;border-radius:4px;cursor:pointer">✕ Cancel org</button>
               </form>`
          }
        </td>
      </tr>`;
    }).join('');

    // --- Full invoice history ---
    const historyRows = (invoices || []).map(inv => {
      const org = (orgs || []).find(o => o.id === inv.org_id);
      const days = daysSince(inv.issued_at);
      const markPaidBtn = (inv.status === 'pending' || inv.status === 'overdue')
        ? `<form method="POST" action="/api/saas/billing/mark-paid" style="display:inline;margin-left:6px">
            <input type="hidden" name="secret" value="${secret}">
            <input type="hidden" name="invoiceId" value="${inv.id}">
            <button type="submit" style="font-size:10px;padding:2px 6px;background:#22c55e;color:#fff;border:none;border-radius:4px;cursor:pointer">✓ Mark paid</button>
           </form>` : '';
      return `<tr>
        <td style="padding:8px 12px;font-size:13px">${inv.invoice_number || '—'}</td>
        <td style="padding:8px 12px;font-size:13px">${org?.name || inv.org_id}</td>
        <td style="padding:8px 12px;font-size:13px">${inv.period_label}</td>
        <td style="padding:8px 12px;font-size:13px;text-align:right">${currency(inv.total)}</td>
        <td style="padding:8px 12px">${statusBadge(inv.status)}${markPaidBtn}</td>
        <td style="padding:8px 12px;font-size:12px;color:#94a3b8">${new Date(inv.issued_at).toLocaleDateString('en-AU')}</td>
        <td style="padding:8px 12px;font-size:12px;color:#94a3b8">${inv.paid_at ? new Date(inv.paid_at).toLocaleDateString('en-AU') : inv.due_at ? `Due ${new Date(inv.due_at).toLocaleDateString('en-AU')}` : '—'}</td>
        <td style="padding:8px 12px;font-size:12px;color:#64748b">${inv.status === 'pending' || inv.status === 'overdue' ? nextReminderLabel(days) : '—'}</td>
      </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Nexus Core Billing</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
    h1 { color: #38bdf8; margin-bottom: 4px; font-size: 24px; }
    h2 { color: #94a3b8; font-size: 15px; font-weight: 500; margin: 32px 0 12px; text-transform: uppercase; letter-spacing: 1px; }
    .summary { display: flex; gap: 12px; margin: 20px 0 28px; flex-wrap: wrap; }
    .card { background: #1e293b; border-radius: 10px; padding: 14px 20px; min-width: 140px; }
    .card-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .card-value { font-size: 26px; font-weight: 700; color: #38bdf8; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; margin-bottom: 8px; }
    th { background: #0f172a; color: #64748b; text-align: left; padding: 10px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
    tr:nth-child(even) td { background: #162032; }
    .section { margin-bottom: 40px; }
  </style>
</head>
<body>
  <h1>Nexus Core Billing</h1>
  <p style="color:#64748b;margin:0 0 4px">$${MONTHLY_FLAT_RATE}/org/month &nbsp;·&nbsp; 14-day free trial &nbsp;·&nbsp; ABN 75 249 898 796</p>

  <div class="summary">
    <div class="card"><div class="card-label">Active</div><div class="card-value">${activeCount}</div></div>
    <div class="card"><div class="card-label">Trialling</div><div class="card-value" style="color:#6366f1">${trialCount}</div></div>
    <div class="card"><div class="card-label">Past Due</div><div class="card-value" style="color:#f59e0b">${pastDueCount}</div></div>
    <div class="card"><div class="card-label">MRR</div><div class="card-value">${currency(mrr)}</div></div>
    <div class="card"><div class="card-label">Next Month Proj</div><div class="card-value">${currency(mrr)}</div></div>
    <div class="card"><div class="card-label">Outstanding</div><div class="card-value" style="color:#f59e0b">${currency(outstanding)}</div></div>
    <div class="card"><div class="card-label">Total Collected</div><div class="card-value" style="color:#22c55e">${currency(totalPaid)}</div></div>
  </div>

  <div class="section">
    <h2>Organisations</h2>
    <table>
      <thead><tr><th>Organisation</th><th>Status</th><th>Fee</th><th>Next Invoice</th><th>Unpaid Invoices</th></tr></thead>
      <tbody>${orgRows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>All Invoices</h2>
    <table>
      <thead><tr><th>Invoice #</th><th>Organisation</th><th>Period</th><th>Amount</th><th>Status</th><th>Issued</th><th>Due / Paid</th><th>Next Reminder</th></tr></thead>
      <tbody>${historyRows || '<tr><td colspan="8" style="padding:16px;color:#64748b;text-align:center">No invoices yet</td></tr>'}</tbody>
    </table>
  </div>

  <p style="color:#1e293b;font-size:11px">Refreshed ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })} AEST</p>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// POST /api/saas/billing/invoice-now
router.post('/invoice-now', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { orgId } = req.body;
  if (!orgId) return res.status(400).send('orgId required');
  try {
    const supabase = getSupabase();
    const now = new Date();
    const label = `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()}`;

    // Check if this org is linked to a Shifter org — if so, send combined invoice
    const { data: org } = await supabase
      .from('organizations')
      .select('linked_shifter_org_id')
      .eq('id', orgId)
      .single();

    if (org?.linked_shifter_org_id) {
      // Count active Shifter users for this org
      const shifterSupabase = getShifterSupabase();
      const { count } = await shifterSupabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', org.linked_shifter_org_id)
        .eq('is_active', true);
      await createCombinedInvoice(orgId, org.linked_shifter_org_id, label, Math.max(1, count || 0));
    } else {
      await createSaasInvoice(orgId, label);
    }

    res.redirect(`/api/saas/billing/dashboard?secret=${req.body.secret}`);
  } catch (err) {
    res.status(500).send(`Failed: ${err.message}`);
  }
});

// POST /api/saas/billing/mark-paid
router.post('/mark-paid', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { invoiceId } = req.body;
  if (!invoiceId) return res.status(400).send('invoiceId required');
  try {
    const supabase = getSupabase();
    const { data: inv } = await supabase
      .from('saas_invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .select('org_id')
      .single();

    if (inv?.org_id) {
      await supabase
        .from('organizations')
        .update({ subscription_status: 'active', locked_at: null })
        .eq('id', inv.org_id);
    }
    res.redirect(`/api/saas/billing/dashboard?secret=${req.body.secret}`);
  } catch (err) {
    res.status(500).send(`Failed: ${err.message}`);
  }
});

// POST /api/saas/billing/void-invoice
router.post('/void-invoice', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { invoiceId } = req.body;
  if (!invoiceId) return res.status(400).send('invoiceId required');
  try {
    const supabase = getSupabase();
    await supabase
      .from('saas_invoices')
      .update({ status: 'voided' })
      .eq('id', invoiceId);
    res.redirect(`/api/saas/billing/dashboard?secret=${req.body.secret}`);
  } catch (err) {
    res.status(500).send(`Failed: ${err.message}`);
  }
});

// POST /api/saas/billing/cancel-org
router.post('/cancel-org', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { orgId } = req.body;
  if (!orgId) return res.status(400).send('orgId required');
  try {
    const supabase = getSupabase();
    await supabase
      .from('organizations')
      .update({ subscription_status: 'cancelled', locked_at: new Date().toISOString() })
      .eq('id', orgId);
    res.redirect(`/api/saas/billing/dashboard?secret=${req.body.secret}`);
  } catch (err) {
    res.status(500).send(`Failed: ${err.message}`);
  }
});

// POST /api/saas/billing/reactivate-org
router.post('/reactivate-org', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { orgId } = req.body;
  if (!orgId) return res.status(400).send('orgId required');
  try {
    const supabase = getSupabase();
    await supabase
      .from('organizations')
      .update({ subscription_status: 'active', locked_at: null })
      .eq('id', orgId);
    res.redirect(`/api/saas/billing/dashboard?secret=${req.body.secret}`);
  } catch (err) {
    res.status(500).send(`Failed: ${err.message}`);
  }
});

export default router;
