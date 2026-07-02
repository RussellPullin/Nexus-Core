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
import { readFileSync, existsSync } from 'fs';
import { join, resolve, isAbsolute, dirname } from 'path';
import { fileURLToPath } from 'url';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import ImageModule from 'docxtemplater-image-module-free';
import { db } from '../db/index.js';
import { buildOrgTokenMap } from './orgContext.service.js';
import { buildGlobalTokenMap } from '../lib/templateTokens.js';
import { convertDocxToPdf } from './consentForm.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const dataUploadsDir = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, 'uploads')
  : join(projectRoot, 'data', 'uploads');

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
    'staff.role': s.role || '',
    'staff.employment_type': s.employment_type || '',
    'staff.hourly_rate': s.hourly_rate || '',
    'staff.start_date': s.start_date || '',
    'staff.abn': s.abn || ''
  };
}

/**
 * Resolve the org logo to an absolute file path (mirrors brandedFormPdf.service.js order).
 * @param {string} orgId
 * @returns {string|null}
 */
function resolveOrgLogoPath(orgId) {
  if (!orgId) return null;
  const row = db.prepare('SELECT logo_path FROM organisations WHERE id = ?').get(orgId);
  const raw = String(row?.logo_path || '').trim();
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
 * Render a library master to a Buffer, branded for the org (logo + name + ABN etc.).
 * @param {object} params
 * @param {string} params.masterId - document_library_masters.id
 * @param {string} params.orgId
 * @param {object} [params.participant]
 * @param {object} [params.staff]
 * @param {object} [params.extra] - additional token overrides
 * @returns {{ buffer: Buffer | null, html: string | null, mime: string, suggestedFilename: string, needsAcroFormFill?: boolean, tokens?: object }}
 */
export function renderLibraryDocument({ masterId, orgId, participant = null, staff = null, extra = {} }) {
  const master = db.prepare('SELECT * FROM document_library_masters WHERE id = ?').get(masterId);
  if (!master) throw new Error(`Document library master ${masterId} not found`);
  if (!master.is_active) throw new Error(`Master ${master.slug} is inactive`);

  const tokens = buildRenderTokenMap({ orgId, participant, staff, extra });
  const baseName = `${master.slug}-${(participant?.id || staff?.id || orgId || 'org')}`;

  switch (master.engine) {
    case 'docxtemplater': {
      const zip = new PizZip(readFileSync(master.template_file_path));

      const logoPath = resolveOrgLogoPath(orgId);
      const modules = [];
      if (logoPath) {
        tokens.org_logo = logoPath;
        modules.push(new ImageModule({
          centered: false,
          getImage: (tagValue) => readFileSync(tagValue),
          getSize: (img) => computeLogoSize(img)
        }));
      } else {
        stripLogoTag(zip);
      }

      const doc = new Docxtemplater(zip, {
        modules,
        delimiters: { start: '{', end: '}' },
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => ''
      });
      doc.render(tokens);
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
