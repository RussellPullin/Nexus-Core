/**
 * Editable variables for the standard NDIS-style Services Agreement template (Version 3).
 * Organisation-specific values default from profile; each tenant overrides via variable_values_json.
 */

export const SERVICE_AGREEMENT_TEMPLATE_KEY = 'service_agreement_standard_v3';

export const VARIABLE_DEFAULTS = {
  principal_names: '',
  establishment_fee_min_hours: 20,
  group_centre_allowance_per_hour: 2,
  shadow_shift_max_hours_per_year: 6,
  invoice_payment_terms_days: 7,
  cancellation_charge_percent: 100,
  cancellation_notice_days: 7,
  complaints_email: '',
  complaints_postal_address: '',
  complaints_phone: '',
  termination_notice_weeks: 4,
  no_contact_termination_months: 2,
  governing_law_jurisdiction: 'Queensland, Australia',
  monitoring_worker_frequency_default: '',
  other_provider_consultation_frequency_default: '',
  document_date_approved: '',
  document_review_date: '',
  document_next_review_date: '',
  board_approval_label: 'The Board'
};

/** UI grouping for the org template editor */
export const VARIABLE_GROUPS = [
  {
    id: 'organisation',
    label: 'Organisation (Section 1 & footer)',
    keys: [
      'org_legal_name',
      'org_trading_name',
      'org_abn',
      'org_address',
      'org_email',
      'org_phone',
      'org_contact_person',
      'principal_names',
      'board_approval_label'
    ],
    descriptions: {
      org_legal_name: 'Legal entity name (defaults from organisation profile).',
      org_trading_name: 'Trading or brand name shown in clauses.',
      org_abn: 'Australian Business Number.',
      org_address: 'Postal or business address.',
      org_email: 'Primary contact email.',
      org_phone: 'Primary phone number.',
      org_contact_person: 'Primary contact person.',
      principal_names: 'Named principals in definitions (e.g. directors).',
      board_approval_label: 'Approval line in document footer (e.g. The Board).'
    }
  },
  {
    id: 'fees',
    label: 'Fees (Clause 6)',
    keys: ['establishment_fee_min_hours', 'group_centre_allowance_per_hour', 'shadow_shift_max_hours_per_year'],
    descriptions: {
      establishment_fee_min_hours: 'Minimum hours per month before establishment fee conditions apply.',
      group_centre_allowance_per_hour: 'Group centre allowance in dollars per hour.',
      shadow_shift_max_hours_per_year: 'Maximum shadow shift hours per calendar year.'
    }
  },
  {
    id: 'payments',
    label: 'Payments (Clause 7)',
    keys: ['invoice_payment_terms_days'],
    descriptions: {
      invoice_payment_terms_days: 'Number of days from invoice date for payment.'
    }
  },
  {
    id: 'cancellation',
    label: 'Cancellation (Clause 10)',
    keys: ['cancellation_charge_percent', 'cancellation_notice_days'],
    descriptions: {
      cancellation_charge_percent: 'Percentage of the agreed fee that may be charged for late cancellations.',
      cancellation_notice_days: 'Minimum clear days notice for cancellations without charge.'
    }
  },
  {
    id: 'complaints',
    label: 'Complaints (Clause 12)',
    keys: ['complaints_email', 'complaints_postal_address', 'complaints_phone'],
    descriptions: {
      complaints_email: 'Email for complaints (defaults from organisation email when blank).',
      complaints_postal_address: 'Postal address for written complaints.',
      complaints_phone: 'Phone number for complaints.'
    }
  },
  {
    id: 'termination',
    label: 'Termination (Clause 13)',
    keys: ['termination_notice_weeks', 'no_contact_termination_months'],
    descriptions: {
      termination_notice_weeks: 'Notice period for termination in weeks.',
      no_contact_termination_months: 'Months without contact after which termination may apply.'
    }
  },
  {
    id: 'general',
    label: 'General (Clause 16)',
    keys: ['governing_law_jurisdiction'],
    descriptions: {
      governing_law_jurisdiction: 'Governing law and jurisdiction.'
    }
  },
  {
    id: 'schedule_defaults',
    label: 'Section 2 defaults',
    keys: ['monitoring_worker_frequency_default', 'other_provider_consultation_frequency_default'],
    descriptions: {
      monitoring_worker_frequency_default: 'Default monitoring frequency (overridable per agreement).',
      other_provider_consultation_frequency_default: 'Default consultation frequency with other providers.'
    }
  },
  {
    id: 'document_control',
    label: 'Document control (footer)',
    keys: ['document_date_approved', 'document_review_date', 'document_next_review_date'],
    descriptions: {
      document_date_approved: 'Date approved (footer).',
      document_review_date: 'Review date (footer).',
      document_next_review_date: 'Next review date (footer).'
    }
  }
];
