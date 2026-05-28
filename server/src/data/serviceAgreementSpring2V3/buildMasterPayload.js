import { SERVICE_AGREEMENT_TEMPLATE_KEY, VARIABLE_DEFAULTS, VARIABLE_GROUPS } from './variableSchema.js';

export function buildDefinitionPayload() {
  return {
    meta: { definitionRevision: 1 },
    clauses: [],
    checklist: [],
    sectionTitles: {},
    partiesBlockLabels: {}
  };
}

export function buildMasterInsertPayload() {
  const definition = buildDefinitionPayload();
  const variableSchema = {
    defaults: VARIABLE_DEFAULTS,
    groups: VARIABLE_GROUPS
  };
  return {
    template_key: SERVICE_AGREEMENT_TEMPLATE_KEY,
    template_type: 'service_agreement',
    title: 'Service Agreement',
    version_label: 'v3',
    definition_json: JSON.stringify(definition),
    variable_schema_json: JSON.stringify(variableSchema)
  };
}
