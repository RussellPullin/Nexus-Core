/**
 * signing_layout for custom uploaded form templates — field boxes for native e-signature + pre-fill.
 * Coordinates use top-left origin in PDF points (same convention as Service Agreement / PDFKit).
 */

import { readFileSync } from 'fs';
import { PDFDocument } from 'pdf-lib';
import { v4 as uuidv4 } from 'uuid';
import { extractPdfAcroFieldNames, suggestContractFieldMap } from './contractTemplateAnalyze.service.js';
import { mergeKeyToHumanLabel } from './formTemplateSignerPreview.service.js';
import { isSignatureAcroFieldName, isProviderAutofillAcroFieldName } from '../lib/templateTokens.js';

const DEFAULT_PAGE_W = 595;
const DEFAULT_PAGE_H = 842;

/** @typedef {'text'|'date'|'signature'|'checkbox'} LayoutFieldType */
/** @typedef {'participant'|'staff'|'org'} LayoutSigner */

/**
 * @typedef {Object} SigningLayoutField
 * @property {string} id
 * @property {number} page 1-based
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {LayoutFieldType} type
 * @property {string} merge_key
 * @property {string} [label]
 * @property {LayoutSigner} signer
 * @property {boolean} [required]
 * @property {string} [api_id]
 * @property {boolean} [cover_underlying] - white-out PDF text under box before pre-fill
 */

/**
 * @typedef {Object} SigningLayout
 * @property {number} page_width
 * @property {number} page_height
 * @property {number} page_count
 * @property {SigningLayoutField[]} fields
 */

export function emptySigningLayout(pageW = DEFAULT_PAGE_W, pageH = DEFAULT_PAGE_H, pageCount = 1) {
  return {
    page_width: pageW,
    page_height: pageH,
    page_count: Math.max(1, pageCount),
    fields: []
  };
}

export function parseSigningLayout(mappingJson) {
  const raw = mappingJson?.signing_layout;
  if (!raw || typeof raw !== 'object') return null;
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  return {
    page_width: Number(raw.page_width) || DEFAULT_PAGE_W,
    page_height: Number(raw.page_height) || DEFAULT_PAGE_H,
    page_count: Math.max(1, Number(raw.page_count) || 1),
    fields: fields.filter((f) => f && typeof f === 'object')
  };
}

function findWidgetPageIndex(doc, widget) {
  const pages = doc.getPages();

  // 1. Trust the widget's own /P entry when the producer set one (pdf-lib, Acrobat, …).
  const pageRef = typeof widget.P === 'function' ? widget.P() : widget.P;
  if (pageRef) {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].ref === pageRef || pages[i].ref?.toString() === pageRef?.toString()) {
        return i;
      }
    }
  }

  // 2. PyMuPDF (the tokenised-master build) omits /P, so match the widget's own
  //    dictionary against each page's /Annots array. Without this every widget on
  //    page 2+ collapses onto page 1 and its signing box lands in the wrong place.
  const widgetDict = widget.dict ?? widget;
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots?.();
    if (!annots) continue;
    let arr;
    try {
      arr = annots.asArray();
    } catch {
      continue;
    }
    for (const ref of arr) {
      let resolved;
      try {
        resolved = doc.context.lookup(ref);
      } catch {
        continue;
      }
      if (resolved === widgetDict) return i;
    }
  }
  return 0;
}

function rectToTopLeft(rect, pageHeight) {
  return {
    x: Math.max(0, rect.x),
    y: Math.max(0, pageHeight - rect.y - rect.height),
    width: Math.max(20, rect.width),
    height: Math.max(14, rect.height)
  };
}

function inferFieldType(fieldName, mergeKey) {
  const n = `${fieldName} ${mergeKey}`.toLowerCase();
  if (isSignatureAcroFieldName(fieldName) || isSignatureAcroFieldName(mergeKey) || /signature/.test(n)) {
    return 'signature';
  }
  if (/date|dob|birth/.test(n)) return 'date';
  if (/check|tick|yes_no/.test(n)) return 'checkbox';
  return 'text';
}

// Fields the document issuer completes when preparing a staff document (position
// description, letter of engagement, contract) — not the incoming worker. The
// worker only signs the acceptance / person-in-role block at the end.
const EMPLOYER_DETAIL_FIELDS = new Set([
  // role details
  'employment_type', 'employment_status', 'reports_to', 'pd_date', 'position_title',
  'classification', 'work_location', 'position_location',
  // letter of engagement — remuneration & terms
  'award', 'pay_point', 'base_rate', 'casual_loading', 'pay_rate', 'casual_rate',
  'pay_frequency', 'pay_cycle', 'super_rate', 'hours_indicative', 'allowances',
  'governing_state', 'return_by', 'letter_date', 'emp_name', 'emp_address',
  'greeting_name', 'induction_status'
]);

function inferSigner(mergeKey, workflow, fieldName = '') {
  const name = String(fieldName || '').toLowerCase().trim();
  if (
    EMPLOYER_DETAIL_FIELDS.has(name)
    || (workflow === 'staff_onboarding' && /^(location|start_date|hours|salary)$/.test(name))
    // "Issued by <provider>" block on a letter of engagement
    || /^iss_(name|position|date|sig)$/.test(name)
  ) {
    return 'org';
  }
  // Join with "_" (not a space) so the (^|_) anchors also match the start of the
  // bare field name when there is no merge key — otherwise "s_sig", "sup_sig" etc.
  // never match and always fall through to the primary signer.
  const k = `${mergeKey}_${fieldName}`.toLowerCase().replace(/^_+|_+$/g, '');
  if (
    /(^|_)(org|prov|provider|employer|supervisor)(_|$)/.test(k)
    // provider-side sign-off block: s_ / sup_ / d_s_ prefix + sig|date|name|print|role
    || /(^|_)(s|sup|d_s|sig_s|sig_prov)_(sig|date|name|print|role)($|_)/.test(k)
    || /^organisation/.test(k)
  ) {
    return 'org';
  }
  if (workflow === 'staff_onboarding') return 'staff';
  return 'participant';
}

function defaultSignerForWorkflow(workflow) {
  return workflow === 'staff_onboarding' ? 'staff' : 'participant';
}

/** Default cover for text/date fields; true when placeholder looks like insert/rate tokens. */
export function defaultCoverUnderlying(type, placeholder = '', mergeKey = '') {
  if (type === 'signature' || type === 'checkbox') return false;
  const text = `${placeholder || ''} ${mergeKey || ''}`.toLowerCase();
  if (/insert\s*value|<\s*insert|\[insert\]|____+|___+/.test(text)) return true;
  if (/hourly_rate|pay.?rate/.test(text)) return true;
  return type === 'text' || type === 'date';
}

/**
 * Read PDF page dimensions and count.
 */
export async function readPdfPageMeta(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const first = pages[0];
  return {
    page_width: first ? first.getWidth() : DEFAULT_PAGE_W,
    page_height: first ? first.getHeight() : DEFAULT_PAGE_H,
    page_count: pages.length || 1
  };
}

/**
 * Build signing_layout from AcroForm widgets + contract_field_map.
 */
export async function suggestSigningLayoutFromPdf(pdfBytes, contractFieldMap, workflow) {
  const wf = workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
  const meta = await readPdfPageMeta(pdfBytes);
  const layout = emptySigningLayout(meta.page_width, meta.page_height, meta.page_count);
  const map = contractFieldMap && typeof contractFieldMap === 'object' ? contractFieldMap : {};

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  let form;
  try {
    form = doc.getForm();
  } catch {
    return suggestSigningLayoutFromMap(map, wf, meta);
  }

  const pages = doc.getPages();
  const fields = form.getFields();
  if (!fields.length) {
    return suggestSigningLayoutFromMap(map, wf, meta);
  }

  for (const field of fields) {
    const name = field.getName();
    // Provider / document-control slots (org name, ABN, logo, effective & review
    // dates, …) are pre-filled from the org's details before the document is sent
    // — they must never become signer-fillable fields.
    if (isProviderAutofillAcroFieldName(name)) continue;
    const wfKind = wf === 'staff_onboarding' ? 'staff' : 'participant';
    const signer = inferSigner('', wf, name);
    // Org-completed fields are entered individually by the preparer — keep the raw
    // field name so distinct boxes (base rate / loading / total rate) don't collapse
    // onto one shared merge key from suggestContractFieldMap.
    let mergeKey = signer === 'org'
      ? (map[name] || name)
      : (map[name] || suggestContractFieldMap([name], wfKind)[name] || '');
    mergeKey = String(mergeKey || '').trim();
    const type = inferFieldType(name, mergeKey);
    const widgets = field.acroField.getWidgets();
    if (!widgets.length) continue;

    for (const widget of widgets) {
      let rect;
      try {
        rect = widget.getRectangle();
      } catch {
        continue;
      }
      const pageIndex = findWidgetPageIndex(doc, widget);
      const pageH = pages[pageIndex]?.getHeight() || meta.page_height;
      const box = rectToTopLeft(rect, pageH);
      layout.fields.push({
        id: uuidv4(),
        page: pageIndex + 1,
        ...box,
        type,
        merge_key: mergeKey || name.replace(/\W+/g, '_').toLowerCase(),
        label: mergeKeyToHumanLabel(mergeKey || name, wf),
        signer,
        required: type === 'signature',
        api_id: sanitizeApiId(name),
        cover_underlying: defaultCoverUnderlying(type, name, mergeKey)
      });
    }
  }

  layout.page_width = meta.page_width;
  layout.page_height = meta.page_height;
  layout.page_count = meta.page_count;
  return layout;
}

function sanitizeApiId(name) {
  return String(name || 'field')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40) || 'field';
}

/**
 * Stack default boxes on page 1 when PDF has no AcroForm fields.
 */
export function suggestSigningLayoutFromMap(contractFieldMap, workflow, pageMeta = {}) {
  const wf = workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
  const meta = {
    page_width: pageMeta.page_width || DEFAULT_PAGE_W,
    page_height: pageMeta.page_height || DEFAULT_PAGE_H,
    page_count: pageMeta.page_count || 1
  };
  const layout = emptySigningLayout(meta.page_width, meta.page_height, meta.page_count);
  const map = contractFieldMap && typeof contractFieldMap === 'object' ? contractFieldMap : {};
  const entries = Object.entries(map);
  let y = 700;
  const x = 72;
  const width = 220;
  const height = 20;

  for (const [placeholder, mergeKey] of entries) {
    const mk = String(mergeKey || placeholder).trim();
    if (!mk) continue;
    const type = inferFieldType(placeholder, mk);
    layout.fields.push({
      id: uuidv4(),
      page: 1,
      x,
      y,
      width: type === 'signature' ? 180 : width,
      height: type === 'signature' ? 36 : height,
      type,
      merge_key: mk,
      label: mergeKeyToHumanLabel(mk, wf),
      signer: inferSigner(mk, wf),
      required: type === 'signature',
      api_id: sanitizeApiId(placeholder || mk),
      cover_underlying: defaultCoverUnderlying(type, placeholder, mk)
    });
    y -= type === 'signature' ? 48 : 28;
    if (y < 80) {
      y = 700;
    }
  }

  layout.page_width = meta.page_width;
  layout.page_height = meta.page_height;
  layout.page_count = meta.page_count;

  if (!layout.fields.length) {
    layout.fields.push({
      id: uuidv4(),
      page: 1,
      x: 72,
      y: 700,
      width: 180,
      height: 36,
      type: 'signature',
      merge_key: 'signature',
      label: 'Signature',
      signer: defaultSignerForWorkflow(wf),
      required: true,
      api_id: 'signature',
      cover_underlying: false
    });
  }

  return layout;
}

/** Sync contract_field_map from layout field merge keys (acro name = api_id). */
export function contractFieldMapFromLayout(layout) {
  const map = {};
  if (!layout?.fields) return map;
  for (const f of layout.fields) {
    if (!f.merge_key) continue;
    const key = f.api_id || f.id;
    map[key] = f.merge_key;
  }
  return map;
}

export function validateSigningLayout(layout) {
  if (!layout || !Array.isArray(layout.fields)) {
    throw new Error('signing_layout.fields must be an array.');
  }
  for (const f of layout.fields) {
    if (!f.id) f.id = uuidv4();
    if (!f.page || f.page < 1) f.page = 1;
    if (f.x == null || f.y == null) throw new Error('Each field needs x and y.');
    if (!f.width || !f.height) throw new Error('Each field needs width and height.');
    if (!f.type) f.type = 'text';
    if (!f.merge_key) f.merge_key = 'text';
    if (!f.signer) f.signer = 'participant';
    if (!f.api_id) f.api_id = sanitizeApiId(f.merge_key);
    if (f.cover_underlying === undefined) {
      f.cover_underlying = defaultCoverUnderlying(f.type, f.api_id, f.merge_key);
    }
  }
  return layout;
}

export async function suggestSigningLayoutForTemplateFile(filePath, contractFieldMap, workflow) {
  const pdfBytes = readFileSync(filePath);
  return suggestSigningLayoutFromPdf(pdfBytes, contractFieldMap, workflow);
}

export function layoutFieldCount(layout) {
  return layout?.fields?.length || 0;
}

export function countAcroFieldsInFile(filePath) {
  const buf = readFileSync(filePath);
  return extractPdfAcroFieldNames(buf).then((names) => names.length);
}
