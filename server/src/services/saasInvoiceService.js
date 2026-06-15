/**
 * Nexus Core SaaS invoicing — no Xero.
 * Creates invoice records in Supabase and emails them to the org billing contact.
 */

import { createClient } from '@supabase/supabase-js';
import { MONTHLY_FLAT_RATE, calculateInvoiceAmount } from '../lib/saasBillingTiers.js';
import { sendMail } from '../lib/mailer.js';

const VENDOR_EMAIL = 'nexuscoresolutions@outlook.com';
const VENDOR_NAME = 'Nexus Core Solutions';

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function currency(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function logoUrl() {
  const base = (process.env.OAUTH_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/logo.png` : null;
}

function buildInvoiceHtml({ invoiceNumber, orgName, periodLabel, subtotal, gst, total, dueDate, issuedAt }) {
  const logo = logoUrl();
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 32px 16px; }
  .header { border-bottom: 3px solid #6366f1; padding-bottom: 16px; margin-bottom: 24px; }
  .logo-text { font-size: 22px; font-weight: 700; color: #6366f1; }
  table { width: 100%; border-collapse: collapse; margin: 24px 0; }
  th { background: #f1f5f9; text-align: left; padding: 10px 12px; font-size: 13px; }
  td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
  .total-row td { font-weight: 700; font-size: 16px; border-top: 2px solid #6366f1; border-bottom: none; }
  .footer { margin-top: 32px; font-size: 12px; color: #94a3b8; }
  .due { background: #fef3c7; border-radius: 6px; padding: 12px 16px; margin: 16px 0; font-weight: 600; }
</style></head>
<body>
  <div class="header">
    ${logo
      ? `<img src="${logo}" alt="Nexus Core Solutions" style="height:48px;width:auto;margin-bottom:6px;display:block">`
      : `<div class="logo-text">${VENDOR_NAME}</div>`}
    <div style="color:#64748b;font-size:13px">nexuscoresolutions@outlook.com</div>
  </div>
  <h2 style="margin:0 0 4px">Invoice</h2>
  <div style="color:#64748b;font-size:13px">Invoice #${invoiceNumber} &nbsp;|&nbsp; Issued ${formatDate(issuedAt)}</div>
  <div class="due">⚠️ Payment due: ${formatDate(dueDate)}</div>
  <p><strong>Bill to:</strong> ${orgName}</p>
  <table>
    <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      <tr><td>Nexus Core – ${periodLabel}<br><span style="font-size:12px;color:#64748b">Monthly subscription</span></td><td style="text-align:right">${currency(subtotal)}</td></tr>
    </tbody>
    <tfoot>
      <tr class="total-row"><td>Total (AUD)</td><td style="text-align:right">${currency(subtotal)}</td></tr>
    </tfoot>
  </table>
  <p style="font-size:13px">Please transfer to:<br>
  <strong>BSB:</strong> 923-100 &nbsp; <strong>Account:</strong> 811730015 &nbsp; <strong>Reference:</strong> ${invoiceNumber}</p>
  <div class="footer">
    ${VENDOR_NAME} &nbsp;|&nbsp; ABN: 75 249 898 796 &nbsp;|&nbsp; Not registered for GST<br>
    Questions? ${VENDOR_EMAIL}
  </div>
</body>
</html>`;
}

/**
 * Generate an invoice number from org name + date, e.g. NC-SPRI-202606-001
 */
function makeInvoiceNumber(orgName, issuedAt) {
  const prefix = (orgName || 'ORG').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const d = new Date(issuedAt);
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const rand = String(Math.floor(Math.random() * 900) + 100);
  return `NC-${prefix}-${ym}-${rand}`;
}

async function sendInvoiceEmail(to, subject, html, invoiceNumber, total, dueDate) {
  await sendMail({ to, subject, invoiceHtml: html, invoiceNumber, total, dueDate });
}

/**
 * Create a SaaS invoice for an org, record it in Supabase, and email it.
 * @param {string} orgId
 * @param {string} periodLabel - e.g. 'Month 1', 'June 2026'
 */
export async function createSaasInvoice(orgId, periodLabel) {
  const supabase = getSupabase();
  const { subtotal, total } = calculateInvoiceAmount();

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, billing_email')
    .eq('id', orgId)
    .single();

  if (!org) throw new Error(`Org not found: ${orgId}`);

  const issuedAt = new Date();
  const dueDate = new Date(issuedAt);
  dueDate.setDate(dueDate.getDate() + 14);
  const invoiceNumber = makeInvoiceNumber(org.name, issuedAt);

  const { data: inv, error } = await supabase.from('saas_invoices').insert({
    org_id: orgId,
    period_label: periodLabel,
    subtotal,
    gst: 0,
    total,
    invoice_number: invoiceNumber,
    status: 'pending',
    issued_at: issuedAt.toISOString(),
    due_at: dueDate.toISOString(),
  }).select().single();

  if (error) throw new Error(`Failed to record invoice: ${error.message}`);

  const html = buildInvoiceHtml({ invoiceNumber, orgName: org.name, periodLabel, subtotal, dueDate, issuedAt });
  const billingEmail = org.billing_email || VENDOR_EMAIL;

  await sendInvoiceEmail(billingEmail, `Nexus Core Invoice – ${periodLabel} – ${invoiceNumber}`, html, invoiceNumber, total, dueDate.toISOString());
  console.log(`[saasInvoice] Invoice ${invoiceNumber} sent to ${billingEmail} for org ${org.name}`);

  return { invoiceId: inv.id, invoiceNumber, total };
}
