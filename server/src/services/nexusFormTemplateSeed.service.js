/**
 * Seeds system-level form template masters once (SQLite).
 */
import { v4 as uuidv4 } from 'uuid';
import { buildMasterInsertPayload } from '../data/serviceAgreementSpring2V3/buildMasterPayload.js';
import { SERVICE_AGREEMENT_TEMPLATE_KEY } from '../data/serviceAgreementSpring2V3/variableSchema.js';

/**
 * @param {import('better-sqlite3').Database} database
 */
export function seedNexusFormTemplateMastersIfNeeded(database) {
  const existing = database
    .prepare('SELECT id FROM nexus_form_template_masters WHERE template_key = ?')
    .get(SERVICE_AGREEMENT_TEMPLATE_KEY);
  if (existing) return { seeded: false, master_id: existing.id };

  const payload = buildMasterInsertPayload();
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
  return { seeded: true, master_id: id };
}
