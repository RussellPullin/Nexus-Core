#!/usr/bin/env node
/**
 * One-off: set provider_org_id for all participants that have none, using the org_id
 * of the Nexus user with the given email (e.g. your admin account).
 *
 * Usage (from repo root):
 *   node server/scripts/backfill-participants-org-by-email.js you@company.com
 *
 * Or:
 *   NEXUS_BACKFILL_USER_EMAIL=you@company.com node server/scripts/backfill-participants-org-by-email.js
 *
 * Requires DATABASE_PATH / data/schedule.db to point at the same DB the server uses.
 */
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

import { db } from '../src/db/index.js';
import { ensureOrganisationExistsById } from '../src/services/organisations.service.js';

const email = (process.argv[2] || process.env.NEXUS_BACKFILL_USER_EMAIL || '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: node server/scripts/backfill-participants-org-by-email.js <user-email>');
  console.error('Example: node server/scripts/backfill-participants-org-by-email.js info@example.com');
  process.exit(1);
}

const user = db.prepare('SELECT id, email, org_id FROM users WHERE lower(trim(email)) = ?').get(email);
if (!user) {
  console.error(`No user found with email: ${email}`);
  process.exit(1);
}
if (!user.org_id || String(user.org_id).trim() === '') {
  console.error('That user has no org_id. Fix the user row (or Supabase profile) so org_id is set, then run again.');
  process.exit(1);
}

ensureOrganisationExistsById(user.org_id);

const before = db
  .prepare(
    `SELECT COUNT(*) AS c FROM participants WHERE provider_org_id IS NULL OR TRIM(COALESCE(provider_org_id, '')) = ''`
  )
  .get();

const result = db
  .prepare(
    `UPDATE participants SET provider_org_id = ?, updated_at = datetime('now')
     WHERE provider_org_id IS NULL OR TRIM(COALESCE(provider_org_id, '')) = ''`
  )
  .run(user.org_id);

console.log('Target user:', user.email);
console.log('users.org_id (provider_org_id will be set to this):', user.org_id);
console.log('Participants missing provider_org before:', before.c);
console.log('Rows updated:', result.changes);
