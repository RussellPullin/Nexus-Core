/**
 * Diagnostic harness: render every document-library master through the EXACT
 * production render path (docxtemplater + image module + LibreOffice → PDF) and
 * report which ones fail and why.
 *
 * This does NOT touch the database. It walks server/templates/library/<slug>/,
 * reads each manifest + template.docx, and replicates
 * documentLibraryRender.service.js so we get ground-truth failures without
 * needing org context.
 *
 *   node scripts/diagnose-library.mjs            # render all, write report
 *   node scripts/diagnose-library.mjs <slug>...  # only the given slugs
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import ImageModule from 'docxtemplater-image-module-free';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '..');
const libraryDir = join(serverRoot, 'templates', 'library');
const workspaceRoot = resolve(serverRoot, '..', '..');

const LOGO_TAG = '{%org_logo}';
const LOGO_MAX_HEIGHT = 60;
const LOGO_MAX_WIDTH = 220;

// A test logo so the image module path is exercised exactly like production.
const TEST_LOGO = [
  join(workspaceRoot, 'logo.png'),
  join(serverRoot, '..', 'logo nexus core')
].find((p) => existsSync(p)) || null;

// Comprehensive flat token map so real tokens resolve; nullGetter handles the rest.
const TOKENS = {
  'org.name': 'Pristine Lifestyle Solutions',
  'org.legal_name': 'Pristine Lifestyle Solutions Pty Ltd',
  'org.abn': '12 345 678 901',
  'org.phone': '1300 000 000',
  'org.email': 'admin@example.com',
  'org.address': '1 Example St, Sydney NSW 2000',
  'org.website': 'https://example.com',
  'org.branding.logo_path': '',
  'participant.full_name': 'Jane Sample',
  'participant.first_name': 'Jane',
  'participant.last_name': 'Sample',
  'participant.date_of_birth': '01/01/1990',
  'participant.ndis_number': '430000000',
  'participant.email': 'jane@example.com',
  'participant.phone': '0400 000 000',
  'participant.address': '2 Example Ave, Sydney NSW 2000',
  'staff.full_name': 'Alex Worker',
  'staff.email': 'alex@example.com',
  'staff.phone': '0400 111 222',
  'staff.role': 'Support Worker',
  'date.today': '08/07/2026'
};

function readImageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen <= 0) break;
      offset += 2 + segLen;
    }
  }
  return null;
}

function computeLogoSize(buf) {
  const dims = readImageDimensions(buf);
  if (!dims || !dims.width || !dims.height) return [150, LOGO_MAX_HEIGHT];
  const scale = Math.min(LOGO_MAX_WIDTH / dims.width, LOGO_MAX_HEIGHT / dims.height, 1);
  return [Math.max(1, Math.round(dims.width * scale)), Math.max(1, Math.round(dims.height * scale))];
}

function stripLogoTag(zip) {
  zip.file(/\.xml$/).forEach((f) => {
    const xml = f.asText();
    if (xml.includes(LOGO_TAG)) zip.file(f.name, xml.split(LOGO_TAG).join(''));
  });
}

/** Extract the raw {tag} tokens docxtemplater would try to parse (best-effort, post-XML-strip). */
function extractTags(zip) {
  const tags = new Set();
  zip.file(/document\.xml$|header\d*\.xml$|footer\d*\.xml$/).forEach((f) => {
    // crude: strip XML tags then find {...}
    const text = f.asText().replace(/<[^>]+>/g, '');
    const re = /\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text)) !== null) tags.add(m[1].trim());
  });
  return [...tags];
}

function convertDocxToPdf(docxBuffer, slug) {
  const tmp = join(tmpdir(), `diag-${slug}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const docxPath = join(tmp, 'doc.docx');
  try {
    writeFileSync(docxPath, docxBuffer);
    const soffice = existsSync('/opt/homebrew/bin/soffice')
      ? '/opt/homebrew/bin/soffice'
      : '/Applications/LibreOffice.app/Contents/MacOS/soffice';
    const result = spawnSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', tmp, docxPath],
      { encoding: 'utf8', timeout: 90000 });
    if (result.status !== 0) return { pdf: null, err: (result.stderr || 'soffice non-zero').slice(0, 200) };
    const pdfPath = join(tmp, 'doc.pdf');
    if (!existsSync(pdfPath)) return { pdf: null, err: 'no pdf produced' };
    return { pdf: readFileSync(pdfPath), err: null };
  } catch (e) {
    return { pdf: null, err: e.message };
  }
}

function pdfPageCount(buf) {
  if (!buf) return 0;
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

function renderOne(slug) {
  const folder = join(libraryDir, slug);
  const manifestPath = join(folder, 'manifest.json');
  const result = { slug, ok: false, stage: null, error: null, tags: [], hasLogoTag: false, pdfPages: 0, mode: null };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    result.stage = 'manifest';
    result.error = `manifest read/parse: ${e.message}`;
    return result;
  }
  result.category = manifest.category;
  result.pack = manifest.pack;
  result.engine = manifest.engine;
  const templatePath = join(folder, manifest.template_file || 'template.docx');
  if (!existsSync(templatePath)) {
    result.stage = 'template-missing';
    result.error = `template file not found: ${manifest.template_file}`;
    return result;
  }
  if (manifest.engine !== 'docxtemplater') {
    result.stage = 'skip';
    result.error = `engine ${manifest.engine} not exercised by this harness`;
    result.ok = true;
    return result;
  }

  let zip;
  try {
    zip = new PizZip(readFileSync(templatePath));
  } catch (e) {
    result.stage = 'zip';
    result.error = `pizzip load: ${e.message}`;
    return result;
  }

  try {
    result.tags = extractTags(zip);
    result.hasLogoTag = result.tags.some((t) => t.includes('%org_logo')) ||
      zip.file(/\.xml$/).some((f) => f.asText().includes(LOGO_TAG));
  } catch { /* non-fatal */ }

  const tokens = { ...TOKENS };
  const modules = [];
  if (TEST_LOGO) {
    tokens.org_logo = TEST_LOGO;
    modules.push(new ImageModule({
      centered: false,
      getImage: (v) => readFileSync(v),
      getSize: (img) => computeLogoSize(img)
    }));
  } else {
    stripLogoTag(zip);
  }

  let docxBuffer;
  try {
    const doc = new Docxtemplater(zip, {
      modules,
      delimiters: { start: '{', end: '}' },
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => ''
    });
    doc.render(tokens);
    docxBuffer = doc.getZip().generate({ type: 'nodebuffer' });
  } catch (e) {
    result.stage = 'docxtemplater';
    // docxtemplater multi-errors carry a .properties.errors array
    const errs = e?.properties?.errors;
    if (Array.isArray(errs) && errs.length) {
      result.error = errs.map((x) => {
        const p = x?.properties || {};
        return `${x.name || 'Error'}: ${p.explanation || x.message || ''}${p.context ? ` [ctx: ${String(p.context).slice(0, 60)}]` : ''}`;
      }).join(' | ');
    } else {
      result.error = e.message;
    }
    return result;
  }

  if (process.env.SKIP_PDF === '1') {
    result.mode = 'docx-only';
    result.ok = true;
    result.stage = 'render-ok';
    return result;
  }
  const { pdf, err } = convertDocxToPdf(docxBuffer, slug);
  if (!pdf) {
    result.stage = 'soffice';
    result.error = err;
    result.mode = 'docx-fallback';
    // Production would still serve the .docx (downloads, doesn't preview inline).
    return result;
  }
  result.pdfPages = pdfPageCount(pdf);
  result.mode = 'pdf';
  result.ok = true;
  result.stage = 'done';
  if (process.env.SAVE_PDF_DIR) {
    mkdirSync(process.env.SAVE_PDF_DIR, { recursive: true });
    writeFileSync(join(process.env.SAVE_PDF_DIR, `${slug}.pdf`), pdf);
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const slugs = args.length
    ? args
    : readdirSync(libraryDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

  console.log(`Test logo: ${TEST_LOGO || '(none — logo tag will be stripped)'}`);
  console.log(`Rendering ${slugs.length} document(s)...\n`);

  const results = [];
  for (const slug of slugs) {
    const r = renderOne(slug);
    results.push(r);
    const badge = r.ok ? (r.stage === 'skip' ? 'SKIP' : 'OK  ') : 'FAIL';
    let line = `[${badge}] ${slug}`;
    if (r.ok && r.mode === 'pdf') line += `  (${r.pdfPages}p)`;
    if (!r.ok) line += `  <${r.stage}> ${r.error}`;
    console.log(line);
  }

  const fails = results.filter((r) => !r.ok);
  const outDir = join(serverRoot, 'scripts', 'diagnostics');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'library-report.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log(`\n──────── SUMMARY ────────`);
  console.log(`total:   ${results.length}`);
  console.log(`ok:      ${results.filter((r) => r.ok && r.stage !== 'skip').length}`);
  console.log(`skipped: ${results.filter((r) => r.stage === 'skip').length}`);
  console.log(`failed:  ${fails.length}`);
  const byStage = {};
  for (const f of fails) byStage[f.stage] = (byStage[f.stage] || 0) + 1;
  console.log(`by stage:`, byStage);
  console.log(`\nreport → ${outPath}`);
}

main();
