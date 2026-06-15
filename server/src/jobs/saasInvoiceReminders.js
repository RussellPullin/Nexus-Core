/**
 * Send payment reminders for unpaid Nexus Core SaaS invoices.
 * Runs daily at 8am AEST (22:00 UTC).
 *
 * Schedule:
 *   Day 7  after issue  → friendly reminder
 *   Day 14 (due date)   → final notice
 *   Day 21 after issue  → overdue warning, org marked past_due
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { sendMail } from '../lib/mailer.js';

const VENDOR_NAME = 'Nexus Core Solutions';
const VENDOR_EMAIL = 'nexuscoresolutions@outlook.com';

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
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

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function buildReminderHtml({ invoiceNumber, orgName, total, dueDate, issuedAt, subject, messageHtml }) {
  const logo = logoUrl();
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 32px 16px; }
  .header { border-bottom: 3px solid #6366f1; padding-bottom: 16px; margin-bottom: 24px; }
  .logo { font-size: 22px; font-weight: 700; color: #6366f1; }
  .box { border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
  .footer { margin-top: 32px; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 16px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th { background: #f1f5f9; text-align: left; padding: 8px 12px; font-size: 13px; }
  td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; }
  .total-row td { font-weight: 700; border-top: 2px solid #6366f1; border-bottom: none; }
</style></head>
<body>
  <div class="header">
    ${logo
      ? `<img src="${logo}" alt="Nexus Core Solutions" style="height:48px;width:auto;margin-bottom:6px;display:block">`
      : `<div class="logo">${VENDOR_NAME}</div>`}
    <div style="color:#64748b;font-size:13px">${VENDOR_EMAIL}</div>
  </div>
  <p>Hi ${orgName},</p>
  ${messageHtml}
  <table>
    <thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      <tr><td>${invoiceNumber}</td><td>${formatDate(issuedAt)}</td><td>${formatDate(dueDate)}</td><td style="text-align:right">${currency(total)}</td></tr>
    </tbody>
    <tfoot><tr class="total-row"><td colspan="3">Total Due</td><td style="text-align:right">${currency(total)}</td></tr></tfoot>
  </table>
  <p style="font-size:13px">Please transfer to:<br>
  <strong>BSB:</strong> 923-100 &nbsp; <strong>Account:</strong> 811730015 &nbsp; <strong>Reference:</strong> ${invoiceNumber}</p>
  <p style="font-size:13px">If you've already paid, please ignore this message.</p>
  <div class="footer">
    ${VENDOR_NAME} &nbsp;|&nbsp; ABN: 75 249 898 796 &nbsp;|&nbsp; Not registered for GST<br>
    Questions? ${VENDOR_EMAIL}
  </div>
</body>
</html>`;
}

async function sendReminderEmail(to, subject, html, invoiceNumber, total, dueDate) {
  await sendMail({ to, subject, invoiceHtml: html, invoiceNumber, total, dueDate });
}

export async function run() {
  const supabase = getSupabase();
  const log = (msg, data) => console.log(`[saasReminders] ${msg}`, data || '');

  // Fetch all pending/overdue invoices with their org billing email
  const { data: invoices } = await supabase
    .from('saas_invoices')
    .select('*, organizations(name, billing_email)')
    .in('status', ['pending', 'overdue'])
    .order('issued_at');

  if (!invoices?.length) return;

  for (const inv of invoices) {
    try {
      const days = daysSince(inv.issued_at);
      const org = inv.organizations;
      const to = org?.billing_email || VENDOR_EMAIL;
      const orgName = org?.name || 'there';

      let subject = null;
      let messageHtml = null;

      if (days === 7) {
        subject = `Reminder: Invoice ${inv.invoice_number} due in 7 days`;
        messageHtml = `<div class="box" style="background:#eff6ff;border-left:4px solid #6366f1">
          <strong>Friendly reminder</strong> — your Nexus Core invoice is due in 7 days.
        </div>`;
      } else if (days === 14) {
        subject = `Final notice: Invoice ${inv.invoice_number} is due today`;
        messageHtml = `<div class="box" style="background:#fef3c7;border-left:4px solid #f59e0b">
          <strong>Payment due today.</strong> Please arrange your transfer to avoid any interruption to your Nexus Core access.
        </div>`;
      } else if (days === 21) {
        subject = `Overdue: Invoice ${inv.invoice_number} — action required`;
        messageHtml = `<div class="box" style="background:#fef2f2;border-left:4px solid #ef4444">
          <strong>Your invoice is now overdue.</strong> Please pay immediately to avoid your Nexus Core access being suspended.
        </div>`;

        // Mark overdue in Supabase
        await supabase
          .from('saas_invoices')
          .update({ status: 'overdue' })
          .eq('id', inv.id);

        await supabase
          .from('organizations')
          .update({ subscription_status: 'past_due', locked_at: new Date().toISOString() })
          .eq('id', inv.org_id);
      }

      if (subject && messageHtml) {
        const html = buildReminderHtml({
          invoiceNumber: inv.invoice_number,
          orgName,
          total: inv.total,
          dueDate: inv.due_at,
          issuedAt: inv.issued_at,
          subject,
          messageHtml,
        });
        await sendReminderEmail(to, subject, html, inv.invoice_number, inv.total, inv.due_at);
        log(`Reminder sent (day ${days})`, { org: orgName, invoice: inv.invoice_number });
      }
    } catch (err) {
      log(`Reminder failed for invoice ${inv.id}`, err.message);
    }
  }
}

export function start() {
  cron.schedule('0 22 * * *', run); // 8am AEST
  console.log('[saasReminders] Scheduled daily at 22:00 UTC (8am AEST)');
  run().catch((e) => console.error('[saasReminders] Initial run failed', e));
}
