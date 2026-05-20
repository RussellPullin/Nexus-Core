/**
 * Pre-flight gaps for Service Agreement PDF — missing fields that would appear empty in the document.
 */
import { buildServiceAgreementSnapshot } from './serviceAgreementSnapshot.service.js';

function isBlank(v) {
  if (v == null) return true;
  return String(v).trim() === '';
}

/**
 * @param {object} params — same shape as buildServiceAgreementSnapshot
 * @returns {{ gaps: Array<{ id: string, severity: 'blocking' | 'warning', title: string, description: string, section: string, fix: object }>, blocking_count: number, warning_count: number }}
 */
export function computeServiceAgreementGaps(params) {
  const snapshot = buildServiceAgreementSnapshot(params);
  const gaps = [];

  const add = (gap) => gaps.push(gap);

  const p = snapshot.participant || {};
  const o = snapshot.org || {};
  const rv = snapshot.resolved_variables || {};
  const s2 = snapshot.section2 || {};
  const fund = snapshot.funding || {};

  if (isBlank(p.name)) {
    add({
      id: 'participant_name',
      severity: 'blocking',
      title: 'Participant full name',
      description: 'The agreement cannot list a participant without a name.',
      section: 'Section 1 — Participant details',
      fix: { kind: 'onboarding_intake', field: 'first_name' }
    });
  }

  if (isBlank(o.legal_name) && isBlank(o.trading_name)) {
    add({
      id: 'org_legal_name',
      severity: 'blocking',
      title: 'Organisation / provider name',
      description: 'Service Provider block needs a legal or trading name from your organisation or company settings.',
      section: 'Section 1 — Service Provider',
      fix: { kind: 'settings', section: 'company', anchor_id: 'settings-section-company' }
    });
  }

  if (isBlank(o.abn)) {
    add({
      id: 'org_abn',
      severity: 'warning',
      title: 'Organisation ABN',
      description: 'ABN will appear blank in the provider details and definitions.',
      section: 'Section 1 / definitions',
      fix: { kind: 'settings', section: 'company', anchor_id: 'settings-section-company' }
    });
  }

  if (isBlank(o.address)) {
    add({
      id: 'org_address',
      severity: 'warning',
      title: 'Organisation postal address',
      description: 'Provider address will be blank.',
      section: 'Section 1 — Service Provider',
      fix: { kind: 'settings', section: 'company', anchor_id: 'settings-section-company' }
    });
  }

  if (isBlank(o.email)) {
    add({
      id: 'org_email',
      severity: 'warning',
      title: 'Organisation email',
      description: 'Provider email will be blank.',
      section: 'Section 1 — Service Provider',
      fix: { kind: 'settings', section: 'company', anchor_id: 'settings-section-company' }
    });
  }

  if (isBlank(o.phone)) {
    add({
      id: 'org_phone',
      severity: 'warning',
      title: 'Organisation phone',
      description: 'Provider phone will be blank.',
      section: 'Section 1 — Service Provider',
      fix: { kind: 'settings', section: 'company', anchor_id: 'settings-section-company' }
    });
  }

  if (isBlank(o.contact_person)) {
    add({
      id: 'org_contact_person',
      severity: 'warning',
      title: 'Contact person',
      description: 'No named contact person for the provider (defaults from an admin user when available).',
      section: 'Section 1 — Service Provider',
      fix: { kind: 'settings', section: 'company', anchor_id: 'settings-section-company' }
    });
  }

  if (isBlank(rv.principal_names)) {
    add({
      id: 'principal_names',
      severity: 'warning',
      title: 'Principal names (definitions)',
      description: 'Clause 1 definitions reference responsible persons — currently blank in your template.',
      section: 'Section 4 — Clause 1',
      fix: { kind: 'forms' }
    });
  }

  if (isBlank(rv.complaints_email) && isBlank(rv.complaints_phone) && isBlank(rv.complaints_postal_address)) {
    add({
      id: 'complaints_contact',
      severity: 'warning',
      title: 'Complaints contact details',
      description: 'Clause 12 contact lines may all be empty if org profile and template variables are blank.',
      section: 'Section 4 — Clause 12',
      fix: { kind: 'forms' }
    });
  }

  if (isBlank(p.ndis_number)) {
    add({
      id: 'participant_ndis',
      severity: 'warning',
      title: 'NDIS number',
      description: 'NDIS number will be blank for the participant.',
      section: 'Section 1 — Participant details',
      fix: { kind: 'onboarding_intake', field: 'ndis_number' }
    });
  }

  if (isBlank(p.address)) {
    add({
      id: 'participant_address',
      severity: 'warning',
      title: 'Participant address',
      description: 'Address will be blank (add in profile or intake).',
      section: 'Section 1 — Participant details',
      fix: { kind: 'onboarding_intake', field: 'street_address' }
    });
  }

  if (isBlank(p.phone)) {
    add({
      id: 'participant_phone',
      severity: 'warning',
      title: 'Participant phone',
      description: 'Phone will be blank.',
      section: 'Section 1 — Participant details',
      fix: { kind: 'onboarding_intake', field: 'phone' }
    });
  }

  if (isBlank(p.email)) {
    add({
      id: 'participant_email',
      severity: 'warning',
      title: 'Participant email',
      description: 'Email will be blank.',
      section: 'Section 1 — Participant details',
      fix: { kind: 'onboarding_intake', field: 'email' }
    });
  }

  if (isBlank(p.plan_start) || isBlank(p.plan_expiry)) {
    add({
      id: 'plan_dates',
      severity: 'warning',
      title: 'NDIS plan start / expiry',
      description: 'No current plan dates found — plan fields will be blank or review date may not match the plan.',
      section: 'Section 1 & 2',
      fix: { kind: 'participant_profile', tab: 'plans', anchor_id: 'sa-gap-plans' }
    });
  }

  if (fund.show_plan_manager && fund.plan_manager) {
    const pm = fund.plan_manager;
    if (isBlank(pm.name) || isBlank(pm.email)) {
      add({
        id: 'plan_manager_details',
        severity: 'warning',
        title: 'Plan manager details',
        description: 'Plan-managed funding is selected but plan manager name or email is missing.',
        section: 'Section 1 — Plan Manager',
        fix: { kind: 'participant_profile', tab: 'overview', anchor_id: 'sa-gap-key-information', open_edit: true }
      });
    }
  }

  if (!snapshot.schedule_rows?.length) {
    add({
      id: 'service_schedule',
      severity: 'warning',
      title: 'Services & supports schedule',
      description: 'No schedule rows from plan allocations or intake — Section 2 schedule will be empty.',
      section: 'Section 2',
      fix: { kind: 'participant_profile', tab: 'plans', anchor_id: 'sa-gap-plans' }
    });
  }

  const io = params.instanceOverrides || {};
  if (isBlank(io.scheduled_review_date) && isBlank(p.plan_expiry)) {
    add({
      id: 'scheduled_review',
      severity: 'warning',
      title: 'Scheduled review date',
      description: 'No plan expiry and no review date chosen — Section 2 may need an explicit review date.',
      section: 'Section 2',
      fix: { kind: 'agreements_tab', anchor_id: 'sa-gap-agreements-fields' }
    });
  }

  if (isBlank(s2.communication_preferences)) {
    add({
      id: 'communication_preferences',
      severity: 'warning',
      title: 'Communication preferences',
      description: 'No preferred contact method from intake — field may be blank.',
      section: 'Section 2',
      fix: { kind: 'agreements_tab', anchor_id: 'sa-gap-agreements-fields' }
    });
  }

  const blocking = gaps.filter((g) => g.severity === 'blocking').length;
  const warning = gaps.filter((g) => g.severity === 'warning').length;

  return {
    gaps,
    blocking_count: blocking,
    warning_count: warning,
    can_generate: blocking === 0
  };
}
