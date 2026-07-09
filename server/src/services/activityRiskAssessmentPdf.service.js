/**
 * Generic Activity Risk Assessment master PDF generator (unbranded).
 * Renders layout with PDFKit, then embeds AcroForm fields via pdf-lib so the PDF is fillable.
 */
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLibDocument, StandardFonts } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../../..');

export const GENERIC_MASTER_FILENAME = 'health-safety-risk-assessment.pdf';

// ── Brand colours ─────────────────────────────────────────────────────────────
const TEAL        = '#1A7A6E';
const TEAL_LIGHT  = '#E8F5F3';
const GOLD        = '#B8962E';
const DARK        = '#1C1C1C';
const MID_GREY    = '#666666';
const LIGHT_GREY  = '#F7F7F7';
const WHITE       = '#FFFFFF';
const HEADER_ROW  = '#2E4057';
const LOW         = '#4CAF50';
const MEDIUM      = '#FFC107';
const HIGH        = '#FF5722';
const EXTREME     = '#B71C1C';

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

/** Teal section header bar (height grows for wrapped titles) */
function sectionBar(doc, text, y) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WHITE);
  const textH = doc.heightOfString(text, { width: CW - 10 });
  const h = Math.max(16, textH + 8);
  doc.rect(M, y, CW, h).fill(TEAL);
  textBox(doc, text, M + 5, y + 4, CW - 10, h - 8, { size: 8.5, color: WHITE, bold: true });
  return y + h;
}

/** Two-column label row */
function labelRow(doc, label, y, colW) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK)
     .text(label, M + 4, y + 3, { width: colW - 8 });
}

/** Draw a bordered cell */
function cell(doc, x, y, w, h, bg) {
  if (bg) doc.rect(x, y, w, h).fill(bg);
  doc.rect(x, y, w, h).stroke('#CCCCCC');
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

/** Page footer */
function drawFooter(doc, pageNum, totalPages) {
  const y = PH - 22;
  doc.save();
  doc.rect(0, y, PW, 22).fill(TEAL);
  textBox(doc, 'Health & Safety Risk Assessment', M, y + 7, 220, 10, { size: 7, color: WHITE });
  textBox(doc, `Page ${pageNum} of ${totalPages}`, PW - M - 140, y + 7, 140, 10, { size: 7, color: WHITE, align: 'right' });
  doc.restore();
}

/** Page banner header */
function drawBanner(doc, subtitle) {
  const bH = 36;
  doc.rect(M, M, CW, bH).fill(TEAL);
  doc.rect(M, M, CW, 3).fill(GOLD);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(WHITE)
     .text('Activity Risk Assessment', M + 8, M + 8);
  doc.font('Helvetica').fontSize(7.5).fillColor('#CCEEEA');
  textBox(doc, subtitle || 'Identify, assess and control health & safety risks for participant activities',
    M + 8, M + 25, CW - 16, 10, { size: 7.5, color: '#CCEEEA' });
  return M + bH + 6;
}

/** Draw text clipped to a box so PDFKit cannot spill onto extra pages */
function textBox(doc, text, x, y, w, h, { font = 'Helvetica', size = 7.5, color = DARK, align = 'left', bold = false } = {}) {
  doc.font(bold ? `${font}-Bold` : font).fontSize(size).fillColor(color)
     .text(String(text ?? ''), x, y, { width: w, height: h, align, ellipsis: true });
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
  doc.rect(M, rowY, CW, otherH).fill(LIGHT_GREY).stroke('#CCCCCC');
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
    doc.rect(M, y, cW0, rH).fill(TEAL_LIGHT).stroke('#CCCCCC');
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
      doc.rect(x, dy, half * 0.35, rH).fill(TEAL_LIGHT).stroke('#CCCCCC');
      doc.rect(x + half * 0.35, dy, half * 0.65, rH).fill(bg).stroke('#CCCCCC');
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
    doc.rect(M,               y, cW1, rH).fill(colour).stroke('#CCCCCC');
    doc.rect(M + cW1,         y, cW2, rH).fill(bg).stroke('#CCCCCC');
    doc.rect(M + cW1 + cW2,   y, cW3, rH).fill(bg).stroke('#CCCCCC');
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

  doc.rect(M, y, CW, rH).fill(TEAL);
  textBox(doc, 'Hierarchy of Controls (most → least effective)', M + 4, y + 2, CW - 8, rH - 4, { size: 8, color: WHITE, bold: true });
  y += rH;

  steps.forEach((row, i) => {
    const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
    doc.rect(M,      y, lW, rH).fill(TEAL_LIGHT).stroke('#CCCCCC');
    doc.rect(M + lW, y, rW, rH).fill(bg).stroke('#CCCCCC');
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
  const rH = 24;

  // header row
  doc.rect(M, y, CW, rH).fill(HEADER_ROW);
  let x = M;
  headers.forEach((h, i) => {
    textBox(doc, h, x + 2, y + 2, widths[i] - 4, rH - 4, {
      size: 6.5, color: WHITE, bold: true, align: i === 0 ? 'center' : 'left'
    });
    x += widths[i];
  });
  y += rH;

  for (let i = 1; i <= 10; i++) {
    const bg = i % 2 === 0 ? LIGHT_GREY : WHITE;
    const rowH = 28;
    x = M;
    widths.forEach((w, ci) => {
      doc.rect(x, y, w, rowH).fill(ci === 0 ? TEAL_LIGHT : bg).stroke('#CCCCCC');
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
      doc.rect(x,       y, lW, rH).fill(TEAL_LIGHT).stroke('#CCCCCC');
      doc.rect(x + lW,  y, vW, rH).fill(WHITE).stroke('#CCCCCC');
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
    doc.rect(M,           y, qW, h).fill(bg).stroke('#CCCCCC');
    doc.rect(M+qW,        y, yW, h).fill(bg).stroke('#CCCCCC');
    doc.rect(M+qW+yW,     y, nW, h).fill(bg).stroke('#CCCCCC');
    doc.rect(M+qW+yW+nW,  y, dW, h).fill(bg).stroke('#CCCCCC');
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
      tf.addToPage(page, {
        x: f.x,
        y: pdfY,
        width: f.width,
        height: f.height,
        borderWidth: 0,
        backgroundColor: undefined
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
    let y = drawBanner(doc, 'Use this form to identify, assess and control health & safety risks for participant activities.');

    // Doc info strip
    doc.rect(M, y, CW, 14).fill(TEAL_LIGHT).stroke('#AADDD8');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text('Approved By:', M + 4, y + 3, { width: CW * 0.15 });
    registerTextField(doc, 'approved_by', M + 58, y + 1, CW * 0.32, 12);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text('Version:', M + CW * 0.5, y + 3, { width: CW * 0.08 });
    registerTextField(doc, 'version', M + CW * 0.5 + 38, y + 1, CW * 0.12, 12);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text('Review Date:', M + CW * 0.7, y + 3, { width: CW * 0.12 });
    registerTextField(doc, 'review_date', M + CW * 0.7 + 52, y + 1, CW * 0.28 - 52, 12);
    y += 18;

    // Section: Activity & Participant Details
    y = sectionBar(doc, 'ACTIVITY & PARTICIPANT DETAILS', y);
    y = fieldRow2(doc, 'Activity Name / Description:', 'Activity Date:', y, 22, ['activity_name', 'activity_date']);
    y = fieldRow2(doc, 'Activity Location:', 'Duration:', y, 22, ['activity_location', 'duration']);
    y = fieldRow2(doc, 'Participant Name:', 'NDIS Number:', y, 22, ['participant_name', 'ndis_number']);
    y = fieldRow2(doc, 'Support Worker / Therapist:', 'Supervisor:', y, 22, ['support_worker', 'supervisor']);
    y = fieldRow2(doc, "Participant's Key Support Needs\n(relevant to this activity):", 'Emergency Contact & Number:', y, 28, ['support_needs', 'emergency_contact']);
    y += 4;

    // Section: Step 1 Hazards
    y = sectionBar(doc, 'STEP 1 — IDENTIFY THE HAZARDS   (tick all that apply; add detail in Other/Details)', y);
    y += 2;

    y = hazardBlock(doc, 'Biological (hygiene, disease, infection)', [
      'Blood / bodily fluids', 'Virus / disease', 'Food handling',
      'Insect / tick-borne illness', 'Skin infection risk (cuts near natural water)',
    ], y, 3, 'hazard_bio');

    y = hazardBlock(doc, 'Chemicals  (refer to label and SDS for classification and management)', [
      'Non-hazardous chemical(s)', 'Hazardous chemical (refer to completed chemical risk assessment)',
      'Sunscreen / insect repellent', 'Cleaning agents / sanitisers',
    ], y, 2, 'hazard_chem');

    y = hazardBlock(doc, 'Critical Incident — may result in:', [
      'Serious injury / death', 'Evacuation required', 'Minor injury',
      'Participant elopement / missing person', 'Medical emergency (seizure, anaphylaxis, cardiac)',
    ], y, 3, 'hazard_critical');

    y = hazardBlock(doc, 'Environment — Outdoor / Natural Setting', [
      'Sun exposure / UV', 'Water (creek, river, beach, dam, pool)',
      'Animals / insects / wildlife', 'Storms / lightning / severe weather',
      'Extreme temperature (heat / cold)', 'Uneven terrain / remote location',
      'Flooding / fast-moving water', 'Sound / noise',
    ], y, 3, 'hazard_env');

    y = hazardBlock(doc, 'Facilities / Built Environment', [
      'Workshops / work rooms', 'Buildings and fixtures', 'Driveways / paths',
      'Playground equipment', 'Furniture', 'Swimming pool / water feature',
    ], y, 3, 'hazard_facility');

    y = hazardBlock(doc, 'Machinery, Plant & Equipment', [
      'Power tools', 'Hand tools', 'Vehicles / transport',
      'Ropes / climbing equipment', 'Craft / art equipment',
    ], y, 3, 'hazard_machinery');

    y = hazardBlock(doc, 'Manual Tasks / Physical Demands', [
      'Repetitive or heavy manual tasks', 'Working at heights', 'Restricted / confined space',
      'Physical overexertion', 'Lifting / carrying loads',
    ], y, 3, 'hazard_manual');

    y = hazardBlock(doc, 'Participant-Specific Considerations (NDIS)', [
      'Behavioural support needs (aggression, elopement)',
      'Sensory sensitivities (noise, texture, heat, light)',
      'Communication support needs',
      'Medical conditions (seizure, allergy, diabetes)',
      'Psychological / emotional wellbeing',
      'Physical disability / reduced mobility',
      'Fatigue or medication side-effects',
      'Participant / carer consent requirements',
    ], y, 2, 'hazard_participant');

    y = hazardBlock(doc, 'People', [
      'Participant', 'Support worker / therapist', 'Other participants',
      'Volunteers / community members', 'Members of public',
    ], y, 3, 'hazard_people');

    // ── Risk matrix + control planning ─────────────────────────────────────
    y = beginSectionPage(doc);
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
    y = beginSectionPage(doc);
    y = sectionBar(doc, 'STEP 3 (continued) — HAZARDS / RISKS AND CONTROL MEASURES', y);
    y = sectionIntro(doc, 'List each hazard, rate its risk level before and after controls, describe control measures applied, and name the responsible person.', y, 12);
    y = drawControlTable(doc, y);

    // Other details box
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text('Additional notes / other details:', M, y + 2);
    y += 12;
    doc.rect(M, y, CW, 38).fill(WHITE).stroke('#CCCCCC');
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
    y = beginSectionPage(doc);
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
    doc.rect(M, y, CW, 40).fill(WHITE).stroke('#CCCCCC');
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
  return form.getFields().map((field) => {
    const name = field.getName();
    const ctor = field.constructor.name;
    let type = 'text';
    if (ctor === 'PDFCheckBox') type = 'checkbox';
    else if (ctor === 'PDFTextField') type = field.isMultiline() ? 'textarea' : 'text';
    return { name, type };
  });
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
