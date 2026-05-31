/**
 * End-to-end test: generate the REAL Nexus Service Agreement PDF (all merged
 * participant + org fields) and send it via Dropbox Sign.
 *
 * Usage:
 *   node scripts/test-service-agreement-sign.mjs
 *   node scripts/test-service-agreement-sign.mjs --email you@example.com
 *   node scripts/test-service-agreement-sign.mjs --participant-id <uuid>
 *   node scripts/test-service-agreement-sign.mjs --preview-only   # save PDF locally, do not send
 *
 * The signer sees the full pre-filled agreement in Dropbox Sign and completes
 * signature fields there (not re-typing every agreement line in the sign UI).
 */

import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(join(ROOT, 'server/package.json'));

require('dotenv').config({ path: join(ROOT, '.env') });
process.chdir(ROOT);

const API_KEY = process.env.DROPBOX_SIGN_API_KEY?.trim();
if (!API_KEY && !process.argv.includes('--preview-only')) {
  console.error('DROPBOX_SIGN_API_KEY is not set in .env');
  process.exit(1);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const previewOnly = process.argv.includes('--preview-only');
const signerEmail =
  argValue('--email') || process.env.TEST_SIGNER_EMAIL || 'info@pristinelifestylesolutions.com.au';
const participantIdArg = argValue('--participant-id');

const { db } = await import('../server/src/db/index.js');
const { computeServiceAgreementGaps } = await import('../server/src/services/serviceAgreementGaps.service.js');
const { buildServiceAgreementSnapshot } = await import('../server/src/services/serviceAgreementSnapshot.service.js');
const { generateServiceAgreementPdfBuffer } = await import('../server/src/services/serviceAgreementPdf.service.js');
const { buildServiceAgreementDropboxFields } = await import('../server/src/services/serviceAgreementDropboxFields.service.js');

const orgId = '00000000-0000-0000-0000-000000000001';
let participantId = participantIdArg;
if (!participantId) {
  const row = db
    .prepare(
      `SELECT id, name, email FROM participants
       WHERE provider_org_id = ? OR plan_manager_id = ?
       ORDER BY datetime(updated_at) DESC LIMIT 1`
    )
    .get(orgId, orgId);
  if (!row) {
    console.error('No participant found. Pass --participant-id <uuid>.');
    process.exit(1);
  }
  participantId = row.id;
  console.log(`Using participant: ${row.name || row.id} (${row.email || 'no email on file'})`);
}

const orgTpl = db
  .prepare(
    `SELECT * FROM nexus_org_form_templates WHERE org_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1`
  )
  .get(orgId);
if (!orgTpl) {
  console.error('No org service agreement template. Open Forms and save the Services Agreement template first.');
  process.exit(1);
}

const master = db.prepare('SELECT * FROM nexus_form_template_masters WHERE id = ?').get(orgTpl.master_id);
if (!master) {
  console.error('Template master missing.');
  process.exit(1);
}

const gapResult = computeServiceAgreementGaps({
  participantId,
  orgId,
  masterRow: master,
  orgTemplateRow: orgTpl,
  instanceOverrides: {}
});

if (!gapResult.can_generate) {
  console.error('Cannot generate — blocking fields:');
  for (const g of gapResult.gaps.filter((x) => x.severity === 'blocking')) {
    console.error(`  - ${g.title}: ${g.description}`);
  }
  console.error('\nFill intake + org settings in Nexus, then re-run.');
  process.exit(1);
}

if (gapResult.warning_count > 0) {
  console.log(`Note: ${gapResult.warning_count} warning(s) — some lines may be blank in the PDF.`);
}

// Sample services so the printed quote section is visible in the test PDF when the
// participant has no `implementations` configured. Real sends use whatever the
// admin entered under Agreements → Services & quote.
const sampleServices = [
  { description: '01_011_0107_1_1 — Assistance with daily personal activities', rate: 67.56, hours: 240 },
  { description: '04_104_0125_6_1 — Community participation', rate: 65.09, hours: 120 },
  { description: '07_001_0106_8_3 — Support coordination', rate: 100.14, hours: 40 }
];

const snapshot = buildServiceAgreementSnapshot({
  participantId,
  orgId,
  masterRow: master,
  orgTemplateRow: orgTpl,
  instanceOverrides: { services: sampleServices }
});

console.log('Generating full Service Agreement PDF…');
const pdfBuffer = await generateServiceAgreementPdfBuffer(snapshot);
const dropboxFields = buildServiceAgreementDropboxFields(snapshot);
const fieldCount = dropboxFields.formFieldsPerDocument?.[0]?.length ?? 0;
const orgSignerName = dropboxFields.signers?.org?.name || '(unknown — set Default signatory in Settings → Business)';
const orgSignerEmailDerived = dropboxFields.signers?.org?.email || '';
console.log(`Dropbox Sign: ${fieldCount} field(s) — Provider sig/name/date for org admin + Client sig/name/date for participant.`);
console.log(`Org admin signer (signer 1): ${orgSignerName} <${orgSignerEmailDerived || 'no email'}>`);
const participant = db.prepare('SELECT name FROM participants WHERE id = ?').get(participantId);
const safeParticipant = (participant?.name || 'Participant').replace(/[^a-zA-Z0-9._-]+/g, '_');

const outDir = join(ROOT, 'data', 'test-output');
mkdirSync(outDir, { recursive: true });
const previewPath = join(outDir, `service-agreement-${safeParticipant}-${Date.now()}.pdf`);
writeFileSync(previewPath, pdfBuffer);
console.log(`Saved local preview (${pdfBuffer.length} bytes):`);
console.log(`  ${previewPath}`);
console.log('Open that file to review every section before signing.');

if (previewOnly) {
  console.log('\n--preview-only: skipped Dropbox Sign send.');
  process.exit(0);
}

const fetchFn = global.fetch;
if (!fetchFn) {
  console.error('Node fetch is required (Node 18+).');
  process.exit(1);
}

// In test mode we send BOTH signers to the same inbox (the tester) so you can
// drive both the admin and participant steps yourself. In production the
// real org signatory + participant emails are used.
const orgSignerEmail = orgSignerEmailDerived || signerEmail;
const participantSignerEmail = signerEmail;

console.log(`\nSending to Dropbox Sign (TEST MODE):`);
console.log(`  Step 1 → ${orgSignerEmail}  (org admin: Provider signature only)`);
console.log(`  Step 2 → ${participantSignerEmail}  (participant: Client signature only)`);

const form = new FormData();
form.append('signers[0][email_address]', orgSignerEmail);
form.append('signers[0][name]', dropboxFields.signers?.org?.name || 'Organisation admin');
form.append('signers[0][order]', '0');
form.append('signers[1][email_address]', participantSignerEmail);
form.append('signers[1][name]', `${participant?.name || 'Participant'}`);
form.append('signers[1][order]', '1');
form.append('title', `Service Agreement – ${participant?.name || 'Participant'}`);
form.append('subject', `Action requested: review & sign Service Agreement – ${participant?.name || 'Participant'}`);
form.append(
  'message',
  'All details finalised in Nexus. Step 1 (admin): sign the Provider box. Step 2 (participant): sign the Client box. (TEST MODE)'
);
form.append(
  'file[0]',
  new Blob([pdfBuffer], { type: 'application/pdf' }),
  `Service-Agreement-${safeParticipant}.pdf`
);
if (dropboxFields.formFieldsPerDocument?.length) {
  form.append('form_fields_per_document', JSON.stringify(dropboxFields.formFieldsPerDocument));
}
if (dropboxFields.customFields?.length) {
  form.append('custom_fields', JSON.stringify(dropboxFields.customFields));
}
form.append('test_mode', '1');

const authB64 = Buffer.from(`${API_KEY}:`).toString('base64');
const res = await fetchFn('https://api.hellosign.com/v3/signature_request/send', {
  method: 'POST',
  headers: { Authorization: `Basic ${authB64}`, Accept: 'application/json' },
  body: form
});

const responseText = await res.text();
let body;
try {
  body = JSON.parse(responseText);
} catch {
  body = { raw: responseText };
}

if (!res.ok) {
  console.error('Dropbox Sign error:', res.status, JSON.stringify(body, null, 2));
  process.exit(1);
}

const reqId = body?.signature_request?.signature_request_id;
console.log('\nSent successfully.');
console.log('  Request ID:', reqId);
console.log('  Inbox:', signerEmail);
console.log('\nWhat the signers will see:');
console.log('  1) Org admin email first — full agreement to review + Provider signature box (no other fields).');
console.log('  2) After admin signs, participant email goes out — Client signature box (no other fields).');
console.log('\n  (All editable details — services, dates, communication preferences — are entered in Nexus before sending.)');
