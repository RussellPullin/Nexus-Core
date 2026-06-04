/**
 * Signer-view preview for custom form templates: fields labelled with merge names
 * (admin check before Dropbox Sign — flattened so labels are visible in all PDF viewers).
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { suggestContractFieldMap, extractPdfAcroFieldNames } from './contractTemplateAnalyze.service.js';
import { defaultCoverUnderlying } from './formTemplateSigningLayout.service.js';

function fieldCoversUnderlying(f) {
  if (f.cover_underlying === false) return false;
  if (f.cover_underlying === true) return true;
  return defaultCoverUnderlying(f.type, f.api_id, f.merge_key);
}
import { participantFieldLabels, staffFieldLabels } from '../../../shared/onboardingFieldRegistry.js';

const ORG_MERGE_LABELS = {
  organisation_name: 'Organisation name',
  abn: 'ABN',
  organisation_address: 'Organisation address',
  organisation_email: 'Organisation email',
  organisation_phone: 'Organisation phone',
  organisation_contact_name: 'Organisation contact',
  employer_name: 'Employer name',
  staff_name: 'Staff name',
  employee_name: 'Employee name',
  name: 'Full name',
  today: 'Date',
  date: 'Date',
  plan_start_date: 'Plan start date',
  plan_end_date: 'Plan end date',
  scheduled_review_date: 'Scheduled review date',
  plan_manager_company_name: 'Plan manager company',
  plan_manager_invoice_email: 'Plan manager invoice email'
};

function workflowKind(workflow) {
  return workflow === 'staff_onboarding' ? 'staff' : 'participant';
}

function toPdfSafeText(str) {
  return String(str ?? '')
    .replace(/\u2192/g, '->')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\t\n\r\x20-\x7E]/g, '?');
}

/** @param {string} mergeKey @param {'participant_onboarding'|'staff_onboarding'} workflow */
export function mergeKeyToHumanLabel(mergeKey, workflow) {
  const k = String(mergeKey || '').trim();
  if (!k) return 'Unmapped field';
  const base =
    workflow === 'staff_onboarding'
      ? { ...staffFieldLabels(), ...ORG_MERGE_LABELS }
      : { ...participantFieldLabels(), ...ORG_MERGE_LABELS };
  if (base[k]) return base[k];
  return k
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function resolveMergeKeyForField(fieldName, contractFieldMap, workflow) {
  const map = contractFieldMap && typeof contractFieldMap === 'object' ? contractFieldMap : {};
  if (map[fieldName]) return String(map[fieldName]).trim();

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(fieldName);
  for (const [k, v] of Object.entries(map)) {
    if (norm(k) === target && v) return String(v).trim();
  }

  const suggested = suggestContractFieldMap([fieldName], workflowKind(workflow));
  return suggested[fieldName] ? String(suggested[fieldName]).trim() : '';
}

/**
 * Build map keyed by actual PDF AcroForm field names (not OCR-only labels).
 */
export function buildEffectiveAcroFieldMap(contractFieldMap, acroFieldNames, workflow) {
  const effective = {};
  const wf = workflowKind(workflow);
  for (const rawName of acroFieldNames || []) {
    const name = String(rawName || '').trim();
    if (!name) continue;
    effective[name] = resolveMergeKeyForField(name, contractFieldMap, workflow);
  }
  return effective;
}

/**
 * @param {Buffer} pdfBytes
 * @param {Record<string, string>|null|undefined} contractFieldMap
 * @param {'participant_onboarding'|'staff_onboarding'} workflow
 * @param {import('./formTemplateSigningLayout.service.js').SigningLayout|null|undefined} [signingLayout]
 * @returns {Promise<{ pdfBuffer: Buffer, acro_field_count: number, labelled_count: number, layout_field_count?: number }>}
 */
export async function buildSignerPreviewPdfBuffer(pdfBytes, contractFieldMap, workflow, signingLayout = null) {
  const wf = workflow === 'staff_onboarding' ? 'staff_onboarding' : 'participant_onboarding';

  if (signingLayout?.fields?.length) {
    return buildLayoutOverlayPreview(pdfBytes, signingLayout, wf);
  }

  const acroFieldNames = await extractPdfAcroFieldNames(pdfBytes);
  const effectiveMap = buildEffectiveAcroFieldMap(contractFieldMap, acroFieldNames, wf);

  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  let form;
  try {
    form = doc.getForm();
  } catch {
    return { pdfBuffer: Buffer.from(pdfBytes), acro_field_count: 0, labelled_count: 0 };
  }

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fields = form.getFields();
  let labelledCount = 0;

  for (const field of fields) {
    const name = field.getName();
    const mergeKey = effectiveMap[name] ?? resolveMergeKeyForField(name, contractFieldMap, wf);
    const label = toPdfSafeText(mergeKeyToHumanLabel(mergeKey, wf));

    let labelled = false;
    try {
      const tf = form.getTextField(name);
      tf.setText(label);
      try {
        tf.updateAppearances(font);
      } catch {
        /* continue */
      }
      labelled = true;
      labelledCount += 1;
      continue;
    } catch {
      /* not text */
    }

    try {
      const dd = form.getDropdown(name);
      const opts = dd.getOptions();
      const idx = opts.findIndex((o) => String(o).toLowerCase() === label.toLowerCase());
      if (idx >= 0) dd.select(idx);
      else if (opts.length) dd.select(0);
      labelledCount += 1;
      labelled = true;
      continue;
    } catch {
      /* not dropdown */
    }

    try {
      form.getCheckBox(name);
      labelledCount += 1;
    } catch {
      /* other widget types — still counted if we had a mapping attempt */
      if (mergeKey) labelledCount += 1;
    }
  }

  try {
    form.updateFieldAppearances(font);
  } catch {
    /* optional */
  }

  // Flatten so labels appear in browser PDF viewers (field widgets otherwise hide page-drawn content).
  try {
    form.flatten();
  } catch {
    /* keep editable if flatten fails */
  }

  if (acroFieldNames.length === 0 && Object.keys(contractFieldMap || {}).length > 0) {
    const page = doc.addPage([595, 842]);
    const margin = 48;
    let y = 842 - margin;
    page.drawText(toPdfSafeText('No fillable PDF fields detected'), {
      x: margin,
      y: y - 14,
      size: 14,
      font
    });
    y -= 36;
    page.drawText(
      toPdfSafeText(
        'This template has mapped labels from document text but no AcroForm fields. Export from your editor as a PDF with fillable form fields, then re-upload.'
      ),
      { x: margin, y, size: 10, font, maxWidth: 500, lineHeight: 12, color: rgb(0.35, 0.35, 0.35) }
    );
  }

  return {
    pdfBuffer: Buffer.from(await doc.save()),
    acro_field_count: acroFieldNames.length,
    labelled_count: labelledCount
  };
}

async function buildLayoutOverlayPreview(pdfBytes, signingLayout, workflow) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  let labelledCount = 0;

  for (const f of signingLayout.fields) {
    const page = pages[(f.page || 1) - 1];
    if (!page) continue;
    const pageH = page.getHeight();
    const drawY = pageH - f.y - f.height;
    const label = toPdfSafeText(f.label || mergeKeyToHumanLabel(f.merge_key, workflow));
    const typeHint = f.type && f.type !== 'text' ? ` (${f.type})` : '';
    const covers = fieldCoversUnderlying(f);

    if (covers) {
      page.drawRectangle({
        x: f.x,
        y: drawY,
        width: f.width,
        height: f.height,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.15, 0.39, 0.92),
        borderWidth: 1
      });
      page.drawText(`${label}${typeHint}`, {
        x: f.x + 3,
        y: drawY + Math.max(2, f.height - 11),
        size: Math.min(9, Math.max(7, f.height - 6)),
        font,
        maxWidth: Math.max(20, f.width - 6),
        color: rgb(0.1, 0.2, 0.45)
      });
    } else {
      page.drawRectangle({
        x: f.x,
        y: drawY,
        width: f.width,
        height: f.height,
        borderColor: rgb(0.15, 0.39, 0.92),
        borderWidth: 1.5,
        color: rgb(0.88, 0.94, 1),
        opacity: 0.35
      });
      page.drawText(`${label}${typeHint}`, {
        x: f.x + 3,
        y: drawY + Math.max(2, f.height - 11),
        size: Math.min(9, Math.max(7, f.height - 6)),
        font,
        maxWidth: Math.max(20, f.width - 6),
        color: rgb(0.1, 0.2, 0.45)
      });
    }
    labelledCount += 1;
  }

  return {
    pdfBuffer: Buffer.from(await doc.save()),
    acro_field_count: 0,
    labelled_count: labelledCount,
    layout_field_count: signingLayout.fields.length
  };
}
