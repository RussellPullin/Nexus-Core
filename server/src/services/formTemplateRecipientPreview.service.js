/**
 * Sample merge preview for custom form templates (Forms UI).
 * Produces a PDF: template pages (filled when AcroForm fields exist) plus appendix pages
 * listing placeholder → sample value so admins can sanity-check mappings for flat PDFs.
 */

import { readFileSync } from 'fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  applyContractPlaceholderMap,
  buildParticipantCustomMergeData,
  buildStaffContractMergeData,
  fillStaffContractPdfBuffer,
  resolvePdfFieldMergeValue
} from './staffContractFill.service.js';
import { renderDocxTemplateBuffer, convertDocxToPdf } from './consentForm.service.js';
import { embedRasterImageAsSinglePagePdf } from './imageToPdf.service.js';
import { extractPdfAcroFieldNames } from './contractTemplateAnalyze.service.js';
import { participantEmptyIntake } from '../../../shared/onboardingFieldRegistry.js';

/** pdf-lib StandardFonts only support WinAnsi — strip/replace common Unicode before drawText. */
function toPdfSafeText(str) {
  return String(str ?? '')
    .replace(/\u2192/g, '->')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\t\n\r\x20-\x7E]/g, '?');
}

/**
 * @param {Record<string, string>} contractFieldMap
 * @param {Record<string, string>} renderData
 * @param {string[]} [acroFieldNames]
 * @param {'participant_onboarding'|'staff_onboarding'} [workflow]
 */
export function buildFullFieldMappingRows(contractFieldMap, renderData, acroFieldNames = [], workflow = 'participant_onboarding') {
  const map = contractFieldMap && typeof contractFieldMap === 'object' ? contractFieldMap : {};
  const wf = workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
  const rows = [];
  const seen = new Set();

  for (const fieldName of acroFieldNames || []) {
    const name = String(fieldName || '').trim();
    if (!name) continue;
    const mergeKey = map[name] ? String(map[name]).trim() : '';
    const sample = resolvePdfFieldMergeValue(renderData, name, { workflow: wf }) || '';
    rows.push({
      pdf_field: name,
      merge_key: mergeKey || '(not mapped)',
      sample_value: sample || '(empty)',
      mapped: Boolean(mergeKey)
    });
    seen.add(name);
  }

  for (const [placeholder, mergeKeyRaw] of Object.entries(map)) {
    if (seen.has(placeholder)) continue;
    const mergeKey = String(mergeKeyRaw || '').trim();
    if (!mergeKey) continue;
    const sample =
      renderData[placeholder] != null && renderData[placeholder] !== ''
        ? String(renderData[placeholder])
        : renderData[mergeKey] != null
          ? String(renderData[mergeKey])
          : '';
    rows.push({
      pdf_field: String(placeholder),
      merge_key: mergeKey,
      sample_value: sample || '(empty)',
      mapped: true,
      ocr_only: true
    });
  }

  rows.sort((a, b) => a.pdf_field.localeCompare(b.pdf_field));
  return rows;
}

/**
 * @param {Record<string, string>} contractFieldMap
 * @param {Record<string, string>} renderData
 */
export function buildMergePreviewRows(contractFieldMap, renderData, acroFieldNames = [], workflow = 'participant_onboarding') {
  return buildFullFieldMappingRows(contractFieldMap, renderData, acroFieldNames, workflow).map((r) => ({
    placeholder: r.pdf_field,
    merge_key: r.merge_key,
    sample_value: r.sample_value === '(empty)' ? '' : r.sample_value,
    mapped: r.mapped
  }));
}

async function appendFieldMappingPages(outDoc, rows, { appendixOnly = false } = {}) {
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);
  const pageW = 595;
  const pageH = 842;
  const margin = 40;
  const lineH = 11;
  const col1 = margin;
  const col2 = margin + 185;
  const col3 = margin + 310;
  const fontSize = 8;

  let page = outDoc.addPage([pageW, pageH]);
  let y = pageH - margin;

  const title = appendixOnly
    ? 'Field mapping reference (no fillable PDF fields detected)'
    : 'Field mapping reference (read this first)';
  page.drawText(toPdfSafeText(title), { x: margin, y: y - 12, size: 12, font: fontBold });
  y -= 22;
  page.drawText(toPdfSafeText('PDF field name'), { x: col1, y, size: 9, font: fontBold });
  page.drawText(toPdfSafeText('Mapped to'), { x: col2, y, size: 9, font: fontBold });
  page.drawText(toPdfSafeText('Sample value'), { x: col3, y, size: 9, font: fontBold });
  y -= lineH + 4;

  if (!rows.length) {
    page.drawText(toPdfSafeText('No fields detected or mapped yet. Re-upload the PDF or edit field links in Forms.'), {
      x: margin,
      y,
      size: fontSize,
      font
    });
    return;
  }

  for (const row of rows) {
    if (y < margin + 20) {
      page = outDoc.addPage([pageW, pageH]);
      y = pageH - margin;
      page.drawText(toPdfSafeText('PDF field name'), { x: col1, y, size: 9, font: fontBold });
      page.drawText(toPdfSafeText('Mapped to'), { x: col2, y, size: 9, font: fontBold });
      page.drawText(toPdfSafeText('Sample value'), { x: col3, y, size: 9, font: fontBold });
      y -= lineH + 4;
    }
    page.drawText(toPdfSafeText(String(row.pdf_field || '').slice(0, 30)), { x: col1, y, size: fontSize, font });
    page.drawText(toPdfSafeText(String(row.merge_key || '').slice(0, 24)), { x: col2, y, size: fontSize, font });
    page.drawText(toPdfSafeText(String(row.sample_value || '(empty)').slice(0, 38)), {
      x: col3,
      y,
      size: fontSize,
      font
    });
    y -= lineH;
  }

  if (!appendixOnly) {
    if (y < margin + 30) {
      page = outDoc.addPage([pageW, pageH]);
      y = pageH - margin;
    } else {
      y -= 8;
    }
    page.drawText(toPdfSafeText('--- Filled form preview follows on next page(s) ---'), {
      x: margin,
      y,
      size: 9,
      font: fontBold
    });
  }
}

/** Fictitious participant/plan/intake used for admin sample previews. */
export function buildSampleParticipantContext() {
  const intake = participantEmptyIntake();
  Object.assign(intake, {
    first_name: 'Jamie',
    last_name: 'Sample',
    full_legal_name: 'Jamie A. Sample',
    preferred_name: 'Jamie',
    date_of_birth: '1991-03-20',
    ndis_number: '43000001234',
    email: 'jamie.sample.preview@example.test',
    phone: '0400 111 222',
    preferred_contact_method: 'Email',
    street_address: '10 Preview Street',
    suburb_city: 'Sampleville',
    state: 'QLD',
    postcode: '4000',
    address: '10 Preview Street, Sampleville QLD 4000',
    primary_contact_relationship: 'Parent',
    plan_start_date: '2024-07-01',
    plan_end_date: '2025-06-30',
    scheduled_review_date: '2025-12-01',
    plan_manager_company_name: 'Preview Plan Managers Pty Ltd',
    plan_manager_invoice_email: 'invoices@preview-plan.example.test'
  });
  const participant = {
    id: 'preview-participant',
    name: 'Jamie Sample',
    email: 'jamie.sample.preview@example.test',
    phone: '0400 111 222',
    address: '10 Preview Street, Sampleville QLD 4000',
    ndis_number: '43000001234',
    date_of_birth: '1991-03-20'
  };
  const plan = { start_date: '2024-07-01', end_date: '2025-06-30' };
  return { participant, plan, intake };
}

function staffPreviewFixture() {
  const staffRow = {
    id: 'preview-staff',
    name: 'Taylor Staff-Preview',
    email: 'taylor.staff.preview@example.test',
    phone: '0400 333 444',
    address: '20 Staff Example Road, Brisbane QLD 4001',
    date_of_birth: '1988-11-02',
    role: 'Support Worker',
    employment_type: 'Part-time',
    hourly_rate: '38.50',
    abn: '12 345 678 901',
    emergency_contact_name: 'Sam Preview',
    emergency_contact_phone: '0400 555 666'
  };
  const intakeMap = {
    first_name: 'Taylor',
    last_name: 'Staff-Preview',
    full_legal_name: 'Taylor Staff-Preview',
    date_of_birth: '1988-11-02',
    phone: '0400 333 444',
    address: '20 Staff Example Road, Brisbane QLD 4001',
    role: 'Support Worker',
    employment_type: 'Part-time',
    hourly_rate: '38.50',
    abn: '12 345 678 901',
    emergency_contact_name: 'Sam Preview',
    emergency_contact_phone: '0400 555 666'
  };
  return { staffRow, intakeMap };
}

/**
 * @param {'participant_onboarding'|'staff_onboarding'} workflow
 * @param {Record<string, string>|null|undefined} contractFieldMap
 * @param {{ name?: string, abn?: string, address?: string, email?: string, phone?: string }|null} organisation
 */
export function buildSampleRenderData(workflow, contractFieldMap, organisation) {
  const org = organisation && typeof organisation === 'object' ? organisation : {};
  const providerOrg = {
    organisation_name: String(org.name || 'Preview Provider Pty Ltd'),
    abn: String(org.abn || '99 888 777 666'),
    organisation_address: String(org.address || '1 Provider Lane, Brisbane QLD 4000'),
    organisation_email: String(org.email || 'admin@preview-provider.example.test'),
    organisation_phone: String(org.phone || '07 3000 0000'),
    organisation_contact_name: 'Alex Provider-Contact'
  };

  if (workflow === 'staff_onboarding') {
    const { staffRow, intakeMap } = staffPreviewFixture();
    const base = buildStaffContractMergeData(staffRow, intakeMap, { organisationName: providerOrg.organisation_name });
    return applyContractPlaceholderMap(base, contractFieldMap || {});
  }

  const { participant, plan, intake } = buildSampleParticipantContext();
  const base = buildParticipantCustomMergeData(participant, plan, intake, providerOrg);
  return applyContractPlaceholderMap(base, contractFieldMap || {});
}

/**
 * @returns {Promise<{ pdfBuffer: Buffer, acro_field_count: number, appendix_only: boolean, note: string | null }>}
 */
export async function buildRecipientPreviewPdfBuffer(resolved, workflow, contractFieldMap, organisation) {
  const wf = workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
  const renderData = buildSampleRenderData(wf, contractFieldMap, organisation);

  let basePdfBytes;
  let acroCount = 0;
  let acroFieldNames = [];
  let appendixOnly = false;
  let note = null;

  if (resolved.type === 'pdf') {
    const buf = readFileSync(resolved.path);
    acroFieldNames = await extractPdfAcroFieldNames(buf);
    acroCount = acroFieldNames.length;
    basePdfBytes = await fillStaffContractPdfBuffer(buf, renderData, { workflow: wf });
    if (acroCount === 0) {
      appendixOnly = true;
      note =
        'This PDF has no fillable fields detected; sample values are listed in the mapping table. If your PDF uses XFA or non-standard widgets, export a standard AcroForm PDF from your editor.';
    }
  } else if (resolved.type === 'docx') {
    const buf = readFileSync(resolved.path);
    const filled = renderDocxTemplateBuffer(buf, renderData);
    const pdfBuf = convertDocxToPdf(filled);
    if (!pdfBuf) {
      throw new Error('DOCX could not be converted to PDF on this server; use the merge table and download the Word file from disk to preview.');
    }
    basePdfBytes = pdfBuf;
    acroCount = 0;
  } else if (resolved.type === 'image') {
    const img = readFileSync(resolved.path);
    basePdfBytes = await embedRasterImageAsSinglePagePdf(img, resolved.path);
    appendixOnly = true;
    note = 'Image template: one page is the artwork; merge values are listed in the appendix (no text overlay yet).';
    acroCount = 0;
  } else {
    throw new Error('Unsupported template type.');
  }

  const mappingRows = buildFullFieldMappingRows(contractFieldMap || {}, renderData, acroFieldNames, wf);

  const outDoc = await PDFDocument.create();
  await appendFieldMappingPages(outDoc, mappingRows, { appendixOnly });

  const templateDoc = await PDFDocument.load(basePdfBytes);
  const copiedPages = await outDoc.copyPages(templateDoc, templateDoc.getPageIndices());
  for (const p of copiedPages) outDoc.addPage(p);

  const out = await outDoc.save();
  return {
    pdfBuffer: Buffer.from(out),
    acro_field_count: acroCount,
    appendix_only: appendixOnly,
    note,
    mapping_rows: mappingRows
  };
}
