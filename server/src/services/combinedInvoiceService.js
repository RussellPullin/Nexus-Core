/**
 * Combined invoice for orgs that use both Nexus Core and Shifter.
 * Reads Shifter Supabase via SHIFTER_SUPABASE_URL + SHIFTER_SUPABASE_SERVICE_ROLE_KEY.
 * Sends one email invoice with two line items, records in both saas_invoices tables.
 */

import { createClient } from '@supabase/supabase-js';
import { MONTHLY_FLAT_RATE } from '../lib/saasBillingTiers.js';
import { sendMail } from '../lib/mailer.js';

const PRICE_PER_USER = 8.5;
const VENDOR_NAME = 'Nexus Core Solutions';
const VENDOR_EMAIL = 'nexuscoresolutions@outlook.com';
const VENDOR_ABN = '75 249 898 796';
const VENDOR_BSB = '923-100';
const VENDOR_ACCOUNT = '811730015';

function getNcSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NC Supabase env not set');
  return createClient(url, key);
}

function getShifterSupabase() {
  const url = (process.env.SHIFTER_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SHIFTER_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SHIFTER_SUPABASE_URL and SHIFTER_SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function logoUrl() {
  const base = (process.env.OAUTH_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/logo.png` : null;
}

function currency(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function makeInvoiceNumber(orgName, issuedAt) {
  const slug = (orgName || 'ORG').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4).padEnd(4, 'X');
  const ym = new Date(issuedAt).toISOString().slice(0, 7).replace('-', '');
  const rand = String(Math.floor(Math.random() * 900) + 100);
  return `NC-${slug}-${ym}-${rand}`;
}

function buildCombinedInvoiceHtml({ invoiceNumber, orgName, to, issuedAt, dueDate, ncAmount, shifterUserCount, shifterAmount, total }) {
  const logo = logoUrl();
  const shifterDesc = `Shifter – ${new Date(issuedAt).toLocaleString('default', { month: 'long' })} ${new Date(issuedAt).getFullYear()} – ${shifterUserCount} user${shifterUserCount !== 1 ? 's' : ''} @ ${currency(PRICE_PER_USER)}/user`;
  const ncDesc = `Nexus Core – ${new Date(issuedAt).toLocaleString('default', { month: 'long' })} ${new Date(issuedAt).getFullYear()}`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 32px 16px; }
  .header { border-bottom: 3px solid #6366f1; padding-bottom: 16px; margin-bottom: 24px; }
  .logo-text { font-size: 22px; font-weight: 700; color: #6366f1; }
  table { width: 100%; border-collapse: collapse; margin: 24px 0; }
  th { background: #f1f5f9; text-align: left; padding: 10px 12px; font-size: 13px; }
  td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
  .subtotal-row td { color: #64748b; font-size: 13px; border-bottom: none; }
  .total-row td { font-weight: 700; font-size: 16px; border-top: 2px solid #6366f1; border-bottom: none; }
  .footer { margin-top: 32px; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 16px; }
  .due { background: #fef3c7; border-radius: 6px; padding: 12px 16px; margin: 16px 0; font-weight: 600; }
  .app-tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; margin-right: 4px; }
</style></head>
<body>
  <div class="header">
    ${logo
      ? `<img src="${logo}" alt="Nexus Core Solutions" style="height:48px;width:auto;margin-bottom:6px;display:block">`
      : `<div class="logo-text">${VENDOR_NAME}</div>`}
    <div style="color:#64748b;font-size:13px">${VENDOR_EMAIL}</div>
  </div>

  <h2 style="margin:0 0 4px">Invoice</h2>
  <div style="color:#64748b;font-size:13px">Invoice #${invoiceNumber} &nbsp;|&nbsp; Issued ${formatDate(issuedAt)}</div>

  <div class="due">⚠️ Payment due: ${formatDate(dueDate)}</div>

  <p><strong>Bill to:</strong> ${orgName}</p>

  <table>
    <thead>
      <tr><th>Description</th><th style="text-align:right">Amount</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>
          <span class="app-tag" style="background:#e0e7ff;color:#4338ca">Nexus Core</span>
          ${ncDesc}<br>
          <span style="font-size:12px;color:#64748b">Monthly subscription – flat rate</span>
        </td>
        <td style="text-align:right">${currency(ncAmount)}</td>
      </tr>
      <tr>
        <td>
          <span class="app-tag" style="background:#fef3c7;color:#b45309">Shifter</span>
          ${shifterDesc}<br>
          <span style="font-size:12px;color:#64748b">Monthly shift recording subscription</span>
        </td>
        <td style="text-align:right">${currency(shifterAmount)}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr class="total-row">
        <td>Total (AUD)</td>
        <td style="text-align:right">${currency(total)}</td>
      </tr>
    </tfoot>
  </table>

  <p style="font-size:13px">Please transfer to:<br>
  <strong>BSB:</strong> ${VENDOR_BSB} &nbsp;&nbsp; <strong>Account:</strong> ${VENDOR_ACCOUNT} &nbsp;&nbsp; <strong>Reference:</strong> ${invoiceNumber}</p>

  <div class="footer">
    ${VENDOR_NAME} &nbsp;|&nbsp; ABN: ${VENDOR_ABN} &nbsp;|&nbsp; Not registered for GST<br>
    Questions? ${VENDOR_EMAIL}
  </div>
</body>
</html>`;
}

async function sendEmail(to, subject, html, invoiceNumber, total, dueDate) {
  await sendMail({ to, subject, invoiceHtml: html, invoiceNumber, total, dueDate });
}

/**
 * Create a combined invoice for an NC org that has a linked Shifter org.
 * @param {string} ncOrgId - NC org UUID
 * @param {string} shifterOrgId - Shifter org UUID
 * @param {string} periodLabel - e.g. 'June 2026'
 * @param {number} shifterUserCount - peak users for this period
 */
export async function createCombinedInvoice(ncOrgId, shifterOrgId, periodLabel, shifterUserCount) {
  const ncSupabase = getNcSupabase();
  const shifterSupabase = getShifterSupabase();

  const { data: org } = await ncSupabase
    .from('organizations')
    .select('name, billing_email')
    .eq('id', ncOrgId)
    .single();

  if (!org) throw new Error(`NC org not found: ${ncOrgId}`);

  const issuedAt = new Date();
  const dueDate = new Date(issuedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  const invoiceNumber = makeInvoiceNumber(org.name, issuedAt);

  const ncAmount = MONTHLY_FLAT_RATE;
  const shifterAmount = Math.round(Math.max(1, shifterUserCount) * PRICE_PER_USER * 100) / 100;
  const total = Math.round((ncAmount + shifterAmount) * 100) / 100;

  const lineItems = [
    { app: 'nexus_core', description: `Nexus Core – ${periodLabel}`, amount: ncAmount },
    { app: 'shifter', description: `Shifter – ${periodLabel} – ${shifterUserCount} users @ $${PRICE_PER_USER}/user`, userCount: shifterUserCount, pricePerUser: PRICE_PER_USER, amount: shifterAmount },
  ];

  const to = org.billing_email || VENDOR_EMAIL;
  const subject = `Invoice ${invoiceNumber} – ${org.name} – ${periodLabel}`;
  const html = buildCombinedInvoiceHtml({
    invoiceNumber,
    orgName: org.name,
    to,
    issuedAt: issuedAt.toISOString(),
    dueDate: dueDate.toISOString(),
    ncAmount,
    shifterUserCount: Math.max(1, shifterUserCount),
    shifterAmount,
    total,
  });

  // Insert into NC saas_invoices
  await ncSupabase.from('saas_invoices').insert({
    org_id: ncOrgId,
    shifter_org_id: shifterOrgId,
    invoice_number: invoiceNumber,
    period_label: periodLabel,
    subtotal: total,
    gst: 0,
    total,
    status: 'pending',
    issued_at: issuedAt.toISOString(),
    due_at: dueDate.toISOString(),
    line_items: lineItems,
  });

  // Insert reference into Shifter saas_invoices
  await shifterSupabase.from('saas_invoices').insert({
    org_id: shifterOrgId,
    invoice_number: invoiceNumber,
    period_label: periodLabel,
    user_count: Math.max(1, shifterUserCount),
    price_per_user: PRICE_PER_USER,
    subtotal: shifterAmount,
    gst: 0,
    total,
    status: 'pending',
    issued_at: issuedAt.toISOString(),
    due_at: dueDate.toISOString(),
    line_items: lineItems,
  });

  await sendEmail(to, subject, html, invoiceNumber, total, dueDate.toISOString());
  console.log(`[combinedInvoice] Sent ${invoiceNumber} to ${to} (${org.name})`);

  return { invoiceNumber, total };
}
