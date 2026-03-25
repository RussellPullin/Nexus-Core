/**
 * Form Fill Service - fills PDF and Word templates with participant and intake data.
 * Service Agreement: PDF with AcroForm fields
 * Support Plan: PDF or Word (when template added)
 * Privacy Consent: Word (handled by consentForm.service.js)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { getServiceAgreementTemplatePath, getSupportPlanTemplatePath } from './formTemplatePath.service.js';
import { db } from '../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** NDIS support category ID to name (for derived schedule/support description when intake has no service_schedule). */
const SUPPORT_CATEGORY_NAMES = {
  '01': 'Assistance with Daily Life',
  '02': 'Transport',
  '03': 'Consumables',
  '04': 'Assistance with Social, Economic and Community Participation',
  '05': 'Assistive Technology',
  '06': 'Home Modifications and SDA',
  '07': 'Support Coordination',
  '08': 'Improved Living Arrangements',
  '09': 'Increased Social and Community Participation',
  '10': 'Finding and Keeping a Job',
  '11': 'Improved Relationships',
  '12': 'Improved Health and Wellbeing',
  '13': 'Improved Learning',
  '14': 'Improved Life Choices',
  '15': 'Improved Daily Living Skills'
};

function parseIntakeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? p : [];
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

/** Parse service_schedule_rows from intake (JSON string or array) – matches Service Agreement schedule boxes. */
function parseScheduleRows(intake) {
  const raw = intake.service_schedule_rows;
  const mapRow = (r) => ({
    description: (r.description ?? '').toString().trim(),
    hours: (r.hours ?? '').toString().trim(),
    rate: (r.rate ?? '').toString().trim(),
    ratio: (r.ratio ?? '').toString().trim(),
    budget: (r.budget ?? '').toString().trim()
  });
  const hasContent = (r) => r.description || r.hours || r.rate || r.budget;
  if (Array.isArray(raw)) {
    return raw.map(mapRow).filter(hasContent);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (!Array.isArray(p)) return [];
      return p.map(mapRow).filter(hasContent);
    } catch {
      return [];
    }
  }
  return [];
}

/** Format ISO date (yyyy-mm-dd) as dd/mm/yyyy for forms. */
function formatDateDDMMYYYY(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return '';
  const s = isoDate.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Default hours per week per support category when not specified. */
const DEFAULT_HOURS_PER_WEEK = 2;
/** Provider travel hours per week (always included). */
const PROVIDER_TRAVEL_HOURS_PER_WEEK = 0.5;

/**
 * Build detailed service and supports schedule with hourly rate, duration, appointment times, annual total.
 * Uses weekday hourly rate; always includes provider travel; includes non-provider travel (km) for 02/04 when applicable.
 * @param {{ services_required?: string|string[] }} intake
 * @param {object} database - db instance for ndis_line_items queries
 * @returns {string}
 */
function buildDetailedSchedule(intake, database) {
  const servicesRequired = parseIntakeArray(intake.services_required);
  if (!servicesRequired.length || !database) return '';

  const lines = [];
  let totalAnnual = 0;
  let firstHourlyRate = 0;

  const allItems = database.prepare(`
    SELECT id, support_item_number, support_category, description, rate, rate_remote, rate_very_remote, unit, rate_type
    FROM ndis_line_items
    WHERE (unit = 'hour' OR unit = 'hr') AND rate > 0
  `).all();

  const byCategory = {};
  for (const it of allItems) {
    const sc = it.support_category || (it.support_item_number && it.support_item_number.split('_')[0]);
    if (sc && /^\d{2}$/.test(sc)) {
      if (!byCategory[sc]) byCategory[sc] = [];
      byCategory[sc].push(it);
    }
  }

  const getWeekdayRate = (item) => Number(item.rate_remote ?? item.rate_very_remote ?? item.rate) || 0;
  const preferWeekday = (items) => items.filter(i => !i.rate_type || String(i.rate_type).toLowerCase() === 'weekday');

  for (const catId of servicesRequired) {
    const items = byCategory[catId] || [];
    const preferred = preferWeekday(items).length ? preferWeekday(items) : items;
    const item = preferred[0] || items[0];
    if (!item) continue;
    const rate = getWeekdayRate(item);
    const name = SUPPORT_CATEGORY_NAMES[catId] || `Category ${catId}`;
    const hrsPerWeek = DEFAULT_HOURS_PER_WEEK;
    const annual = hrsPerWeek * 52 * rate;
    totalAnnual += annual;
    if (firstHourlyRate === 0) firstHourlyRate = rate;
    lines.push(`${name}: ${hrsPerWeek} hrs/week, $${rate.toFixed(2)}/hr, appointment times as agreed. Annual total: $${annual.toFixed(2)}`);
  }

  if (firstHourlyRate > 0) {
    const travelAnnual = PROVIDER_TRAVEL_HOURS_PER_WEEK * 52 * firstHourlyRate;
    totalAnnual += travelAnnual;
    lines.push(`Provider travel: ${PROVIDER_TRAVEL_HOURS_PER_WEEK} hrs/week, $${firstHourlyRate.toFixed(2)}/hr. Annual total: $${travelAnnual.toFixed(2)}`);
  }

  const travelCats = servicesRequired.filter(c => c === '02' || c === '04');
  if (travelCats.length > 0) {
    const cat = travelCats[0];
    const kmItems = database.prepare(`
      SELECT rate, support_item_number FROM ndis_line_items
      WHERE (support_category = ? OR support_item_number LIKE ?) AND (unit = 'km' OR unit = 'kilometre')
      LIMIT 1
    `).get(cat, cat + '_%');
    if (kmItems && Number(kmItems.rate) > 0) {
      lines.push(`Non-provider travel (with client): $${Number(kmItems.rate).toFixed(2)}/km, as required.`);
    }
  }

  lines.push(`Total estimated annual cost: $${totalAnnual.toFixed(2)}`);
  return lines.join('\n');
}

/**
 * Decode a data URL (e.g. from signature_data) to a buffer. Returns null if invalid.
 */
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
}

/**
 * Embed coordinator signature image on the first page of the PDF (bottom-right).
 * @param {PDFDocument} doc - pdf-lib document
 * @param {string} coordinatorSignatureDataUrl - data URL (e.g. data:image/png;base64,...)
 */
async function embedCoordinatorSignature(doc, coordinatorSignatureDataUrl) {
  const buf = dataUrlToBuffer(coordinatorSignatureDataUrl);
  if (!buf) return;
  const pages = doc.getPages();
  if (pages.length === 0) return;
  const page = pages[0];
  const { width, height } = page.getSize();
  const sigWidth = 100;
  const sigHeight = 40;
  const padding = 30;
  const x = width - sigWidth - padding;
  const y = padding;
  try {
    const image = await doc.embedPng(buf);
    page.drawImage(image, { x, y, width: sigWidth, height: sigHeight });
  } catch (err) {
    console.warn('Could not embed coordinator signature in PDF:', err.message);
  }
}

export { getServiceAgreementTemplatePath, getSupportPlanTemplatePath };

/**
 * Build data object for form filling from participant, plan, intake.
 * @param {object} [context] - optional { db } for building detailed schedule from NDIS line items
 */
function buildFillData(participant = {}, plan = null, intake = {}, context = {}) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const addrParts = [intake.street_address, intake.suburb_city, intake.state, intake.postcode].filter(Boolean);
  const addr = participant.address || addrParts.join(', ') || intake.address || '';
  const streetOnly = (intake.street_address || '').trim() || (addr && addr.split(',')[0].trim()) || addr;

  let reviewDate = todayIso;
  if (intake.preferred_start_date) {
    const d = new Date(intake.preferred_start_date);
    d.setFullYear(d.getFullYear() + 1);
    reviewDate = d.toISOString().slice(0, 10);
  }
  const fundingMgmt = intake.funding_management_type ||
    (participant.management_type === 'plan' ? 'Plan' : participant.management_type === 'ndia' ? 'NDIA' : participant.management_type === 'self' ? 'Self' : '');

  const servicesRequired = parseIntakeArray(intake.services_required);
  const ndiaManaged = parseIntakeArray(intake.ndia_managed_services);
  const planManaged = parseIntakeArray(intake.plan_managed_services);
  const parts = [];
  for (const id of servicesRequired) {
    const name = SUPPORT_CATEGORY_NAMES[id] || id;
    let mgmt = 'Self';
    if (ndiaManaged.includes(id)) mgmt = 'NDIA';
    else if (planManaged.includes(id)) mgmt = 'Plan';
    parts.push(`${id} – ${name} (${mgmt})`);
  }
  const support_categories_description = parts.length ? `Support categories: ${parts.join('; ')}` : '';

  const scheduleRows = parseScheduleRows(intake);
  let service_schedule;
  if (scheduleRows.length > 0) {
    service_schedule = scheduleRows.map((r) => [r.description, r.hours, r.rate, r.ratio, r.budget].filter(Boolean).join(' \u2013 ')).join('\n');
  } else {
    const userSchedule = (intake.service_schedule || '').toString().trim();
    const detailedSchedule = context.db ? buildDetailedSchedule(intake, context.db) : '';
    service_schedule = userSchedule || detailedSchedule || support_categories_description;
  }
  const plan_budget_amount = (intake.plan_budget_amount || '').toString().trim();

  const dobRaw = (participant.date_of_birth || intake.date_of_birth || '').toString().slice(0, 10);
  const planStartRaw = (plan?.start_date || intake.plan_start_date || '').toString().slice(0, 10);
  const planEndRaw = (plan?.end_date || intake.plan_end_date || '').toString().slice(0, 10);
  const serviceStartRaw = (intake.preferred_start_date || todayIso).toString().slice(0, 10);

  return {
    participant_name: participant.name || intake.full_legal_name || '',
    participant_email: participant.email || intake.email || '',
    participant_phone: participant.phone || intake.phone || '',
    participant_address: streetOnly,
    participant_dob: formatDateDDMMYYYY(dobRaw) || dobRaw,
    ndis_number: participant.ndis_number || intake.ndis_number || '',
    plan_start: formatDateDDMMYYYY(planStartRaw) || planStartRaw,
    plan_end: formatDateDDMMYYYY(planEndRaw) || planEndRaw,
    primary_contact_name: intake.primary_contact_name || '',
    primary_contact_relationship: intake.primary_contact_relationship || '',
    primary_contact_phone: intake.primary_contact_phone || participant.parent_guardian_phone || '',
    primary_contact_email: intake.primary_contact_email || participant.parent_guardian_email || '',
    funding_management: fundingMgmt,
    service_start_date: formatDateDDMMYYYY(serviceStartRaw) || serviceStartRaw,
    scheduled_review_date: formatDateDDMMYYYY(reviewDate) || reviewDate,
    preferred_contact_method: intake.preferred_contact_method || '',
    street_address: (intake.street_address || '').trim(),
    suburb_city: (intake.suburb_city || '').trim(),
    state: (intake.state || '').trim(),
    postcode: (intake.postcode || '').trim(),
    preferred_name: (intake.preferred_name || '').trim(),
    service_schedule,
    scheduleRows,
    support_categories_description,
    plan_budget_amount,
    goals_and_outcomes: intake.goals_and_outcomes || '',
    support_needs: intake.support_needs || '',
    today: formatDateDDMMYYYY(todayIso) || todayIso,
    execution_date: formatDateDDMMYYYY(todayIso) || todayIso
  };
}

/**
 * Fill Service Agreement PDF with participant and intake data.
 * @param {object} [options] - optional { coordinatorSignatureDataUrl }
 * @returns {Buffer} Filled PDF buffer
 */
export async function fillServiceAgreement(participant = {}, plan = null, intake = {}, options = {}) {
  const template = getServiceAgreementTemplatePath();
  if (!template) throw new Error('Service Agreement template not found. Add a PDF or .docx to data/forms/templates/service-agreement/');

  if (template.type === 'docx') {
    return fillWordTemplate(template.path, participant, plan, intake, options);
  }

  const context = options.db ? { db: options.db } : {};
  const data = buildFillData(participant, plan, intake, context);
  const pdfBytes = readFileSync(template.path);
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();

  const fieldMap = {
    client_full_name: data.participant_name,
    client_preferred_name: data.preferred_name,
    client_phone: data.participant_phone,
    client_email: data.participant_email,
    client_dob: data.participant_dob,
    client_address: data.participant_address,
    client_suburb: data.suburb_city,
    client_state: data.state,
    client_postcode: data.postcode,
    client_ndis_number: data.ndis_number,
    ndis_plan_start: data.plan_start,
    ndis_plan_end: data.plan_end,
    primary_contact_name: data.primary_contact_name,
    primary_contact_relationship: data.primary_contact_relationship,
    primary_contact_phone: data.primary_contact_phone,
    primary_contact_email: data.primary_contact_email,
    funding_management: data.funding_management,
    service_start_date: data.service_start_date,
    scheduled_review_date: data.scheduled_review_date,
    preferred_contact_method: data.preferred_contact_method,
    execution_date: data.today,
    plan_budget: data.plan_budget_amount,
    budget_amount: data.plan_budget_amount,
    total_budget: data.plan_budget_amount
  };

  // Map intake schedule rows to Service Agreement boxes (schedule_1_description, schedule_1_hours, schedule_1_rate, schedule_1_budget, schedule_2_*, …)
  const scheduleRows = data.scheduleRows || [];
  if (scheduleRows.length > 0) {
    scheduleRows.forEach((row, i) => {
      const n = i + 1;
      const descWithRatio = row.ratio ? `${row.description || ''} (ratio ${row.ratio})`.trim() : (row.description || '');
      fieldMap[`schedule_${n}_description`] = descWithRatio;
      fieldMap[`schedule_${n}_hours`] = row.hours || '';
      fieldMap[`schedule_${n}_rate`] = row.rate || '';
      fieldMap[`schedule_${n}_budget`] = row.budget || (n === 1 ? data.plan_budget_amount : '');
    });
  } else {
    fieldMap.schedule_1_description = data.service_schedule;
    fieldMap.schedule_1_budget = data.plan_budget_amount;
  }

  const servicesRequired = parseIntakeArray(intake.services_required);

  const fields = form.getFields();
  for (const field of fields) {
    const name = field.getName();
    const value = fieldMap[name];

    const supportMatch = name.match(/^support_(\d{2})$/);
    if (supportMatch) {
      const catId = supportMatch[1];
      if (servicesRequired.includes(catId)) {
        try {
          const cb = form.getCheckBox(name);
          cb.check();
        } catch {
          // Skip if not a checkbox
        }
      }
      continue;
    }

    if (value == null || value === '') continue;
    try {
      const f = form.getTextField(name);
      f.setText(String(value));
    } catch {
      try {
        const cb = form.getCheckBox(name);
        if (String(value).toLowerCase() === 'yes' || String(value).toLowerCase() === 'true' || value === '1') cb.check();
      } catch {
        // Skip fields we can't fill
      }
    }
  }

  form.flatten();
  if (options.coordinatorSignatureDataUrl) {
    await embedCoordinatorSignature(doc, options.coordinatorSignatureDataUrl);
  }
  return Buffer.from(await doc.save());
}

/**
 * Fill Support Plan (PDF or Word)
 * @param {object} [options] - optional { coordinatorSignatureDataUrl }
 */
export async function fillSupportPlan(participant = {}, plan = null, intake = {}, options = {}) {
  const template = getSupportPlanTemplatePath();
  if (!template) throw new Error('Support Plan template not found. Add a PDF or .docx to data/forms/templates/support-plan/');

  if (template.type === 'docx') {
    return fillWordTemplate(template.path, participant, plan, intake, options);
  }

  const data = buildFillData(participant, plan, intake);
  const pdfBytes = readFileSync(template.path);
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  const fields = form.getFields();

  for (const field of fields) {
    const name = field.getName();
    const value = data[name] ?? data[name.replace(/-/g, '_')] ?? '';
    if (!value) continue;
    try {
      const f = form.getTextField(name);
      f.setText(String(value));
    } catch {
      // Skip
    }
  }

  form.flatten();
  if (options.coordinatorSignatureDataUrl) {
    await embedCoordinatorSignature(doc, options.coordinatorSignatureDataUrl);
  }
  return Buffer.from(await doc.save());
}

/**
 * Fill Word template with docxtemplater
 * @param {object} [options] - optional { coordinatorSignatureDataUrl }
 */
function fillWordTemplate(templatePath, participant = {}, plan = null, intake = {}, options = {}) {
  const context = options.db ? { db: options.db } : {};
  const data = buildFillData(participant, plan, intake, context);
  const templateData = {
    name: data.participant_name,
    participant_name: data.participant_name,
    client_name: data.participant_name,
    client_full_name: data.participant_name,
    preferred_name: data.preferred_name,
    email: data.participant_email,
    phone: data.participant_phone,
    address: data.participant_address,
    date_of_birth: data.participant_dob,
    ndis_number: data.ndis_number,
    date: data.today,
    today: data.today,
    plan_start_date: data.plan_start,
    plan_end_date: data.plan_end,
    primary_contact_name: data.primary_contact_name,
    primary_contact_phone: data.primary_contact_phone,
    primary_contact_email: data.primary_contact_email,
    service_schedule: data.service_schedule,
    goals_and_outcomes: data.goals_and_outcomes,
    support_needs: data.support_needs,
    plan_budget_amount: data.plan_budget_amount,
    support_categories_description: data.support_categories_description,
    coordinator_signed_date: options.coordinatorSignatureDataUrl ? data.today : '',
    coordinator_signature_note: options.coordinatorSignatureDataUrl ? 'Signed by coordinator' : '',
    ...data
  };
  // Map schedule rows to placeholders for Word: {schedule_1_description}, {schedule_1_hours}, {schedule_1_rate}, {schedule_1_budget}, etc.
  (data.scheduleRows || []).forEach((row, i) => {
    const n = i + 1;
    const descWithRatio = row.ratio ? `${row.description || ''} (ratio ${row.ratio})`.trim() : (row.description || '');
    templateData[`schedule_${n}_description`] = descWithRatio;
    templateData[`schedule_${n}_hours`] = row.hours || '';
    templateData[`schedule_${n}_rate`] = row.rate || '';
    templateData[`schedule_${n}_budget`] = row.budget || (n === 1 ? data.plan_budget_amount : '');
  });

  const content = readFileSync(templatePath, 'binary');
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => ''
  });
  doc.render(templateData);
  return doc.getZip().generate({ type: 'nodebuffer' });
}
