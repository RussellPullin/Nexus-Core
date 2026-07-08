/**
 * Repair the library templates whose bodies contain malformed docxtemplater tags.
 *
 * The source Spring 2 Health Word docs carried mustache-style `{{Business_Name}}`,
 * `{{Entity_Name}}`, `{{Approver_Name}}` placeholders (and a stray `{`) that the
 * render engine — which uses single-brace `{ }` delimiters — cannot parse, so the
 * whole preview 500s. We rewrite those runs to the correct, already-used branded
 * tokens (matching the sibling headers/footers that DO render).
 *
 * Runs against template.docx AND template.docx.prebrand so a future re-brand does
 * not reintroduce the breakage. Ordered so double-brace forms are handled before
 * the mangled single-`}}` remnants.
 *
 *   node scripts/fix-broken-templates.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libraryDir = resolve(__dirname, '..', 'templates', 'library');

const DOTTED = '\u2026'.repeat(24); // "………" manual sign-off line

// [find, replace] applied in order, as literal global substring replacements on each XML part.
const REPLACEMENTS = [
  // exit-interview-form header title line
  ['{{Business_Name}} &amp; {{Employee_Name}}', '{org.name}'],
  ['Business_Name}} &amp; Employee_Name}}', '{org.name}'],
  ['{{Business_Name}} & {{Employee_Name}}', '{org.name}'],
  ['Business_Name}} & Employee_Name}}', '{org.name}'],
  // "Approved By: {{Entity_Name}}" → provider board (matches incident register footer)
  ['{{Entity_Name}}', ' The Board of {org.legal_name}'],
  ['Entity_Name}}', ' The Board of {org.legal_name}'],
  // progress-notes manual approver sign-off
  ['{{Approver_Name}}', DOTTED],
  ['Approver_Name}}', DOTTED],
  // incident-management-register stray unclosed brace
  ['{org.legal_name}{', '{org.legal_name}']
];

const TARGET_SLUGS = ['exit-interview-form', 'incident-management-register', 'progress-notes-template'];

function fixFile(filePath) {
  if (!existsSync(filePath)) return { path: filePath, exists: false, changes: 0 };
  const zip = new PizZip(readFileSync(filePath));
  let totalChanges = 0;
  const changedParts = [];
  zip.file(/word\/.*\.xml$/).forEach((f) => {
    let xml = f.asText();
    let partChanges = 0;
    for (const [find, repl] of REPLACEMENTS) {
      if (xml.includes(find)) {
        const before = xml;
        xml = xml.split(find).join(repl);
        const n = (before.length - xml.length + repl.length * ((before.split(find).length - 1))) ? (before.split(find).length - 1) : 0;
        partChanges += n;
      }
    }
    if (partChanges > 0) {
      zip.file(f.name, xml);
      changedParts.push(`${f.name}(${partChanges})`);
      totalChanges += partChanges;
    }
  });
  if (totalChanges > 0) {
    const out = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    writeFileSync(filePath, out);
  }
  return { path: filePath, exists: true, changes: totalChanges, parts: changedParts };
}

for (const slug of TARGET_SLUGS) {
  console.log(`\n== ${slug} ==`);
  for (const name of ['template.docx', 'template.docx.prebrand']) {
    const r = fixFile(join(libraryDir, slug, name));
    if (!r.exists) { console.log(`  ${name}: (absent)`); continue; }
    console.log(`  ${name}: ${r.changes} change(s) ${r.parts.length ? '→ ' + r.parts.join(', ') : ''}`);
  }
}
console.log('\nDone.');
