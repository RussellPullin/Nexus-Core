#!/usr/bin/env node
/**
 * Fix the legacy `organisations.name` column when it still holds the seed-time
 * placeholder (e.g. literally "Primary organisation") instead of the org's real
 * name. A handful of UI surfaces (org directory, org search, the Shifter
 * organisation-name lookup fallback) read this column directly rather than
 * going through getOrgRenderContext's business_settings-first precedence, so a
 * stale placeholder here leaks into those views even though every rendered
 * document already shows the correct name.
 *
 * By default, syncs `name` to business_settings.company_name, falling back to
 * trading_name, then legal_name. Pass --name to set an explicit value instead.
 *
 * Usage:
 *   node server/scripts/sync-org-legacy-name.mjs <organisationId> [--name "Spring 2 Health"] [--dry-run]
 *
 * Production (Fly):
 *   fly ssh console -a nexus-core-crm -C \
 *     "env DATABASE_PATH=/data/schedule.db node /app/server/scripts/sync-org-legacy-name.mjs <organisationId>"
 */
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

const args = process.argv.slice(2);
const orgId = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const nameIdx = args.indexOf('--name');
const explicitName = nameIdx >= 0 ? args[nameIdx + 1] : null;

if (!orgId) {
  console.error('Usage: node sync-org-legacy-name.mjs <organisationId> [--name "..."] [--dry-run]');
  process.exit(1);
}

const dbPath = resolve(projectRoot, process.env.DATABASE_PATH || 'data/schedule.db');
const db = new Database(dbPath);

const org = db.prepare('SELECT id, name, trading_name, legal_name FROM organisations WHERE id = ?').get(orgId);
if (!org) {
  console.error(`No organisation with id ${orgId}`);
  process.exit(1);
}
const biz = db.prepare('SELECT company_name FROM business_settings WHERE org_id = ?').get(orgId);

const nextName = explicitName || biz?.company_name || org.trading_name || org.legal_name;
if (!nextName) {
  console.error('Could not determine a replacement name (no business_settings.company_name, trading_name, or legal_name set). Pass --name explicitly.');
  process.exit(1);
}

console.log(`Organisation ${orgId}`);
console.log(`  current name : ${JSON.stringify(org.name)}`);
console.log(`  trading_name : ${JSON.stringify(org.trading_name)}`);
console.log(`  legal_name   : ${JSON.stringify(org.legal_name)}`);
console.log(`  business_settings.company_name : ${JSON.stringify(biz?.company_name ?? null)}`);
console.log(`  -> new name  : ${JSON.stringify(nextName)}`);

if (org.name === nextName) {
  console.log('Already correct — no change needed.');
  process.exit(0);
}

if (dryRun) {
  console.log('[dry-run] no write performed.');
  process.exit(0);
}

db.prepare("UPDATE organisations SET name = ?, updated_at = datetime('now') WHERE id = ?").run(nextName, orgId);
const after = db.prepare('SELECT name, updated_at FROM organisations WHERE id = ?').get(orgId);
console.log('Updated:', JSON.stringify(after));
