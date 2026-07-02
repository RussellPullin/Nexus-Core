#!/usr/bin/env node
/**
 * Rebuild every template manifest.json + the _catalogue.json index for the shared library
 * so they reflect the real (DOCX) templates:
 *   - engine        -> "docxtemplater"   (the flat PDFs have no form fields; the DOCX are the source)
 *   - template_file -> "template.docx"
 *   - placeholders  -> the known org/participant/staff tokens actually present in the DOCX,
 *                      plus org.branding.logo_path (the logo is now embedded via {%org_logo}).
 *
 * All other manifest fields (pack, category, form_type, signer role, renewal, etc.) are preserved.
 *
 * Usage (from server/):  node scripts/rebuildLibraryManifests.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';
import { isKnownToken } from '../src/lib/templateTokens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = process.env.DOCUMENT_LIBRARY_DIR || resolve(__dirname, '..', 'templates', 'library');

const LOGO_TOKEN = 'org.branding.logo_path';

function visibleText(docxPath) {
  const zip = new PizZip(readFileSync(docxPath));
  let text = '';
  zip.file(/^word\/(document|header\d+|footer\d+)\.xml$/).forEach((f) => {
    const xml = f.asText();
    const runs = xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
    for (const r of runs) text += r.replace(/<[^>]+>/g, '');
  });
  return text;
}

function extractTokens(text) {
  const found = new Set();
  const re = /\{\s*([\w.]+)\s*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1].trim();
    if (isKnownToken(tok)) found.add(tok);
  }
  return found;
}

function main() {
  if (!existsSync(LIBRARY_DIR)) {
    console.error(`Library directory not found: ${LIBRARY_DIR}`);
    process.exit(1);
  }
  const slugs = readdirSync(LIBRARY_DIR)
    .filter((n) => {
      try { return statSync(join(LIBRARY_DIR, n)).isDirectory(); } catch { return false; }
    })
    .sort();

  const catalogue = [];
  let updated = 0;
  let skipped = 0;

  for (const slug of slugs) {
    const dir = join(LIBRARY_DIR, slug);
    const manifestPath = join(dir, 'manifest.json');
    const docxPath = join(dir, 'template.docx');
    if (!existsSync(manifestPath) || !existsSync(docxPath)) {
      skipped += 1;
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const tokens = extractTokens(visibleText(docxPath));
    tokens.add(LOGO_TOKEN);

    manifest.engine = 'docxtemplater';
    manifest.template_file = 'template.docx';
    manifest.placeholders = [...tokens].sort();

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    catalogue.push(manifest);
    updated += 1;
  }

  writeFileSync(join(LIBRARY_DIR, '_catalogue.json'), `${JSON.stringify(catalogue, null, 2)}\n`);
  console.log(`Rebuilt ${updated} manifests (skipped ${skipped}); catalogue entries: ${catalogue.length}`);
}

main();
