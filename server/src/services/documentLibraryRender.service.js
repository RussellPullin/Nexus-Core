/**
 * Phase 1: Render a document from the file-based library with the universal org token map.
 *
 * Supported engines (manifest.engine):
 *   - docxtemplater : .docx with {{org.legal_name}} / {{participant.full_name}} placeholders
 *   - html          : .html template with the same placeholder syntax (returns rendered HTML)
 *   - pdf-acroform  : .pdf with named AcroForm fields (we call existing pdf-lib path)
 */
import { readFileSync } from 'fs';
import { extname } from 'path';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { db } from '../db/index.js';
import { buildOrgTokenMap } from './orgContext.service.js';
import { buildGlobalTokenMap } from '../lib/templateTokens.js';

/**
 * Build the merge data passed to docxtemplater / html templates.
 * Caller may supply `participant` and `staff` objects to populate the matching token groups.
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
 * Render a library master to a Buffer.
 * @param {object} params
 * @param {string} params.masterId - document_library_masters.id
 * @param {string} params.orgId
 * @param {object} [params.participant]
 * @param {object} [params.staff]
 * @param {object} [params.extra] - additional token overrides
 * @returns {{ buffer: Buffer | null, html: string | null, mime: string, suggestedFilename: string }}
 */
export function renderLibraryDocument({ masterId, orgId, participant = null, staff = null, extra = {} }) {
  const master = db.prepare('SELECT * FROM document_library_masters WHERE id = ?').get(masterId);
  if (!master) throw new Error(`Document library master ${masterId} not found`);
  if (!master.is_active) throw new Error(`Master ${master.slug} is inactive`);

  const tokens = buildRenderTokenMap({ orgId, participant, staff, extra });
  const baseName = `${master.slug}-${(participant?.id || orgId || 'org')}`;

  switch (master.engine) {
    case 'docxtemplater': {
      const content = readFileSync(master.template_file_path, 'binary');
      const zip = new PizZip(content);
      const doc = new Docxtemplater(zip, {
        delimiters: { start: '{{', end: '}}' },
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => ''
      });
      doc.render(tokens);
      const buffer = doc.getZip().generate({ type: 'nodebuffer' });
      return {
        buffer,
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
      // For PDFs with AcroForm fields we re-use the existing formFill renderer at the route
      // layer (it already integrates with pdf-lib). This service returns the raw PDF buffer
      // so the caller can then run it through formFill.fillPdfForm with the same token map.
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
