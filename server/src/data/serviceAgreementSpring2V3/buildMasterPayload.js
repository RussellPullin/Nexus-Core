import {
  DOCUMENT_META,
  SECTION_TITLES,
  PARTIES_BLOCK_LABELS,
  TERMS_CLAUSES,
  AGREEMENT_CHECKLIST
} from './documentBody.js';
import { EDITABLE_SECTIONS } from './fieldCatalog.js';
import { VARIABLE_DEFAULTS, VARIABLE_GROUPS, SERVICE_AGREEMENT_TEMPLATE_KEY } from './variableSchema.js';

export { DOCUMENT_META };

/**
 * Full master definition stored in `nexus_form_template_masters.definition_json`.
 * PDF and preview renderers consume this structure; clause wording stays immutable per master revision.
 */
export function buildDefinitionPayload() {
  return {
    meta: DOCUMENT_META,
    sectionTitles: SECTION_TITLES,
    partiesBlockLabels: PARTIES_BLOCK_LABELS,
    checklist: AGREEMENT_CHECKLIST,
    clauses: TERMS_CLAUSES,
    editableSections: EDITABLE_SECTIONS
  };
}

export function buildBrandingSlotsPayload() {
  return [
    { key: 'logo', label: 'Logo', type: 'image', source: 'organisation.logo_path' },
    { key: 'primary_colour', label: 'Primary colour', type: 'colour', source: 'organisation.brand_primary_color' },
    { key: 'org_name', label: 'Organisation name', type: 'text', source: 'organisation.trading_name' },
    { key: 'abn', label: 'ABN', type: 'text', source: 'organisation.abn' },
    { key: 'address', label: 'Address', type: 'text', source: 'organisation.address' },
    { key: 'phone', label: 'Phone', type: 'text', source: 'organisation.phone' },
    { key: 'email', label: 'Email', type: 'text', source: 'organisation.email' }
  ];
}

export function buildVariableSlotsPayload() {
  return VARIABLE_GROUPS.flatMap((group) =>
    (group.keys || []).map((key) => ({
      key,
      label: group.descriptions?.[key] || key.replace(/_/g, ' '),
      group: group.id,
      default_value: VARIABLE_DEFAULTS[key] ?? ''
    }))
  );
}

export function buildSectionsPayload() {
  const clauseHtml = TERMS_CLAUSES.map(
    (clause) =>
      `<h3>Clause ${clause.number}: ${clause.title}</h3><p>${String(clause.body || '').replace(/\n\n/g, '</p><p>')}</p>`
  ).join('');

  return [
    {
      id: 'parties',
      title: SECTION_TITLES.s1,
      locked: false,
      body_html:
        '<h3>Service Provider (We / Us)</h3>' +
        '<p><strong>Organisation:</strong> {{org_legal_name}}</p>' +
        '<p><strong>ABN:</strong> {{org_abn}}</p>' +
        '<p><strong>Address:</strong> {{org_address}}</p>' +
        '<p><strong>Phone:</strong> {{org_phone}}</p>' +
        '<p><strong>Email:</strong> {{org_email}}</p>' +
        '<p><strong>Contact person:</strong> {{org_contact_person}}</p>' +
        '<h3>Participant details (You)</h3>' +
        '<p><strong>Name:</strong> {{participant_first_name}} {{participant_last_name}}</p>' +
        '<p><strong>NDIS number:</strong> {{participant_ndis_number}}</p>' +
        '<p><strong>Date of birth:</strong> {{participant_date_of_birth}}</p>' +
        '<p><strong>Address:</strong> {{participant_address}}</p>' +
        '<p><strong>Phone:</strong> {{participant_phone}}</p>' +
        '<p><strong>Email:</strong> {{participant_email}}</p>' +
        '<p><strong>Preferred contact method:</strong> {{participant_preferred_contact_method}}</p>' +
        '<h3>Representative / Advocate (if applicable)</h3>' +
        '<p><strong>Name:</strong> {{representative_first_name}} {{representative_last_name}}</p>' +
        '<p><strong>Relationship:</strong> {{representative_relationship}}</p>' +
        '<p><strong>Phone:</strong> {{representative_phone}}</p>' +
        '<p><strong>Email:</strong> {{representative_email}}</p>' +
        '<h3>Funding Management</h3>' +
        '<p><strong>Arrangement:</strong> {{funding_management_type}}</p>' +
        '<p><strong>Plan manager (if plan-managed):</strong> {{plan_manager_company_name}}</p>' +
        '<p><strong>Plan manager email:</strong> {{plan_manager_invoice_email}}</p>'
    },
    {
      id: 'key_details',
      title: SECTION_TITLES.s2,
      locked: false,
      body_html:
        '<p><strong>Agreement date:</strong> {{agreement_date}}</p>' +
        '<p><strong>Plan start date:</strong> {{plan_start_date}}</p>' +
        '<p><strong>Plan end / review date:</strong> {{plan_end_date}}</p>' +
        '<p><strong>Scheduled review date:</strong> {{scheduled_review_date}}</p>' +
        '<p><strong>Preferred communication:</strong> {{communication_preferences}}</p>' +
        '<p><strong>Services and supports schedule:</strong> Attached or completed at onboarding</p>'
    },
    {
      id: 'terms',
      title: SECTION_TITLES.s4,
      locked: false,
      body_html: clauseHtml
    },
    {
      id: 'execution',
      title: 'Execution — Signatures',
      locked: false,
      body_html:
        '<p>By signing below, both parties agree to the terms of this Services Agreement.</p>' +
        '<p><strong>Provider signatory:</strong> {{org_signatory_name}}</p>' +
        '<p><strong>Role:</strong> {{org_contact_person}}</p>' +
        '<p><strong>Date:</strong> ___________________________</p>' +
        '<p><strong>Participant name (print):</strong> {{participant_first_name}} {{participant_last_name}}</p>' +
        '<p><strong>Representative name (if signing on behalf):</strong> {{representative_first_name}} {{representative_last_name}}</p>' +
        '<p><strong>Relationship to participant:</strong> {{representative_relationship}}</p>' +
        '<p><strong>Date:</strong> ___________________________</p>'
    }
  ];
}

export function buildPageLayoutPayload() {
  return {
    paper: 'A4',
    margins: { top: 48, right: 48, bottom: 56, left: 48 },
    font_family: 'Helvetica',
    font_size: 9.5,
    header_height: 108
  };
}

export function buildVariableSchemaPayload() {
  return {
    template_key: SERVICE_AGREEMENT_TEMPLATE_KEY,
    defaults: { ...VARIABLE_DEFAULTS },
    groups: VARIABLE_GROUPS
  };
}

export function buildMasterInsertPayload() {
  return {
    template_key: SERVICE_AGREEMENT_TEMPLATE_KEY,
    template_type: 'service_agreement',
    title: 'NDIS Services Agreement',
    version_label: '',
    definition_json: JSON.stringify(buildDefinitionPayload()),
    variable_schema_json: JSON.stringify(buildVariableSchemaPayload()),
    branding_slots_json: JSON.stringify(buildBrandingSlotsPayload()),
    variable_slots_json: JSON.stringify(buildVariableSlotsPayload()),
    sections_json: JSON.stringify(buildSectionsPayload()),
    page_layout_json: JSON.stringify(buildPageLayoutPayload()),
    category: 'service_agreement'
  };
}
