export const SERVICE_AGREEMENT_TEMPLATE_KEY = 'service_agreement_spring2_v3';

export const VARIABLE_DEFAULTS = {
  org_legal_name: '',
  org_trading_name: '',
  org_abn: '',
  org_address: '',
  org_email: '',
  org_phone: '',
  org_contact_person: '',
  document_date_approved: '',
  document_review_date: '',
  document_next_review_date: '',
  monitoring_worker_frequency_default: 'As agreed between the parties',
  other_provider_consultation_frequency_default: 'As agreed between the parties'
};

export const VARIABLE_GROUPS = [
  {
    key: 'organisation',
    label: 'Organisation Details',
    variables: ['org_legal_name', 'org_trading_name', 'org_abn', 'org_address', 'org_email', 'org_phone', 'org_contact_person']
  },
  {
    key: 'document',
    label: 'Document Info',
    variables: ['document_date_approved', 'document_review_date', 'document_next_review_date']
  },
  {
    key: 'service',
    label: 'Service Delivery',
    variables: ['monitoring_worker_frequency_default', 'other_provider_consultation_frequency_default']
  }
];
