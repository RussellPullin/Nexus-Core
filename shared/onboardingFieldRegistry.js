/**
 * Canonical onboarding fields: stable snake_case `key` + human `label`.
 * Used by participant intake (OnboardingPage), staff onboarding (StaffOnboardingFormPage),
 * server save paths, and template merge maps (PDF/Word).
 *
 * Fill modes:
 * - Participant intake: admin completes in Nexus (`OnboardingPage`) via authenticated onboarding API.
 * - Staff onboarding: admin starts from Staff profile; recipient completes via token (`/api/public/staff-onboarding/:token`).
 * - Participant self-service via public link is not implemented yet; same `participant_intake_fields` keys apply when added.
 */

/** @typedef {{ key: string, label: string, section?: string, type?: string }} ParticipantFieldDef */

/** Participant intake: scalar + structured fields stored in participant_intake_fields / intake payload */
export const PARTICIPANT_INTAKE_FIELD_DEFS = [
  { key: 'first_name', label: 'First name', section: 'client', type: 'text' },
  { key: 'last_name', label: 'Last name', section: 'client', type: 'text' },
  { key: 'full_legal_name', label: 'Full legal name (if different)', section: 'client', type: 'text' },
  { key: 'preferred_name', label: 'Preferred name', section: 'client', type: 'text' },
  { key: 'date_of_birth', label: 'Date of birth', section: 'client', type: 'date' },
  { key: 'ndis_number', label: 'NDIS number', section: 'client', type: 'text' },
  { key: 'email', label: 'Email', section: 'client', type: 'text' },
  { key: 'phone', label: 'Phone', section: 'client', type: 'text' },
  { key: 'preferred_contact_method', label: 'Preferred contact method', section: 'client', type: 'text' },
  { key: 'best_time_to_contact', label: 'Best time to contact', section: 'client', type: 'text' },
  { key: 'address', label: 'Address', section: 'client', type: 'text' },
  { key: 'street_address', label: 'Street address', section: 'client', type: 'text' },
  { key: 'suburb_city', label: 'Suburb / City', section: 'client', type: 'text' },
  { key: 'state', label: 'State', section: 'client', type: 'text' },
  { key: 'postcode', label: 'Postcode', section: 'client', type: 'text' },
  { key: 'primary_contact_name', label: 'Primary contact name', section: 'contacts', type: 'text' },
  { key: 'primary_contact_relationship', label: 'Primary contact relationship', section: 'contacts', type: 'text' },
  { key: 'primary_contact_phone', label: 'Primary contact phone', section: 'contacts', type: 'text' },
  { key: 'primary_contact_email', label: 'Primary contact email', section: 'contacts', type: 'text' },
  { key: 'emergency_contact_name', label: 'Emergency contact name', section: 'contacts', type: 'text' },
  { key: 'emergency_contact_relationship', label: 'Emergency contact relationship', section: 'contacts', type: 'text' },
  { key: 'emergency_contact_phone', label: 'Emergency contact phone', section: 'contacts', type: 'text' },
  { key: 'preferred_start_date', label: 'Preferred start date', section: 'service', type: 'date' },
  { key: 'consent_email_sms', label: 'Consent to email/SMS', section: 'service', type: 'text' },
  { key: 'medical_conditions', label: 'Medical conditions', section: 'service', type: 'text' },
  { key: 'medications', label: 'Medications', section: 'service', type: 'text' },
  { key: 'allergies', label: 'Allergies', section: 'service', type: 'text' },
  { key: 'mobility_supports', label: 'Mobility supports', section: 'service', type: 'text' },
  { key: 'support_needs', label: 'Support needs', section: 'service', type: 'text' },
  { key: 'goals_and_outcomes', label: 'Goals and outcomes', section: 'service', type: 'text' },
  { key: 'additional_notes', label: 'Additional notes', section: 'service', type: 'text' },
  { key: 'service_schedule', label: 'Service schedule', section: 'service', type: 'text' },
  { key: 'service_schedule_rows', label: 'Service schedule rows', section: 'service', type: 'json' },
  { key: 'services_required', label: 'Services required', section: 'ndis', type: 'json' },
  { key: 'ndia_managed_services', label: 'NDIA-managed categories', section: 'ndis', type: 'json' },
  { key: 'plan_managed_services', label: 'Plan-managed categories', section: 'ndis', type: 'json' },
  { key: 'plan_start_date', label: 'Plan start date', section: 'ndis', type: 'date' },
  { key: 'plan_end_date', label: 'Plan end date', section: 'ndis', type: 'date' },
  { key: 'scheduled_review_date', label: 'Scheduled review date', section: 'ndis', type: 'date' },
  { key: 'plan_manager_id', label: 'Plan manager', section: 'ndis', type: 'text' },
  { key: 'plan_manager_company_name', label: 'Plan manager company', section: 'ndis', type: 'text' },
  { key: 'plan_manager_invoice_email', label: 'Plan manager invoice email', section: 'ndis', type: 'text' },
  { key: 'additional_invoice_emails', label: 'Additional invoice emails', section: 'ndis', type: 'json' },
  { key: 'plan_manager_details', label: 'Plan manager details', section: 'ndis', type: 'text' },
  { key: 'plan_budget_amount', label: 'Plan budget amount', section: 'ndis', type: 'text' },
  { key: 'funding_management_type', label: 'Funding management', section: 'ndis', type: 'text' },
  { key: 'risks_at_home', label: 'Risks at home', section: 'clinical', type: 'text' },
  { key: 'triggers_stressors', label: 'Triggers / stressors', section: 'clinical', type: 'text' },
  { key: 'current_supports_strategies', label: 'Current supports', section: 'clinical', type: 'text' },
  { key: 'functional_assistance_needs', label: 'Functional assistance needs', section: 'clinical', type: 'text' },
  { key: 'living_arrangements', label: 'Living arrangements', section: 'clinical', type: 'text' },
  { key: 'mental_health_summary', label: 'Mental health summary', section: 'clinical', type: 'text' }
];

/** Map field_key → label for previews and fallbacks */
export function participantFieldLabels() {
  return Object.fromEntries(PARTICIPANT_INTAKE_FIELD_DEFS.map((d) => [d.key, d.label]));
}

/** Dot paths for `form_templates.mapping_json.prefill_fields` (participant onboarding). Keep in sync with seedCoreTemplates. */
export function participantPrefillFieldPaths() {
  return [
    'participant.name',
    'participant.date_of_birth',
    'participant.address',
    'participant.phone',
    'participant.email',
    'participant.ndis_number',
    'plan.start_date',
    'plan.end_date',
    'intake.first_name',
    'intake.last_name',
    'intake.full_legal_name',
    'intake.ndis_number',
    'intake.service_schedule',
    'intake.service_schedule_rows'
  ];
}

/** Initial intake state object */
export function participantEmptyIntake() {
  const o = {};
  for (const d of PARTICIPANT_INTAKE_FIELD_DEFS) {
    if (d.type === 'json') o[d.key] = d.key === 'service_schedule_rows' ? [] : [];
    else o[d.key] = '';
  }
  return o;
}

/**
 * Legal display name for participant.profile + PDFs:
 * optional full_legal_name; else "first last".
 */
export function composeParticipantLegalName(intake) {
  const legal = String(intake?.full_legal_name || '').trim();
  if (legal) return legal;
  const first = String(intake?.first_name || '').trim();
  const last = String(intake?.last_name || '').trim();
  return [first, last].filter(Boolean).join(' ').trim();
}

/** Best-effort split when only a single display name exists (import / legacy profile). */
export function splitParticipantNameFromFull(full) {
  const s = String(full || '').trim();
  if (!s) return { first_name: '', last_name: '', full_legal_name: '' };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '', full_legal_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' '), full_legal_name: '' };
}

/** Staff onboarding: keys aligned with staff_intake_fields + staff row updates */

export const STAFF_ONBOARDING_FIELD_DEFS = [
  // Step 1 – personal
  { key: 'first_name', label: 'First name', step: 1, section: 'personal', type: 'text' },
  { key: 'last_name', label: 'Last name', step: 1, section: 'personal', type: 'text' },
  { key: 'full_legal_name', label: 'Full legal name (if different)', step: 1, section: 'personal', type: 'text' },
  { key: 'date_of_birth', label: 'Date of birth', step: 1, section: 'personal', type: 'date' },
  { key: 'address', label: 'Address', step: 1, section: 'personal', type: 'text' },
  { key: 'phone', label: 'Phone number', step: 1, section: 'personal', type: 'text' },
  { key: 'emergency_contact_name', label: 'Emergency contact name', step: 1, section: 'personal', type: 'text' },
  { key: 'emergency_contact_phone', label: 'Emergency contact phone', step: 1, section: 'personal', type: 'text' },
  // Step 2 – employment (flat keys match POST body)
  { key: 'role', label: 'Role / position', step: 2, section: 'employment', type: 'text' },
  { key: 'employment_type', label: 'Employment type', step: 2, section: 'employment', type: 'text' },
  { key: 'hourly_rate', label: 'Hourly rate', step: 2, section: 'employment', type: 'text' },
  { key: 'abn', label: 'ABN', step: 2, section: 'employment', type: 'text' },
  { key: 'tfn', label: 'Tax file number', step: 2, section: 'employment', type: 'sensitive' },
  { key: 'super_fund_name', label: 'Super fund name', step: 2, section: 'employment', type: 'text' },
  { key: 'super_member_number', label: 'Super member number', step: 2, section: 'employment', type: 'text' },
  { key: 'bank_bsb', label: 'Bank BSB', step: 2, section: 'employment', type: 'text' },
  { key: 'bank_account', label: 'Bank account number', step: 2, section: 'employment', type: 'sensitive' },
  // Step 4 – policy
  { key: 'policy_acknowledged', label: 'Policy acknowledged', step: 4, section: 'policy', type: 'boolean' },
  { key: 'signature', label: 'Signature', step: 4, section: 'policy', type: 'text' },
  // Step 5
  { key: 'tfd_confirmed', label: 'Tax File Declaration confirmed', step: 5, section: 'tax', type: 'boolean' }
];

export function staffFieldLabels() {
  return Object.fromEntries(STAFF_ONBOARDING_FIELD_DEFS.map((d) => [d.key, d.label]));
}

export function composeStaffDisplayName(fields) {
  const legal = String(fields?.full_legal_name || '').trim();
  if (legal) return legal;
  const first = String(fields?.first_name || '').trim();
  const last = String(fields?.last_name || '').trim();
  const joined = [first, last].filter(Boolean).join(' ').trim();
  if (joined) return joined;
  return String(fields?.full_name || '').trim();
}
