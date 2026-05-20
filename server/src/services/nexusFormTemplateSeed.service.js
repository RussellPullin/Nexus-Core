/**
 * Seeds system-level form template masters once (SQLite); refreshes definition when revision changes.
 */
import { v4 as uuidv4 } from 'uuid';
import { buildMasterInsertPayload, buildDefinitionPayload } from '../data/serviceAgreementSpring2V3/buildMasterPayload.js';
import { SERVICE_AGREEMENT_TEMPLATE_KEY } from '../data/serviceAgreementSpring2V3/variableSchema.js';

function parseDefinitionRevision(definitionJson) {
  try {
    const def = typeof definitionJson === 'string' ? JSON.parse(definitionJson) : definitionJson;
    return def?.meta?.definitionRevision ?? 0;
  } catch {
    return 0;
  }
}

/**
 * @param {import('better-sqlite3').Database} database
 */
export function seedNexusFormTemplateMastersIfNeeded(database) {
  const payload = buildMasterInsertPayload();
  const existing = database
    .prepare('SELECT id, definition_json FROM nexus_form_template_masters WHERE template_key = ?')
    .get(SERVICE_AGREEMENT_TEMPLATE_KEY);

  const targetRevision = buildDefinitionPayload().meta?.definitionRevision ?? 0;

  if (existing) {
    const currentRevision = parseDefinitionRevision(existing.definition_json);
    if (currentRevision < targetRevision) {
      database
        .prepare(
          `UPDATE nexus_form_template_masters
           SET title = ?, version_label = ?, definition_json = ?, variable_schema_json = ?
           WHERE id = ?`
        )
        .run(payload.title, payload.version_label, payload.definition_json, payload.variable_schema_json, existing.id);
      return { seeded: false, refreshed: true, master_id: existing.id };
    }
    return { seeded: false, refreshed: false, master_id: existing.id };
  }

  const id = uuidv4();
  database
    .prepare(
      `INSERT INTO nexus_form_template_masters (id, template_key, template_type, title, version_label, definition_json, variable_schema_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      payload.template_key,
      payload.template_type,
      payload.title,
      payload.version_label,
      payload.definition_json,
      payload.variable_schema_json
    );
  return { seeded: true, refreshed: false, master_id: id };
}
