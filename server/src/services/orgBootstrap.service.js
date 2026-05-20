/**
 * Phase 1: One-call bootstrap that wires a freshly-created org into the master template ecosystem.
 *
 * Called after `POST /organisations/me/profile` with `setup_completed=true` (org setup wizard's
 * "Finish" step) and also exposed via `POST /api/organisations/me/seed-templates` for manual reseed.
 *
 *  1. Clone every active `nexus_form_template_masters` row into `nexus_org_form_templates`.
 *  2. Clone every active `document_library_masters` row into `document_library_org_clones`.
 *  3. Ensure a `provider_profiles` row exists so onboarding flows can begin immediately.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { cloneAllLibraryMastersForOrg } from './documentLibrary.service.js';
import { mergeBranding } from './nexusFormTemplateRuntime.service.js';

/**
 * @param {string} orgId
 * @returns {{
 *   nexus_masters_cloned: number,
 *   library_masters_cloned: number,
 *   provider_profile_id: string,
 *   skipped_existing: number
 * }}
 */
export function seedOrgFromMasters(orgId) {
  if (!orgId) throw new Error('orgId required');

  const result = {
    nexus_masters_cloned: 0,
    library_masters_cloned: 0,
    provider_profile_id: '',
    skipped_existing: 0
  };

  // ---- 1. Nexus structured masters -> per-org instance ----
  const nexusMasters = db.prepare('SELECT * FROM nexus_form_template_masters').all();
  const orgClonesByMaster = new Map(
    db
      .prepare('SELECT master_id FROM nexus_org_form_templates WHERE org_id = ?')
      .all(orgId)
      .map((r) => [r.master_id, true])
  );
  const insertNexus = db.prepare(
    `INSERT INTO nexus_org_form_templates (id, org_id, master_id, label, variable_values_json, branding_json, metadata_json)
     VALUES (?, ?, ?, ?, '{}', ?, '{}')`
  );
  const tx = db.transaction(() => {
    for (const master of nexusMasters) {
      if (orgClonesByMaster.has(master.id)) {
        result.skipped_existing += 1;
        continue;
      }
      insertNexus.run(
        uuidv4(),
        orgId,
        master.id,
        master.title || 'Untitled template',
        JSON.stringify(mergeBranding(null))
      );
      result.nexus_masters_cloned += 1;
    }
  });
  tx();

  // ---- 2. File-based document library -> per-org clone rows ----
  const libraryResult = cloneAllLibraryMastersForOrg(orgId);
  result.library_masters_cloned = libraryResult.cloned;

  // ---- 3. Ensure provider_profiles exists ----
  const existing = db.prepare('SELECT id FROM provider_profiles WHERE organisation_id = ?').get(orgId);
  if (existing?.id) {
    result.provider_profile_id = existing.id;
  } else {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO provider_profiles (id, organisation_id, onboarding_enabled, onboarding_pilot, signature_mode, default_renewal_days, config_json, created_at, updated_at)
      VALUES (?, ?, 0, 1, 'hybrid', 365, '{}', datetime('now'), datetime('now'))
    `).run(id, orgId);
    result.provider_profile_id = id;
  }

  return result;
}
