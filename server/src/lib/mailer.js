/**
 * Shared mailer for Nexus Core billing emails.
 * Sends via Resend with a PDF invoice attachment.
 */

import puppeteer from 'puppeteer';

const FROM = 'Nexus Core Solutions <billing@spring2health.com.au>';
const REPLY_TO = 'nexuscoresolutions@outlook.com';

/**
 * Render an HTML string to a PDF buffer via headless Chrome.
 */
async function htmlToPdf(html) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    return pdf;
  } finally {
    await browser.close();
  }
}

function currency(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

/**
 * Send a billing email with a PDF invoice attached.
 * @param {{ to: string, subject: string, invoiceHtml: string, invoiceNumber: string, total: number, dueDate: string }} opts
 */
export async function sendMail({ to, subject, invoiceHtml, invoiceNumber, total, dueDate }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[mailer] RESEND_API_KEY not set — email not sent');
    return;
  }

  // Generate PDF
  const pdfBuffer = Buffer.from(await htmlToPdf(invoiceHtml));
  const pdfBase64 = pdfBuffer.toString('base64');

  const dueDateStr = dueDate ? new Date(dueDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  const bodyHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#1e293b;max-width:520px;margin:0 auto;padding:32px 16px">
  <p style="font-size:16px">Hi,</p>
  <p>Please find your invoice attached.</p>
  <table style="border-collapse:collapse;margin:20px 0;width:100%">
    <tr>
      <td style="padding:8px 12px;background:#f1f5f9;font-weight:600">Invoice</td>
      <td style="padding:8px 12px;background:#f1f5f9">${invoiceNumber}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;font-weight:600">Amount due</td>
      <td style="padding:8px 12px;font-size:18px;font-weight:700;color:#6366f1">${currency(total)}</td>
    </tr>
    ${dueDateStr ? `<tr>
      <td style="padding:8px 12px;font-weight:600">Due date</td>
      <td style="padding:8px 12px">${dueDateStr}</td>
    </tr>` : ''}
  </table>
  <p style="font-size:13px;color:#64748b">Please use the invoice number as your payment reference.<br>
  BSB: 923-100 &nbsp; Account: 811730015</p>
  <p style="font-size:13px">Questions? Reply to this email or contact us at <a href="mailto:nexuscoresolutions@outlook.com">nexuscoresolutions@outlook.com</a></p>
  <p style="margin-top:32px;font-size:12px;color:#94a3b8">Nexus Core Solutions &nbsp;|&nbsp; ABN: 75 249 898 796 &nbsp;|&nbsp; Not registered for GST</p>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      reply_to: REPLY_TO,
      to,
      subject,
      html: bodyHtml,
      attachments: [{
        filename: `${invoiceNumber}.pdf`,
        content: pdfBase64,
      }],
    }),
  });

  if (res.ok) {
    const data = await res.json();
    console.log(`[mailer] Sent to ${to} with PDF attachment — id: ${data.id}`);
  } else {
    const text = await res.text();
    throw new Error(`Resend failed: ${res.status} ${text}`);
  }
}
