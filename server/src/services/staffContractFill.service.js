/**
 * Fills organisation "staff onboarding" custom templates (Forms → Staff tab) with staff + intake data.
 * Supports Word (.docx) merge tags and PDF AcroForm fields (pdf-lib).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { db } from '../db/index.js';
import { getCustomTemplatePath } from './formTemplatePath.service.js';
import { renderDocxTemplateBuffer, convertDocxToPdf } from './consentForm.service.js';
import { suggestContractFieldMap } from './contractTemplateAnalyze.service.js';
import {
  composeStaffDisplayName,
  composeParticipantLegalName,
  splitParticipantNameFromFull
} from '../../../shared/onboardingFieldRegistry.js';
import { embedRasterImageAsSinglePagePdf } from './imageToPdf.service.js';
import { mergeStaffIntakeForProfile } from './staffOnboardingSync.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

function toSafeString(value) {
  if (value == null) return '';
  if (typeof value === 'object') return Array.isArray(value) ? value.join(', ') : JSON.stringify(value);
  return String(value).trim();
}

function formatDateDDMMYYYY(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return '';
  const s = isoDate.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function parseTemplateMappingJson(value) {
  if (!value) return {};
  try {
    return typeof value === 'object' ? value : JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Apply template-specific placeholder names (from OCR / contract analysis) to merge data keys.
 * @param {Record<string, string>} baseData
 * @param {Record<string, string>|null|undefined} contractFieldMap - placeholder → merge key
 */
export function applyContractPlaceholderMap(baseData, contractFieldMap) {
  const renderData = { ...baseData };
  if (!contractFieldMap || typeof contractFieldMap !== 'object') return renderData;
  for (const [placeholderKey, sourceKey] of Object.entries(contractFieldMap)) {
    const sk = String(sourceKey || '').trim();
    if (!sk || !Object.prototype.hasOwnProperty.call(baseData, sk)) continue;
    renderData[placeholderKey] = baseData[sk];
  }
  return renderData;
}

function workflowKindForFill(options = {}) {
  const w = options.workflow || options.workflowKind || 'participant';
  if (w === 'staff' || w === 'staff_onboarding') return 'staff';
  return 'participant';
}

/**
 * Resolve a PDF AcroForm field name to a merge value (exact key, normalised key, or synonym map).
 * @param {Record<string, string>} mergeData
 * @param {string} fieldName
 * @param {{ workflow?: string, workflowKind?: string }} [options]
 */
export function resolvePdfFieldMergeValue(mergeData, fieldName, options = {}) {
  if (!mergeData || !fieldName) return null;
  const tryKey = (k) => {
    if (k == null || k === '') return null;
    const v = mergeData[k];
    if (v != null && String(v).trim() !== '') return String(v);
    return null;
  };

  let hit = tryKey(fieldName);
  if (hit) return hit;

  const variants = [
    fieldName.replace(/\s+/g, '_'),
    fieldName.replace(/_/g, ' '),
    fieldName
      .replace(/\[\d+\]/g, '')
      .replace(/\.+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
  ];
  for (const variant of variants) {
    hit = tryKey(variant);
    if (hit) return hit;
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(fieldName);
  if (target) {
    for (const [k, val] of Object.entries(mergeData)) {
      if (val == null || String(val).trim() === '') continue;
      if (norm(k) === target) return String(val);
    }
  }

  const suggested = suggestContractFieldMap([fieldName], workflowKindForFill(options));
  const mergeKey = suggested[fieldName];
  if (mergeKey) {
    hit = tryKey(mergeKey);
    if (hit) return hit;
  }

  return null;
}

/**
 * Flat merge map for participant custom PDF/DOCX (intake + profile + plan dates).
 * @param {object} participant - participants row
 * @param {object|null} plan - current plan or null
 * @param {Record<string, string>} intake - participant_intake_fields map
 * @param {Record<string, string>|null} [providerOrg] - provider organisation row (name, abn, address, email, phone) for agreement headers
 */
export function buildParticipantCustomMergeData(participant, plan, intake, providerOrg = null) {
  const i = intake || {};
  const p = participant || {};
  const today = new Date().toISOString().slice(0, 10);
  const split = splitParticipantNameFromFull(p.name || '');
  const first = String(i.first_name || '').trim() || split.first_name;
  const last = String(i.last_name || '').trim() || split.last_name;
  const fullLegal = composeParticipantLegalName(i) || String(p.name || '').trim();
  const addrFromIntake = [i.street_address, i.suburb_city, i.state, i.postcode].filter(Boolean).join(', ');
  const repFirst = String(i.representative_first_name || i.primary_contact_name?.split(' ')[0] || '').trim();
  const repLast = String(i.representative_last_name || '').trim();
  const repFull = String(i.representative_full_name || [repFirst, repLast].filter(Boolean).join(' ') || '').trim();

  const data = {
    today,
    date: today,
    agreement_date: today,
    first_name: first,
    last_name: last,
    full_legal_name: fullLegal,
    name: fullLegal,
    participant_first_name: first,
    participant_last_name: last,
    participant_full_name: fullLegal,
    participant_address: (addrFromIntake || p.address || '').trim(),
    participant_phone: String(i.phone || p.phone || '').trim(),
    participant_email: String(i.email || p.email || '').trim(),
    participant_date_of_birth: String(i.date_of_birth || p.date_of_birth || '').trim().slice(0, 10),
    participant_ndis_number: String(i.ndis_number || p.ndis_number || '').trim(),
    participant_preferred_contact_method: String(i.preferred_contact_method || '').trim(),
    ndis_number: String(i.ndis_number || p.ndis_number || '').trim(),
    email: String(i.email || p.email || '').trim(),
    phone: String(i.phone || p.phone || '').trim(),
    address: (addrFromIntake || p.address || '').trim(),
    date_of_birth: String(i.date_of_birth || p.date_of_birth || '').trim().slice(0, 10),
    plan_start_date: plan?.start_date ? String(plan.start_date).slice(0, 10) : '',
    plan_end_date: plan?.end_date ? String(plan.end_date).slice(0, 10) : '',
    representative_first_name: repFirst,
    representative_last_name: repLast,
    representative_full_name: repFull,
    representative_relationship: String(i.representative_relationship || i.primary_contact_relationship || '').trim(),
    representative_phone: String(i.representative_phone || i.primary_contact_phone || '').trim(),
    representative_email: String(i.representative_email || i.primary_contact_email || '').trim(),
    funding_management_type: String(i.funding_management_type || p.management_type || '').trim(),
    plan_manager_company_name: String(i.plan_manager_company_name || '').trim(),
    plan_manager_invoice_email: String(i.plan_manager_invoice_email || '').trim(),
    organisation_name: '',
    abn: '',
    organisation_address: '',
    organisation_email: '',
    organisation_phone: '',
    organisation_contact_name: ''
  };
  const po = providerOrg && typeof providerOrg === 'object' ? providerOrg : null;
  if (po) {
    if (po.organisation_name != null) data.organisation_name = toSafeString(po.organisation_name);
    if (po.abn != null) data.abn = toSafeString(po.abn);
    if (po.organisation_address != null) data.organisation_address = toSafeString(po.organisation_address);
    if (po.organisation_email != null) data.organisation_email = toSafeString(po.organisation_email);
    if (po.organisation_phone != null) data.organisation_phone = toSafeString(po.organisation_phone);
    if (po.organisation_contact_name != null) data.organisation_contact_name = toSafeString(po.organisation_contact_name);
  }
  if (intake && typeof intake === 'object') {
    for (const [key, value] of Object.entries(intake)) {
      if (!key) continue;
      const safeKey = String(key).replace(/\s+/g, '_').replace(/-/g, '_');
      if (!(safeKey in data)) data[safeKey] = toSafeString(value);
    }
  }
  return data;
}

/**
 * First active custom template for staff onboarding with an uploaded file.
 */
export function getStaffContractTemplate(providerProfileId) {
  if (!providerProfileId) return null;
  const row = db
    .prepare(
      `SELECT id, display_name, template_filename, mapping_json FROM form_templates
       WHERE provider_profile_id = ? AND workflow = 'staff_onboarding' AND form_type = 'custom' AND is_active = 1
       ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, created_at DESC LIMIT 1`
    )
    .get(providerProfileId);
  if (!row) return null;
  const resolved = getCustomTemplatePath(row.id, row.template_filename);
  if (!resolved || !['docx', 'pdf', 'image'].includes(resolved.type)) return null;
  if (!existsSync(resolved.path)) return null;
  const mapping = parseTemplateMappingJson(row.mapping_json);
  return {
    templateId: row.id,
    displayName: row.display_name,
    path: resolved.path,
    type: resolved.type,
    contractFieldMap: mapping.contract_field_map || {}
  };
}

/**
 * Fill PDF AcroForm fields using merge keys (and mapped aliases from contract_field_map).
 * @param {Buffer} pdfBytes
 * @param {Record<string, string>} mergeData - includes standard keys plus any PDF field names set by applyContractPlaceholderMap
 * @param {{ workflow?: string, workflowKind?: string, flatten?: boolean }} [options]
 */
export async function fillStaffContractPdfBuffer(pdfBytes, mergeData, options = {}) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  let form;
  try {
    form = doc.getForm();
  } catch {
    return Buffer.from(await doc.save());
  }

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fields = form.getFields();
  for (const field of fields) {
    const name = field.getName();
    const value = resolvePdfFieldMergeValue(mergeData, name, options);
    if (value == null || value === '') continue;
    const str = String(value);

    try {
      const tf = form.getTextField(name);
      tf.setText(str);
      try {
        tf.updateAppearances(font);
      } catch {
        /* some widgets cannot regenerate appearance */
      }
      continue;
    } catch {
      /* not a text field */
    }

    try {
      const dd = form.getDropdown(name);
      const opts = dd.getOptions();
      let idx = opts.findIndex((o) => String(o).trim() === str.trim());
      if (idx < 0) {
        idx = opts.findIndex((o) => String(o).toLowerCase().includes(str.toLowerCase()));
      }
      if (idx >= 0) dd.select(idx);
      continue;
    } catch {
      /* not dropdown */
    }

    try {
      form.getRadioGroup(name).select(str);
      continue;
    } catch {
      /* not radio */
    }

    try {
      const cb = form.getCheckBox(name);
      if (/^(yes|true|1|x|checked|on)$/i.test(str.trim())) cb.check();
    } catch {
      /* skip */
    }
  }

  try {
    form.updateFieldAppearances(font);
  } catch {
    /* optional whole-form pass */
  }

  if (options.flatten !== false) {
    try {
      form.flatten();
    } catch {
      /* leave editable if flatten fails */
    }
  }
  return Buffer.from(await doc.save());
}

/**
 * @param {object} staffRow - staff.* columns used in HR docs
 * @param {Record<string, string>} intakeMap - staff_intake_fields flat map
 * @param {{ organisationName?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildStaffContractMergeData(staffRow, intakeMap, options = {}) {
  const merged = mergeStaffIntakeForProfile(intakeMap, staffRow?.name || '');
  const today = new Date().toISOString().slice(0, 10);
  const employeeName =
    composeStaffDisplayName({
      first_name: merged.first_name,
      last_name: merged.last_name,
      full_legal_name: merged.full_legal_name,
      full_name: merged.full_name
    }) ||
    staffRow?.name ||
    '';

  const hourly =
    merged.hourly_rate != null && merged.hourly_rate !== ''
      ? merged.hourly_rate
      : staffRow?.hourly_rate != null
        ? String(staffRow.hourly_rate)
        : '';

  const data = {
    date: today,
    today,
    agreement_date: today,
    acceptance_deadline_date: merged.acceptance_deadline_date || '',
    organisation_name: options.organisationName || '',
    employer_name: options.organisationName || '',
    staff_name: employeeName,
    employee_name: employeeName,
    name: employeeName,
    first_name: merged.first_name,
    last_name: merged.last_name,
    staff_first_name: merged.first_name,
    staff_last_name: merged.last_name,
    staff_full_name: employeeName,
    email: staffRow?.email || '',
    phone: merged.phone || staffRow?.phone || '',
    address: merged.address || staffRow?.address || '',
    staff_address: merged.address || staffRow?.address || '',
    date_of_birth: formatDateDDMMYYYY((merged.date_of_birth || staffRow?.date_of_birth || '').toString().slice(0, 10)),
    date_of_birth_iso: (merged.date_of_birth || staffRow?.date_of_birth || '').toString().slice(0, 10),
    role: merged.role || staffRow?.role || '',
    employment_type: merged.employment_type || staffRow?.employment_type || '',
    hourly_rate: hourly,
    staff_hourly_rate: hourly,
    pay_frequency: merged.pay_frequency || staffRow?.pay_frequency || '',
    staff_pay_frequency: merged.pay_frequency || staffRow?.pay_frequency || '',
    governing_state: merged.governing_state || staffRow?.governing_state || '',
    staff_governing_state: merged.governing_state || staffRow?.governing_state || '',
    supervisor_name: merged.supervisor_name || staffRow?.supervisor_name || '',
    staff_supervisor_name: merged.supervisor_name || staffRow?.supervisor_name || '',
    abn: merged.abn || staffRow?.abn || '',
    contractor_abn: merged.abn || staffRow?.abn || '',
    contractor_full_name: employeeName,
    contractor_address: merged.address || staffRow?.address || '',
    contractor_services_fee: hourly,
    contractor_insurance_min: merged.contractor_insurance_min || '',
    contractor_governing_state: merged.governing_state || staffRow?.governing_state || '',
    emergency_contact_name: merged.emergency_contact_name || staffRow?.emergency_contact_name || '',
    emergency_contact_phone: merged.emergency_contact_phone || staffRow?.emergency_contact_phone || ''
  };

  if (intakeMap && typeof intakeMap === 'object') {
    for (const [key, value] of Object.entries(intakeMap)) {
      if (!key) continue;
      const safeKey = String(key).replace(/\s+/g, '_').replace(/-/g, '_');
      if (!(safeKey in data)) data[safeKey] = toSafeString(value);
    }
  }

  return data;
}

/**
 * @returns {Promise<{ docx: Buffer|null, pdf: Buffer|null, templateMeta: { displayName: string } | null }>}
 */
export async function generateStaffContractBuffers(staffRow, intakeMap, providerProfileId) {
  const tpl = getStaffContractTemplate(providerProfileId);
  if (!tpl) {
    return { docx: null, pdf: null, templateMeta: null };
  }

  let orgName = '';
  const pp = db.prepare('SELECT organisation_id FROM provider_profiles WHERE id = ?').get(providerProfileId);
  if (pp?.organisation_id) {
    const org = db.prepare('SELECT name FROM organisations WHERE id = ?').get(pp.organisation_id);
    orgName = org?.name || '';
  }

  const baseData = buildStaffContractMergeData(staffRow, intakeMap, { organisationName: orgName });
  const data = applyContractPlaceholderMap(baseData, tpl.contractFieldMap);
  const templateMeta = { displayName: tpl.displayName || 'Employment contract' };

  if (tpl.type === 'pdf') {
    const pdfBytes = readFileSync(tpl.path);
    const pdf = await fillStaffContractPdfBuffer(pdfBytes, data, { workflow: 'staff_onboarding' });
    return { docx: null, pdf, templateMeta };
  }

  if (tpl.type === 'image') {
    const imgBytes = readFileSync(tpl.path);
    const pdfBytes = await embedRasterImageAsSinglePagePdf(imgBytes, tpl.path);
    const pdf = await fillStaffContractPdfBuffer(pdfBytes, data, { workflow: 'staff_onboarding' });
    return { docx: null, pdf, templateMeta };
  }

  const templateBuf = readFileSync(tpl.path);
  const docx = renderDocxTemplateBuffer(templateBuf, data);
  const pdf = convertDocxToPdf(docx);
  return { docx, pdf, templateMeta };
}

const contractsDir = join(projectRoot, 'data', 'onboarding', 'staff-contracts');

/** Persist filled contract for audit (.pdf or .docx). */
export function persistStaffContractFile(staffId, buffer, ext = 'pdf') {
  if (!buffer?.length) return null;
  const dir = join(contractsDir, staffId);
  mkdirSync(dir, { recursive: true });
  const safeExt = ext === 'docx' ? 'docx' : 'pdf';
  const name = `employment-contract-${Date.now()}.${safeExt}`;
  const abs = join(dir, name);
  writeFileSync(abs, buffer);
  return abs;
}

/** Persist legacy .docx merge output for audit (same as persistStaffContractFile(..., 'docx')). */
export function persistStaffContractDocx(staffId, docxBuffer) {
  return persistStaffContractFile(staffId, docxBuffer, 'docx');
}
