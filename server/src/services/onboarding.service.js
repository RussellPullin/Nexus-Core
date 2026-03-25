import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { getConsentFormPath, fillConsentForm, convertDocxToPdf } from './consentForm.service.js';
import { ensurePlanManagerOrg, buildOrgLookupMaps } from './organisations.service.js';
import { fillServiceAgreement, fillSupportPlan, getServiceAgreementTemplatePath, getSupportPlanTemplatePath } from './formFill.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const onboardingDir = join(projectRoot, 'data', 'onboarding');

const CORE_FORM_TYPES = ['service_agreement', 'intake_form', 'support_plan', 'privacy_consent'];
const DEFAULT_HYBRID_SEPARATE = new Set(['privacy_consent']);

function ensureOnboardingDir() {
  if (!existsSync(onboardingDir)) {
    mkdirSync(onboardingDir, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeFormType(formType) {
  return String(formType || '').trim().toLowerCase().replace(/\s+/g, '_');
}

export function createAuditEvent({
  participantId = null,
  participantOnboardingId = null,
  actorType = 'system',
  actorId = null,
  eventType,
  entityType = null,
  entityId = null,
  oldValue = null,
  newValue = null,
  metadata = null,
  sourceIp = null,
  userAgent = null
}) {
  db.prepare(`
    INSERT INTO audit_events (
      id, participant_id, participant_onboarding_id, actor_type, actor_id, event_type,
      entity_type, entity_id, old_value_json, new_value_json, metadata_json, source_ip, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    participantId,
    participantOnboardingId,
    actorType,
    actorId,
    eventType,
    entityType,
    entityId,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null,
    metadata ? JSON.stringify(metadata) : null,
    sourceIp,
    userAgent
  );
}

export function ensureProviderProfile(organisationId) {
  const existing = db.prepare('SELECT * FROM provider_profiles WHERE organisation_id = ?').get(organisationId);
  if (existing) return existing;

  const id = uuidv4();
  db.prepare(`
    INSERT INTO provider_profiles (id, organisation_id, onboarding_enabled, onboarding_pilot, signature_mode)
    VALUES (?, ?, 1, 0, 'hybrid')
  `).run(id, organisationId);
  return db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(id);
}

export function seedCoreTemplates(providerProfileId) {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM form_templates WHERE provider_profile_id = ?').get(providerProfileId)?.c || 0;
  if (existingCount > 0) return;

  const defaults = [
    { form_type: 'service_agreement', display_name: 'Service Agreement', signer: 'participant', legal_basis: 'Service delivery contract' },
    { form_type: 'intake_form', display_name: 'Participant Intake Form', signer: 'participant', legal_basis: 'Client onboarding and supports intake' },
    { form_type: 'support_plan', display_name: 'Support Plan', signer: 'participant', legal_basis: 'Support planning and service scope' },
    { form_type: 'privacy_consent', display_name: 'Privacy Consent Form', signer: 'participant', legal_basis: 'Privacy and information sharing consent' }
  ];

  const insertTemplate = db.prepare(`
    INSERT INTO form_templates (
      id, provider_profile_id, form_type, display_name, version, is_active,
      required_signer_role, renewal_days, legal_basis, mapping_json, workflow
    ) VALUES (?, ?, ?, ?, 'v1', 1, ?, 365, ?, ?, 'participant_onboarding')
  `);
  const insertRequired = db.prepare(`
    INSERT INTO provider_required_forms (id, provider_profile_id, form_template_id, is_required)
    VALUES (?, ?, ?, 1)
  `);

  defaults.forEach((template) => {
    const templateId = uuidv4();
    insertTemplate.run(
      templateId,
      providerProfileId,
      template.form_type,
      template.display_name,
      template.signer,
      template.legal_basis,
      JSON.stringify({
        prefill_fields: [
          'participant.name',
          'participant.date_of_birth',
          'participant.address',
          'participant.phone',
          'participant.email',
          'plan.start_date',
          'plan.end_date',
          'intake.service_schedule',
          'intake.service_schedule_rows'
        ]
      })
    );
    insertRequired.run(uuidv4(), providerProfileId, templateId);
  });
}

function getCurrentPlan(participantId) {
  const today = new Date().toISOString().slice(0, 10);
  const plan = db.prepare(`
    SELECT *
    FROM ndis_plans
    WHERE participant_id = ? AND start_date <= ? AND end_date >= ?
    ORDER BY start_date DESC
    LIMIT 1
  `).get(participantId, today, today);
  if (!plan) return null;

  const budgets = db.prepare('SELECT * FROM plan_budgets WHERE plan_id = ? ORDER BY category').all(plan.id);
  return { ...plan, budgets };
}

function getIntakeFields(participantOnboardingId) {
  const rows = db.prepare(`
    SELECT field_key, field_value
    FROM participant_intake_fields
    WHERE participant_onboarding_id = ?
  `).all(participantOnboardingId);
  const intake = {};
  rows.forEach((row) => {
    intake[row.field_key] = row.field_value;
  });
  return intake;
}

function getProviderTemplates(providerProfileId) {
  return db.prepare(`
    SELECT
      t.*,
      prf.is_required,
      prf.service_category,
      prf.participant_cohort
    FROM form_templates t
    JOIN provider_required_forms prf ON prf.form_template_id = t.id
    WHERE t.provider_profile_id = ? AND t.is_active = 1
    ORDER BY prf.is_required DESC, t.form_type ASC, t.created_at ASC
  `).all(providerProfileId);
}

export function getOnboardingByParticipant(participantId) {
  const onboarding = db.prepare(`
    SELECT po.*, pp.organisation_id, pp.signature_mode, pp.onboarding_enabled, pp.onboarding_pilot
    FROM participant_onboarding po
    JOIN provider_profiles pp ON pp.id = po.provider_profile_id
    WHERE po.participant_id = ?
  `).get(participantId);
  if (!onboarding) return null;

  const intakeFields = getIntakeFields(onboarding.id);
  const forms = db.prepare(`
    SELECT pfi.*, ft.form_type, ft.display_name, ft.version as template_version, ft.renewal_days, ft.legal_basis
    FROM participant_form_instances pfi
    JOIN form_templates ft ON ft.id = pfi.form_template_id
    WHERE pfi.participant_onboarding_id = ?
    ORDER BY ft.form_type, pfi.version DESC
  `).all(onboarding.id);
  const envelopes = db.prepare(`
    SELECT *
    FROM signature_envelopes
    WHERE participant_onboarding_id = ?
    ORDER BY created_at DESC
  `).all(onboarding.id);

  const formStatusSummary = {
    total: forms.length,
    signed: forms.filter((f) => f.status === 'signed').length,
    pending: forms.filter((f) => ['generated', 'sent', 'viewed'].includes(f.status)).length,
    expired: forms.filter((f) => f.status === 'expired').length,
    declined: forms.filter((f) => f.status === 'declined').length
  };

  return { ...onboarding, intake_fields: intakeFields, forms, envelopes, form_status_summary: formStatusSummary };
}

export function initializeParticipantOnboarding({
  participantId,
  providerOrganisationId,
  actorType = 'user',
  actorId = null,
  sourceIp = null,
  userAgent = null
}) {
  const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(participantId);
  if (!participant) {
    throw new Error('Participant not found');
  }

  let providerOrgId = providerOrganisationId || participant.plan_manager_id || null;
  if (!providerOrgId) {
    const fallbackOrg = db.prepare('SELECT id FROM organisations ORDER BY created_at ASC LIMIT 1').get();
    providerOrgId = fallbackOrg?.id || null;
  }
  if (!providerOrgId) {
    throw new Error('No provider organisation available. Create a provider organisation first.');
  }

  const providerProfile = ensureProviderProfile(providerOrgId);
  seedCoreTemplates(providerProfile.id);

  const existing = db.prepare('SELECT * FROM participant_onboarding WHERE participant_id = ?').get(participantId);
  if (existing) {
    return getOnboardingByParticipant(participantId);
  }

  const onboardingId = uuidv4();
  db.prepare(`
    INSERT INTO participant_onboarding (
      id, participant_id, provider_profile_id, status, current_stage, started_at, last_activity_at
    ) VALUES (?, ?, ?, 'in_progress', 'participant_details', ?, ?)
  `).run(onboardingId, participantId, providerProfile.id, nowIso(), nowIso());

  createAuditEvent({
    participantId,
    participantOnboardingId: onboardingId,
    actorType,
    actorId,
    eventType: 'onboarding_initialized',
    entityType: 'onboarding',
    entityId: onboardingId,
    newValue: { provider_profile_id: providerProfile.id, provider_organisation_id: providerOrgId },
    sourceIp,
    userAgent
  });

  return getOnboardingByParticipant(participantId);
}

export function upsertIntakeFields({
  participantId,
  fields,
  actorType = 'user',
  actorId = null,
  sourceIp = null,
  userAgent = null
}) {
  const onboarding = getOnboardingByParticipant(participantId);
  if (!onboarding) throw new Error('Onboarding not initialized for participant');

  const entries = Object.entries(fields || {}).filter(([key]) => key);
  const upsert = db.prepare(`
    INSERT INTO participant_intake_fields (id, participant_onboarding_id, field_key, field_value, source)
    VALUES (?, ?, ?, ?, 'user')
    ON CONFLICT(participant_onboarding_id, field_key)
    DO UPDATE SET field_value = excluded.field_value, source = 'user', updated_at = datetime('now')
  `);
  entries.forEach(([key, value]) => {
    upsert.run(uuidv4(), onboarding.id, key, value == null ? '' : String(value));
  });

  db.prepare(`
    UPDATE participant_onboarding
    SET current_stage = ?, status = ?, last_activity_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run('intake', 'in_progress', nowIso(), onboarding.id);

  createAuditEvent({
    participantId,
    participantOnboardingId: onboarding.id,
    actorType,
    actorId,
    eventType: 'intake_fields_updated',
    entityType: 'onboarding',
    entityId: onboarding.id,
    newValue: fields,
    sourceIp,
    userAgent
  });

  return getOnboardingByParticipant(participantId);
}

/** Sync participant record from intake fields. Call after saving intake. */
function syncParticipantFromIntake(participantId, intake) {
  if (!intake) return;
  const parts = [];
  const values = [];
  const f = (key, val) => {
    if (val != null && String(val).trim() !== '') {
      parts.push(`${key} = ?`);
      values.push(String(val).trim());
    }
  };
  f('name', intake.full_legal_name || intake.name);
  f('date_of_birth', intake.date_of_birth);
  f('ndis_number', intake.ndis_number);
  f('email', intake.email);
  f('phone', intake.phone);
  const addr = [intake.street_address, intake.suburb_city, intake.state, intake.postcode].filter(Boolean).join(', ');
  f('address', addr || intake.address);
  f('parent_guardian_phone', intake.primary_contact_phone || intake.primary_guardian_phone);
  f('parent_guardian_email', intake.primary_contact_email || intake.primary_guardian_email);
  const diagnosis = [intake.medical_conditions, intake.mental_health_summary].filter(Boolean).join('; ');
  f('diagnosis', diagnosis || intake.diagnosis);
  let planManagerId = intake.plan_manager_id;
  const planManagedArr = Array.isArray(intake.plan_managed_services) ? intake.plan_managed_services : (() => { try { const p = JSON.parse(intake.plan_managed_services || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } })();
  const ndiaManagedArr = Array.isArray(intake.ndia_managed_services) ? intake.ndia_managed_services : (() => { try { const p = JSON.parse(intake.ndia_managed_services || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } })();
  let mgmt = String(intake.funding_management_type || '').toLowerCase();
  if (!mgmt && planManagedArr.length > 0) mgmt = 'plan';
  else if (!mgmt && ndiaManagedArr.length > 0) mgmt = 'ndia';
  else if (!mgmt) mgmt = 'self';
  const isPlanManaged = mgmt.includes('plan');
  let pmEmail = (intake.plan_manager_invoice_email || '').trim() || null;
  let pmName = (intake.plan_manager_company_name || '').trim() || null;
  const providerOrgId =
    db.prepare('SELECT provider_org_id FROM participants WHERE id = ?').get(participantId)?.provider_org_id || null;
  const details = (intake.plan_manager_details || '').trim() || null;
  if (details && !details.includes('@')) pmName = pmName || details;
  else if (details && details.includes(' – ')) {
    const before = details.split(' – ')[0]?.trim();
    const after = details.split(' – ')[1]?.trim();
    if (before) pmName = pmName || before;
    if (after && after.includes('@')) pmEmail = pmEmail || after;
  } else if (details && details.includes('@')) pmEmail = pmEmail || details;
  if (!planManagerId && isPlanManaged && (pmEmail || pmName)) {
    const { orgByName, orgByEmail } = buildOrgLookupMaps(providerOrgId);
    planManagerId = ensurePlanManagerOrg(orgByName, orgByEmail, pmName, pmEmail, providerOrgId);
  }
  if (planManagerId != null) {
    parts.push('plan_manager_id = ?');
    values.push(planManagerId);
  }
  if (mgmt.includes('plan')) f('management_type', 'plan');
  else if (mgmt.includes('ndia')) f('management_type', 'ndia');
  else if (mgmt.includes('self')) f('management_type', 'self');
  const servicesJson = Array.isArray(intake.services_required) ? JSON.stringify(intake.services_required) : null;
  const ndiaJson = Array.isArray(intake.ndia_managed_services) ? JSON.stringify(intake.ndia_managed_services) : null;
  const planJson = Array.isArray(intake.plan_managed_services) ? JSON.stringify(intake.plan_managed_services) : null;
  if (servicesJson != null) {
    parts.push('services_required = ?');
    values.push(servicesJson);
  }
  if (ndiaJson != null) {
    parts.push('ndia_managed_services = ?');
    values.push(ndiaJson);
  }
  if (planJson != null) {
    parts.push('plan_managed_services = ?');
    values.push(planJson);
  }
  // Build invoice_emails from plan_manager_invoice_email + additional_invoice_emails (for invoice batching)
  const invoiceEmails = [];
  if (intake.plan_manager_invoice_email) invoiceEmails.push(intake.plan_manager_invoice_email);
  if (isPlanManaged && planManagerId && pmEmail && !invoiceEmails.includes(pmEmail)) invoiceEmails.unshift(pmEmail);
  if (Array.isArray(intake.additional_invoice_emails)) {
    intake.additional_invoice_emails.forEach((e) => { if (e && !invoiceEmails.includes(e)) invoiceEmails.push(e); });
  }
  if (invoiceEmails.length > 0) {
    parts.push('invoice_emails = ?');
    values.push(JSON.stringify(invoiceEmails));
  }
  if (parts.length === 0) return;
  values.push(participantId);
  db.prepare(`UPDATE participants SET ${parts.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);
}

function upsertContactsFromIntake(participantId, contactsData) {
  if (!contactsData || contactsData.length === 0) return;
  const toRemove = db.prepare(`
    SELECT pc.id, pc.contact_id FROM participant_contacts pc
    JOIN contacts c ON c.id = pc.contact_id
    WHERE pc.participant_id = ? AND c.organisation_id IS NULL
      AND c.role IN ('Primary contact', 'Emergency contact')
  `).all(participantId);
  for (const r of toRemove) {
    db.prepare('DELETE FROM participant_contacts WHERE id = ?').run(r.id);
    db.prepare('DELETE FROM contacts WHERE id = ?').run(r.contact_id);
  }
  for (const c of contactsData) {
    if (!c.name && !c.phone && !c.email) continue;
    const roleLabel = c.role === 'primary_guardian' ? 'Primary contact' : c.role === 'emergency' ? 'Emergency contact' : 'Contact';
    const contactId = uuidv4();
    db.prepare(`
      INSERT INTO contacts (id, organisation_id, name, email, phone, role)
      VALUES (?, NULL, ?, ?, ?, ?)
    `).run(contactId, (c.name || '').trim() || 'Unknown', c.email || null, c.phone || null, roleLabel);
    const pcId = uuidv4();
    db.prepare(`
      INSERT INTO participant_contacts (id, participant_id, contact_id, relationship)
      VALUES (?, ?, ?, ?)
    `).run(pcId, participantId, contactId, c.relationship || null);
  }
}

/** Save intake form and sync participant record. */
export function saveIntakeAndSyncParticipant({
  participantId,
  participantData,
  intakeData,
  contactsData,
  actorType = 'user',
  actorId = null,
  sourceIp = null,
  userAgent = null
}) {
  const onboarding = getOnboardingByParticipant(participantId);
  if (!onboarding) throw new Error('Onboarding not initialized for participant');

  const contactFields = {};
  for (const c of contactsData || []) {
    if (c.role === 'primary_guardian') {
      contactFields.primary_contact_name = c.name;
      contactFields.primary_contact_relationship = c.relationship;
      contactFields.primary_contact_phone = c.phone;
      contactFields.primary_contact_email = c.email;
    } else if (c.role === 'emergency') {
      contactFields.emergency_contact_name = c.name;
      contactFields.emergency_contact_relationship = c.relationship;
      contactFields.emergency_contact_phone = c.phone;
    }
  }
  const allFields = { ...participantData, ...intakeData, ...contactFields };
  const fieldsForStorage = { ...allFields };
  if (Array.isArray(allFields.services_required)) fieldsForStorage.services_required = JSON.stringify(allFields.services_required);
  if (Array.isArray(allFields.ndia_managed_services)) fieldsForStorage.ndia_managed_services = JSON.stringify(allFields.ndia_managed_services);
  if (Array.isArray(allFields.plan_managed_services)) fieldsForStorage.plan_managed_services = JSON.stringify(allFields.plan_managed_services);
  if (Array.isArray(allFields.service_schedule_rows)) fieldsForStorage.service_schedule_rows = JSON.stringify(allFields.service_schedule_rows);
  if (Array.isArray(allFields.additional_invoice_emails)) fieldsForStorage.additional_invoice_emails = JSON.stringify(allFields.additional_invoice_emails);

  upsertIntakeFields({ participantId, fields: fieldsForStorage, actorType, actorId, sourceIp, userAgent });
  syncParticipantFromIntake(participantId, allFields);
  upsertContactsFromIntake(participantId, contactsData);

  return getOnboardingByParticipant(participantId);
}

function buildPrefillSnapshot(participantId, participantOnboardingId) {
  const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(participantId);
  const currentPlan = getCurrentPlan(participantId);
  const intakeFields = getIntakeFields(participantOnboardingId);

  return {
    participant: {
      id: participant.id,
      name: participant.name,
      date_of_birth: participant.date_of_birth,
      address: participant.address,
      email: participant.email,
      phone: participant.phone,
      ndis_number: participant.ndis_number,
      parent_guardian_email: participant.parent_guardian_email,
      parent_guardian_phone: participant.parent_guardian_phone,
      diagnosis: participant.diagnosis
    },
    plan: currentPlan
      ? {
        id: currentPlan.id,
        start_date: currentPlan.start_date,
        end_date: currentPlan.end_date,
        is_pace: !!currentPlan.is_pace,
        budgets: currentPlan.budgets
      }
      : null,
    intake: intakeFields,
    generated_at: nowIso()
  };
}

function getNextFormVersion(participantOnboardingId, formTemplateId) {
  const row = db.prepare(`
    SELECT MAX(version) as max_version
    FROM participant_form_instances
    WHERE participant_onboarding_id = ? AND form_template_id = ?
  `).get(participantOnboardingId, formTemplateId);
  return (row?.max_version || 0) + 1;
}

function persistGeneratedDraft(participantId, formType, version, snapshot) {
  ensureOnboardingDir();
  const safeType = normalizeFormType(formType) || 'custom_form';
  const fileName = `${participantId}-${safeType}-v${version}.json`;
  const absolutePath = join(onboardingDir, fileName);
  writeFileSync(absolutePath, JSON.stringify(snapshot, null, 2));
  return absolutePath;
}

function persistFilledDocument(participantId, formType, version, buffer, ext = 'pdf') {
  ensureOnboardingDir();
  const safeType = normalizeFormType(formType) || 'custom_form';
  const fileName = `${participantId}-${safeType}-v${version}.${ext}`;
  const absolutePath = join(onboardingDir, fileName);
  writeFileSync(absolutePath, buffer);
  return absolutePath;
}

export async function generateFormPack({
  participantId,
  actorType = 'user',
  actorId = null,
  userId = null,
  sourceIp = null,
  userAgent = null
}) {
  const onboarding = getOnboardingByParticipant(participantId);
  if (!onboarding) throw new Error('Onboarding not initialized for participant');
  if (!onboarding.onboarding_enabled) throw new Error('Onboarding is disabled for this provider');

  const actingUserId = userId || actorId;
  const coordinatorSignatureDataUrl = actingUserId
    ? (db.prepare('SELECT signature_data FROM users WHERE id = ?').get(actingUserId)?.signature_data || null)
    : null;

  const allTemplates = getProviderTemplates(onboarding.provider_profile_id);
  const templates = allTemplates.filter((t) => ['service_agreement', 'support_plan', 'privacy_consent'].includes(t.form_type));
  if (!templates.length) throw new Error('No templates configured. Save intake first to enable auto-filled forms.');

  const snapshot = buildPrefillSnapshot(participantId, onboarding.id);
  const consentFormPath = getConsentFormPath();
  const generatedIds = [];
  const insertForm = db.prepare(`
    INSERT INTO participant_form_instances (
      id, participant_onboarding_id, participant_id, form_template_id, status, version, due_at, generated_at,
      source_snapshot_json, draft_document_path
    ) VALUES (?, ?, ?, ?, 'generated', ?, ?, ?, ?, ?)
  `);

  const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(participantId);
  const plan = getCurrentPlan(participantId);
  const intake = getIntakeFields(onboarding.id);
  const signatureOptions = coordinatorSignatureDataUrl ? { coordinatorSignatureDataUrl } : {};

  for (const template of templates) {
    if (template.form_type === 'privacy_consent' && !consentFormPath) continue;
    const version = getNextFormVersion(onboarding.id, template.id);
    const dueAtBase = new Date();
    const renewalDays = template.renewal_days || 365;
    dueAtBase.setDate(dueAtBase.getDate() + renewalDays);
    let draftPath;
    let sourceJson;
    if (template.form_type === 'privacy_consent') {
      const filledDocx = fillConsentForm(participant, intake, signatureOptions);
      const pdfBuffer = convertDocxToPdf(filledDocx);
      const ext = pdfBuffer ? 'pdf' : 'docx';
      draftPath = persistFilledDocument(participantId, template.form_type, version, pdfBuffer || filledDocx, ext);
      sourceJson = JSON.stringify({ ...snapshot, template: { id: template.id, form_type: 'privacy_consent', display_name: template.display_name } });
    } else if (template.form_type === 'service_agreement' && getServiceAgreementTemplatePath()) {
      const filledBuffer = await fillServiceAgreement(participant, plan, intake, { ...signatureOptions, db });
      draftPath = persistFilledDocument(participantId, template.form_type, version, filledBuffer, 'pdf');
      sourceJson = JSON.stringify({
        ...snapshot,
        template: { id: template.id, form_type: 'service_agreement', display_name: template.display_name, version: template.template_version || template.version },
        mapping: parseJson(template.mapping_json, {})
      });
    } else if (template.form_type === 'support_plan' && getSupportPlanTemplatePath()) {
      const filledBuffer = await fillSupportPlan(participant, plan, intake, signatureOptions);
      const ext = getSupportPlanTemplatePath().type === 'docx' ? 'docx' : 'pdf';
      draftPath = persistFilledDocument(participantId, template.form_type, version, filledBuffer, ext);
      sourceJson = JSON.stringify({
        ...snapshot,
        template: { id: template.id, form_type: 'support_plan', display_name: template.display_name, version: template.template_version || template.version },
        mapping: parseJson(template.mapping_json, {})
      });
    } else {
      const formSnapshot = {
        ...snapshot,
        template: {
          id: template.id,
          form_type: template.form_type,
          display_name: template.display_name,
          version: template.template_version || template.version
        },
        mapping: parseJson(template.mapping_json, {})
      };
      draftPath = persistGeneratedDraft(participantId, template.form_type, version, formSnapshot);
      sourceJson = JSON.stringify(formSnapshot);
    }
    const formId = uuidv4();
    insertForm.run(
      formId,
      onboarding.id,
      participantId,
      template.id,
      version,
      dueAtBase.toISOString(),
      nowIso(),
      sourceJson,
      draftPath
    );
    generatedIds.push(formId);
  }

  db.prepare(`
    UPDATE participant_onboarding
    SET current_stage = ?, status = ?, last_activity_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run('review', 'in_progress', nowIso(), onboarding.id);

  createAuditEvent({
    participantId,
    participantOnboardingId: onboarding.id,
    actorType,
    actorId,
    eventType: 'form_pack_generated',
    entityType: 'onboarding',
    entityId: onboarding.id,
    newValue: { form_instance_ids: generatedIds },
    sourceIp,
    userAgent
  });

  return getOnboardingByParticipant(participantId);
}

export function getLatestGeneratedForms(participantOnboardingId) {
  return db.prepare(`
    SELECT pfi.*, ft.form_type, ft.display_name, ft.required_signer_role, ft.renewal_days
    FROM participant_form_instances pfi
    JOIN form_templates ft ON ft.id = pfi.form_template_id
    WHERE pfi.participant_onboarding_id = ?
      AND pfi.status IN ('generated', 'sent', 'viewed', 'signed')
    ORDER BY pfi.generated_at DESC
  `).all(participantOnboardingId);
}

export function computeHybridPackets(forms) {
  const packetForms = [];
  const separatePackets = [];
  forms.forEach((form) => {
    if (DEFAULT_HYBRID_SEPARATE.has(form.form_type)) {
      separatePackets.push([form]);
    } else {
      packetForms.push(form);
    }
  });
  const packets = [];
  if (packetForms.length) packets.push(packetForms);
  packets.push(...separatePackets);
  return packets;
}

export function createEnvelopeRecords({
  participantId,
  participantOnboardingId,
  packets,
  packetMode = 'hybrid',
  actorType = 'user',
  actorId = null,
  sourceIp = null,
  userAgent = null
}) {
  const created = [];
  const insertEnvelope = db.prepare(`
    INSERT INTO signature_envelopes (
      id, participant_onboarding_id, participant_id, packet_mode, provider_name,
      status, packet_reasoning, sent_at
    ) VALUES (?, ?, ?, ?, 'adobe_sign', 'sent', ?, ?)
  `);
  const linkForm = db.prepare(`
    INSERT INTO envelope_form_instances (id, envelope_id, form_instance_id)
    VALUES (?, ?, ?)
  `);
  const updateForm = db.prepare(`
    UPDATE participant_form_instances
    SET status = 'sent', sent_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  packets.forEach((forms) => {
    const envelopeId = uuidv4();
    const packetReasoning = forms.length > 1
      ? 'Bundled for participant convenience under hybrid rules'
      : 'Separated due to consent-specific legal requirements';
    insertEnvelope.run(envelopeId, participantOnboardingId, participantId, packetMode, packetReasoning, nowIso());
    forms.forEach((form) => {
      linkForm.run(uuidv4(), envelopeId, form.id);
      updateForm.run(nowIso(), form.id);
      db.prepare(`
        INSERT INTO signature_events (
          id, envelope_id, form_instance_id, provider_name, event_type, event_timestamp, payload_json
        ) VALUES (?, ?, ?, 'adobe_sign', 'agreement_sent', ?, ?)
      `).run(uuidv4(), envelopeId, form.id, nowIso(), JSON.stringify({ reason: packetReasoning }));
    });
    created.push({ envelope_id: envelopeId, form_instance_ids: forms.map((f) => f.id), packet_reasoning: packetReasoning });
  });

  db.prepare(`
    UPDATE participant_onboarding
    SET current_stage = ?, status = ?, last_activity_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run('signature', 'awaiting_signature', nowIso(), participantOnboardingId);

  createAuditEvent({
    participantId,
    participantOnboardingId,
    actorType,
    actorId,
    eventType: 'signature_packets_created',
    entityType: 'onboarding',
    entityId: participantOnboardingId,
    newValue: { packets: created },
    sourceIp,
    userAgent
  });

  return created;
}

export function markEnvelopeCompleted({
  envelopeId,
  externalEventId = null,
  eventType = 'agreement_signed',
  payload = null,
  sourceIp = null,
  userAgent = null
}) {
  const envelope = db.prepare('SELECT * FROM signature_envelopes WHERE id = ?').get(envelopeId);
  if (!envelope) throw new Error('Envelope not found');

  const linkedForms = db.prepare(`
    SELECT pfi.*
    FROM envelope_form_instances efi
    JOIN participant_form_instances pfi ON pfi.id = efi.form_instance_id
    WHERE efi.envelope_id = ?
  `).all(envelopeId);

  db.prepare(`
    UPDATE signature_envelopes
    SET status = 'signed', completed_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nowIso(), envelopeId);

  const updateForm = db.prepare(`
    UPDATE participant_form_instances
    SET status = 'signed', signed_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  linkedForms.forEach((form) => {
    updateForm.run(nowIso(), form.id);
    db.prepare(`
      INSERT INTO signature_events (
        id, envelope_id, form_instance_id, provider_name, external_event_id,
        event_type, event_timestamp, payload_json
      ) VALUES (?, ?, ?, 'adobe_sign', ?, ?, ?, ?)
    `).run(
      uuidv4(),
      envelopeId,
      form.id,
      externalEventId,
      eventType,
      nowIso(),
      payload ? JSON.stringify(payload) : null
    );
  });

  const notSignedCount = db.prepare(`
    SELECT COUNT(*) as c
    FROM participant_form_instances
    WHERE participant_onboarding_id = ? AND status != 'signed'
  `).get(envelope.participant_onboarding_id)?.c || 0;

  if (notSignedCount === 0) {
    db.prepare(`
      UPDATE participant_onboarding
      SET status = 'complete', current_stage = 'complete', completed_at = ?, last_activity_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nowIso(), nowIso(), envelope.participant_onboarding_id);
  }

  createAuditEvent({
    participantId: envelope.participant_id,
    participantOnboardingId: envelope.participant_onboarding_id,
    actorType: 'webhook',
    actorId: 'adobe_sign',
    eventType: 'signature_completed',
    entityType: 'envelope',
    entityId: envelopeId,
    newValue: { envelope_status: 'signed', linked_forms: linkedForms.map((f) => f.id) },
    sourceIp,
    userAgent
  });
}

export function upsertRenewalTasksForParticipant(participantOnboardingId) {
  const forms = db.prepare(`
    SELECT pfi.*, ft.id as template_id, ft.renewal_days
    FROM participant_form_instances pfi
    JOIN form_templates ft ON ft.id = pfi.form_template_id
    WHERE pfi.participant_onboarding_id = ? AND pfi.status = 'signed'
  `).all(participantOnboardingId);
  const now = new Date();
  const upsertTask = db.prepare(`
    INSERT INTO onboarding_renewal_tasks (
      id, participant_id, participant_onboarding_id, form_instance_id, form_template_id, due_at, reason, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  let created = 0;
  forms.forEach((form) => {
    const dueAt = form.due_at ? new Date(form.due_at) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) return;
    const daysRemaining = Math.ceil((dueAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysRemaining > 30) return;

    const existing = db.prepare(`
      SELECT id
      FROM onboarding_renewal_tasks
      WHERE participant_onboarding_id = ? AND form_instance_id = ? AND status IN ('pending', 'generated')
      LIMIT 1
    `).get(participantOnboardingId, form.id);
    if (existing) return;

    upsertTask.run(
      uuidv4(),
      form.participant_id,
      participantOnboardingId,
      form.id,
      form.template_id,
      dueAt.toISOString(),
      'expires_soon'
    );
    created += 1;
  });
  return created;
}

export function getParticipantEvidenceBundle(participantId) {
  const onboarding = getOnboardingByParticipant(participantId);
  if (!onboarding) return null;

  const auditEvents = db.prepare(`
    SELECT *
    FROM audit_events
    WHERE participant_id = ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(participantId);
  const renewalTasks = db.prepare(`
    SELECT *
    FROM onboarding_renewal_tasks
    WHERE participant_id = ?
    ORDER BY due_at ASC
  `).all(participantId);
  const documents = db.prepare(`
    SELECT *
    FROM participant_documents
    WHERE participant_id = ?
    ORDER BY created_at DESC
  `).all(participantId);

  return {
    onboarding,
    audit_events: auditEvents,
    renewal_tasks: renewalTasks,
    documents
  };
}

export function getProviderComplianceDashboard(organisationId) {
  const provider = db.prepare('SELECT * FROM provider_profiles WHERE organisation_id = ?').get(organisationId);
  if (!provider) {
    return {
      provider_profile: null,
      totals: { participants: 0, complete: 0, awaiting_signature: 0, expired_forms: 0, renewals_due_30_days: 0 },
      participants: []
    };
  }

  const rows = db.prepare(`
    SELECT
      po.id as onboarding_id,
      po.participant_id,
      po.status,
      po.current_stage,
      p.name as participant_name,
      SUM(CASE WHEN pfi.status = 'expired' THEN 1 ELSE 0 END) as expired_forms,
      SUM(CASE WHEN pfi.status = 'signed' THEN 1 ELSE 0 END) as signed_forms,
      COUNT(pfi.id) as total_forms
    FROM participant_onboarding po
    JOIN participants p ON p.id = po.participant_id
    LEFT JOIN participant_form_instances pfi ON pfi.participant_onboarding_id = po.id
    WHERE po.provider_profile_id = ?
    GROUP BY po.id, po.participant_id, po.status, po.current_stage, p.name
    ORDER BY p.name
  `).all(provider.id);

  const renewalsDue = db.prepare(`
    SELECT COUNT(*) as c
    FROM onboarding_renewal_tasks ort
    JOIN participant_onboarding po ON po.id = ort.participant_onboarding_id
    WHERE po.provider_profile_id = ? AND ort.status IN ('pending', 'generated') AND datetime(ort.due_at) <= datetime('now', '+30 day')
  `).get(provider.id)?.c || 0;

  return {
    provider_profile: provider,
    totals: {
      participants: rows.length,
      complete: rows.filter((r) => r.status === 'complete').length,
      awaiting_signature: rows.filter((r) => r.status === 'awaiting_signature').length,
      expired_forms: rows.reduce((sum, row) => sum + (row.expired_forms || 0), 0),
      renewals_due_30_days: renewalsDue
    },
    participants: rows
  };
}

export function getTemplateCoverage(providerProfileId, options = {}) {
  const { workflow: filterWorkflow } = options;
  let sql = `
    SELECT t.id, t.form_type, t.display_name, t.version, t.is_active, t.workflow, t.template_filename, prf.is_required
    FROM form_templates t
    LEFT JOIN provider_required_forms prf ON prf.form_template_id = t.id
    WHERE t.provider_profile_id = ?
  `;
  const params = [providerProfileId];
  if (filterWorkflow) {
    sql += ' AND (t.workflow = ? OR t.workflow IS NULL)';
    params.push(filterWorkflow);
  }
  sql += ' ORDER BY t.form_type, t.version DESC';
  const rows = db.prepare(sql).all(...params);
  const missingCoreTypes = filterWorkflow === 'participant_onboarding'
    ? CORE_FORM_TYPES.filter((type) => !rows.some((row) => row.form_type === type && row.is_active))
    : [];
  return { templates: rows, missing_core_types: missingCoreTypes };
}

export function updateFormTemplate(templateId, updates) {
  const allowed = ['display_name', 'is_active', 'workflow'];
  const setClause = [];
  const values = [];
  for (const key of allowed) {
    if (!(key in updates)) continue;
    if (key === 'is_active') {
      setClause.push('is_active = ?');
      values.push(updates[key] ? 1 : 0);
    } else {
      setClause.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (setClause.length === 0) return null;
  values.push(templateId);
  db.prepare(`UPDATE form_templates SET ${setClause.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM form_templates WHERE id = ?').get(templateId);
}

/** Create a custom form template. version = v1, v2, ... for form_type 'custom'. */
export function createFormTemplate(providerProfileId, { display_name, workflow = 'participant_onboarding' }) {
  const nextVersion = db.prepare(`
    SELECT COALESCE(MAX(CAST(REPLACE(version, 'v', '') AS INTEGER)), 0) + 1 AS n
    FROM form_templates WHERE provider_profile_id = ? AND form_type = 'custom'
  `).get(providerProfileId);
  const version = `v${nextVersion?.n ?? 1}`;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO form_templates (
      id, provider_profile_id, form_type, display_name, version, is_active, workflow, renewal_days
    ) VALUES (?, ?, 'custom', ?, ?, 1, ?, 365)
  `).run(id, providerProfileId, display_name, version, workflow);
  return db.prepare('SELECT * FROM form_templates WHERE id = ?').get(id);
}
