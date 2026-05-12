/**
 * Detect merge placeholders / form fields in employment or participant contract uploads.
 * DOCX: {placeholder} tags in word/*.xml. PDF: AcroForm names + OCR text heuristics when scanned.
 */

import PizZip from 'pizzip';
import { PDFDocument } from 'pdf-lib';
import { extractContractPdfText, ocrRasterBufferToText } from './pdfOcrText.service.js';

/** Max characters of document text sent to the browser for local LLM reading (preview / Ollama). */
export const CONTRACT_TEXT_EXCERPT_MAX = 48000;

/** @typedef {{ key: string, label: string, method: 'acro'|'docx'|'ocr_heuristic', page?: number|null, confidence?: number|null }} DetectedField */

/** @returns {string} */
export function extractDocxPlainText(buffer, maxLen = CONTRACT_TEXT_EXCERPT_MAX) {
  try {
    const zip = new PizZip(buffer);
    const doc = zip.file('word/document.xml');
    if (!doc) return '';
    const raw = doc.asText();
    const plain = raw
      .replace(/<w:tab\/>/gi, '\t')
      .replace(/<w:br\/?>/gi, '\n')
      .replace(/<w:p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return plain.slice(0, maxLen);
  } catch {
    return '';
  }
}

/** @returns {string[]} */
export function extractDocxPlaceholders(buffer) {
  const found = new Set();
  try {
    const zip = new PizZip(buffer);
    const names = Object.keys(zip.files).filter((n) => n.startsWith('word/') && n.endsWith('.xml'));
    const re = /\{([^{}]+)\}/g;
    for (const name of names) {
      const f = zip.file(name);
      if (!f) continue;
      const text = f.asText();
      let m;
      while ((m = re.exec(text)) !== null) {
        const inner = m[1].trim();
        if (!inner || inner.startsWith('/') || inner.includes('{')) continue;
        if (inner.length > 120) continue;
        found.add(inner);
      }
    }
  } catch {
    /* ignore */
  }
  return [...found];
}

/** @returns {Promise<string[]>} */
export async function extractPdfAcroFieldNames(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    try {
      const form = doc.getForm();
      return form.getFields().map((f) => f.getName());
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

/** @returns {Promise<{ text: string, ocr_used: boolean }>} */
export async function extractPdfTextWithOcrFallback(buffer) {
  let { text, ocrUsed } = await extractContractPdfText(buffer, { forceOcr: false });
  const thin = String(text || '').replace(/\s/g, '').length;
  if (thin < 100) {
    const second = await extractContractPdfText(buffer, { forceOcr: true });
    text = second.text;
    ocrUsed = second.ocrUsed || ocrUsed;
  }
  return { text: String(text || ''), ocr_used: !!ocrUsed };
}

/**
 * Heuristic field labels from plain / OCR text.
 * @param {string} text
 * @returns {{ ocr_labels: string[], detected_fields: DetectedField[] }}
 */
export function extractFormFieldCandidatesFromText(text) {
  const raw = String(text || '');
  const labels = new Set();
  /** @type {DetectedField[]} */
  const detected = [];
  const add = (key, label, method) => {
    const k = String(key || '').trim().replace(/\s+/g, '_');
    if (!k || k.length > 120) return;
    labels.add(k);
    detected.push({ key: k, label: label || k, method, page: null, confidence: null });
  };

  const lines = raw.split(/\r?\n/).map((l) => l.trim());

  // "Label: ___" or "Label : ______"
  const lineColonBlank = /^([A-Za-z][A-Za-z0-9 /&'°().-]{1,64})\s*:\s*[_.\s─–—-]{2,}\s*$/;
  for (const line of lines) {
    const m = lineColonBlank.exec(line);
    if (m) add(m[1], m[1], 'ocr_heuristic');
  }

  // "Label________________" (underscores run)
  const lineUnderscore = /^([A-Za-z][A-Za-z0-9 /&'°().-]{1,64})\s*[_.─–—]{3,}\s*$/;
  for (const line of lines) {
    const m = lineUnderscore.exec(line);
    if (m && !lineColonBlank.test(line)) add(m[1], m[1], 'ocr_heuristic');
  }

  // [ Field name ]
  const bracketRe = /\[\s*([A-Za-z][A-Za-z0-9 /&'°().-]{1,64})\s*\]/g;
  let bm;
  while ((bm = bracketRe.exec(raw)) !== null) {
    add(bm[1], bm[1], 'ocr_heuristic');
  }

  // "Field name …" or "Field name ..."
  const ellipsisRe = /^([A-Za-z][A-Za-z0-9 /&'°().-]{1,64})\s*[.…]{2,}\s*$/;
  for (const line of lines) {
    const m = ellipsisRe.exec(line);
    if (m) add(m[1], m[1], 'ocr_heuristic');
  }

  // Table-ish " | Header cell | "
  const pipeRe = /\|\s*([A-Za-z][A-Za-z0-9 /&'°().-]{1,48})\s*\|/g;
  let pm;
  while ((pm = pipeRe.exec(raw)) !== null) {
    if (!/^(yes|no|na|date|name)$/i.test(pm[1])) add(pm[1], pm[1], 'ocr_heuristic');
  }

  // Tick / checkbox lines: "☐ Label" or "[ ] Label" or "□ Label"
  const tickRe = /^(?:☐|☑|□|■|\[\s*\])\s+([A-Za-z][A-Za-z0-9 /&'°().-]{1,64})/;
  for (const line of lines) {
    const m = tickRe.exec(line);
    if (m) add(m[1], m[1], 'ocr_heuristic');
  }

  // Dedupe detected by key (keep first label)
  const seen = new Set();
  const deduped = [];
  for (const d of detected) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    deduped.push(d);
  }

  return { ocr_labels: [...labels], detected_fields: deduped };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function guessLabelsFromFlatText(text) {
  return extractFormFieldCandidatesFromText(text).ocr_labels;
}

/**
 * Merge suggested placeholder → merge-key map with existing user mappings (existing wins).
 * @param {Record<string, string>} suggested
 * @param {Record<string, string>|null|undefined} existing
 * @returns {Record<string, string>}
 */
export function mergeContractFieldMapSuggestions(suggested, existing) {
  const ex = existing && typeof existing === 'object' ? existing : {};
  return { ...suggested, ...ex };
}

/**
 * @param {string[]} acroNames
 * @param {string[]} docxPh
 * @param {DetectedField[]} ocrDetected
 * @returns {DetectedField[]}
 */
export function buildDetectedFieldsList(acroNames, docxPh, ocrDetected) {
  /** @type {DetectedField[]} */
  const out = [];
  const keys = new Set();
  for (const name of acroNames || []) {
    const k = String(name || '').trim();
    if (!k || keys.has(k)) continue;
    keys.add(k);
    out.push({ key: k, label: k, method: 'acro', page: null, confidence: null });
  }
  for (const ph of docxPh || []) {
    const k = String(ph || '').trim();
    if (!k || keys.has(k)) continue;
    keys.add(k);
    out.push({ key: k, label: k, method: 'docx', page: null, confidence: null });
  }
  for (const d of ocrDetected || []) {
    if (!d?.key || keys.has(d.key)) continue;
    keys.add(d.key);
    out.push(d);
  }
  return out;
}

const STAFF_MERGE_SYNONYMS = [
  { mergeKey: 'staff_name', patterns: [/^staff_name$/i, /employee.?name/i, /worker.?name/i, /^full_?legal_?name$/i, /^name$/i] },
  { mergeKey: 'employee_name', patterns: [/employee/i] },
  { mergeKey: 'email', patterns: [/e-?mail/i, /^email$/i] },
  { mergeKey: 'phone', patterns: [/phone/i, /mobile/i, /contact.?number/i] },
  { mergeKey: 'address', patterns: [/address/i, /residential/i] },
  { mergeKey: 'date_of_birth', patterns: [/birth/i, /dob/i, /date.?of.?birth/i] },
  { mergeKey: 'role', patterns: [/position/i, /job.?title/i, /^role$/i] },
  { mergeKey: 'employment_type', patterns: [/employment.?type/i, /casual|full.?time|part.?time/i] },
  { mergeKey: 'hourly_rate', patterns: [/hourly/i, /rate.?per.?hour/i, /^pay.?rate$/i, /\brate\b/i] },
  { mergeKey: 'abn', patterns: [/^abn$/i] },
  { mergeKey: 'organisation_name', patterns: [/employer/i, /company/i, /organisation|organization/i] },
  { mergeKey: 'today', patterns: [/commencement.?date/i, /start.?date/i, /^date$/i, /^today$/i] },
  { mergeKey: 'emergency_contact_name', patterns: [/emergency/i] },
  { mergeKey: 'emergency_contact_phone', patterns: [/emergency.?contact.?phone/i] }
];

const PARTICIPANT_MERGE_SYNONYMS = [
  { mergeKey: 'first_name', patterns: [/first.?name/i] },
  { mergeKey: 'last_name', patterns: [/last.?name/i] },
  { mergeKey: 'full_legal_name', patterns: [/legal.?name/i] },
  { mergeKey: 'ndis_number', patterns: [/ndis/i] },
  { mergeKey: 'email', patterns: [/e-?mail/i] },
  { mergeKey: 'phone', patterns: [/phone/i, /mobile/i] },
  { mergeKey: 'address', patterns: [/address/i] },
  { mergeKey: 'date_of_birth', patterns: [/birth/i, /dob/i] },
  { mergeKey: 'plan_start_date', patterns: [/plan.?start/i] },
  { mergeKey: 'plan_end_date', patterns: [/plan.?end/i] }
];

/**
 * Map template placeholder names → merge-data keys used when rendering.
 * @param {string[]} placeholders
 * @param {'staff'|'participant'} workflow
 * @returns {Record<string, string>}
 */
export function suggestContractFieldMap(placeholders, workflow = 'staff') {
  const table = workflow === 'participant' ? PARTICIPANT_MERGE_SYNONYMS : STAFF_MERGE_SYNONYMS;
  const map = {};
  for (const ph of placeholders) {
    const raw = String(ph || '').trim();
    if (!raw) continue;
    const underscored = raw.replace(/\s+/g, '_');
    const candidates = [raw, underscored, raw.replace(/_/g, ' ')];
    let matched = false;
    for (const { mergeKey, patterns } of table) {
      if (patterns.some((p) => candidates.some((c) => p.test(c)))) {
        map[raw] = mergeKey;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const lower = underscored.toLowerCase();
      if (/^[a-z][a-z0-9_]*$/i.test(lower)) map[raw] = lower;
    }
  }
  return map;
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<{ docx_placeholders: string[], pdf_form_fields: string[], ocr_labels: string[], detected_fields: DetectedField[], ocr_used: boolean, text_preview: string, text_excerpt: string, all_placeholders: string[], file_kind: string }>}
 */
export async function analyzeContractTemplateBuffer(buffer, filename = '') {
  const lower = (filename || '').toLowerCase();
  const ext = lower.endsWith('.docx') ? 'docx' : lower.endsWith('.pdf') ? 'pdf' : /\.(png|jpe?g|webp)$/i.test(lower) ? 'image' : 'unknown';

  const docx_placeholders = ext === 'docx' ? extractDocxPlaceholders(buffer) : [];
  let pdf_form_fields = [];
  let ocr_labels = [];
  /** @type {DetectedField[]} */
  let ocr_detected_slice = [];
  let ocr_used = false;
  let text_preview = '';
  let text_excerpt = '';

  if (ext === 'pdf') {
    pdf_form_fields = await extractPdfAcroFieldNames(buffer);
    const { text, ocr_used: ou } = await extractPdfTextWithOcrFallback(buffer);
    ocr_used = ou;
    const t = String(text || '');
    text_preview = t.slice(0, 1200);
    text_excerpt = t.slice(0, CONTRACT_TEXT_EXCERPT_MAX);
    const extracted = extractFormFieldCandidatesFromText(t);
    ocr_labels = extracted.ocr_labels;
    ocr_detected_slice = extracted.detected_fields;
  }

  if (ext === 'image') {
    const text = await ocrRasterBufferToText(buffer, filename || 'scan.jpg');
    ocr_used = true;
    const t = String(text || '');
    text_preview = t.slice(0, 1200);
    text_excerpt = t.slice(0, CONTRACT_TEXT_EXCERPT_MAX);
    const extracted = extractFormFieldCandidatesFromText(t);
    ocr_labels = extracted.ocr_labels;
    ocr_detected_slice = extracted.detected_fields;
  }

  if (ext === 'docx') {
    const plain = extractDocxPlainText(buffer, CONTRACT_TEXT_EXCERPT_MAX);
    text_preview = plain.slice(0, 1200);
    text_excerpt = plain;
    const extracted = extractFormFieldCandidatesFromText(plain);
    ocr_labels = extracted.ocr_labels;
    ocr_detected_slice = extracted.detected_fields;
  }

  const detected_fields = buildDetectedFieldsList(pdf_form_fields, docx_placeholders, ocr_detected_slice);
  const all = [...new Set([...docx_placeholders, ...pdf_form_fields, ...ocr_labels])];
  return {
    docx_placeholders,
    pdf_form_fields,
    ocr_labels,
    detected_fields,
    ocr_used,
    text_preview,
    text_excerpt,
    all_placeholders: all,
    file_kind: ext
  };
}
