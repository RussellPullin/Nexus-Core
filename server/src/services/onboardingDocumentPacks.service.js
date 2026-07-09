/**
 * Onboarding document attachments.
 *
 * The branded document library is the single source for onboarding documents.
 * Attachments come from (1) active, cloned library masters tagged for the
 * workflow (rendered branded) plus (2) the org's uploaded extra PDFs
 * (`company_policy_files`) as an escape hatch.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { db } from '../db/index.js';
import { renderLibraryDocument } from './documentLibraryRender.service.js';
import { fillAcroFormWithTokens } from './formFill.service.js';
import {
  manifestMatchesOnboardingContext,
  VALID_PARTICIPANT_SERVICE_TYPES,
  VALID_STAFF_ONBOARDING_ROLES
} from '../../../shared/onboardingDocumentContext.js';

function safeAttachmentFilename(name, ext) {
  const base = (name || 'attachment').replace(/[/\\?%*:|"<>]/g, '_').trim() || 'attachment';
  return `${base}.${ext}`;
}

/**
 * Resolve a stored `company_policy_files.file_path` to an absolute path.
 * Paths are stored relative ("data/onboarding/policies/...") and must survive
 * deploys, so resolve against the persistent DATA_DIR volume.
 */
function resolvePolicyFilePath(filePath) {
  if (!filePath) return null;
  if (filePath.startsWith('/')) return filePath;
  const dataDir = process.env.DATA_DIR || '/data';
  return join(dataDir, filePath.replace(/^data\//, ''));
}

function parseManifest(row) {
  try {
    return row?.manifest_json ? JSON.parse(row.manifest_json) : {};
  } catch {
    return {};
  }
}

/**
 * Active cloned library masters for an org whose manifest `packs` (or legacy `pack`) includes the
 * given onboarding workflow. These are the branded documents attached to /
 * acknowledged during onboarding.
 * @param {string|null} orgId
 * @param {'staff_onboarding'|'participant_onboarding'} workflow
 * @returns {Array<{ id: string, slug: string, display_name: string, manifest: object }>}
 */
export function listOnboardingLibraryMasters(orgId, workflow) {
  if (!orgId || !workflow) return [];
  return db
    .prepare(
      `
    SELECT m.id, m.slug, m.display_name, m.manifest_json
    FROM document_library_masters m
    JOIN document_library_org_clones c ON c.master_id = m.id AND c.org_id = ?
    WHERE c.is_active = 1
      AND m.is_active = 1
      AND (
        JSON_EXTRACT(m.manifest_json, '$.pack') = ?
        OR EXISTS (
          SELECT 1 FROM json_each(JSON_EXTRACT(m.manifest_json, '$.packs'))
          WHERE value = ?
        )
      )
    ORDER BY m.display_name COLLATE NOCASE
  `
    )
    .all(orgId, workflow, workflow)
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      display_name: row.display_name,
      manifest: parseManifest(row)
    }));
}

/**
 * Documents available for runtime selection in the send modal.
 * @param {string|null} orgId
 * @param {'staff_onboarding'|'participant_onboarding'} workflow
 * @param {{ participantServiceType?: string|null, staffRole?: string|null }} [context]
 */
export function listOnboardingPackDocumentsForSelection(orgId, workflow, { participantServiceType = null, staffRole = null } = {}) {
  const ctx =
    workflow === 'participant_onboarding'
      ? { participantServiceType: participantServiceType || 'all' }
      : { staffRole: staffRole || 'all' };

  return listOnboardingLibraryMasters(orgId, workflow).map((master) => {
    const signatureCount = Number(master.manifest.signature_count) || 0;
    return {
      id: master.id,
      slug: master.slug,
      display_name: master.display_name,
      signature_count: signatureCount,
      requires_signature: signatureCount > 0,
      participant_service_types: master.manifest.participant_service_types || ['all'],
      staff_roles: master.manifest.staff_roles || ['all'],
      suggested: manifestMatchesOnboardingContext(master.manifest, ctx)
    };
  });
}

/**
 * Ensure every master id belongs to the workflow pack and is cloned for the org.
 * @param {string|null} orgId
 * @param {'staff_onboarding'|'participant_onboarding'} workflow
 * @param {string[]} masterIds
 */
export function validateOnboardingMasterIds(orgId, workflow, masterIds) {
  if (!orgId || !workflow) throw new Error('Organisation and workflow required');
  if (!Array.isArray(masterIds)) throw new Error('master_ids must be an array');
  if (masterIds.length === 0) return [];

  const allowed = new Set(listOnboardingLibraryMasters(orgId, workflow).map((m) => m.id));
  const invalid = masterIds.filter((id) => !allowed.has(id));
  if (invalid.length) {
    throw new Error('One or more selected documents are not in this onboarding pack for your organisation.');
  }
  return masterIds;
}

/**
 * Render a single branded library master to an email attachment.
 * @returns {Promise<{ filename: string, content: Buffer, contentType: string }|null>}
 */
export async function renderLibraryMasterAttachment(master, orgId, { participant = null, staff = null } = {}) {
  const rendered = renderLibraryDocument({ masterId: master.id, orgId, participant, staff });
  let buf = rendered?.buffer;
  if (rendered?.needsAcroFormFill && buf) {
    buf = await fillAcroFormWithTokens(buf, rendered.tokens);
  }
  if (!buf) return null;
  const ext = rendered.mime === 'application/pdf' ? 'pdf' : 'docx';
  return {
    filename: safeAttachmentFilename(master.display_name || master.slug, ext),
    content: buf,
    contentType: rendered.mime || 'application/pdf'
  };
}

function resolveMastersForAttachments(orgId, workflow, masterIds) {
  const all = listOnboardingLibraryMasters(orgId, workflow);
  if (masterIds == null) return all;
  const selected = new Set(validateOnboardingMasterIds(orgId, workflow, masterIds));
  return all.filter((m) => selected.has(m.id));
}

export function masterRequiresSignature(master) {
  return (Number(master?.manifest?.signature_count) || 0) > 0;
}

/**
 * Split selected (or all) onboarding masters into policy PDFs vs DocuSeal forms.
 * @returns {{ policyMasters: object[], formMasters: object[], policyMasterIds: string[], formMasterIds: string[] }}
 */
export function splitOnboardingMasters(orgId, workflow, masterIds) {
  const masters = resolveMastersForAttachments(orgId, workflow, masterIds);
  const policyMasters = masters.filter((m) => !masterRequiresSignature(m));
  const formMasters = masters.filter((m) => masterRequiresSignature(m));
  return {
    policyMasters,
    formMasters,
    policyMasterIds: policyMasters.map((m) => m.id),
    formMasterIds: formMasters.map((m) => m.id)
  };
}

/**
 * Single source of onboarding email attachments:
 *   1. every branded, active, cloned library document tagged for `workflow`
 *      (or subset when master_ids provided);
 *   2. the org's uploaded extra PDFs (`company_policy_files`) as an escape hatch.
 *
 * @param {string|null} orgId - organisation id (for library clones + branding)
 * @param {string|null} providerProfileId - provider profile id (for extra uploads)
 * @param {'staff_onboarding'|'participant_onboarding'} workflow
 * @param {{
 *   participant?: object|null,
 *   staff?: object|null,
 *   masterIds?: string[]|null,
 *   includeExtraPdfs?: boolean,
 *   signatureFilter?: 'all'|'policy_only'|'form_only'
 * }} [context]
 * @returns {Promise<{ attachments: Array<{ filename: string, content: Buffer, contentType: string }> }>}
 */
export async function buildOnboardingAttachments(
  orgId,
  providerProfileId,
  workflow,
  { participant = null, staff = null, masterIds = null, includeExtraPdfs = true, signatureFilter = 'all' } = {}
) {
  const attachments = [];
  let masters = resolveMastersForAttachments(orgId, workflow, masterIds);
  if (signatureFilter === 'policy_only') {
    masters = masters.filter((m) => !masterRequiresSignature(m));
  } else if (signatureFilter === 'form_only') {
    masters = masters.filter((m) => masterRequiresSignature(m));
  }

  for (const master of masters) {
    try {
      const att = await renderLibraryMasterAttachment(master, orgId, { participant, staff });
      if (att) attachments.push(att);
    } catch (err) {
      console.warn(`[onboarding-attachments] library render failed (${master.slug}):`, err?.message);
    }
  }

  if (includeExtraPdfs !== false && providerProfileId) {
    const policies = db
      .prepare(
        `SELECT id, display_name, file_path FROM company_policy_files WHERE provider_profile_id = ? ORDER BY display_name COLLATE NOCASE`
      )
      .all(providerProfileId);
    for (const pf of policies) {
      const fullPath = resolvePolicyFilePath(pf.file_path);
      if (!fullPath || !existsSync(fullPath)) continue;
      try {
        attachments.push({
          filename: safeAttachmentFilename(pf.display_name || 'document', 'pdf'),
          content: readFileSync(fullPath),
          contentType: 'application/pdf'
        });
      } catch {
        /* skip unreadable file */
      }
    }
  }

  return { attachments };
}

/**
 * Documents a staff member must read/acknowledge during public onboarding:
 *   - branded, active, cloned library documents tagged `staff_onboarding`
 *     (kind: 'library' — served rendered/branded);
 *   - the org's uploaded extra PDFs (kind: 'policy' — escape hatch).
 * @param {string|null} providerProfileId
 * @returns {Array<{ id: string, display_name: string, kind: 'library'|'policy', file_path?: string }>}
 */
export function listPoliciesForStaffOnboarding(providerProfileId) {
  if (!providerProfileId) return [];
  const pp = db.prepare(`SELECT organisation_id FROM provider_profiles WHERE id = ?`).get(providerProfileId);
  const orgId = pp?.organisation_id || null;

  const libraryDocs = listOnboardingLibraryMasters(orgId, 'staff_onboarding').map((m) => ({
    id: m.id,
    display_name: m.display_name,
    kind: 'library'
  }));

  const extraDocs = db
    .prepare(`SELECT id, display_name, file_path FROM company_policy_files WHERE provider_profile_id = ? ORDER BY display_name COLLATE NOCASE`)
    .all(providerProfileId)
    .map((p) => ({ ...p, kind: 'policy' }));

  return [...libraryDocs, ...extraDocs];
}

export { VALID_PARTICIPANT_SERVICE_TYPES, VALID_STAFF_ONBOARDING_ROLES };
