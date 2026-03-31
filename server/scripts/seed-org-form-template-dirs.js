#!/usr/bin/env node
/**
 * One-off: copy legacy global form templates (data/forms/templates/<type>/) into
 * per-org folders (data/forms/templates/by-org/<organisationId>/<type>/) for every
 * organisation in the DB.
 *
 * Skips a file if the destination already exists unless --force.
 *
 * Usage (from repo root, with .env / DATABASE_PATH as for the server):
 *   node server/scripts/seed-org-form-template-dirs.js
 *   node server/scripts/seed-org-form-template-dirs.js --dry-run
 *   node server/scripts/seed-org-form-template-dirs.js --force
 */
import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync, mkdirSync, copyFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
config({ path: join(projectRoot, '.env') });

import { db } from '../src/db/index.js';

const TEMPLATES_DIR = join(projectRoot, 'data', 'forms', 'templates');

/** Matches server formTemplatePath.service.js */
const FORM_SUBDIRS = [
  { key: 'privacy-consent', exts: ['.docx'] },
  { key: 'service-agreement', exts: ['.pdf', '.docx'] },
  { key: 'support-plan', exts: ['.pdf', '.docx'] }
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function listTemplateFiles(legacyDir, exts) {
  if (!existsSync(legacyDir)) return [];
  return readdirSync(legacyDir).filter((f) => {
    if (f.startsWith('.')) return false;
    const lower = f.toLowerCase();
    return exts.some((ext) => lower.endsWith(ext));
  });
}

function main() {
  const orgs = db.prepare('SELECT id, name FROM organisations ORDER BY created_at ASC').all();
  if (!orgs.length) {
    console.log('No organisations in DB; nothing to do.');
    process.exit(0);
  }

  let copied = 0;
  let skippedExisting = 0;

  for (const org of orgs) {
    const orgId = org.id;
    if (!orgId || /[./\\]/.test(String(orgId))) {
      console.warn(`Skip invalid org id: ${orgId}`);
      continue;
    }
    const label = org.name ? `${org.name} (${orgId})` : orgId;
    console.log(`\nOrganisation: ${label}`);

    for (const { key, exts } of FORM_SUBDIRS) {
      const legacyDir = join(TEMPLATES_DIR, key);
      const destDir = join(TEMPLATES_DIR, 'by-org', orgId, key);
      const files = listTemplateFiles(legacyDir, exts);

      if (files.length === 0) {
        console.log(`  ${key}: no legacy files (${legacyDir})`);
        continue;
      }

      if (!dryRun) {
        mkdirSync(destDir, { recursive: true });
      }

      for (const name of files) {
        const src = join(legacyDir, name);
        const dest = join(destDir, name);
        if (existsSync(dest) && !force) {
          skippedExisting += 1;
          console.log(`  ${key}: skip (exists) ${name}`);
          continue;
        }
        if (dryRun) {
          console.log(`  ${key}: would copy ${name} -> by-org/.../${key}/${name}`);
          copied += 1;
        } else {
          copyFileSync(src, dest);
          console.log(`  ${key}: copied ${name}`);
          copied += 1;
        }
      }
    }
  }

  console.log('\n---');
  console.log(
    dryRun
      ? `Dry run: ${copied} file(s) would be copied; ${skippedExisting} skipped (destination already exists).`
      : `Done: ${copied} file(s) copied; ${skippedExisting} skipped (destination already exists — use --force to overwrite).`
  );
}

main();
