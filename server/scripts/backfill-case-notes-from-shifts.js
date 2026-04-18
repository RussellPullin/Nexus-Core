#!/usr/bin/env node
/**
 * One-off: create/update case_notes rows from completed shifts that have session notes.
 * Run after deploying shift → case note sync so historical data appears for quarterly reporting.
 *
 * Usage (from repo root):
 *   node server/scripts/backfill-case-notes-from-shifts.js
 */
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

import { db } from '../src/db/index.js';
import { syncCaseNoteFromShift } from '../src/services/shiftCaseNoteSync.service.js';

const rows = db
  .prepare(
    `SELECT id FROM shifts WHERE status IN ('completed', 'completed_by_admin') AND notes IS NOT NULL AND trim(notes) != ''`
  )
  .all();

let n = 0;
for (const r of rows) {
  syncCaseNoteFromShift(r.id);
  n++;
}
console.log(`Processed ${n} completed shift(s) with notes.`);
