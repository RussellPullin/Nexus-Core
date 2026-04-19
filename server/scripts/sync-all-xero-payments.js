#!/usr/bin/env node
/**
 * One-off: pull AmountPaid from Xero for every Nexus billing invoice linked to Xero
 * and insert payment rows where Xero shows more received than Nexus.
 *
 * Run from repo root: node server/scripts/sync-all-xero-payments.js
 */
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

const { db } = await import('../src/db/index.js');
const { syncBillingInvoiceFromXero } = await import('../src/services/xeroPaymentSync.service.js');

const NOTE = 'Synced from Xero (bulk one-off)';
const DELAY_MS = 300;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const rows = db
  .prepare(
    `
    SELECT bi.id
    FROM billing_invoices bi
    WHERE bi.xero_invoice_id IS NOT NULL
      AND TRIM(bi.xero_invoice_id) != ''
      AND bi.status != 'void'
    ORDER BY bi.updated_at DESC
  `
  )
  .all();

console.log(`Found ${rows.length} Xero-linked invoices (non-void). Syncing...`);

let paymentsRecorded = 0;
let skipped = 0;
let failed = 0;

for (let i = 0; i < rows.length; i++) {
  const { id } = rows[i];
  try {
    const r = await syncBillingInvoiceFromXero(id, null, NOTE);
    if (r?.skipped) {
      skipped++;
      console.log(`[${i + 1}/${rows.length}] ${id} skip: ${r.reason || 'skipped'}`);
    } else if (r?.payment_id) {
      paymentsRecorded++;
      console.log(`[${i + 1}/${rows.length}] ${id} +$${Number(r.amount_added || 0).toFixed(2)} payment`);
    } else {
      console.log(`[${i + 1}/${rows.length}] ${id}`, r);
    }
  } catch (e) {
    failed++;
    console.error(`[${i + 1}/${rows.length}] ${id} ERROR:`, e.message || e);
  }
  if (i < rows.length - 1) await sleep(DELAY_MS);
}

console.log(`Done. new payments recorded: ${paymentsRecorded}, skipped: ${skipped}, failed: ${failed}`);
