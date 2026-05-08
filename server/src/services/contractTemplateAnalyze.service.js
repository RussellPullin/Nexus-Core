/**
 * Detect merge placeholders / form fields in employment or participant contract uploads.
 * DOCX: {placeholder} tags in word/*.xml. PDF: AcroForm names + OCR text heuristics when scanned.
 */

import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import PizZip from 'pizzip';
import { PDFDocument } from 'pdf-lib';
import { extractNdisPlanPdfText } from './pdfOcrText.service.js';

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
  let { text, ocrUsed } = await extractNdisPlanPdfText(buffer, { forceOcr: false });
  const thin = String(text || '').replace(/\s/g, '').length;
  if (thin < 120) {
    const second = await extractNdisPlanPdfText(buffer, { forceOcr: true });
    text = second.text;
    ocrUsed = second.ocrUsed || ocrUsed;
  }
  return { text: String(text || ''), ocr_used: !!ocrUsed };
}

/**
 * Guess fill-in labels from OCR/plain text (e.g. "Employee name: ______").
 * @param {string} text
 * @returns {string[]}
 */
export function guessLabelsFromFlatText(text) {
  const raw = String(text || '');
  const labels = new Set();
  const lineRe = /^([A-Za-z][A-Za-z0-9 /&'().-]{1,52}):\s*[_.\s─–-]{3,}\s*$/;
  const bracketRe = /\[\s*([A-Za-z][A-Za-z0-9 /&'().-]{1,52})\s*\]/g;
  for (const line of raw.split(/\r?\n/).map((l) => l.trim())) {
    const m = lineRe.exec(line);
    if (m) labels.add(m[1].replace(/\s+/g, '_'));
  }
  let bm;
  while ((bm = bracketRe.exec(raw)) !== null) {
    labels.add(bm[1].replace(/\s+/g, '_'));
  }
  return [...labels];
}

async function ocrImageBuffer(buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'contract-ocr-'));
  const path = join(dir, 'scan.png');
  try {
    await writeFile(path, buffer);
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(path);
      return String(data?.text || '');
    } finally {
      await worker.terminate();
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
 * @returns {Promise<{ docx_placeholders: string[], pdf_form_fields: string[], ocr_labels: string[], ocr_used: boolean, text_preview: string, all_placeholders: string[] }>}
 */
export async function analyzeContractTemplateBuffer(buffer, filename = '') {
  const lower = (filename || '').toLowerCase();
  const ext = lower.endsWith('.docx') ? 'docx' : lower.endsWith('.pdf') ? 'pdf' : /\.(png|jpe?g|webp)$/i.test(lower) ? 'image' : 'unknown';

  const docx_placeholders = ext === 'docx' ? extractDocxPlaceholders(buffer) : [];
  let pdf_form_fields = [];
  let ocr_labels = [];
  let ocr_used = false;
  let text_preview = '';

  if (ext === 'pdf') {
    pdf_form_fields = await extractPdfAcroFieldNames(buffer);
    const { text, ocr_used: ou } = await extractPdfTextWithOcrFallback(buffer);
    ocr_used = ou;
    text_preview = text.slice(0, 1200);
    ocr_labels = guessLabelsFromFlatText(text);
  }

  if (ext === 'image') {
    const text = await ocrImageBuffer(buffer);
    ocr_used = true;
    text_preview = text.slice(0, 1200);
    ocr_labels = guessLabelsFromFlatText(text);
  }

  const all = [...new Set([...docx_placeholders, ...pdf_form_fields, ...ocr_labels])];
  return {
    docx_placeholders,
    pdf_form_fields,
    ocr_labels,
    ocr_used,
    text_preview,
    all_placeholders: all,
    file_kind: ext
  };
}
