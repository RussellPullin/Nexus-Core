/**
 * Render a document from the file-based library, branded for a specific org.
 *
 * Supported engines (manifest.engine):
 *   - docxtemplater : .docx with {org.name} / {org.abn} / {participant.full_name} text tokens
 *                     and a {%org_logo} image placeholder in the header. Rendered with the
 *                     org token map + logo, then converted to PDF (LibreOffice) when available.
 *   - html          : .html template with the same token syntax (returns rendered HTML)
 *   - pdf-acroform  : legacy .pdf with named AcroForm fields (route layer fills via pdf-lib)
 *
 * Branding note: the DOCX tokens are FLAT dotted keys (e.g. `org.abn`), which is exactly what
 * docxtemplater's default parser looks up, so we reuse `buildOrgTokenMap` directly. The org logo
 * is embedded from `organisations.logo_path` via the docxtemplater image module.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve, isAbsolute, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import ImageModule from 'docxtemplater-image-module-free';
import { db } from '../db/index.js';
import { buildOrgTokenMap, getOrgRenderContext } from './orgContext.service.js';
import { buildGlobalTokenMap } from '../lib/templateTokens.js';
import { convertDocxToPdf } from './consentForm.service.js';
import { getOrgFullUploadDocument, listOrgSectionOverrides } from './documentLibrary.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const dataUploadsDir = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, 'uploads')
  : join(projectRoot, 'data', 'uploads');
const dataDir = process.env.DATA_DIR || join(projectRoot, 'data');

const LOGO_TAG = '{%org_logo}';
const LOGO_MAX_HEIGHT = 60;
const LOGO_MAX_WIDTH = 220;

/**
 * Build the merge data passed to docxtemplater / html templates.
 * Caller may supply `participant` and `staff` objects to populate the matching token groups.
 * Keys are flat dotted strings (org.abn, participant.full_name, ...) to match template tokens.
 */
export function buildRenderTokenMap({ orgId, participant = null, staff = null, extra = {} } = {}) {
  const orgTokens = buildOrgTokenMap(orgId);
  const globalTokens = buildGlobalTokenMap();
  return {
    ...orgTokens,
    ...globalTokens,
    ...flattenParticipant(participant),
    ...flattenStaff(staff),
    ...extra
  };
}

function flattenParticipant(p) {
  if (!p) return {};
  const fullName = p.name || [p.first_name, p.last_name].filter(Boolean).join(' ');
  const parts = String(fullName || '').trim().split(/\s+/);
  const first = p.first_name || parts[0] || '';
  const last = p.last_name || parts.slice(1).join(' ') || '';
  return {
    'participant.full_name': fullName,
    'participant.first_name': first,
    'participant.last_name': last,
    'participant.date_of_birth': p.date_of_birth || '',
    'participant.ndis_number': p.ndis_number || '',
    'participant.email': p.email || '',
    'participant.phone': p.phone || '',
    'participant.address': p.address || '',
    'participant.guardian_name': p.guardian_name || '',
    'participant.guardian_email': p.guardian_email || '',
    'participant.guardian_phone': p.guardian_phone || '',
    'participant.plan_start_date': p.plan_start_date || '',
    'participant.plan_end_date': p.plan_end_date || ''
  };
}

function flattenStaff(s) {
  if (!s) return {};
  return {
    'staff.full_name': s.name || '',
    'staff.email': s.email || '',
    'staff.phone': s.phone || '',
    'staff.address': s.address || '',
    'staff.supervisor_name': s.supervisor_name || '',
    'staff.role': s.role || '',
    'staff.employment_type': s.employment_type || '',
    'staff.hourly_rate': s.hourly_rate || '',
    'staff.start_date': s.start_date || '',
    'staff.abn': s.abn || ''
  };
}

/**
 * Resolve the org logo to an absolute file path. Uses the same canonical org render context as
 * every text token (getOrgRenderContext, orgContext.service.js) — business_settings.logo_path
 * (set via Settings) over the organisations row's own logo_path, which is often still whatever
 * was seeded at initial org setup and never updated again.
 * @param {string} orgId
 * @returns {string|null}
 */
function resolveOrgLogoPath(orgId) {
  if (!orgId) return null;
  const raw = String(getOrgRenderContext(orgId)?.branding?.logoPath || '').trim();
  if (!raw) return null;
  const candidates = isAbsolute(raw)
    ? [raw]
    : [
        join(projectRoot, raw),
        join(dataUploadsDir, raw.replace(/^.*[/\\]/, '')),
        join(dataUploadsDir, raw)
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Read intrinsic PNG/JPEG dimensions from a buffer without extra dependencies.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
function readImageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: 8-byte signature, then IHDR (width @16, height @20, big-endian).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan for a Start-Of-Frame marker (0xFFC0-0xFFC3, C5-C7, C9-CB, CD-CF).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen <= 0) break;
      offset += 2 + segLen;
    }
  }
  return null;
}

/**
 * Scale a logo to fit within the header box while preserving aspect ratio.
 * @param {Buffer} buf
 * @returns {[number, number]} [widthPx, heightPx]
 */
function computeLogoSize(buf) {
  const dims = readImageDimensions(buf);
  if (!dims || !dims.width || !dims.height) return [150, LOGO_MAX_HEIGHT];
  const scale = Math.min(LOGO_MAX_WIDTH / dims.width, LOGO_MAX_HEIGHT / dims.height, 1);
  return [Math.max(1, Math.round(dims.width * scale)), Math.max(1, Math.round(dims.height * scale))];
}

/**
 * Strip the logo image placeholder from every XML part in a zip. Used when the org has no logo,
 * so docxtemplater does not choke on an image tag with no backing module/data.
 */
function stripLogoTag(zip) {
  zip.file(/\.xml$/).forEach((f) => {
    const xml = f.asText();
    if (xml.includes(LOGO_TAG)) zip.file(f.name, xml.split(LOGO_TAG).join(''));
  });
}

/**
 * Error-path safety net: neutralise malformed / unknown `{…}` delimiters so a single bad
 * placeholder in an authored template can never 500 the whole preview. Only invoked after a
 * first render attempt throws. Operates on `<w:t>` text nodes: collapses doubled braces,
 * drops any `{token}` whose key is not a known merge token, and removes stray lone braces.
 * Known tokens (and the `%org_logo` image tag) are preserved so branding still renders.
 * @param {PizZip} zip
 * @param {string[]} validKeys - valid flat token keys (e.g. org.name, participant.full_name)
 */
function sanitizeMalformedTags(zip, validKeys) {
  const known = new Set([...validKeys, '%org_logo', 'org_logo']);
  zip.file(/word\/[^/]*\.xml$/).forEach((f) => {
    let xml = f.asText();
    if (!xml.includes('{') && !xml.includes('}')) return;
    xml = xml.replace(/<w:t([^>]*)>([\s\S]*?)<\/w:t>/g, (full, attrs, content) => {
      if (!content.includes('{') && !content.includes('}')) return full;
      let c = content
        .replace(/\{\{+/g, '{')
        .replace(/\}\}+/g, '}')
        .replace(/\{([^{}]*)\}/g, (m, inner) => (known.has(inner.trim()) ? `{${inner}}` : ''))
        .replace(/[{}]/g, '');
      return `<w:t${attrs}>${c}</w:t>`;
    });
    zip.file(f.name, xml);
  });
}

/**
 * Build a docxtemplater instance, embedding the org logo image module when a logo exists
 * (otherwise stripping the placeholder). Shared by the initial render and the sanitised retry.
 */
function buildDocxInstance(zip, logoPath) {
  const modules = [];
  if (logoPath) {
    modules.push(new ImageModule({
      centered: false,
      getImage: (tagValue) => readFileSync(tagValue),
      getSize: (img) => computeLogoSize(img)
    }));
  } else {
    stripLogoTag(zip);
  }
  return new Docxtemplater(zip, {
    modules,
    delimiters: { start: '{', end: '}' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => ''
  });
}

/**
 * Resolve a path stored on `org_company_documents.file_path` (same relative-path convention as
 * `company_policy_files.file_path`) to an absolute path on the persistent DATA_DIR volume.
 */
function resolveOrgDocumentPath(filePath) {
  if (!filePath) return null;
  if (isAbsolute(filePath)) return filePath;
  return join(dataDir, filePath.replace(/^data\//, ''));
}

/**
 * Substitute flat `{token.key}` placeholders (docxtemplater-style, single braces — matching the
 * tokens used inside the policy .docx templates themselves) in an HTML string, HTML-escaping
 * values. This is deliberately separate from `renderMustacheLite`, which uses double-brace
 * `{{token}}` syntax for the unrelated `html` engine templates.
 */
export function renderFlatTokens(html, tokens) {
  return String(html || '').replace(/\{([\w.]+)\}/g, (full, key) => {
    if (!(key in tokens)) return full;
    const v = tokens[key];
    if (v === undefined || v === null) return '';
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  });
}

/**
 * Convert an HTML string to PDF via LibreOffice (soffice), mirroring `convertDocxToPdf`.
 * @param {string} html
 * @returns {Buffer|null}
 */
function convertHtmlToPdf(html) {
  const tmpDir = join(tmpdir(), `doclib-html-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const htmlPath = join(tmpDir, 'document.html');
  try {
    writeFileSync(htmlPath, html, 'utf8');
    const result = spawnSync('soffice', [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', tmpDir,
      htmlPath
    ], { encoding: 'utf8', timeout: 60000 });
    if (result.status !== 0) return null;
    const pdfPath = join(tmpDir, 'document.pdf');
    if (!existsSync(pdfPath)) return null;
    return readFileSync(pdfPath);
  } catch {
    return null;
  }
}

/**
 * Render a policy master whose org clone has `override_mode = 'sections'` and at least one saved
 * section override: stitch the master's sections together, substituting the org's override HTML
 * for any matching `section_key`, run the flat-token pass over the result, and convert via
 * LibreOffice. Sections without an override render exactly as the master (and pick up future
 * master edits automatically, since they aren't copied — only the key is referenced).
 */
export function mergeSectionsWithOverrides(sections, overrides) {
  const overrideByKey = new Map((overrides || []).map((o) => [o.section_key, o.content_html]));
  return (sections || [])
    .map((s) => overrideByKey.get(s.key) ?? s.content_html)
    .join('\n');
}

function renderStitchedSections(master, overrides, tokens, baseName) {
  const sections = JSON.parse(master.sections_json || '[]');
  const bodyHtml = mergeSectionsWithOverrides(sections, overrides);
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${renderFlatTokens(bodyHtml, tokens)}</body></html>`;

  const pdfBuffer = convertHtmlToPdf(fullHtml);
  if (pdfBuffer) {
    return { buffer: pdfBuffer, html: null, mime: 'application/pdf', suggestedFilename: `${baseName}.pdf` };
  }
  // LibreOffice unavailable — fall back to raw HTML so the caller still gets something.
  return { buffer: null, html: fullHtml, mime: 'text/html', suggestedFilename: `${baseName}.html` };
}

/**
 * Serve an org's fully-uploaded replacement document instead of the master. `.docx` uploads
 * still go through the normal docxtemplater token pipeline (so `{org.name}` etc. resolve if the
 * org copied a template and only edited wording); other file types are served as-is.
 */
function renderOrgFullUpload(uploaded, tokens, baseName) {
  const absPath = resolveOrgDocumentPath(uploaded.file_path);
  if (!absPath || !existsSync(absPath)) {
    throw new Error(`Uploaded document for ${uploaded.slug} is missing on disk: ${uploaded.file_path}`);
  }
  const fileBuffer = readFileSync(absPath);

  if (uploaded.engine === 'docxtemplater') {
    let doc;
    try {
      doc = buildDocxInstance(new PizZip(fileBuffer), null);
      doc.render(tokens);
    } catch (renderErr) {
      const cleanZip = new PizZip(fileBuffer);
      sanitizeMalformedTags(cleanZip, Object.keys(tokens));
      doc = buildDocxInstance(cleanZip, null);
      doc.render(tokens);
      console.warn(`[document-library] rendered org upload "${uploaded.slug}" after sanitising malformed tags:`, renderErr?.message);
    }
    const docxBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const pdfBuffer = convertDocxToPdf(docxBuffer);
    if (pdfBuffer) {
      return { buffer: pdfBuffer, html: null, mime: 'application/pdf', suggestedFilename: `${baseName}.pdf` };
    }
    return {
      buffer: docxBuffer,
      html: null,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      suggestedFilename: `${baseName}.docx`
    };
  }

  // static-pdf (or anything else) — pass through as uploaded.
  return { buffer: fileBuffer, html: null, mime: 'application/pdf', suggestedFilename: `${baseName}.pdf` };
}

/**
 * Render a library master to a Buffer, branded for the org (logo + name + ABN etc.). If the org
 * has switched a policy to `full_upload` mode, their own document is served instead; if switched
 * to `sections` mode with at least one saved override, the master is re-assembled with those
 * overrides applied. Otherwise renders the master exactly as before.
 * @param {object} params
 * @param {string} params.masterId - document_library_masters.id
 * @param {string} params.orgId
 * @param {object} [params.participant]
 * @param {object} [params.staff]
 * @param {object} [params.extra] - additional token overrides
 * @returns {{ buffer: Buffer | null, html: string | null, mime: string, suggestedFilename: string, needsAcroFormFill?: boolean, tokens?: object }}
 */
/**
 * Decide which render path applies, given the org's chosen mode and what they've actually
 * saved. `full_upload` wins outright once a file exists; `sections` only kicks in once at least
 * one override is saved (zero overrides renders identically to `inherit`); anything else (or no
 * org context at all, e.g. a master-library preview with no orgId) uses the plain master render.
 * Pure decision table — kept separate from the DB/soffice-touching render functions so it's
 * cheaply unit-testable.
 * @param {{overrideMode: string, hasSectionsJson: boolean, hasFullUpload: boolean, hasSectionOverrides: boolean}} params
 * @returns {'full_upload'|'sections'|'default'}
 */
export function resolveOverrideStrategy({ overrideMode, hasSectionsJson, hasFullUpload, hasSectionOverrides }) {
  if (overrideMode === 'full_upload' && hasFullUpload) return 'full_upload';
  if (overrideMode === 'sections' && hasSectionsJson && hasSectionOverrides) return 'sections';
  return 'default';
}

export function renderLibraryDocument({ masterId, orgId, participant = null, staff = null, extra = {} }) {
  const master = db.prepare('SELECT * FROM document_library_masters WHERE id = ?').get(masterId);
  if (!master) throw new Error(`Document library master ${masterId} not found`);
  if (!master.is_active) throw new Error(`Master ${master.slug} is inactive`);

  const tokens = buildRenderTokenMap({ orgId, participant, staff, extra });
  const baseName = `${master.slug}-${(participant?.id || staff?.id || orgId || 'org')}`;

  const clone = orgId
    ? db.prepare('SELECT override_mode FROM document_library_org_clones WHERE org_id = ? AND master_id = ?').get(orgId, masterId)
    : null;
  const overrideMode = clone?.override_mode || 'inherit';
  const uploaded = orgId && overrideMode === 'full_upload' ? getOrgFullUploadDocument(orgId, masterId) : null;
  const overrides = orgId && overrideMode === 'sections' ? listOrgSectionOverrides(orgId, masterId) : [];

  const strategy = resolveOverrideStrategy({
    overrideMode,
    hasSectionsJson: Boolean(master.sections_json),
    hasFullUpload: Boolean(uploaded),
    hasSectionOverrides: overrides.length > 0
  });

  if (strategy === 'full_upload') {
    return renderOrgFullUpload(uploaded, tokens, baseName);
  }
  if (strategy === 'sections') {
    return renderStitchedSections(master, overrides, tokens, baseName);
  }

  switch (master.engine) {
    case 'docxtemplater': {
      const templateBytes = readFileSync(master.template_file_path);
      const logoPath = resolveOrgLogoPath(orgId);
      if (logoPath) tokens.org_logo = logoPath;

      let doc;
      try {
        doc = buildDocxInstance(new PizZip(templateBytes), logoPath);
        doc.render(tokens);
      } catch (renderErr) {
        // A malformed/unknown placeholder in the authored template broke parsing.
        // Retry once on a sanitised copy so the document still previews instead of 500-ing.
        try {
          const cleanZip = new PizZip(templateBytes);
          sanitizeMalformedTags(cleanZip, Object.keys(tokens));
          doc = buildDocxInstance(cleanZip, logoPath);
          doc.render(tokens);
          console.warn(`[document-library] rendered "${master.slug}" after sanitising malformed tags:`, renderErr?.message);
        } catch {
          throw renderErr; // surface the original, more descriptive error
        }
      }
      const docxBuffer = doc.getZip().generate({ type: 'nodebuffer' });

      const pdfBuffer = convertDocxToPdf(docxBuffer);
      if (pdfBuffer) {
        return {
          buffer: pdfBuffer,
          html: null,
          mime: 'application/pdf',
          suggestedFilename: `${baseName}.pdf`
        };
      }
      // LibreOffice unavailable — fall back to the branded .docx.
      return {
        buffer: docxBuffer,
        html: null,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        suggestedFilename: `${baseName}.docx`
      };
    }
    case 'html': {
      const raw = readFileSync(master.template_file_path, 'utf8');
      const html = renderMustacheLite(raw, tokens);
      return {
        buffer: null,
        html,
        mime: 'text/html',
        suggestedFilename: `${baseName}.html`
      };
    }
    case 'pdf-acroform': {
      // Legacy path: PDFs with AcroForm fields are filled at the route layer via pdf-lib.
      const buffer = readFileSync(master.template_file_path);
      return {
        buffer,
        html: null,
        mime: 'application/pdf',
        suggestedFilename: `${baseName}.pdf`,
        needsAcroFormFill: true,
        tokens
      };
    }
    default:
      throw new Error(`Unsupported engine: ${master.engine}`);
  }
}

/**
 * Tiny Mustache-style renderer. Supports:
 *   {{variable}}           — interpolation (HTML-escaped)
 *   {{{variable}}}         — interpolation (raw, no escaping)
 *   {{#variable}}...{{/variable}}    — section: rendered if truthy
 *   {{^variable}}...{{/variable}}    — inverted section: rendered if falsy
 *
 * Designed to match what the seed templates use without pulling in a heavy dependency.
 */
function renderMustacheLite(template, tokens) {
  const truthy = (key) => {
    const v = tokens[key];
    return v !== undefined && v !== null && v !== '' && v !== false && v !== 0 && v !== '0';
  };
  const sectionRe = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
  let out = template;
  for (let i = 0; i < 4; i += 1) {
    const before = out;
    out = out.replace(sectionRe, (_, kind, key, body) => {
      const include = kind === '#' ? truthy(key) : !truthy(key);
      return include ? body : '';
    });
    if (out === before) break;
  }
  out = out.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, key) => {
    const v = tokens[key];
    return v === undefined || v === null ? '' : String(v);
  });
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = tokens[key];
    if (v === undefined || v === null) return '';
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  });
  return out;
}
