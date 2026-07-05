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

/**
 * Active cloned library masters for an org whose manifest `pack` tag matches the
 * given onboarding workflow. These are the branded documents attached to /
 * acknowledged during onboarding.
 * @param {string|null} orgId
 * @param {'staff_onboarding'|'participant_onboarding'} workflow
 * @returns {Array<{ id: string, slug: string, display_name: string }>}
 */
export function listOnboardingLibraryMasters(orgId, workflow) {
  if (!orgId || !workflow) return [];
  return db
    .prepare(
      `
    SELECT m.id, m.slug, m.display_name
    FROM document_library_masters m
    JOIN document_library_org_clones c ON c.master_id = m.id AND c.org_id = ?
    WHERE c.is_active = 1
      AND m.is_active = 1
      AND JSON_EXTRACT(m.manifest_json, '$.pack') = ?
    ORDER BY m.display_name COLLATE NOCASE
  `
    )
    .all(orgId, workflow);
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

/**
 * Single source of onboarding email attachments:
 *   1. every branded, active, cloned library document tagged for `workflow`;
 *   2. the org's uploaded extra PDFs (`company_policy_files`) as an escape hatch.
 *
 * @param {string|null} orgId - organisation id (for library clones + branding)
 * @param {string|null} providerProfileId - provider profile id (for extra uploads)
 * @param {'staff_onboarding'|'participant_onboarding'} workflow
 * @param {{ participant?: object|null, staff?: object|null }} [context]
 * @returns {Promise<{ attachments: Array<{ filename: string, content: Buffer, contentType: string }> }>}
 */
export async function buildOnboardingAttachments(orgId, providerProfileId, workflow, { participant = null, staff = null } = {}) {
  const attachments = [];

  // 1. Branded library documents tagged for this workflow.
  for (const master of listOnboardingLibraryMasters(orgId, workflow)) {
    try {
      const att = await renderLibraryMasterAttachment(master, orgId, { participant, staff });
      if (att) attachments.push(att);
    } catch (err) {
      console.warn(`[onboarding-attachments] library render failed (${master.slug}):`, err?.message);
    }
  }

  // 2. Escape hatch: the org's uploaded extra PDFs.
  if (providerProfileId) {
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
