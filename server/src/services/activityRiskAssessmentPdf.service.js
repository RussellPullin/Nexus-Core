/**
 * Spring 2 Health — Activity Risk Assessment master PDF generator.
 * Branded for Spring 2 Health (NDIS Adventure Therapy, Gold Coast QLD).
 * Replaces the generic unbranded version.
 */
import PDFDocument from 'pdfkit';
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

// ── Drawing helpers ───────────────────────────────────────────────────────────

function newPage(doc) {
  doc.addPage({ size: 'A4', margin: M });
}

/** Teal section header bar */
function sectionBar(doc, text, y) {
  doc.rect(M, y, CW, 16).fill(TEAL);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WHITE)
     .text(text, M + 5, y + 4, { width: CW - 10 });
  return y + 16;
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
function cbLine(doc, label, x, y, width) {
  doc.rect(x, y + 1, 8, 8).stroke(DARK);
  doc.font('Helvetica').fontSize(8).fillColor(DARK)
     .text(label, x + 11, y, { width: width - 14, lineBreak: false });
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
  doc.rect(0, y, PW, 22).fill(TEAL);
  doc.font('Helvetica').fontSize(7).fillColor(WHITE)
     .text('Spring 2 Health  |  NDIS Adventure Therapy  |  spring2health.com.au', M, y + 7);
  doc.font('Helvetica').fontSize(7).fillColor(WHITE)
     .text(`Page ${pageNum} of ${totalPages}  |  Version 2.0  |  June 2026`,
           0, y + 7, { width: PW - M, align: 'right' });
}

/** Page banner header */
function drawBanner(doc, subtitle) {
  const bH = 36;
  doc.rect(M, M, CW, bH).fill(TEAL);
  doc.rect(M, M, CW, 3).fill(GOLD);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(WHITE)
     .text('Activity Risk Assessment', M + 8, M + 8);
  doc.font('Helvetica').fontSize(7.5).fillColor('#CCEEEA')
     .text(subtitle || 'Spring 2 Health  |  NDIS Adventure Therapy  |  spring2health.com.au',
           M + 8, M + 25, { width: CW * 0.65 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WHITE)
     .text('Spring 2 Health', M + CW * 0.68, M + 10, { width: CW * 0.3, align: 'right' });
  doc.font('Helvetica').fontSize(7).fillColor('#CCEEEA')
     .text('NDIS Adventure Therapy Provider', M + CW * 0.68, M + 22, { width: CW * 0.3, align: 'right' });
  return M + bH + 6;
}

/** Thin horizontal rule */
function rule(doc, y) {
  doc.moveTo(M, y).lineTo(M + CW, y).stroke('#DDDDDD');
  return y + 4;
}

// ── Field grid helpers ────────────────────────────────────────────────────────

/**
 * Draw a 2-column label+blank grid row.
 * Returns new Y after the row.
 */
function fieldRow2(doc, left, right, y, rowH = 22) {
  const half = CW / 2;
  // left label
  cell(doc, M,          y, half * 0.42, rowH, TEAL_LIGHT);
  cell(doc, M + half * 0.42, y, half * 0.58, rowH, null);
  // right label
  cell(doc, M + half,   y, half * 0.42, rowH, TEAL_LIGHT);
  cell(doc, M + half + half * 0.42, y, half * 0.58, rowH, null);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
     .text(left,  M + 3, y + 3, { width: half * 0.4 });
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
     .text(right, M + half + 3, y + 3, { width: half * 0.4 });
  return y + rowH;
}

/** Single full-width label row (tall, for multi-line fields) */
function fieldRowFull(doc, label, y, rowH = 28) {
  const lW = CW * 0.28;
  cell(doc, M,      y, lW,      rowH, TEAL_LIGHT);
  cell(doc, M + lW, y, CW - lW, rowH, null);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
     .text(label, M + 3, y + 3, { width: lW - 6 });
  return y + rowH;
}

// ── Hazard checklist block ────────────────────────────────────────────────────

function hazardBlock(doc, category, items, y, cols = 3) {
  const needed = 16 + Math.ceil(items.length / cols) * 13 + 18;
  if (y + needed > PH - 60) { newPage(doc); y = drawBanner(doc) + 2; }

  y = sectionBar(doc, category, y);
  const colW = CW / cols;
  let col = 0;
  let rowY = y;
  items.forEach((item) => {
    cbLine(doc, item, M + col * colW + 4, rowY, colW - 4);
    col++;
    if (col >= cols) { col = 0; rowY += 13; }
  });
  if (col > 0) rowY += 13;
  // Other/details line
  doc.rect(M, rowY, CW, 16).fill(LIGHT_GREY).stroke('#CCCCCC');
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
     .text('Other / Details:', M + 4, rowY + 4);
  doc.moveTo(M + 80, rowY + 11).lineTo(M + CW - 6, rowY + 11).stroke('#AAAAAA');
  return rowY + 16 + 2;
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
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
     .text('Likelihood \\ Consequence', M + 2, y + 3, { width: cW0 - 4 });
  cols.slice(1).forEach((h, i) => {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(WHITE)
       .text(h, M + cW0 + i * cWn + 2, y + 3, { width: cWn - 4, align: 'center' });
  });
  y += rH;

  const colourMap = { Low: LOW, Medium: MEDIUM, High: HIGH, Extreme: EXTREME };
  rows.forEach((row, ri) => {
    const bg = ri % 2 === 0 ? WHITE : LIGHT_GREY;
    doc.rect(M, y, cW0, rH).fill(TEAL_LIGHT).stroke('#CCCCCC');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text(row[0], M + 3, y + 3, { width: cW0 - 6 });
    row.slice(1).forEach((val, ci) => {
      const x = M + cW0 + ci * cWn;
      const c = colourMap[val] || bg;
      doc.rect(x, y, cWn, rH).fill(c).stroke(WHITE);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(WHITE)
         .text(val, x, y + 3, { width: cWn, align: 'center' });
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
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
       .text(x === M ? 'Consequence' : 'Likelihood', x + 3, y + 3, { width: half * 0.35 - 6 });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
       .text('Description', x + half * 0.35, y + 3, { width: half * 0.65 - 6 });
    let dy = y + rH;
    data.forEach((row, i) => {
      const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
      doc.rect(x, dy, half * 0.35, rH).fill(TEAL_LIGHT).stroke('#CCCCCC');
      doc.rect(x + half * 0.35, dy, half * 0.65, rH).fill(bg).stroke('#CCCCCC');
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(DARK)
         .text(row[0], x + 2, dy + 3, { width: half * 0.35 - 4 });
      doc.font('Helvetica').fontSize(6.5).fillColor(DARK)
         .text(row[1], x + half * 0.35 + 2, dy + 3, { width: half * 0.65 - 4 });
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
  const rH = 13;

  doc.rect(M, y, CW, rH).fill(HEADER_ROW);
  [['Risk Level', M, cW1], ['Description', M + cW1, cW2], ['Required Action', M + cW1 + cW2, cW3]]
    .forEach(([t, x, w]) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
         .text(t, x + 2, y + 3, { width: w - 4 });
    });
  y += rH;

  levels.forEach(({ level, colour, desc, action }) => {
    const bg = LIGHT_GREY;
    doc.rect(M,               y, cW1, rH).fill(colour).stroke('#CCCCCC');
    doc.rect(M + cW1,         y, cW2, rH).fill(bg).stroke('#CCCCCC');
    doc.rect(M + cW1 + cW2,   y, cW3, rH).fill(bg).stroke('#CCCCCC');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
       .text(level, M, y + 3, { width: cW1, align: 'center' });
    doc.font('Helvetica').fontSize(7).fillColor(DARK)
       .text(desc,   M + cW1 + 2,       y + 3, { width: cW2 - 4 });
    doc.font('Helvetica').fontSize(7).fillColor(DARK)
       .text(action, M + cW1 + cW2 + 2, y + 3, { width: cW3 - 4 });
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
  const lW = CW * 0.22, rW = CW * 0.78, rH = 14;

  doc.rect(M, y, CW, rH).fill(TEAL);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(WHITE)
     .text('Hierarchy of Controls (most → least effective)', M + 4, y + 3, { width: CW - 8 });
  y += rH;

  steps.forEach((row, i) => {
    const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
    doc.rect(M,      y, lW, rH).fill(TEAL_LIGHT).stroke('#CCCCCC');
    doc.rect(M + lW, y, rW, rH).fill(bg).stroke('#CCCCCC');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text(row[0], M + 3, y + 3, { width: lW - 6 });
    doc.font('Helvetica').fontSize(7.5).fillColor(DARK)
       .text(row[1], M + lW + 3, y + 3, { width: rW - 6 });
    y += rH;
  });
  return y + 4;
}

// ── Control measures table ────────────────────────────────────────────────────

function drawControlTable(doc, y) {
  const widths = [CW*0.04, CW*0.22, CW*0.10, CW*0.38, CW*0.12, CW*0.14];
  const headers = ['#', 'Hazard / Risk Description', 'Risk Level\n(pre)', 'Control Measures (hierarchy level applied)', 'Residual Risk\n(post)', 'Responsible\nPerson'];
  const rH = 14;

  // header row
  doc.rect(M, y, CW, rH).fill(HEADER_ROW);
  let x = M;
  headers.forEach((h, i) => {
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(WHITE)
       .text(h, x + 2, y + 2, { width: widths[i] - 4, align: i === 0 ? 'center' : 'left' });
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
      }
      x += w;
    });
    y += rowH;
  }
  return y + 4;
}

// ── Sign-off grid ─────────────────────────────────────────────────────────────

function drawSignOff(doc, fields, y) {
  // fields: array of [label, label, label, label] rows (2 pairs per row)
  const half = CW / 2;
  const lW = half * 0.42, vW = half * 0.58;
  const rH = 22;

  fields.forEach((row) => {
    const pairs = [[row[0], row[1]], [row[2], row[3]]];
    pairs.forEach(([label, _val], pi) => {
      const x = M + pi * half;
      doc.rect(x,       y, lW, rH).fill(TEAL_LIGHT).stroke('#CCCCCC');
      doc.rect(x + lW,  y, vW, rH).fill(WHITE).stroke('#CCCCCC');
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
         .text(label, x + 3, y + 4, { width: lW - 6 });
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
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
         .text(t, x + 2, y + 3, { width: w - 4, align: 'center' });
    });
  y += rH - 4;

  questions.forEach((q, i) => {
    const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
    const h = 20;
    doc.rect(M,           y, qW, h).fill(bg).stroke('#CCCCCC');
    doc.rect(M+qW,        y, yW, h).fill(bg).stroke('#CCCCCC');
    doc.rect(M+qW+yW,     y, nW, h).fill(bg).stroke('#CCCCCC');
    doc.rect(M+qW+yW+nW,  y, dW, h).fill(bg).stroke('#CCCCCC');
    doc.font('Helvetica').fontSize(7.5).fillColor(DARK)
       .text(q, M + 3, y + 4, { width: qW - 6 });
    // checkbox pairs
    [[M+qW, yW], [M+qW+yW, nW]].forEach(([cx, cw]) => {
      doc.rect(cx + cw/2 - 4, y + 6, 8, 8).stroke(DARK);
    });
    y += h;
  });
  return y + 4;
}

// ── Main generator ────────────────────────────────────────────────────────────

export function generateBlankActivityRiskAssessmentPdfBuffer() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, autoFirstPage: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);

    // ── PAGE 1: Details + Hazard identification ────────────────────────────
    doc.addPage({ size: 'A4' });
    let y = drawBanner(doc, 'Use this form to identify, assess and control health & safety risks for adventure therapy activities.');

    // Doc info strip
    doc.rect(M, y, CW, 14).fill(TEAL_LIGHT).stroke('#AADDD8');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text('Approved By: Spring 2 Health Management', M+4, y+3, { width: CW*0.5 });
    doc.font('Helvetica').fontSize(7.5).fillColor(DARK)
       .text('Version: 2.0', M + CW*0.5, y+3, { width: CW*0.2, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor(DARK)
       .text('Review Date: June 2027', M + CW*0.7, y+3, { width: CW*0.3, align: 'right' });
    y += 18;

    // Section: Activity & Participant Details
    y = sectionBar(doc, 'ACTIVITY & PARTICIPANT DETAILS', y);
    y = fieldRow2(doc, 'Activity Name / Description:', 'Activity Date:', y, 22);
    y = fieldRow2(doc, 'Activity Location:', 'Duration:', y, 22);
    y = fieldRow2(doc, 'Participant Name:', 'NDIS Number:', y, 22);
    y = fieldRow2(doc, 'Support Worker / Therapist:', 'Supervisor:', y, 22);
    y = fieldRow2(doc, "Participant's Key Support Needs\n(relevant to this activity):", 'Emergency Contact & Number:', y, 28);
    y += 4;

    // Section: Step 1 Hazards
    y = sectionBar(doc, 'STEP 1 — IDENTIFY THE HAZARDS   (tick all that apply; add detail in Other/Details)', y);
    y += 2;

    y = hazardBlock(doc, 'Biological (hygiene, disease, infection)', [
      'Blood / bodily fluids', 'Virus / disease', 'Food handling',
      'Insect / tick-borne illness', 'Skin infection risk (cuts near natural water)',
    ], y, 3);

    y = hazardBlock(doc, 'Chemicals  (refer to label and SDS for classification and management)', [
      'Non-hazardous chemical(s)', 'Hazardous chemical (refer to completed chemical risk assessment)',
      'Sunscreen / insect repellent', 'Cleaning agents / sanitisers',
    ], y, 2);

    y = hazardBlock(doc, 'Critical Incident — may result in:', [
      'Serious injury / death', 'Evacuation required', 'Minor injury',
      'Participant elopement / missing person', 'Medical emergency (seizure, anaphylaxis, cardiac)',
    ], y, 3);

    y = hazardBlock(doc, 'Environment — Outdoor / Natural Setting', [
      'Sun exposure / UV', 'Water (creek, river, beach, dam, pool)',
      'Animals / insects / wildlife', 'Storms / lightning / severe weather',
      'Extreme temperature (heat / cold)', 'Uneven terrain / remote location',
      'Flooding / fast-moving water', 'Sound / noise',
    ], y, 3);

    y = hazardBlock(doc, 'Facilities / Built Environment', [
      'Workshops / work rooms', 'Buildings and fixtures', 'Driveways / paths',
      'Playground equipment', 'Furniture', 'Swimming pool / water feature',
    ], y, 3);

    y = hazardBlock(doc, 'Machinery, Plant & Equipment', [
      'Power tools', 'Hand tools', 'Vehicles / transport',
      'Ropes / climbing equipment', 'Craft / art equipment',
    ], y, 3);

    y = hazardBlock(doc, 'Manual Tasks / Physical Demands', [
      'Repetitive or heavy manual tasks', 'Working at heights', 'Restricted / confined space',
      'Physical overexertion', 'Lifting / carrying loads',
    ], y, 3);

    y = hazardBlock(doc, 'Participant-Specific Considerations (NDIS / Adventure Therapy)', [
      'Behavioural support needs (aggression, elopement)',
      'Sensory sensitivities (noise, texture, heat, light)',
      'Communication support needs',
      'Medical conditions (seizure, allergy, diabetes)',
      'Psychological / emotional wellbeing',
      'Physical disability / reduced mobility',
      'Fatigue or medication side-effects',
      'Participant / carer consent requirements',
    ], y, 2);

    y = hazardBlock(doc, 'People', [
      'Participant', 'Support worker / therapist', 'Other participants',
      'Volunteers / community members', 'Members of public',
    ], y, 3);

    // ── PAGE 2: Risk Matrix + Step 3 intro ────────────────────────────────
    newPage(doc);
    y = drawBanner(doc);

    y = sectionBar(doc, 'STEP 2 — ASSESS THE LEVEL OF RISK', y);
    doc.font('Helvetica').fontSize(7.5).fillColor(MID_GREY)
       .text('Use the matrix and descriptors below to assign a risk level (Likelihood × Consequence) to each hazard from Step 1.', M+2, y+2);
    y += 14;

    y = drawRiskMatrix(doc, y);
    y = drawDescriptors(doc, y);
    y = drawActionTable(doc, y);
    y += 4;

    y = sectionBar(doc, 'STEP 3 — CONTROL THE RISK', y);
    doc.font('Helvetica').fontSize(7.5).fillColor(MID_GREY)
       .text('Control measures should follow the Hierarchy of Controls (most to least effective). If only Administration or PPE controls are used, explain why.', M+2, y+2);
    y += 14;
    y = drawHierarchy(doc, y);

    // ── PAGE 3: Control measures table ────────────────────────────────────
    newPage(doc);
    y = drawBanner(doc);
    y = sectionBar(doc, 'STEP 3 (continued) — HAZARDS / RISKS AND CONTROL MEASURES', y);
    doc.font('Helvetica').fontSize(7.5).fillColor(MID_GREY)
       .text('List each hazard, rate its risk level before and after controls, describe control measures applied, and name the responsible person.', M+2, y+2);
    y += 12;
    y = drawControlTable(doc, y);

    // Other details box
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(DARK)
       .text('Additional notes / other details:', M, y + 2);
    y += 12;
    doc.rect(M, y, CW, 38).fill(WHITE).stroke('#CCCCCC');
    y += 42;

    // Submission / Pre-activity sign-off
    y = sectionBar(doc, 'SUBMISSION & PRE-ACTIVITY SIGN-OFF', y);
    doc.font('Helvetica').fontSize(7.5).fillColor(MID_GREY)
       .text('This activity will be conducted in accordance with this risk assessment. Control measures listed in Step 3 will be implemented. Any emerging risks will be managed and documented.', M+2, y+2, { width: CW - 4 });
    y += 22;

    y = drawSignOff(doc, [
      ['Prepared by (name):', '', 'Role / Designation:', ''],
      ['Date prepared:', '', 'Others involved in preparation:', ''],
      ['Reviewed / approved by:', '', 'Approval date:', ''],
      ['Signature:', '', 'Participant / Guardian consent obtained:  ☐ Yes   ☐ N/A', ''],
    ], y);

    // ── PAGE 4: Monitor & Review ───────────────────────────────────────────
    newPage(doc);
    y = drawBanner(doc);

    y = sectionBar(doc, 'STEP 4 — MONITOR & REVIEW CONTROLS', y);
    doc.font('Helvetica').fontSize(7.5).fillColor(MID_GREY)
       .text('Complete this section during and/or after the activity.', M+2, y+2);
    y += 14;

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
    y += 44;

    // Post-activity sign-off
    y = drawSignOff(doc, [
      ['Review completed by:', '', 'Designation:', ''],
      ['Signature:', '', 'Date:', ''],
    ], y);

    // ── Add footers to all pages ───────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawFooter(doc, i + 1, range.count);
    }

    doc.end();
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
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
