/**
 * Detect merge placeholders / form fields in employment or participant contract uploads.
 * DOCX: {placeholder} tags in word/*.xml. PDF: AcroForm names + OCR text heuristics when scanned.
 */

import PizZip from 'pizzip';
import { PDFDocument } from 'pdf-lib';
import { extractContractPdfText, ocrRasterBufferToText } from './pdfOcrText.service.js';
import { augmentPdfTextWithPdfJs } from './pdfJsNativeText.service.js';
import { looksLikeParticipantServicesAgreement, scanParticipantServicesAgreementFields } from './participantAgreementFieldScan.service.js';

/** Max characters of document text sent to the browser for local LLM reading (preview / Ollama). */
export const CONTRACT_TEXT_EXCERPT_MAX = 48000;

function strippedLen(s) {
  return String(s || '').replace(/\s/g, '').length;
}

/**
 * When the browser sends a blob name or missing extension, infer kind from magic bytes.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {'pdf'|'docx'|'image'|'unknown'}
 */
export function sniffContractFileKind(buffer, filename = '') {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|webp)$/i.test(lower)) return 'image';

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length || buf.length < 5) return 'unknown';

  const scanLen = Math.min(buf.length, 12000);
  const headBin = buf.slice(0, scanLen).toString('binary');

  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && headBin.includes('word/document.xml')) return 'docx';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image';
  if (headBin.includes('WEBP')) return 'image';

  return 'unknown';
}

/**
 * Flat / scanned PDFs: pdf-parse often returns hundreds of junk characters so OCR never ran.
 * When there are no AcroForm fields, merge native text with a forced OCR pass for label heuristics.
 * @param {Buffer} buffer
 * @returns {Promise<{ text: string, ocr_used: boolean }>}
 */
export async function extractPdfTextForFieldDiscovery(buffer) {
  const acro = await extractPdfAcroFieldNames(buffer);
  const light = await extractContractPdfText(buffer, { forceOcr: false });
  const native = String(light.text || '');

  if (acro.length > 0) {
    const hard = await extractContractPdfText(buffer, { forceOcr: true });
    const ocr = String(hard.text || '');
    let text = native;
    let ocr_used = !!light.ocrUsed;
    if (strippedLen(ocr) > strippedLen(native) * 1.25 && strippedLen(ocr) > 80) {
      text = `${native}\n\n${ocr}`.trim();
      ocr_used = true;
    }
    text = await augmentPdfTextWithPdfJs(buffer, text);
    return { text, ocr_used };
  }

  const hard = await extractContractPdfText(buffer, { forceOcr: true });
  const ocr = String(hard.text || '');
  const parts = [];
  if (strippedLen(native) > 20) parts.push(native);
  if (strippedLen(ocr) > 20) parts.push(ocr);
  let text = parts.length ? parts.join('\n\n---\n\n') : ocr || native;
  text = await augmentPdfTextWithPdfJs(buffer, text);
  const ocr_used = hard.ocrUsed || light.ocrUsed || strippedLen(ocr) > 40;
  return { text, ocr_used };
}

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
  return extractPdfTextForFieldDiscovery(buffer);
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

  const slugLabel = (s) => {
    const t = String(s || '').trim();
    if (!t) return '';
    try {
      return t
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
    } catch {
      return t
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
    }
  };

  const add = (keyRaw, labelRaw, method) => {
    const slug = slugLabel(keyRaw);
    let k =
      slug ||
      String(keyRaw || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    if (!k || k.length < 2 || k.length > 120) return;
    if (/^\d+$/.test(k)) return;
    labels.add(k);
    detected.push({
      key: k,
      label: String(labelRaw || keyRaw).trim().slice(0, 200),
      method,
      page: null,
      confidence: null
    });
  };

  const lines = raw.split(/\r?\n/).map((l) => l.trim());

  // Unicode: "Label : ____" same line
  const lineColonBlankU = /^(\p{L}[\p{L}\p{N} /&'°().,\-–—]{1,70})\s*[:\uFF1A]\s*[.\s_─–—]{2,}\s*$/u;
  const lineUnderscoreU = /^(\p{L}[\p{L}\p{N} /&'°().,\-–—]{1,70})\s*[._─–—]{3,}\s*$/u;
  for (const line of lines) {
    if (!line) continue;
    const a = lineColonBlankU.exec(line);
    if (a) add(a[1], a[1], 'ocr_heuristic');
    else {
      const b = lineUnderscoreU.exec(line);
      if (b && !lineColonBlankU.test(line)) add(b[1], b[1], 'ocr_heuristic');
    }
  }

  // ASCII fallback (older OCR without unicode property)
  const lineColonBlank = /^([A-Za-z][A-Za-z0-9 /&'°().,-]{1,64})\s*:\s*[_.\s─–—-]{2,}\s*$/;
  const lineUnderscore = /^([A-Za-z][A-Za-z0-9 /&'°().,-]{1,64})\s*[_.─–—]{3,}\s*$/;
  for (const line of lines) {
    if (!line) continue;
    const m = lineColonBlank.exec(line);
    if (m && !lineColonBlankU.test(line)) add(m[1], m[1], 'ocr_heuristic');
    else {
      const u = lineUnderscore.exec(line);
      if (u && !lineColonBlank.test(line) && !lineUnderscoreU.test(line)) add(u[1], u[1], 'ocr_heuristic');
    }
  }

  // "Label …" end of line
  const ellipsisU = /^(\p{L}[\p{L}\p{N} /&'°().,\-–—]{1,70})\s*[.…]{2,}\s*$/u;
  for (const line of lines) {
    const m = ellipsisU.exec(line);
    if (m) add(m[1], m[1], 'ocr_heuristic');
  }

  // [ any short label ]
  const bracketRe = /\[\s*([^\]\n]{2,70})\s*\]/g;
  let bm;
  while ((bm = bracketRe.exec(raw)) !== null) {
    const inner = bm[1].trim();
    if (inner.length < 2) continue;
    add(inner, inner, 'ocr_heuristic');
  }

  // Numbered list + blank: "1. Full name __" or "2) Address:"
  const numbered = /^\d+[.)]\s*(.{2,72}?)\s*[:\s]*[._─–—]{2,}\s*$/;
  for (const line of lines) {
    const m = numbered.exec(line);
    if (m) add(m[1], m[1], 'ocr_heuristic');
  }

  // Loose "Label:" lines (not URLs), helps OCR that breaks underscores onto next line
  const looseColon = /^([^:]+):\s*$/;
  for (const line of lines) {
    const m = looseColon.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    if (label.length < 2 || label.length > 70) continue;
    if (/^https?:/i.test(label) || /[/@]/.test(label)) continue;
    if (/^\d+%?$/.test(label)) continue;
    add(label, label, 'ocr_heuristic');
  }

  // Label segment before a run of underscores/dots mid-line
  const midBlank = /(\p{L}[\p{L}\p{N}'°().,\- /]{1,52})\s{0,4}[._─–—]{4,}/gu;
  let mm;
  while ((mm = midBlank.exec(raw)) !== null) {
    add(mm[1], mm[1], 'ocr_heuristic');
  }

  // Table-ish "| Header |"
  const pipeRe = /\|\s*([^|\n]{2,48})\s*\|/g;
  let pm;
  while ((pm = pipeRe.exec(raw)) !== null) {
    const cell = pm[1].trim();
    if (!cell || /^(yes|no|n\/a|na|date|name|total)$/i.test(cell)) continue;
    if (cell.length < 3) continue;
    add(cell, cell, 'ocr_heuristic');
  }

  // Tick / checkbox
  const tickU = /^(?:☐|☑|□|■|❏|\[\s*\])\s+(\p{L}[^\n]{0,64})/u;
  for (const line of lines) {
    const m = tickU.exec(line);
    if (m) add(m[1].trim(), m[1].trim(), 'ocr_heuristic');
  }

  const tickAscii = /^(?:\[\s*\])\s+([A-Za-z][^\n]{0,64})/;
  for (const line of lines) {
    const m = tickAscii.exec(line);
    if (m && !tickU.test(line)) add(m[1].trim(), m[1].trim(), 'ocr_heuristic');
  }

  // Last-resort: common NDIS / HR phrases (only when we still found almost nothing)
  const strippedAll = raw.replace(/\s/g, '').length;
  if (labels.size < 10 && strippedAll > 80) {
    const blocks = [
      [/ndi?s\s*(number|no\.?|#)/i, 'NDIS_Number'],
      [/medicare\s*(number|no\.?)/i, 'Medicare_Number'],
      [/tax\s*file/i, 'Tax_File_Number'],
      [/date\s*of\s*birth|d\.?o\.?b\.?/i, 'Date_of_Birth'],
      [/e-?mail|email\s*address/i, 'Email'],
      [/phone|mobile|contact\s*number/i, 'Phone'],
      [/street\s*address|postal\s*address|residential\s*address/i, 'Address'],
      [/post\s*code|postcode/i, 'Postcode'],
      [/emergency\s*contact/i, 'Emergency_Contact'],
      [/participant\s*name|client\s*name|full\s*name/i, 'Full_Name'],
      [/given\s*name|first\s*name/i, 'First_Name'],
      [/surname|family\s*name|last\s*name/i, 'Last_Name'],
      [/signature/i, 'Signature'],
      [/today'?s?\s*date|date\s*signed/i, 'Date_Signed']
    ];
    for (const [re, key] of blocks) {
      if (re.test(raw)) add(key, key, 'ocr_heuristic');
    }
  }

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

/**
 * When flat text looks like a participant services agreement, merge template-specific
 * field keys and drop a few OCR line labels that duplicate provider vs client lines.
 * @param {string} text
 * @param {string[]} ocrLabels
 * @param {DetectedField[]} ocrDetected
 * @returns {{ ocr_labels: string[], ocr_detected_slice: DetectedField[] }}
 */
export function mergeAgreementScanIntoOcrResults(text, ocrLabels, ocrDetected) {
  let ocr_labels = [...(ocrLabels || [])];
  let ocr_detected_slice = [...(ocrDetected || [])];
  const t = String(text || '');
  if (!looksLikeParticipantServicesAgreement(t)) {
    return { ocr_labels, ocr_detected_slice };
  }
  const { mergeKeys, detected_fields: agreementFields } = scanParticipantServicesAgreementFields(t);
  const labelSet = new Set(ocr_labels);
  const keySeen = new Set(ocr_detected_slice.map((d) => d.key));
  for (const k of mergeKeys) {
    if (!labelSet.has(k)) labelSet.add(k);
  }
  ocr_labels = [...labelSet];
  for (const d of agreementFields) {
    if (keySeen.has(d.key)) continue;
    keySeen.add(d.key);
    ocr_detected_slice.push(d);
  }
  const mk = new Set(mergeKeys);
  if (mk.has('organisation_email') && mk.has('email')) {
    ocr_labels = ocr_labels.filter((l) => String(l) !== 'Email');
    ocr_detected_slice = ocr_detected_slice.filter(
      (d) => !(d.method === 'ocr_heuristic' && String(d.key).toLowerCase() === 'email')
    );
  }
  if (mk.has('organisation_phone') && mk.has('phone')) {
    ocr_labels = ocr_labels.filter((l) => String(l) !== 'Phone');
    ocr_detected_slice = ocr_detected_slice.filter(
      (d) => !(d.method === 'ocr_heuristic' && String(d.key).toLowerCase() === 'phone')
    );
  }
  if (mk.has('organisation_address') && mk.has('street_address')) {
    ocr_labels = ocr_labels.filter((l) => String(l) !== 'Address');
    ocr_detected_slice = ocr_detected_slice.filter(
      (d) => !(d.method === 'ocr_heuristic' && String(d.key).toLowerCase() === 'address')
    );
  }
  return { ocr_labels, ocr_detected_slice };
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
  { mergeKey: 'abn', patterns: [/^abn$/i, /provider.?abn/i, /business.?number/i] },
  { mergeKey: 'organisation_name', patterns: [/employer/i, /company/i, /organisation|organization/i, /^org_?name$/i, /provider.?name/i, /legal.?name/i, /trading.?name/i] },
  { mergeKey: 'organisation_address', patterns: [/org.?address/i, /provider.?address/i, /business.?address/i] },
  { mergeKey: 'organisation_email', patterns: [/org.?email/i, /provider.?email/i, /company.?email/i] },
  { mergeKey: 'organisation_phone', patterns: [/org.?phone/i, /provider.?phone/i, /company.?phone/i] },
  { mergeKey: 'organisation_contact_name', patterns: [/signatory/i, /contact.?person/i, /authorised.?representative/i, /authorized.?representative/i] },
  { mergeKey: 'today', patterns: [/commencement.?date/i, /start.?date/i, /^date$/i, /^today$/i] },
  { mergeKey: 'emergency_contact_name', patterns: [/emergency/i] },
  { mergeKey: 'emergency_contact_phone', patterns: [/emergency.?contact.?phone/i] }
];

const PARTICIPANT_MERGE_SYNONYMS = [
  { mergeKey: 'organisation_name', patterns: [/^organisation$/i, /^organisation_name$/i, /^org_?name$/i, /provider.?name/i, /legal.?name/i, /trading.?name/i, /company.?name/i] },
  { mergeKey: 'abn', patterns: [/^abn$/i, /provider.?abn/i, /business.?number/i] },
  { mergeKey: 'organisation_email', patterns: [/^organisation_email$/i, /org.?email/i, /provider.?email/i] },
  { mergeKey: 'organisation_phone', patterns: [/^organisation_phone$/i, /org.?phone/i, /provider.?phone/i] },
  { mergeKey: 'organisation_address', patterns: [/^organisation_address$/i, /org.?address/i, /provider.?address/i] },
  { mergeKey: 'organisation_contact_name', patterns: [/^organisation_contact_name$/i, /signatory/i, /contact.?person/i] },
  { mergeKey: 'scheduled_review_date', patterns: [/scheduled.?review/i] },
  { mergeKey: 'plan_manager_invoice_email', patterns: [/plan_manager_invoice_email/i, /plan.?manager.*invoice.*email/i] },
  { mergeKey: 'plan_manager_company_name', patterns: [/plan_manager_company_name/i, /plan.?manager.*name/i] },
  { mergeKey: 'first_name', patterns: [/first.?name/i] },
  { mergeKey: 'last_name', patterns: [/last.?name/i] },
  { mergeKey: 'full_legal_name', patterns: [/legal.?name/i, /please\s*print/i] },
  { mergeKey: 'ndis_number', patterns: [/ndis/i] },
  { mergeKey: 'email', patterns: [/^e-?mail$/i, /^email$/i, /^email_address$/i] },
  { mergeKey: 'phone', patterns: [/^phone$/i, /^mobile$/i, /phonemobile/i, /phone\s*mobile/i, /contact.?number/i] },
  { mergeKey: 'address', patterns: [/^address$/i, /residential|postal.?address/i] },
  { mergeKey: 'street_address', patterns: [/street.?address/i] },
  { mergeKey: 'date_of_birth', patterns: [/birth/i, /dob/i] },
  { mergeKey: 'plan_start_date', patterns: [/plan.?start/i] },
  { mergeKey: 'plan_end_date', patterns: [/plan.?end/i, /plan.?expiry/i] }
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
 * @returns {Promise<{ docx_placeholders: string[], pdf_form_fields: string[], ocr_labels: string[], detected_fields: DetectedField[], ocr_used: boolean, text_preview: string, text_excerpt: string, all_placeholders: string[], file_kind: string, analysis_note?: string|null }>}
 */
export async function analyzeContractTemplateBuffer(buffer, filename = '') {
  const lower = (filename || '').toLowerCase();
  let ext = lower.endsWith('.docx') ? 'docx' : lower.endsWith('.pdf') ? 'pdf' : /\.(png|jpe?g|webp)$/i.test(lower) ? 'image' : 'unknown';
  if (ext === 'unknown') {
    ext = sniffContractFileKind(buffer, lower);
  }

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
    const { text, ocr_used: ou } = await extractPdfTextForFieldDiscovery(buffer);
    ocr_used = ou;
    const t = String(text || '');
    text_preview = t.slice(0, 1200);
    text_excerpt = t.slice(0, CONTRACT_TEXT_EXCERPT_MAX);
    const extracted = extractFormFieldCandidatesFromText(t);
    const merged = mergeAgreementScanIntoOcrResults(t, extracted.ocr_labels, extracted.detected_fields);
    ocr_labels = merged.ocr_labels;
    ocr_detected_slice = merged.ocr_detected_slice;
  }

  if (ext === 'image') {
    const text = await ocrRasterBufferToText(buffer, filename || 'scan.jpg');
    ocr_used = true;
    const t = String(text || '');
    text_preview = t.slice(0, 1200);
    text_excerpt = t.slice(0, CONTRACT_TEXT_EXCERPT_MAX);
    const extracted = extractFormFieldCandidatesFromText(t);
    const merged = mergeAgreementScanIntoOcrResults(t, extracted.ocr_labels, extracted.detected_fields);
    ocr_labels = merged.ocr_labels;
    ocr_detected_slice = merged.ocr_detected_slice;
  }

  if (ext === 'docx') {
    const plain = extractDocxPlainText(buffer, CONTRACT_TEXT_EXCERPT_MAX);
    text_preview = plain.slice(0, 1200);
    text_excerpt = plain;
    const extracted = extractFormFieldCandidatesFromText(plain);
    const merged = mergeAgreementScanIntoOcrResults(plain, extracted.ocr_labels, extracted.detected_fields);
    ocr_labels = merged.ocr_labels;
    ocr_detected_slice = merged.ocr_detected_slice;
  }

  const detected_fields = buildDetectedFieldsList(pdf_form_fields, docx_placeholders, ocr_detected_slice);
  const all = [...new Set([...docx_placeholders, ...pdf_form_fields, ...ocr_labels])];

  let analysis_note = null;
  if (ext === 'unknown') {
    analysis_note =
      'Could not tell if this file is PDF, Word, or an image from the name or contents. Rename with a .pdf / .docx / .jpg extension, or re-upload.';
  } else if (ext === 'pdf' && pdf_form_fields.length === 0 && all.length === 0) {
    analysis_note =
      strippedLen(text_excerpt) < 45
        ? 'Almost no text was extracted (common for image-only or designer PDFs). Install Poppler so the server can OCR pages: macOS `brew install poppler`, Linux `apt install poppler-utils`. Alternatively export from Word with an embedded text layer, or upload a .docx template.'
        : 'Text was read from the file but no field labels were inferred. If this is a scan, install Poppler for OCR; otherwise add manual placeholder rows under Edit field links.';
  } else if (ext === 'pdf' && strippedLen(text_excerpt) < 40 && pdf_form_fields.length === 0) {
    analysis_note =
      'Very little text was extracted. If this is a scan, install poppler-utils (pdftoppm) on the server and ensure CONTRACT_PDF_OCR is not disabled. Fillable PDFs should still list fields when AcroForm widgets exist.';
  }

  return {
    docx_placeholders,
    pdf_form_fields,
    ocr_labels,
    detected_fields,
    ocr_used,
    text_preview,
    text_excerpt,
    all_placeholders: all,
    file_kind: ext,
    analysis_note
  };
}
