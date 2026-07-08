#!/usr/bin/env node
/**
 * Upsert the bundled NDIS Support Catalogue CSV into ndis_line_items.
 * Updates existing rates by support_item_number (preserves UUIDs on shifts/invoices).
 *
 * Usage (from repo root):
 *   npm run upsert-ndis
 *   node server/scripts/upsert-ndis-catalogue.mjs [path/to/catalogue.csv]
 *
 * On Fly (after deploy):
 *   fly ssh console -a nexus-core-crm -C "env DATABASE_PATH=/data/schedule.db DATA_DIR=/data NODE_ENV=production node /app/server/scripts/upsert-ndis-catalogue.mjs"
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/db/index.js';
import { importCatalogueFromBuffer } from '../src/lib/ndisCatalogueImport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const defaultCsv = join(projectRoot, 'server', 'ndis-catalogue.csv');

const csvPath = process.argv[2] ? resolve(process.argv[2]) : defaultCsv;

if (!existsSync(csvPath)) {
  console.error(`Catalogue file not found: ${csvPath}`);
  process.exit(1);
}

const buffer = readFileSync(csvPath);
const result = await importCatalogueFromBuffer(db, buffer, csvPath);

console.log('[upsert-ndis-catalogue]', {
  file: csvPath,
  format: result.format,
  parsed: result.parsedCount,
  inserted: result.inserted,
  updated: result.updated,
  totalRows: result.total,
});
