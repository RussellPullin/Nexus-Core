/**
 * Test script – sends a service agreement signature request via Dropbox Sign
 * to info@pristinelifestylesolutions.com.au so you can see the full experience.
 *
 * Run with:  node scripts/test-dropbox-sign.mjs
 */

import { createRequire } from 'module';
import { createReadStream, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Use createRequire to load CommonJS packages from the server node_modules
const _require = createRequire(import.meta.url);

// ── Load env ───────────────────────────────────────────────────────────────
const envPath = resolve(ROOT, '.env');
const { readFileSync } = await import('fs');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const API_KEY = env.DROPBOX_SIGN_API_KEY;
if (!API_KEY) {
  console.error('❌  DROPBOX_SIGN_API_KEY not set in .env');
  process.exit(1);
}
console.log('✓  API key loaded:', API_KEY.slice(0, 8) + '...' + API_KEY.slice(-4));

// ── Generate a simple service agreement PDF ────────────────────────────────
console.log('\n📄 Generating test service agreement PDF…');

const PDFDocument = _require('../server/node_modules/pdfkit/js/pdfkit.js');

const pdfPath = join(tmpdir(), `test-service-agreement-${Date.now()}.pdf`);

await new Promise((res, rej) => {
  const doc = new PDFDocument({ margin: 60, size: 'A4' });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  doc.on('end', () => {
    writeFileSync(pdfPath, Buffer.concat(chunks));
    res();
  });
  doc.on('error', rej);

  // Header
  doc.fontSize(20).fillColor('#1e3a5f').font('Helvetica-Bold')
     .text('Spring 2 Health', { align: 'center' });
  doc.fontSize(14).fillColor('#333').font('Helvetica')
     .text('NDIS Support Coordination Service Agreement', { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#1e3a5f').stroke();
  doc.moveDown(1);

  // Body
  doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text('TEST DOCUMENT – FOR REVIEW PURPOSES ONLY');
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).fillColor('#333');

  const body = `This Service Agreement is made between Spring 2 Health (ABN: 12 345 678 901) and the Participant named below.

SERVICES: The Provider agrees to deliver NDIS funded supports as outlined in the Participant's NDIS plan, including:
  • Support Coordination
  • Plan Management assistance
  • Daily Living supports

AGREEMENT PERIOD: This agreement commences on the date of signing and remains in effect until varied or terminated by either party with 14 days written notice.

PRICING: All supports are delivered in accordance with the NDIS Pricing Arrangements and Price Limits currently in effect.

PARTICIPANT RIGHTS: You have the right to:
  • Choose your service providers
  • Provide feedback or make a complaint at any time
  • Access your records
  • Cancel or vary services with reasonable notice

PRIVACY: Spring 2 Health collects and stores personal information in accordance with the Australian Privacy Act 1988. Your information will not be shared without your consent except where required by law.

COMPLAINTS: If you are unhappy with any aspect of your services, please contact us at info@pristinelifestylesolutions.com.au or call us directly.

By signing below, the Participant (or their authorised representative) agrees to the terms of this Service Agreement.`;

  doc.text(body, { lineGap: 4 });

  doc.moveDown(2);
  doc.font('Helvetica-Bold').fontSize(11).text('Participant Signature');
  doc.moveDown(0.5);

  // Signature line
  const sx = 60, sy = doc.y;
  doc.moveTo(sx, sy + 40).lineTo(sx + 250, sy + 40).strokeColor('#000').stroke();
  doc.fontSize(9).font('Helvetica').fillColor('#555')
     .text('Signature', sx, sy + 44)
     .text('Date: _______________', sx + 270, sy + 44);

  doc.end();
});

console.log('✓  PDF written to', pdfPath);

// ── Send via Dropbox Sign API ──────────────────────────────────────────────
console.log('\n📨 Sending signature request to info@pristinelifestylesolutions.com.au…');

const nodeFetch = (await import('node-fetch').catch(() => null))?.default;
const fetchFn = global.fetch || nodeFetch;

if (!fetchFn) {
  console.error('❌  No fetch available. Run with Node 18+ or install node-fetch.');
  process.exit(1);
}

const pdfBuffer = readFileSync(pdfPath);

const form = new globalThis.FormData();
form.append('signers[0][email_address]', 'info@pristinelifestylesolutions.com.au');
form.append('signers[0][name]', 'Russell Pullin (Spring 2 Health – Test)');
form.append('title', 'TEST – Spring 2 Health Service Agreement');
form.append('subject', 'TEST – Please review your Spring 2 Health Service Agreement');
form.append('message',
  'This is a TEST signature request sent from Nexus Core CRM to verify the Dropbox Sign integration. ' +
  'Please review the document and click Sign to confirm the signature box is working correctly.'
);
form.append(
  'file[0]',
  new Blob([pdfBuffer], { type: 'application/pdf' }),
  'Spring2Health-ServiceAgreement-TEST.pdf'
);
// test_mode=1 means it doesn't count against your plan quota and is watermarked "TEST MODE"
form.append('test_mode', '1');

const authB64 = Buffer.from(`${API_KEY}:`).toString('base64');

const res = await fetchFn('https://api.hellosign.com/v3/signature_request/send', {
  method: 'POST',
  headers: { Authorization: `Basic ${authB64}`, Accept: 'application/json' },
  body: form
});

const responseText = await res.text();
let responseBody;
try { responseBody = JSON.parse(responseText); } catch { responseBody = { raw: responseText }; }

if (!res.ok) {
  console.error('❌  Dropbox Sign API error:', res.status, JSON.stringify(responseBody, null, 2));
  process.exit(1);
}

const reqId = responseBody?.signature_request?.signature_request_id;
const signerStatus = responseBody?.signature_request?.signatures?.[0]?.status_code;
console.log('\n✅  Signature request sent successfully!');
console.log('   Request ID :', reqId);
console.log('   Signer status:', signerStatus);
console.log('\n📧  Check your inbox at info@pristinelifestylesolutions.com.au');
console.log('   Subject: "TEST – Please review your Spring 2 Health Service Agreement"');
console.log('   Note: document is watermarked TEST MODE (free — no quota used)');
console.log('\nDone.');
