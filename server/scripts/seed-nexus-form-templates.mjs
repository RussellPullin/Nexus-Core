/**
 * Re-seed nexus form template masters (SQLite). Idempotent: skips if template_key already exists.
 * Run from project root: node server/scripts/seed-nexus-form-templates.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const projectRoot = resolve(__dirname, '../..');
const dbPath = resolve(projectRoot, process.env.DATABASE_PATH || 'data/schedule.db');
const db = new Database(dbPath);
const { seedNexusFormTemplateMastersIfNeeded } = await import('../src/services/nexusFormTemplateSeed.service.js');

const r = seedNexusFormTemplateMastersIfNeeded(db);
console.log(r.seeded ? `Seeded master: ${r.master_id}` : `Skip (exists): ${r.master_id}`);
db.close();
