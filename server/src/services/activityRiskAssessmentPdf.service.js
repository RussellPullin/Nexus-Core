/**
 * Generic Activity Risk Assessment master PDF generator (unbranded).
 * Renders layout with PDFKit, then embeds AcroForm fields via pdf-lib so the PDF is fillable.
 */
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLibDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ACTIVITY_RISK_HAZARD_BLOCKS } from '../../../shared/activityRiskHazards.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../../..');

export const GENERIC_MASTER_FILENAME = 'health-safety-risk-assessment.pdf';

// ── Design system (matches the tokenised policy/form library) ─────────────────
const TEAL        = '#1c6b72';   // accent
const TEAL_DARK   = '#124a4f';   // accent-dark
const TEAL_LIGHT  = '#eef5f5';   // accent-tint
const GOLD        = '#1c6b72';   // legacy alias — no longer a separate colour
const DARK        = '#1f2328';   // ink
const MID_GREY    = '#5b626b';   // muted
const LIGHT_GREY  = '#f6f7f8';
const WHITE        = '#FFFFFF';
const HAIR         = '#dfe3e8';  // hairline borders
const HEADER_ROW  = '#124a4f';   // dense-table header fill
const LOW         = '#4CAF50';
const MEDIUM      = '#E0A100';
const HIGH        = '#E4572E';
const EXTREME     = '#B71C1C';
const PROVIDER_SLOT_BG = '#e9f1f1';

const M  = 36;       // page margin
const PW = 595.28;   // A4 width pts
const PH = 841.89;   // A4 height pts
const CW = PW - M * 2; // content width

// ── AcroForm field registry (PDFKit top-left coords; converted in embed step) ─

const formFieldRegistry = [];

function resetFormFieldRegistry() {
  formFieldRegistry.length = 0;
}

const CONTENT_BOTTOM = PH - 30; // keep above footer band

function pageIndex(doc) {
  return doc.bufferedPageRange().count - 1;
}

function beginSectionPage(doc) {
  newPage(doc);
  return drawBanner(doc);
}

function ensureSpace(doc, y, needed) {
  if (y + needed <= CONTENT_BOTTOM) return y;
  return beginSectionPage(doc) + 2;
}

function registerTextField(doc, name, x, y, width, height, { multiline = false } = {}) {
  const idx = doc.bufferedPageRange().count - 1;
  formFieldRegistry.push({ type: 'text', name, pageIndex: idx, x, y, width, height, multiline });
}

function registerCheckbox(doc, name, x, y, size = 10) {
  const idx = doc.bufferedPageRange().count - 1;
  formFieldRegistry.push({ type: 'checkbox', name, pageIndex: idx, x, y, width: size, height: size });
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function newPage(doc) {
  doc.addPage({ size: 'A4', margin: M });
}

/** Section header — tinted bar with a hairline underline (matches .fs cards). */
function sectionBar(doc, text, y) {
  doc.font('Helvetica-Bold').fontSize(8.2);
  const textH = doc.heightOfString(text.toUpperCase(), { width: CW - 14 });
  const h = Math.max(15, textH + 7);
  doc.rect(M, y, CW, h).fill(TEAL_LIGHT);
  textBox(doc, text.toUpperCase(), M + 7, y + 4, CW - 14, h - 7,
    { size: 8.2, color: TEAL_DARK, bold: true, characterSpacing: 0.3 });
  doc.moveTo(M, y + h).lineTo(M + CW, y + h).lineWidth(0.7).strokeColor(HAIR).stroke();
  return y + h + 2;
}

/** Two-column label row */
function labelRow(doc, label, y, colW) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK)
     .text(label, M + 4, y + 3, { width: colW - 8 });
}

/** Draw a bordered cell */
function cell(doc, x, y, w, h, bg) {
  if (bg) doc.rect(x, y, w, h).fill(bg);
  doc.rect(x, y, w, h).stroke(HAIR);
}

/** Checkbox square + label on one line */
function cbLine(doc, label, x, y, width, fieldName = null) {
  doc.rect(x, y + 1, 8, 8).stroke(DARK);
  if (fieldName) registerCheckbox(doc, fieldName, x, y + 1, 8);
  textBox(doc, label, x + 11, y, width - 14, 12, { size: 8 });
  return y + 13;
}

/** Risk level badge */
function riskBadge(doc, level, x, y, w, h) {
  const colours = { Low: LOW, Medium: MEDIUM, High: HIGH, Extreme: EXTREME };
  const bg = colours[level] || MID_GREY;
  doc.rect(x, y, w, h).fill(bg);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
     .text(level, x, y + h / 2 - 4, { width: w, align: 'center' });
}

/** Page footer — hairline rule with muted metadata (matches the stamped library footer). */
function drawFooter(doc, pageNum, totalPages) {
  const y = PH - 26;
  doc.save();
  doc.moveTo(M, y).lineTo(PW - M, y).lineWidth(0.6).strokeColor(HAIR).stroke();
  textBox(doc, `NDIS Provider   ·   ${DOC_TITLE.toUpperCase()}   ·   V1.0`,
    M, y + 5, CW * 0.62, 10, { size: 6.4, color: MID_GREY });
  textBox(doc, `Uncontrolled when printed   ·   Page ${pageNum} of ${totalPages}`,
    M, y + 5, CW, 10, { size: 6.4, color: MID_GREY, align: 'right' });
  doc.restore();
}

const DOC_TITLE = 'Health & Safety Risk Assessment';

/** A tinted CRM-fill slot: draws the highlight and registers a text AcroForm field. */
function providerSlot(doc, name, x, y, w, h) {
  doc.save();
  doc.rect(x, y, w, h).fill(PROVIDER_SLOT_BG);
  doc.restore();
  registerTextField(doc, name, x + 1, y + 1, w - 2, h - 2);
}

/** Letterhead (page 1) or a compact running header (continuation pages). */
function drawBanner(doc, subtitle, { first = false } = {}) {
  if (!first) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MID_GREY)
       .text(DOC_TITLE, M, M + 2, { width: CW * 0.6 });
    doc.moveTo(M, M + 16).lineTo(M + CW, M + 16).lineWidth(0.6).strokeColor(HAIR).stroke();
    return M + 24;
  }

  const top = M;
  // logo slot, left
  const logoW = 132;
  const logoH = 40;
  providerSlot(doc, 'org_logo', M, top, logoW, logoH);

  // kicker + title, right-aligned
  doc.font('Helvetica-Bold').fontSize(7).fillColor(TEAL)
     .text('N D I S   C O R E   M O D U L E   ·   F O R M', M, top + 3, { width: CW, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(16).fillColor(DARK)
     .text(DOC_TITLE, M, top + 14, { width: CW, align: 'right' });

  let y = top + Math.max(logoH, 40) + 6;
  // 2pt accent rule
  doc.rect(M, y, CW, 2).fill(TEAL);
  y += 10;

  // document-control strip: 5 hairline cells
  const cells = [
    ['VERSION', '1.0', null],
    ['EFFECTIVE', '', 'EFFECTIVE_DATE'],
    ['NEXT REVIEW', '', 'REVIEW_DATE'],
    ['OWNER', '', 'DOC_OWNER'],
    ['APPROVED BY', '', 'APPROVED_BY']
  ];
  const cw = CW / cells.length;
  const stripH = 26;
  doc.rect(M, y, CW, stripH).lineWidth(0.7).strokeColor(HAIR).stroke();
  cells.forEach(([label, value, field], i) => {
    const cx = M + i * cw;
    if (i > 0) doc.moveTo(cx, y).lineTo(cx, y + stripH).lineWidth(0.7).strokeColor(HAIR).stroke();
    doc.font('Helvetica-Bold').fontSize(5.6).fillColor(MID_GREY)
       .text(label, cx + 5, y + 4, { width: cw - 10, characterSpacing: 0.4 });
    if (field) {
      providerSlot(doc, field, cx + 4, y + 12, cw - 8, 11);
    } else {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK)
         .text(value, cx + 5, y + 12, { width: cw - 10 });
    }
  });
  y += stripH + 8;

  if (subtitle) {
    y = sectionIntro(doc, subtitle, y - 4, 16) + 2;
  }
  return y;
}

/** Draw text clipped to a box so PDFKit cannot spill onto extra pages */
function textBox(doc, text, x, y, w, h, { font = 'Helvetica', size = 7.5, color = DARK, align = 'left', bold = false, characterSpacing = 0 } = {}) {
  doc.font(bold ? `${font}-Bold` : font).fontSize(size).fillColor(color)
     .text(String(text ?? ''), x, y, { width: w, height: h, align, ellipsis: true, characterSpacing });
}

/** Instruction line below a section bar */
function sectionIntro(doc, text, y, height = 14) {
  textBox(doc, text, M + 2, y + 4, CW - 4, height - 4, { size: 7.5, color: MID_GREY });
  return y + height;
}

// ── Field grid helpers ────────────────────────────────────────────────────────

/**
 * Draw a 2-column label+blank grid row.
 * Returns new Y after the row.
 */
function fieldRow2(doc, left, right, y, rowH = 22, fieldNames = null) {
  const half = CW / 2;
  doc.font('Helvetica-Bold').fontSize(7.5);
  const leftH = doc.heightOfString(left, { width: half * 0.38 });
  const rightH = doc.heightOfString(right, { width: half * 0.38 });
  const rowHeight = Math.max(rowH, leftH + 6, rightH + 6);

  cell(doc, M,          y, half * 0.42, rowHeight, TEAL_LIGHT);
  cell(doc, M + half * 0.42, y, half * 0.58, rowHeight, null);
  cell(doc, M + half,   y, half * 0.42, rowHeight, TEAL_LIGHT);
  cell(doc, M + half + half * 0.42, y, half * 0.58, rowHeight, null);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
     .text(left,  M + 3, y + 3, { width: half * 0.38, height: rowHeight - 6, ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
     .text(right, M + half + 3, y + 3, { width: half * 0.38, height: rowHeight - 6, ellipsis: true });
  if (fieldNames?.length === 2) {
    const pad = 3;
    const leftW = half * 0.58 - pad * 2;
    const rightW = half * 0.58 - pad * 2;
    registerTextField(doc, fieldNames[0], M + half * 0.42 + pad, y + pad, leftW, rowHeight - pad * 2);
    registerTextField(doc, fieldNames[1], M + half + half * 0.42 + pad, y + pad, rightW, rowHeight - pad * 2);
  }
  return y + rowHeight;
}

/** Single full-width label row (tall, for multi-line fields) */
function fieldRowFull(doc, label, y, rowH = 28, fieldName = null) {
  const lW = CW * 0.28;
  cell(doc, M,      y, lW,      rowH, TEAL_LIGHT);
  cell(doc, M + lW, y, CW - lW, rowH, null);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
     .text(label, M + 3, y + 3, { width: lW - 6 });
  if (fieldName) {
    registerTextField(doc, fieldName, M + lW + 3, y + 3, CW - lW - 6, rowH - 6, { multiline: true });
  }
  return y + rowH;
}

// ── Hazard checklist block ────────────────────────────────────────────────────

function hazardBlock(doc, category, items, y, cols = 3, fieldPrefix = 'hazard') {
  const rowStep = 13;
  const otherH = 16;
  const needed = 20 + Math.ceil(items.length / cols) * rowStep + otherH + 4;
  y = ensureSpace(doc, y, needed);

  y = sectionBar(doc, category, y);
  const colW = CW / cols;
  let col = 0;
  let rowY = y;
  items.forEach((item, idx) => {
    if (rowY + rowStep > CONTENT_BOTTOM) {
      newPage(doc);
      rowY = M + 4;
      col = 0;
    }
    const fieldName = `${fieldPrefix}_${idx + 1}`;
    cbLine(doc, item.label ?? item, M + col * colW + 4, rowY, colW - 4, fieldName);
    col++;
    if (col >= cols) { col = 0; rowY += rowStep; }
  });
  if (col > 0) rowY += rowStep;
  rowY = ensureSpace(doc, rowY, otherH + 4);
  doc.rect(M, rowY, CW, otherH).fill(LIGHT_GREY).stroke(HAIR);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
     .text('Other / Details:', M + 4, rowY + 4);
  registerTextField(doc, `${fieldPrefix}_other`, M + 80, rowY + 2, CW - 86, 12);
  return rowY + otherH + 2;
}

// ── Risk matrix ───────────────────────────────────────────────────────────────

function drawRiskMatrix(doc, y) {
  const cols   = ['', 'Insignificant', 'Minor', 'Moderate', 'Major', 'Critical'];
  const rows   = [
    ['Almost Certain', 'Medium', 'Medium', 'High',   'Extreme', 'Extreme'],
    ['Likely',         'Low',    'Medium', 'High',   'High',    'Extreme'],
    ['Possible',       'Low',    'Medium', 'Medium', 'High',    'High'],
    ['Unlikely',       'Low',    'Low',    'Medium', 'Medium',  'High'],
    ['Rare',           'Low',    'Low',    'Low',    'Low',     'Medium'],
  ];
  const cW0 = CW * 0.18;
  const cWn = (CW - cW0) / 5;
  const rH  = 14;

  // Header
  doc.rect(M, y, CW, rH).fill(HEADER_ROW);
  textBox(doc, 'Likelihood \\ Consequence', M + 2, y + 2, cW0 - 4, rH - 4, { size: 7.5, color: WHITE, bold: true });
  cols.slice(1).forEach((h, i) => {
    textBox(doc, h, M + cW0 + i * cWn + 2, y + 2, cWn - 4, rH - 4, { size: 7, color: WHITE, bold: true, align: 'center' });
  });
  y += rH;

  const colourMap = { Low: LOW, Medium: MEDIUM, High: HIGH, Extreme: EXTREME };
  rows.forEach((row, ri) => {
    const bg = ri % 2 === 0 ? WHITE : LIGHT_GREY;
    doc.rect(M, y, cW0, rH).fill(TEAL_LIGHT).stroke(HAIR);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text(row[0], M + 3, y + 3, { width: cW0 - 6, height: rH - 6, ellipsis: true });
    row.slice(1).forEach((val, ci) => {
      const x = M + cW0 + ci * cWn;
      const c = colourMap[val] || bg;
      doc.rect(x, y, cWn, rH).fill(c).stroke(WHITE);
      textBox(doc, val, x, y + 3, cWn, rH - 6, { size: 7, color: WHITE, bold: true, align: 'center' });
    });
    y += rH;
  });
  return y + 4;
}

// ── Consequence / Likelihood descriptor tables ────────────────────────────────

function drawDescriptors(doc, y) {
  const half = CW / 2 - 2;
  const rH   = 13;

  const cons = [
    ['1. Insignificant', 'No treatment required.'],
    ['2. Minor',         'Minor injury — first aid (cuts, bruises).'],
    ['3. Moderate',      'Injury requiring medical treatment or lost time.'],
    ['4. Major',         'Serious injury — specialist / hospitalisation.'],
    ['5. Critical',      'Loss of life, permanent disability.'],
  ];
  const like = [
    ['1. Rare',           'Only in exceptional circumstances.'],
    ['2. Unlikely',       'Not likely in the foreseeable future.'],
    ['3. Possible',       'May occur in the foreseeable future.'],
    ['4. Likely',         'Likely to occur in the foreseeable future.'],
    ['5. Almost Certain', 'Almost certain to occur.'],
  ];

  [[cons, M], [like, M + half + 4]].forEach(([data, x]) => {
    doc.rect(x, y, half, rH).fill(HEADER_ROW);
    textBox(doc, x === M ? 'Consequence' : 'Likelihood', x + 3, y + 2, half * 0.35 - 6, rH - 4, { size: 7.5, color: WHITE, bold: true });
    textBox(doc, 'Description', x + half * 0.35, y + 2, half * 0.65 - 6, rH - 4, { size: 7.5, color: WHITE, bold: true });
    let dy = y + rH;
    data.forEach((row, i) => {
      const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
      doc.rect(x, dy, half * 0.35, rH).fill(TEAL_LIGHT).stroke(HAIR);
      doc.rect(x + half * 0.35, dy, half * 0.65, rH).fill(bg).stroke(HAIR);
      textBox(doc, row[0], x + 2, dy + 2, half * 0.35 - 4, rH - 4, { size: 6.5, bold: true });
      textBox(doc, row[1], x + half * 0.35 + 2, dy + 2, half * 0.65 - 4, rH - 4, { size: 6.5 });
      dy += rH;
    });
  });
  return y + rH * 6 + 4;
}

// ── Risk level action table ───────────────────────────────────────────────────

function drawActionTable(doc, y) {
  const levels = [
    { level: 'Low',     colour: LOW,     desc: 'Little likelihood of injury.',                         action: 'Proceed with existing controls.' },
    { level: 'Medium',  colour: MEDIUM,  desc: 'Some chance of first-aid-level injury.',               action: 'Additional controls may be needed.' },
    { level: 'High',    colour: HIGH,    desc: 'Likely that medical treatment would be needed.',        action: 'Controls MUST be in place. Supervisor sign-off required.' },
    { level: 'Extreme', colour: EXTREME, desc: 'Likely permanent/debilitating injury or death.',       action: 'Consider alternatives. Management approval required.' },
  ];
  const cW1 = CW * 0.11, cW2 = CW * 0.42, cW3 = CW * 0.47;
  const rH = 22;

  doc.rect(M, y, CW, rH).fill(HEADER_ROW);
  [['Risk Level', M, cW1], ['Description', M + cW1, cW2], ['Required Action', M + cW1 + cW2, cW3]]
    .forEach(([t, x, w]) => {
      textBox(doc, t, x + 2, y + 2, w - 4, rH - 4, { size: 7.5, color: WHITE, bold: true });
    });
  y += rH;

  levels.forEach(({ level, colour, desc, action }) => {
    const bg = LIGHT_GREY;
    doc.rect(M,               y, cW1, rH).fill(colour).stroke(HAIR);
    doc.rect(M + cW1,         y, cW2, rH).fill(bg).stroke(HAIR);
    doc.rect(M + cW1 + cW2,   y, cW3, rH).fill(bg).stroke(HAIR);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
       .text(level, M, y + 3, { width: cW1, align: 'center' });
    textBox(doc, desc, M + cW1 + 2, y + 2, cW2 - 4, rH - 4, { size: 7 });
    textBox(doc, action, M + cW1 + cW2 + 2, y + 2, cW3 - 4, rH - 4, { size: 7 });
    y += rH;
  });
  return y + 4;
}

// ── Hierarchy of controls table ───────────────────────────────────────────────

function drawHierarchy(doc, y) {
  const steps = [
    ['1. Elimination',    'Remove the hazard completely from the workplace or activity.'],
    ['2. Substitution',   'Replace the hazard with something less dangerous.'],
    ['3. Redesign',       'Change the process or equipment to make it inherently safer.'],
    ['4. Isolation',      'Separate people from the hazard (barriers, restricted areas).'],
    ['5. Administration', 'Put rules, training, signage or safe work procedures in place.'],
    ['6. PPE',            'Personal protective equipment as a last resort (gloves, helmets, sun protection).'],
  ];
  const lW = CW * 0.22, rW = CW * 0.78, rH = 20;

  doc.rect(M, y, CW, rH).fill(HEADER_ROW);
  textBox(doc, 'Hierarchy of Controls (most to least effective)', M + 4, y + 2, CW - 8, rH - 4, { size: 8, color: WHITE, bold: true });
  y += rH;

  steps.forEach((row, i) => {
    const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
    doc.rect(M,      y, lW, rH).fill(TEAL_LIGHT).stroke(HAIR);
    doc.rect(M + lW, y, rW, rH).fill(bg).stroke(HAIR);
    textBox(doc, row[0], M + 3, y + 2, lW - 6, rH - 4, { size: 7.5, bold: true });
    textBox(doc, row[1], M + lW + 3, y + 2, rW - 6, rH - 4, { size: 7.5 });
    y += rH;
  });
  return y + 4;
}

// ── Control measures table ────────────────────────────────────────────────────

function drawControlTable(doc, y) {
  const widths = [CW*0.04, CW*0.22, CW*0.10, CW*0.38, CW*0.12, CW*0.14];
  const headers = ['#', 'Hazard / Risk Description', 'Risk Level\n(pre)', 'Control Measures (hierarchy level applied)', 'Residual Risk\n(post)', 'Responsible\nPerson'];
  const headerH = 24;
  const rowH = 28;

  y = ensureSpace(doc, y, headerH + rowH);
  doc.rect(M, y, CW, headerH).fill(HEADER_ROW);
  let x = M;
  headers.forEach((h, i) => {
    textBox(doc, h, x + 2, y + 2, widths[i] - 4, headerH - 4, {
      size: 6.5, color: WHITE, bold: true, align: i === 0 ? 'center' : 'left'
    });
    x += widths[i];
  });
  y += headerH;

  for (let i = 1; i <= 10; i++) {
    y = ensureSpace(doc, y, rowH);
    const bg = i % 2 === 0 ? LIGHT_GREY : WHITE;
    x = M;
    widths.forEach((w, ci) => {
      doc.rect(x, y, w, rowH).fill(ci === 0 ? TEAL_LIGHT : bg).stroke(HAIR);
      if (ci === 0) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK)
           .text(String(i), x, y + 9, { width: w, align: 'center' });
      } else {
        const fieldKeys = ['desc', 'pre_risk', 'controls', 'post_risk', 'responsible'];
        const key = fieldKeys[ci - 1];
        registerTextField(doc, `control_${i}_${key}`, x + 2, y + 2, w - 4, rowH - 4, { multiline: ci === 3 });
      }
      x += w;
    });
    y += rowH;
  }
  return y + 4;
}

// ── Sign-off grid ─────────────────────────────────────────────────────────────

function drawSignOff(doc, fields, y, fieldPrefix = 'signoff') {
  // fields: array of [label, label, label, label] rows (2 pairs per row)
  const half = CW / 2;
  const lW = half * 0.42, vW = half * 0.58;
  const rH = 22;

  fields.forEach((row, rowIdx) => {
    const pairs = [[row[0], row[1]], [row[2], row[3]]];
    pairs.forEach(([label, fieldKey], pi) => {
      const x = M + pi * half;
      doc.rect(x,       y, lW, rH).fill(TEAL_LIGHT).stroke(HAIR);
      doc.rect(x + lW,  y, vW, rH).fill(WHITE).stroke(HAIR);
      textBox(doc, label, x + 3, y + 4, lW - 6, rH - 8, { size: 7.5, bold: true });
      if (fieldKey) {
        registerTextField(doc, `${fieldPrefix}_${fieldKey}`, x + lW + 3, y + 3, vW - 6, rH - 6);
      }
    });
    y += rH;
  });
  return y + 4;
}

// ── Review checklist ──────────────────────────────────────────────────────────

function drawReviewTable(doc, questions, y) {
  const qW = CW * 0.52, yW = CW * 0.07, nW = CW * 0.07, dW = CW * 0.34;
  const rH = 18;

  doc.rect(M, y, CW, rH - 4).fill(HEADER_ROW);
  [['Question', M, qW], ['Yes', M+qW, yW], ['No', M+qW+yW, nW], ['Details / Actions', M+qW+yW+nW, dW]]
    .forEach(([t, x, w]) => {
      textBox(doc, t, x + 2, y + 2, w - 4, (rH - 4) - 4, { size: 7.5, color: WHITE, bold: true, align: 'center' });
    });
  y += rH - 4;

  questions.forEach((q, i) => {
    const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
    doc.font('Helvetica').fontSize(7.5);
    const h = Math.max(24, doc.heightOfString(q, { width: qW - 6 }) + 10);
    doc.rect(M,           y, qW, h).fill(bg).stroke(HAIR);
    doc.rect(M+qW,        y, yW, h).fill(bg).stroke(HAIR);
    doc.rect(M+qW+yW,     y, nW, h).fill(bg).stroke(HAIR);
    doc.rect(M+qW+yW+nW,  y, dW, h).fill(bg).stroke(HAIR);
    textBox(doc, q, M + 3, y + 4, qW - 6, h - 8, { size: 7.5 });
    const qNum = i + 1;
    registerCheckbox(doc, `review_q${qNum}_yes`, M + qW + yW / 2 - 4, y + 6, 8);
    registerCheckbox(doc, `review_q${qNum}_no`, M + qW + yW + nW / 2 - 4, y + 6, 8);
    registerTextField(doc, `review_q${qNum}_details`, M + qW + yW + nW + 2, y + 2, dW - 4, h - 4);
    y += h;
  });
  return y + 4;
}

// ── Main generator ────────────────────────────────────────────────────────────

async function embedAcroFormFields(pdfBytes, fields) {
  const pdfDoc = await PdfLibDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  for (const f of fields) {
    const page = pages[f.pageIndex];
    if (!page) continue;
    const pageHeight = page.getHeight();
    const pdfY = pageHeight - f.y - f.height;

    if (f.type === 'text') {
      const tf = form.createTextField(f.name);
      tf.setText('');
      // provider text slots get a white fill so the CRM value covers the tint;
      // org_logo stays transparent so the drawn logo image shows through.
      const opaque = ACTIVITY_RISK_PROVIDER_FIELDS.has(f.name) && f.name !== 'org_logo';
      tf.addToPage(page, {
        x: f.x,
        y: pdfY,
        width: f.width,
        height: f.height,
        borderWidth: 0,
        backgroundColor: opaque ? rgb(1, 1, 1) : undefined
      });
      if (f.multiline) tf.enableMultiline();
      tf.updateAppearances(font);
    } else if (f.type === 'checkbox') {
      const cb = form.createCheckBox(f.name);
      cb.addToPage(page, { x: f.x, y: pdfY, width: f.width, height: f.height });
    }
  }

  return Buffer.from(await pdfDoc.save({ updateFieldAppearances: false }));
}

function renderActivityRiskAssessmentLayout() {
  return new Promise((resolve, reject) => {
    resetFormFieldRegistry();
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, autoFirstPage: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);

    // ── PAGE 1: Details + Hazard identification ────────────────────────────
    doc.addPage({ size: 'A4' });
    let y = drawBanner(
      doc,
      'Use this form to identify, assess and control health & safety risks for participant activities.',
      { first: true }
    );

    // Section: Activity details (activity-level — not session or participant specific)
    y = sectionBar(doc, 'ACTIVITY DETAILS', y);
    y = fieldRowFull(doc, 'Activity Name / Description:', y, 28, 'activity_name');
    y = fieldRow2(doc, 'Activity Location:', 'Typical Duration:', y, 22, ['activity_location', 'duration']);
    y += 4;

    // Section: Step 1 Hazards
    y = sectionBar(doc, 'STEP 1 — IDENTIFY THE HAZARDS   (tick all that apply; add detail in Other/Details)', y);
    y += 2;

    for (const block of ACTIVITY_RISK_HAZARD_BLOCKS) {
      y = hazardBlock(doc, block.category, block.items, y, block.cols, block.prefix);
    }

    // ── Risk matrix + control planning ─────────────────────────────────────
    y = ensureSpace(doc, y, 220);
    y = sectionBar(doc, 'STEP 2 — ASSESS THE LEVEL OF RISK', y);
    y = sectionIntro(doc, 'Use the matrix and descriptors below to assign a risk level (Likelihood × Consequence) to each hazard from Step 1.', y);

    y = drawRiskMatrix(doc, y);
    y = drawDescriptors(doc, y);
    y = drawActionTable(doc, y);
    y += 4;

    y = ensureSpace(doc, y, 120);
    y = sectionBar(doc, 'STEP 3 — CONTROL THE RISK', y);
    y = sectionIntro(doc, 'Control measures should follow the Hierarchy of Controls (most to least effective). If only Administration or PPE controls are used, explain why.', y);
    y = drawHierarchy(doc, y);

    // ── Control measures table + sign-off ───────────────────────────────────
    y = ensureSpace(doc, y, 90);
    y = sectionBar(doc, 'STEP 3 (continued) — HAZARDS / RISKS AND CONTROL MEASURES', y);
    y = sectionIntro(doc, 'List each hazard, rate its risk level before and after controls, describe control measures applied, and name the responsible person.', y, 12);
    y = drawControlTable(doc, y);

    // Other details box
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text('Additional notes / other details:', M, y + 2);
    y += 12;
    doc.rect(M, y, CW, 38).fill(WHITE).stroke(HAIR);
    registerTextField(doc, 'additional_notes', M + 3, y + 3, CW - 6, 32, { multiline: true });
    y += 42;

    // Submission / Pre-activity sign-off
    y = ensureSpace(doc, y, 130);
    y = sectionBar(doc, 'SUBMISSION & PRE-ACTIVITY SIGN-OFF', y);
    y = sectionIntro(doc, 'This activity will be conducted in accordance with this risk assessment. Control measures listed in Step 3 will be implemented. Any emerging risks will be managed and documented.', y, 22);

    y = drawSignOff(doc, [
      ['Prepared by (name):', 'prepared_by', 'Role / Designation:', 'prepared_role'],
      ['Date prepared:', 'date_prepared', 'Others involved in preparation:', 'others_involved'],
      ['Reviewed / approved by:', 'reviewed_by', 'Approval date:', 'approval_date'],
      ['Signature:', 'signature', 'Participant / Guardian consent obtained:', 'consent_notes'],
    ], y, 'pre_activity');

    // Consent yes / N/A checkboxes (right column of last sign-off row)
    const consentY = y - 22 - 4;
    const consentX = M + CW / 2 + CW / 2 * 0.42 + 3;
    doc.font('Helvetica').fontSize(7).fillColor(DARK)
       .text('Yes', consentX + 12, consentY + 4);
    registerCheckbox(doc, 'consent_yes', consentX, consentY + 3, 8);
    doc.font('Helvetica').fontSize(7).fillColor(DARK)
       .text('N/A', consentX + 52, consentY + 4);
    registerCheckbox(doc, 'consent_na', consentX + 40, consentY + 3, 8);

    // ── Monitor & review ────────────────────────────────────────────────────
    y = ensureSpace(doc, y, 280);
    y = sectionBar(doc, 'STEP 4 — MONITOR & REVIEW CONTROLS', y);
    y = sectionIntro(doc, 'Complete this section during and/or after the activity.', y);

    y = drawReviewTable(doc, [
      'Were the planned control measures sufficient and effective in minimising risk?',
      'Were any changes made to the planned control measures during the activity?',
      'Were there any incidents, near misses or injuries? (If yes, complete an Incident Report.)',
      'Did any participant display unexpected behavioural or support needs that affected safety?',
      'Are further control measures required for future sessions?',
    ], y);

    // Details box
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text('Details:', M, y + 2);
    y += 12;
    doc.rect(M, y, CW, 40).fill(WHITE).stroke(HAIR);
    registerTextField(doc, 'review_details', M + 3, y + 3, CW - 6, 34, { multiline: true });
    y += 44;

    // Post-activity sign-off
    y = drawSignOff(doc, [
      ['Review completed by:', 'completed_by', 'Designation:', 'designation'],
      ['Signature:', 'signature', 'Date:', 'date'],
    ], y, 'post_activity');

    // ── Add footers to all pages ───────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawFooter(doc, i + 1, range.count);
    }
    // Return to the last page so PDFKit does not append blank pages after footer pass.
    doc.switchToPage(range.start + range.count - 1);

    doc.end();
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export async function generateBlankActivityRiskAssessmentPdfBuffer() {
  const layoutBuffer = await renderActivityRiskAssessmentLayout();
  return embedAcroFormFields(layoutBuffer, formFieldRegistry);
}

export async function writeGenericActivityRiskMaster(targetPath) {
  const buf = await generateBlankActivityRiskAssessmentPdfBuffer();
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, buf);
  return buf;
}

export function bundledMasterPath() {
  return join(projectRoot, 'server', 'data', 'forms', 'templates', 'activity-risk-assessment', 'master', GENERIC_MASTER_FILENAME);
}

/** @param {Buffer|Uint8Array} pdfBytes */
export async function listActivityRiskPdfFieldSchema(pdfBytes) {
  const pdfDoc = await PdfLibDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const pages = pdfDoc.getPages();
  const pageRefs = pages.map((page) => page.ref.toString());

  return form.getFields()
    .filter((field) => !ACTIVITY_RISK_PROVIDER_FIELDS.has(field.getName()))
    .map((field) => {
    const name = field.getName();
    const ctor = field.constructor.name;
    let type = 'text';
    if (ctor === 'PDFCheckBox') type = 'checkbox';
    else if (ctor === 'PDFTextField') type = field.isMultiline() ? 'textarea' : 'text';

    const widget = field.acroField.getWidgets()[0];
    const rect = widget.getRectangle();
    const pageIndex = Math.max(0, pageRefs.indexOf(widget.P()?.toString() ?? ''));
    const pageHeight = pages[pageIndex]?.getHeight() ?? PH;

    return {
      name,
      type,
      pageIndex,
      x: rect.x,
      y: pageHeight - rect.y - rect.height,
      width: rect.width,
      height: rect.height,
      pageWidth: PW,
      pageHeight
    };
  });
}

/**
 * CRM-filled provider slots (logo + document-control strip). Populated at render
 * time from the org's business details — never shown in the in-app editor.
 */
export const ACTIVITY_RISK_PROVIDER_FIELDS = new Set([
  'org_logo', 'EFFECTIVE_DATE', 'REVIEW_DATE', 'DOC_OWNER', 'APPROVED_BY'
]);

/** Field prefixes excluded from the in-app editor — signed by admin via Nexus Core. */
export const ACTIVITY_RISK_ADMIN_SIGN_FIELD_PREFIXES = ['pre_activity_', 'post_activity_'];
export const ACTIVITY_RISK_ADMIN_SIGN_EXTRA_FIELDS = new Set(['consent_yes', 'consent_na']);

export function isActivityRiskAdminSignField(fieldName) {
  const name = String(fieldName || '');
  if (ACTIVITY_RISK_ADMIN_SIGN_EXTRA_FIELDS.has(name)) return true;
  return ACTIVITY_RISK_ADMIN_SIGN_FIELD_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  try {
    return { format: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
}

/**
 * Draw the admin signature image over the pre-activity signature field.
 * @param {Buffer} pdfBytes
 * @param {string|null} signatureDataUrl
 * @param {Array<{ name: string, pageIndex: number, x: number, y: number, width: number, height: number }>} schema
 */
export async function embedAdminSignatureInActivityRiskPdf(pdfBytes, signatureDataUrl, schema) {
  if (!signatureDataUrl) return pdfBytes;
  const sigField = (schema || []).find((f) => f.name === 'pre_activity_signature');
  if (!sigField) return pdfBytes;

  const decoded = dataUrlToBuffer(signatureDataUrl);
  if (!decoded?.buffer) return pdfBytes;

  const pdfDoc = await PdfLibDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const page = pages[sigField.pageIndex];
  if (!page) return Buffer.from(await pdfDoc.save({ updateFieldAppearances: true }));

  const pageHeight = page.getHeight();
  const pdfY = pageHeight - sigField.y - sigField.height;

  try {
    const image =
      decoded.format === 'jpeg' || decoded.format === 'jpg'
        ? await pdfDoc.embedJpg(decoded.buffer)
        : await pdfDoc.embedPng(decoded.buffer);
    page.drawImage(image, {
      x: sigField.x,
      y: pdfY,
      width: sigField.width,
      height: sigField.height
    });
  } catch (err) {
    console.warn('[activityRiskAssessmentPdf] Could not embed admin signature:', err?.message);
  }

  return Buffer.from(await pdfDoc.save({ updateFieldAppearances: true }));
}

/** @param {Buffer|Uint8Array} pdfBytes @param {Record<string, unknown>} fieldValues */
export async function fillActivityRiskPdfFields(pdfBytes, fieldValues) {
  const pdfDoc = await PdfLibDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  for (const [name, raw] of Object.entries(fieldValues || {})) {
    if (raw == null) continue;
    let field;
    try {
      field = form.getField(name);
    } catch {
      continue;
    }
    const ctor = field.constructor.name;
    if (ctor === 'PDFTextField') {
      field.setText(String(raw));
      try {
        field.updateAppearances(font);
      } catch {
        /* appearance optional */
      }
    } else if (ctor === 'PDFCheckBox') {
      if (raw === true || raw === 'true' || raw === '1' || raw === 1 || raw === 'yes') {
        field.check();
      } else {
        field.uncheck();
      }
    }
  }
  return Buffer.from(await pdfDoc.save({ updateFieldAppearances: true }));
}

/** @param {Buffer|Uint8Array} pdfBytes */
export async function extractActivityRiskPdfFieldValues(pdfBytes) {
  const pdfDoc = await PdfLibDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const out = {};
  for (const field of form.getFields()) {
    const name = field.getName();
    const ctor = field.constructor.name;
    if (ctor === 'PDFTextField') out[name] = field.getText() || '';
    else if (ctor === 'PDFCheckBox') out[name] = field.isChecked();
  }
  return out;
}
