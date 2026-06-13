/**
 * Field catalog for the standard Services Agreement (Version 3 layout).
 * Labels every fillable area; org-editable fields map to variable_values_json.
 * Participant fields are filled at generation from intake / participant profile.
 */

export const FIELD_SOURCES = {
  organisation: 'organisation',
  participant: 'participant',
  representative: 'representative',
  funding: 'funding',
  schedule: 'schedule',
  checklist: 'checklist',
  signatures: 'signatures',
  generated: 'generated'
};

/** @typedef {{ key: string, label: string, hint?: string, source: string, editableByOrg?: boolean, format?: string }} FieldDef */

/** @type {{ id: string, title: string, description?: string, blocks: { id: string, label: string, fields: FieldDef[] }[] }[]} */
export const EDITABLE_SECTIONS = [
  {
    id: 's1',
    title: 'Section 1 — Parties to this Agreement',
    description: 'Provider details come from your organisation profile and overrides below. Participant fields are filled from each participant’s profile and onboarding intake when you generate the agreement.',
    blocks: [
      {
        id: 'service_provider',
        label: 'Service Provider (We / Us)',
        fields: [
          { key: 'org_legal_name', label: 'Organisation (legal name)', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'org_abn', label: 'ABN', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'org_address', label: 'Address', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'org_email', label: 'Email', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'org_contact_person', label: 'Contact person', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'org_phone', label: 'Phone', source: FIELD_SOURCES.organisation, editableByOrg: true }
        ]
      },
      {
        id: 'client_details',
        label: 'Participant details (You)',
        fields: [
          { key: 'participant_first_name', label: 'First name', source: FIELD_SOURCES.participant, hint: 'From participant intake' },
          { key: 'participant_last_name', label: 'Last name', source: FIELD_SOURCES.participant, hint: 'From participant intake' },
          { key: 'participant_phone', label: 'Phone', source: FIELD_SOURCES.participant },
          { key: 'participant_mobile', label: 'Mobile', source: FIELD_SOURCES.participant },
          { key: 'participant_email', label: 'Email address', source: FIELD_SOURCES.participant },
          { key: 'participant_date_of_birth', label: 'Date of birth', source: FIELD_SOURCES.participant, format: 'DD/MM/YYYY' },
          { key: 'participant_ndis_number', label: 'NDIS number', source: FIELD_SOURCES.participant },
          { key: 'participant_street_address', label: 'Street address', source: FIELD_SOURCES.participant },
          { key: 'participant_suburb', label: 'Suburb', source: FIELD_SOURCES.participant },
          { key: 'participant_state', label: 'State', source: FIELD_SOURCES.participant },
          { key: 'participant_postcode', label: 'Postal code', source: FIELD_SOURCES.participant },
          { key: 'participant_plan_start', label: 'Plan start date', source: FIELD_SOURCES.participant, format: 'DD/MM/YYYY' },
          { key: 'participant_plan_expiry', label: 'Plan expiry date', source: FIELD_SOURCES.participant, format: 'DD/MM/YYYY' }
        ]
      },
      {
        id: 'representative',
        label: 'Representative / Advocate (if applicable)',
        fields: [
          { key: 'representative_first_name', label: 'First name', source: FIELD_SOURCES.representative },
          { key: 'representative_last_name', label: 'Last name', source: FIELD_SOURCES.representative },
          { key: 'representative_phone', label: 'Phone', source: FIELD_SOURCES.representative },
          { key: 'representative_mobile', label: 'Mobile', source: FIELD_SOURCES.representative },
          { key: 'representative_email', label: 'Email address', source: FIELD_SOURCES.representative },
          { key: 'representative_relationship', label: 'Relationship to client', source: FIELD_SOURCES.representative }
        ]
      },
      {
        id: 'invoicing_funding',
        label: 'Invoicing / Funding Management',
        fields: [
          { key: 'funding_management_type', label: 'Funding arrangement', source: FIELD_SOURCES.funding, hint: 'Self-managed, plan-managed, NDIA-managed, or nominee' },
          { key: 'plan_manager_name', label: 'Plan manager name', source: FIELD_SOURCES.funding },
          { key: 'plan_manager_email', label: 'Plan manager email', source: FIELD_SOURCES.funding }
        ]
      },
      {
        id: 'document_control',
        label: 'Document control (footer on each page)',
        fields: [
          { key: 'document_date_approved', label: 'Approved by / date approved', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'document_review_date', label: 'Review date', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'document_next_review_date', label: 'Next review date', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'board_approval_label', label: 'Approval line label', source: FIELD_SOURCES.organisation, editableByOrg: true, hint: 'e.g. The Board' }
        ]
      }
    ]
  },
  {
    id: 's2',
    title: 'Section 2 — Key Details',
    description: 'Agreement dates and schedule rows are set when generating for each participant.',
    blocks: [
      {
        id: 'key_details',
        label: 'Key details',
        fields: [
          { key: 'agreement_date', label: 'Date of agreement', source: FIELD_SOURCES.generated, format: 'DD/MM/YYYY' },
          { key: 'scheduled_review_date', label: 'Scheduled review date', source: FIELD_SOURCES.generated, format: 'DD/MM/YYYY' },
          {
            key: 'monitoring_worker_frequency_default',
            label: 'Monitoring of worker frequency (default)',
            source: FIELD_SOURCES.organisation,
            editableByOrg: true,
            hint: 'Default in template; can override when generating each agreement'
          },
          {
            key: 'other_provider_consultation_frequency_default',
            label: 'Other provider consultation frequency (default)',
            source: FIELD_SOURCES.organisation,
            editableByOrg: true
          },
          { key: 'communication_preferences', label: 'Communication preferences', source: FIELD_SOURCES.participant }
        ]
      },
      {
        id: 'services_schedule',
        label: 'Services and Supports Schedule',
        fields: [
          { key: 'schedule_description', label: 'Support / service (description)', source: FIELD_SOURCES.schedule },
          { key: 'schedule_price', label: 'Price', source: FIELD_SOURCES.schedule },
          { key: 'schedule_appointment_times', label: 'Appointment times', source: FIELD_SOURCES.schedule },
          { key: 'schedule_duration', label: 'Duration', source: FIELD_SOURCES.schedule },
          { key: 'schedule_total_costs', label: 'Total costs', source: FIELD_SOURCES.schedule }
        ]
      }
    ]
  },
  {
    id: 's3',
    title: 'Section 3 — Agreement Checklist',
    description: 'Yes / No / N/A and notes are completed on the printed or signed copy.',
    blocks: [
      {
        id: 'checklist',
        label: 'Administration checklist',
        fields: [
          { key: 'chk_provided_agreement', label: 'Client provided this agreement (date & method)', source: FIELD_SOURCES.checklist },
          { key: 'chk_intake_consistent', label: 'Consistent with client intake form', source: FIELD_SOURCES.checklist },
          { key: 'chk_understood', label: 'Client supported to understand agreement', source: FIELD_SOURCES.checklist },
          { key: 'chk_representative_present', label: 'Representative or advocate present', source: FIELD_SOURCES.checklist },
          { key: 'chk_client_signed', label: 'Client signed the agreement', source: FIELD_SOURCES.checklist },
          { key: 'chk_provider_signed', label: 'Provider signed the agreement', source: FIELD_SOURCES.checklist },
          { key: 'chk_copy_provided', label: 'Fully signed copy provided to client', source: FIELD_SOURCES.checklist }
        ]
      }
    ]
  },
  {
    id: 's4',
    title: 'Section 4 — Terms of Agreement',
    description: 'Clause wording uses your organisation name and the editable values below (fees, complaints, termination, etc.).',
    blocks: [
      {
        id: 'clause_variables',
        label: 'Terms that appear in clauses',
        fields: [
          { key: 'principal_names', label: 'Principal / responsible persons', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'establishment_fee_min_hours', label: 'Establishment fee minimum hours per month', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'group_centre_allowance_per_hour', label: 'Group centre allowance ($/hour)', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'shadow_shift_max_hours_per_year', label: 'Shadow shift max hours per year', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'invoice_payment_terms_days', label: 'Invoice payment terms (days)', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'cancellation_notice_days', label: 'Cancellation notice (days)', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'cancellation_charge_percent', label: 'Cancellation charge (%)', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'complaints_email', label: 'Complaints email', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'complaints_postal_address', label: 'Complaints postal address', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'complaints_phone', label: 'Complaints phone', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'termination_notice_weeks', label: 'Termination notice (weeks)', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'no_contact_termination_months', label: 'No-contact termination (months)', source: FIELD_SOURCES.organisation, editableByOrg: true },
          { key: 'governing_law_jurisdiction', label: 'Governing law', source: FIELD_SOURCES.organisation, editableByOrg: true }
        ]
      }
    ]
  },
  {
    id: 'execution',
    title: 'Execution — Signatures',
    description: 'Signature blocks are left blank on generated PDFs for wet or digital signing.',
    blocks: [
      {
        id: 'signatures',
        label: 'Signatures',
        fields: [
          { key: 'provider_signature', label: 'Provider signature', source: FIELD_SOURCES.signatures },
          { key: 'provider_signatory_name', label: 'Provider signatory name (print)', source: FIELD_SOURCES.signatures },
          { key: 'provider_signature_date', label: 'Provider signature date', source: FIELD_SOURCES.signatures, format: 'DD/MM/YYYY' },
          { key: 'client_signature', label: 'Client signature', source: FIELD_SOURCES.signatures },
          { key: 'client_signatory_name', label: 'Client name (print)', source: FIELD_SOURCES.signatures },
          { key: 'client_signature_date', label: 'Client signature date', source: FIELD_SOURCES.signatures, format: 'DD/MM/YYYY' },
          { key: 'representative_signature', label: 'Representative signature', source: FIELD_SOURCES.signatures },
          { key: 'representative_signatory_name', label: 'Representative name (print)', source: FIELD_SOURCES.signatures },
          { key: 'representative_signature_date', label: 'Representative signature date', source: FIELD_SOURCES.signatures, format: 'DD/MM/YYYY' }
        ]
      }
    ]
  }
];
