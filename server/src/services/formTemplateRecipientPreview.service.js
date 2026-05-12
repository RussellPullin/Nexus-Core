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
  fillStaffContractPdfBuffer
} from './staffContractFill.service.js';
import { renderDocxTemplateBuffer, convertDocxToPdf } from './consentForm.service.js';
import { embedRasterImageAsSinglePagePdf } from './imageToPdf.service.js';
import { extractPdfAcroFieldNames } from './contractTemplateAnalyze.service.js';
import { participantEmptyIntake } from '../../../shared/onboardingFieldRegistry.js';

function wrapChunks(str, maxLen) {
  const s = String(str ?? '');
  if (!s) return [''];
  const lines = [];
  let i = 0;
  while (i < s.length) {
    lines.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return lines;
}

/**
 * @param {Record<string, string>} contractFieldMap
 * @param {Record<string, string>} renderData
 */
export function buildMergePreviewRows(contractFieldMap, renderData) {
  const map = contractFieldMap && typeof contractFieldMap === 'object' ? contractFieldMap : {};
  const rows = [];
  for (const [placeholder, mergeKey] of Object.entries(map)) {
    const sk = String(mergeKey || '').trim();
    if (!sk) continue;
    const v =
      renderData[placeholder] != null && renderData[placeholder] !== ''
        ? String(renderData[placeholder])
        : renderData[sk] != null
          ? String(renderData[sk])
          : '';
    rows.push({
      placeholder: String(placeholder),
      merge_key: sk,
      sample_value: v
    });
  }
  rows.sort((a, b) => a.placeholder.localeCompare(b.placeholder));
  return rows;
}

function participantPreviewFixture() {
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

  const { participant, plan, intake } = participantPreviewFixture();
  const base = buildParticipantCustomMergeData(participant, plan, intake, providerOrg);
  return applyContractPlaceholderMap(base, contractFieldMap || {});
}

/**
 * @returns {Promise<{ pdfBuffer: Buffer, acro_field_count: number, appendix_only: boolean, note: string | null }>}
 */
export async function buildRecipientPreviewPdfBuffer(resolved, workflow, contractFieldMap, organisation) {
  const wf = workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';
  const renderData = buildSampleRenderData(wf, contractFieldMap, organisation);
  const rows = buildMergePreviewRows(contractFieldMap || {}, renderData);
  const appendixLines = [
    'Sample data preview (fictitious) — appendix for administrators.',
    'Placeholder / PDF field name → merge key: sample value as merged for onboarding.',
    '',
    ...rows.map((r) => `${r.placeholder}  →  ${r.merge_key}:  ${r.sample_value || '(empty)'}`)
  ];

  let basePdfBytes;
  let acroCount = 0;
  let appendixOnly = false;
  let note = null;

  if (resolved.type === 'pdf') {
    const buf = readFileSync(resolved.path);
    acroCount = (await extractPdfAcroFieldNames(buf)).length;
    if (acroCount > 0) {
      basePdfBytes = await fillStaffContractPdfBuffer(buf, renderData);
    } else {
      basePdfBytes = buf;
      appendixOnly = true;
      note =
        'This PDF has no fillable fields; values cannot be drawn on the original pages. The appendix lists what would merge for Word/fillable PDFs or future overlays.';
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

  const pdfDoc = await PDFDocument.load(basePdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pageW = 595;
  const pageH = 842;
  const margin = 44;
  const fontSize = 8.2;
  const lineH = 10;
  const maxChars = 92;

  let page = pdfDoc.addPage([pageW, pageH]);
  let y = pageH - margin;
  const title = appendixOnly ? 'Sample merge values (flat template)' : 'Sample merge values (reference)';
  page.drawText(title, { x: margin, y: y - 12, size: 11, font: fontBold });
  y -= 26;

  const flatLines = appendixLines.flatMap((line) => wrapChunks(line, maxChars));
  for (const line of flatLines) {
    if (y < margin + 24) {
      page = pdfDoc.addPage([pageW, pageH]);
      y = pageH - margin;
    }
    page.drawText(line, { x: margin, y, size: fontSize, font });
    y -= lineH;
  }

  const out = await pdfDoc.save();
  return {
    pdfBuffer: Buffer.from(out),
    acro_field_count: acroCount,
    appendix_only: appendixOnly,
    note
  };
}
