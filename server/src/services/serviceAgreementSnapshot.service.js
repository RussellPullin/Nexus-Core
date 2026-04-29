/**
 * Builds an immutable snapshot for a generated Service Agreement PDF (participant + org + template).
 */
import { db } from '../db/index.js';
import {
  mergeVariableValues,
  enrichVariablesFromOrgProfile,
  mergeBranding,
  interpolateTemplate,
  parseJson
} from './nexusFormTemplateRuntime.service.js';
import { buildDefinitionPayload } from '../data/serviceAgreementSpring2V3/buildMasterPayload.js';

function getCurrentPlan(participantId) {
  const today = new Date().toISOString().slice(0, 10);
  const plan = db
    .prepare(
      `SELECT * FROM ndis_plans WHERE participant_id = ? AND start_date <= ? AND end_date >= ?
       ORDER BY start_date DESC LIMIT 1`
    )
    .get(participantId, today, today);
  return plan || null;
}

function getLatestPlan(participantId) {
  return db
    .prepare(`SELECT * FROM ndis_plans WHERE participant_id = ? ORDER BY end_date DESC LIMIT 1`)
    .get(participantId);
}

function getIntakeFieldsForParticipant(participantId) {
  const onboarding = db
    .prepare(
      `SELECT po.id FROM participant_onboarding po WHERE po.participant_id = ? ORDER BY datetime(po.updated_at) DESC LIMIT 1`
    )
    .get(participantId);
  if (!onboarding) return {};
  const rows = db
    .prepare(`SELECT field_key, field_value FROM participant_intake_fields WHERE participant_onboarding_id = ?`)
    .all(onboarding.id);
  const intake = {};
  rows.forEach((r) => {
    intake[r.field_key] = r.field_value;
  });
  return intake;
}

function formatAusDate(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const s = iso.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return iso;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function fundingDisplayLabel(managementType, intake) {
  const raw = String(intake?.funding_management_type || '').trim();
  if (raw) return raw;
  const mt = String(managementType || 'self').toLowerCase();
  if (mt === 'plan') return 'Plan-managed';
  if (mt === 'ndia') return 'NDIA-managed';
  if (mt === 'self') return 'Self-managed';
  return mt;
}

function parseScheduleRowsFromIntake(intake) {
  const raw = intake?.service_schedule_rows;
  const mapRow = (r) => ({
    description: (r.description ?? '').toString().trim(),
    hours: (r.hours ?? '').toString().trim(),
    rate: (r.rate ?? '').toString().trim(),
    ratio: (r.ratio ?? '').toString().trim(),
    budget: (r.budget ?? '').toString().trim()
  });
  const has = (r) => r.description || r.hours || r.rate || r.budget;
  if (Array.isArray(raw)) return raw.map(mapRow).filter(has);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (!Array.isArray(p)) return [];
      return p.map(mapRow).filter(has);
    } catch {
      return [];
    }
  }
  return [];
}

function loadImplementationsSchedule(participantId, planId) {
  if (!planId) return [];
  const rows = db
    .prepare(
      `
    SELECT imp.description, imp.amount, imp.details, imp.ndis_line_item_id, imp.frequency,
           nli.description AS line_desc, nli.support_item_number, nli.rate AS line_rate, nli.unit
    FROM implementations imp
    LEFT JOIN ndis_line_items nli ON imp.ndis_line_item_id = nli.id
    WHERE imp.plan_id = ?
    ORDER BY imp.created_at ASC
  `
    )
    .all(planId);

  return rows.map((r) => {
    const desc =
      [r.description, r.line_desc].filter(Boolean).join(' — ') ||
      r.support_item_number ||
      'Support';
    const unitRate = Number(r.line_rate) || 0;
    const freq = String(r.frequency || '').toLowerCase();
    let hoursNum = null;
    const ft = String(r.details || '').match(/([\d.]+)\s*hrs?\s*\/?\s*wk/i);
    if (ft) hoursNum = Number(ft[1]);
    const budget = Number(r.amount) || 0;
    return {
      description: desc,
      hours: hoursNum != null ? String(hoursNum) : '',
      rate: unitRate ? `$${unitRate.toFixed(2)}` : '',
      ratio: '',
      budget: budget ? `$${budget.toFixed(2)}` : '',
      line_total: budget
    };
  });
}

function sumScheduleTotal(rows) {
  let t = 0;
  rows.forEach((r) => {
    if (typeof r.line_total === 'number' && !Number.isNaN(r.line_total)) t += r.line_total;
    else if (r.budget) {
      const n = Number(String(r.budget).replace(/[^0-9.]/g, ''));
      if (!Number.isNaN(n)) t += n;
    }
  });
  return Math.round(t * 100) / 100;
}

/**
 * @param {object} params
 * @param {string} params.participantId
 * @param {string} params.orgId
 * @param {object} params.masterRow - nexus_form_template_masters row
 * @param {object} params.orgTemplateRow - nexus_org_form_templates row
 * @param {object} [params.instanceOverrides]
 */
export function buildServiceAgreementSnapshot({
  participantId,
  orgId,
  masterRow,
  orgTemplateRow,
  instanceOverrides = {}
}) {
  const participant = db.prepare(`SELECT * FROM participants WHERE id = ?`).get(participantId);
  if (!participant) throw new Error('Participant not found');

  const org = db.prepare(`SELECT * FROM organisations WHERE id = ?`).get(orgId);
  const biz = db.prepare(`SELECT * FROM business_settings WHERE org_id = ?`).get(orgId);

  const adminUser = db
    .prepare(`SELECT name FROM users WHERE org_id = ? AND role = 'admin' ORDER BY created_at ASC LIMIT 1`)
    .get(orgId);
  const contactPerson = adminUser?.name || '';

  let variableMap = mergeVariableValues(masterRow.variable_schema_json, orgTemplateRow.variable_values_json);
  variableMap = enrichVariablesFromOrgProfile(variableMap, org, biz, contactPerson);

  const branding = mergeBranding(orgTemplateRow.branding_json);
  const parsedBrand = parseJson(orgTemplateRow.branding_json, {}) || {};
  if (!parsedBrand.logo_relative_path && biz?.logo_path) {
    branding.logo_relative_path = biz.logo_path;
  }
  const metaDefaults = parseJson(orgTemplateRow.metadata_json, {}) || {};

  const intake = getIntakeFieldsForParticipant(participantId);
  const plan = getCurrentPlan(participantId) || getLatestPlan(participantId);

  let scheduleRows = loadImplementationsSchedule(participantId, plan?.id);
  if (scheduleRows.length === 0) {
    scheduleRows = parseScheduleRowsFromIntake(intake);
  }

  const agreementDate = instanceOverrides.agreement_date || new Date().toISOString().slice(0, 10);
  const scheduledReview =
    instanceOverrides.scheduled_review_date || plan?.end_date || agreementDate;

  const monitoring =
    instanceOverrides.monitoring_worker_frequency ??
    variableMap.monitoring_worker_frequency_default ??
    'As agreed between the parties';
  const otherConsult =
    instanceOverrides.other_provider_consultation_frequency ??
    variableMap.other_provider_consultation_frequency_default ??
    'As agreed between the parties';
  const comms =
    instanceOverrides.communication_preferences ??
    intake.preferred_contact_method ??
    '';

  const pmOrg = participant.plan_manager_id
    ? db.prepare(`SELECT name, abn, email, phone, address FROM organisations WHERE id = ?`).get(participant.plan_manager_id)
    : null;

  const rep =
    intake.primary_contact_name || intake.representative_name
      ? {
          name: intake.primary_contact_name || intake.representative_name || '',
          relationship: intake.primary_contact_relationship || intake.representative_relationship || '',
          phone: intake.primary_contact_phone || intake.representative_phone || '',
          email: intake.primary_contact_email || intake.representative_email || ''
        }
      : null;

  const fundingLabel = fundingDisplayLabel(participant.management_type, intake);

  const definition = parseJson(masterRow.definition_json, null) || buildDefinitionPayload();

  const interpMap = { ...variableMap };
  const clausesRendered = (definition.clauses || []).map((c) => ({
    ...c,
    body_rendered: interpolateTemplate(c.body, interpMap)
  }));

  const participantAddress =
    participant.address ||
    [intake.street_address, intake.suburb_city, intake.state, intake.postcode].filter(Boolean).join(', ');

  const snapshot = {
    template_key: masterRow.template_key,
    master_id: masterRow.id,
    org_template_id: orgTemplateRow.id,
    generated_at_iso: new Date().toISOString(),
    branding,
    metadata: {
      date_approved: metaDefaults.document_date_approved ?? variableMap.document_date_approved ?? '',
      review_date: metaDefaults.document_review_date ?? variableMap.document_review_date ?? '',
      next_review_date: metaDefaults.document_next_review_date ?? variableMap.document_next_review_date ?? ''
    },
    resolved_variables: variableMap,
    org: {
      legal_name: interpMap.org_legal_name,
      trading_name: interpMap.org_trading_name,
      abn: interpMap.org_abn,
      address: interpMap.org_address,
      email: interpMap.org_email,
      phone: interpMap.org_phone,
      contact_person: interpMap.org_contact_person
    },
    participant: {
      name: participant.name,
      phone: participant.phone || intake.phone || '',
      mobile: intake.mobile_phone || intake.mobile || participant.phone || '',
      email: participant.email || intake.email || '',
      date_of_birth: participant.date_of_birth,
      date_of_birth_display: formatAusDate(participant.date_of_birth || intake.date_of_birth),
      ndis_number: participant.ndis_number || intake.ndis_number || '',
      address: participantAddress,
      plan_start: plan?.start_date ? formatAusDate(plan.start_date) : '',
      plan_expiry: plan?.end_date ? formatAusDate(plan.end_date) : ''
    },
    representative: rep,
    funding: {
      label: fundingLabel,
      show_plan_manager: Boolean(participant.management_type === 'plan' && pmOrg),
      plan_manager: pmOrg
        ? {
            name: pmOrg.name,
            abn: pmOrg.abn || '',
            email: pmOrg.email || '',
            phone: pmOrg.phone || '',
            address: pmOrg.address || ''
          }
        : null
    },
    section2: {
      agreement_date: formatAusDate(agreementDate),
      agreement_date_iso: agreementDate,
      scheduled_review_date: formatAusDate(scheduledReview),
      scheduled_review_iso: String(scheduledReview).slice(0, 10),
      monitoring_worker_frequency: monitoring,
      other_provider_consultation_frequency: otherConsult,
      communication_preferences: comms
    },
    schedule_rows: scheduleRows,
    schedule_total: sumScheduleTotal(scheduleRows),
    checklist: definition.checklist || [],
    clauses_rendered: clausesRendered,
    definition_meta: definition.meta || {},
    section_titles: definition.sectionTitles || {},
    parties_labels: definition.partiesBlockLabels || {}
  };

  return snapshot;
}
