/**
 * Fills organisation "staff onboarding" custom templates (Forms → Staff tab) with staff + intake data.
 * Supports Word (.docx) merge tags and PDF AcroForm fields (pdf-lib).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import { db } from '../db/index.js';
import { getCustomTemplatePath } from './formTemplatePath.service.js';
import { renderDocxTemplateBuffer, convertDocxToPdf } from './consentForm.service.js';
import {
  composeStaffDisplayName,
  composeParticipantLegalName,
  splitParticipantNameFromFull
} from '../../../shared/onboardingFieldRegistry.js';
import { embedRasterImageAsSinglePagePdf } from './imageToPdf.service.js';

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
  const data = {
    today,
    date: today,
    first_name: first,
    last_name: last,
    full_legal_name: fullLegal,
    name: fullLegal,
    ndis_number: String(i.ndis_number || p.ndis_number || '').trim(),
    email: String(i.email || p.email || '').trim(),
    phone: String(i.phone || p.phone || '').trim(),
    address: (addrFromIntake || p.address || '').trim(),
    date_of_birth: String(i.date_of_birth || p.date_of_birth || '').trim().slice(0, 10),
    plan_start_date: plan?.start_date ? String(plan.start_date).slice(0, 10) : '',
    plan_end_date: plan?.end_date ? String(plan.end_date).slice(0, 10) : '',
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
 */
export async function fillStaffContractPdfBuffer(pdfBytes, mergeData) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  let form;
  try {
    form = doc.getForm();
  } catch {
    return Buffer.from(await doc.save());
  }

  const fields = form.getFields();
  for (const field of fields) {
    const name = field.getName();
    const value = mergeData[name];
    if (value == null || value === '') continue;
    const str = String(value);

    try {
      form.getTextField(name).setText(str);
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
    } catch {
      /* skip */
    }
  }

  try {
    form.flatten();
  } catch {
    /* leave editable if flatten fails */
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
    organisation_name: options.organisationName || '',
    employer_name: options.organisationName || '',
    staff_name: employeeName,
    employee_name: employeeName,
    name: employeeName,
    email: staffRow?.email || '',
    phone: merged.phone || staffRow?.phone || '',
    address: merged.address || staffRow?.address || '',
    date_of_birth: formatDateDDMMYYYY((merged.date_of_birth || staffRow?.date_of_birth || '').toString().slice(0, 10)),
    date_of_birth_iso: (merged.date_of_birth || staffRow?.date_of_birth || '').toString().slice(0, 10),
    role: merged.role || staffRow?.role || '',
    employment_type: merged.employment_type || staffRow?.employment_type || '',
    hourly_rate: hourly,
    abn: merged.abn || staffRow?.abn || '',
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
    const pdf = await fillStaffContractPdfBuffer(pdfBytes, data);
    return { docx: null, pdf, templateMeta };
  }

  if (tpl.type === 'image') {
    const imgBytes = readFileSync(tpl.path);
    const pdfBytes = await embedRasterImageAsSinglePagePdf(imgBytes, tpl.path);
    const pdf = await fillStaffContractPdfBuffer(pdfBytes, data);
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
