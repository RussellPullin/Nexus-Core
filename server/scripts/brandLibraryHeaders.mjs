#!/usr/bin/env node
/**
 * One-off / idempotent build step for the shared document library.
 *
 * Every deidentified template.docx under templates/library/<slug>/ already carries the
 * org identity text tokens ({org.name} / {org.abn}). What they are all missing is a LOGO.
 * This script injects a logo image placeholder ({%org_logo}, consumed by the docxtemplater
 * image module at render time) into the top of each document header, and — for the handful
 * of templates whose header has no org identity at all — also drops in {org.name} + {org.abn}.
 *
 * Safe to run repeatedly: it detects the marker / existing tokens and skips work already done.
 * The pre-branding original is preserved once as template.docx.prebrand.
 *
 * Usage (from server/):  node scripts/brandLibraryHeaders.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = process.env.DOCUMENT_LIBRARY_DIR || resolve(__dirname, '..', 'templates', 'library');

const LOGO_MARKER = '{%org_logo}';
const HEADER_RE = /^word\/header\d+\.xml$/;

const LOGO_PARAGRAPH =
  '<w:p><w:pPr><w:spacing w:before="0" w:after="80"/><w:jc w:val="left"/></w:pPr>' +
  `<w:r><w:t xml:space="preserve">${LOGO_MARKER}</w:t></w:r></w:p>`;

const IDENTITY_PARAGRAPHS =
  '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>' +
  '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{org.name}</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>' +
  '<w:r><w:t xml:space="preserve">ABN: {org.abn}</w:t></w:r></w:p>';

function hasOrgIdentity(text) {
  return /\{org\.(name|legal_name|abn)\}/.test(text);
}

function injectIntoHeader(xml, { withIdentity }) {
  const idx = xml.indexOf('<w:hdr');
  if (idx === -1) return xml;
  const gt = xml.indexOf('>', idx);
  if (gt === -1) return xml;
  const insert = LOGO_PARAGRAPH + (withIdentity ? IDENTITY_PARAGRAPHS : '');
  return xml.slice(0, gt + 1) + insert + xml.slice(gt + 1);
}

function processDocx(docxPath) {
  const zip = new PizZip(readFileSync(docxPath));
  const headerFiles = zip.file(HEADER_RE);
  if (!headerFiles || headerFiles.length === 0) {
    return { status: 'no-header' };
  }

  const combined = headerFiles.map((f) => f.asText()).join('\n');
  if (combined.includes(LOGO_MARKER)) {
    return { status: 'already-branded' };
  }

  const needIdentity = !hasOrgIdentity(combined);
  let identityDone = false;

  for (const f of headerFiles) {
    const xml = f.asText();
    const withIdentity = needIdentity && !identityDone;
    const next = injectIntoHeader(xml, { withIdentity });
    if (next !== xml) {
      zip.file(f.name, next);
      if (withIdentity) identityDone = true;
    }
  }

  // Preserve the pre-brand original exactly once.
  const backup = `${docxPath}.prebrand`;
  if (!existsSync(backup)) writeFileSync(backup, readFileSync(docxPath));

  writeFileSync(docxPath, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { status: needIdentity ? 'branded+identity' : 'branded' };
}

function main() {
  if (!existsSync(LIBRARY_DIR)) {
    console.error(`Library directory not found: ${LIBRARY_DIR}`);
    process.exit(1);
  }
  const slugs = readdirSync(LIBRARY_DIR).filter((n) => {
    try {
      return statSync(join(LIBRARY_DIR, n)).isDirectory();
    } catch {
      return false;
    }
  });

  const tally = {};
  const identityFixed = [];
  for (const slug of slugs) {
    const docxPath = join(LIBRARY_DIR, slug, 'template.docx');
    if (!existsSync(docxPath)) {
      tally['no-docx'] = (tally['no-docx'] || 0) + 1;
      continue;
    }
    try {
      const { status } = processDocx(docxPath);
      tally[status] = (tally[status] || 0) + 1;
      if (status === 'branded+identity') identityFixed.push(slug);
    } catch (err) {
      tally.error = (tally.error || 0) + 1;
      console.warn(`  ! ${slug}: ${err.message}`);
    }
  }

  console.log(`Scanned ${slugs.length} template folders in ${LIBRARY_DIR}`);
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
  if (identityFixed.length) console.log(`  identity added to: ${identityFixed.join(', ')}`);
}

main();
