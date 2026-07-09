#!/usr/bin/env node
/**
 * Migrate library manifests from legacy single `pack` string to `packs` array.
 * Updates every manifest.json under templates/library and rebuilds _catalogue.json.
 *
 * Usage (from repo root):
 *   node server/scripts/migrate-library-packs.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = process.env.DOCUMENT_LIBRARY_DIR || resolve(__dirname, '..', 'templates', 'library');

function normalizePacks(manifest) {
  if (Array.isArray(manifest.packs) && manifest.packs.length) {
    return manifest.packs.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  }
  if (typeof manifest.pack === 'string' && manifest.pack.trim()) {
    return [manifest.pack.trim()];
  }
  return [];
}

function applyPacks(manifest, packs) {
  if (!packs.length) {
    delete manifest.packs;
    delete manifest.pack;
  } else {
    manifest.packs = packs;
    manifest.pack = packs[0];
  }
  return manifest;
}

function main() {
  if (!existsSync(LIBRARY_DIR)) {
    console.error(`Library directory not found: ${LIBRARY_DIR}`);
    process.exit(1);
  }

  const slugs = readdirSync(LIBRARY_DIR)
    .filter((name) => {
      try {
        return statSync(join(LIBRARY_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

  const catalogue = [];
  let updated = 0;
  let skipped = 0;

  for (const slug of slugs) {
    const manifestPath = join(LIBRARY_DIR, slug, 'manifest.json');
    if (!existsSync(manifestPath)) {
      skipped += 1;
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const packs = normalizePacks(manifest);
    const before = JSON.stringify({ pack: manifest.pack, packs: manifest.packs });
    applyPacks(manifest, packs);
    const after = JSON.stringify({ pack: manifest.pack, packs: manifest.packs });

    if (before !== after) {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      updated += 1;
    }
    catalogue.push(manifest);
  }

  const cataloguePath = join(LIBRARY_DIR, '_catalogue.json');
  writeFileSync(cataloguePath, `${JSON.stringify(catalogue, null, 2)}\n`);

  console.log(`[migrate-library-packs] root=${LIBRARY_DIR}`);
  console.log(`[migrate-library-packs] manifests_updated=${updated} skipped=${skipped} catalogue_entries=${catalogue.length}`);
}

main();
