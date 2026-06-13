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
      locked: true,
      body_html:
        '<p>This section identifies the service provider, participant, representative details where applicable, and funding arrangement for the agreement.</p>'
    },
    {
      id: 'key_details',
      title: SECTION_TITLES.s2,
      locked: true,
      body_html:
        '<p>This section records the agreement date, scheduled review date, communication preferences, and the services and supports schedule.</p>'
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
      locked: true,
      body_html:
        '<p>The provider, participant, and representative where applicable sign this agreement after the details above have been reviewed.</p>'
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
    title: 'NDIS Services Agreement (Version 3)',
    version_label: 'Version 3',
    definition_json: JSON.stringify(buildDefinitionPayload()),
    variable_schema_json: JSON.stringify(buildVariableSchemaPayload()),
    branding_slots_json: JSON.stringify(buildBrandingSlotsPayload()),
    variable_slots_json: JSON.stringify(buildVariableSlotsPayload()),
    sections_json: JSON.stringify(buildSectionsPayload()),
    page_layout_json: JSON.stringify(buildPageLayoutPayload()),
    category: 'service_agreement'
  };
}
