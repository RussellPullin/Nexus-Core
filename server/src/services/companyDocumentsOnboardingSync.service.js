/**
 * Sync org company documents (especially policies) into company_policy_files and onboarding packs.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { ensureProviderProfile } from './onboarding.service.js';
import { convertDocxToPdf } from './consentForm.service.js';
import {
  getOrgCompanyDocumentFile,
  getCompanyDocumentSettings,
  mirrorLibraryMastersToOrgDocuments,
  projectRoot
} from './companyDocuments.service.js';
import { createPack, setPackItems, listPacks } from './onboardingDocumentPacks.service.js';

const policyDir = join(projectRoot, 'data', 'onboarding', 'policies');

async function resolvePolicyPdfBuffer(orgId, docRow) {
  const { absPath } = getOrgCompanyDocumentFile(orgId, docRow.id);
  if (!absPath || !existsSync(absPath)) {
    throw new Error('Policy file missing on disk.');
  }

  const lower = absPath.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return readFileSync(absPath);
  }
  if (lower.endsWith('.docx')) {
    const converted = convertDocxToPdf(readFileSync(absPath));
    if (!converted) throw new Error('Could not convert policy DOCX to PDF.');
    return converted;
  }
  throw new Error('Policies must be PDF (or DOCX convertible to PDF).');
}

/**
 * Upsert company_policy_files row for a single org company document marked sync_to_onboarding.
 */
export async function syncCompanyDocumentToPolicyFile(orgId, docId) {
  const doc = db.prepare('SELECT * FROM org_company_documents WHERE id = ? AND org_id = ?').get(docId, orgId);
  if (!doc) throw new Error('Document not found');
  if (!doc.sync_to_onboarding) throw new Error('Document is not marked for onboarding sync');

  const profile = ensureProviderProfile(orgId);
  const pdfBuffer = await resolvePolicyPdfBuffer(orgId, doc);

  mkdirSync(policyDir, { recursive: true });

  let policyId = doc.company_policy_file_id;
  let filename;
  if (policyId) {
    const existing = db.prepare('SELECT file_path FROM company_policy_files WHERE id = ?').get(policyId);
    filename = existing?.file_path?.split('/').pop() || `${policyId}.pdf`;
  } else {
    policyId = uuidv4();
    filename = `${policyId}.pdf`;
  }

  const absPolicyPath = join(policyDir, filename);
  writeFileSync(absPolicyPath, pdfBuffer);
  const relPath = join('data', 'onboarding', 'policies', filename);

  if (doc.company_policy_file_id) {
    db.prepare(
      `UPDATE company_policy_files SET display_name = ?, file_path = ? WHERE id = ? AND provider_profile_id = ?`
    ).run(doc.display_name, relPath, policyId, profile.id);
  } else {
    db.prepare(
      `INSERT INTO company_policy_files (id, provider_profile_id, display_name, file_path, org_company_document_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run(policyId, profile.id, doc.display_name, relPath, doc.id);
    db.prepare(
      `UPDATE org_company_documents SET company_policy_file_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(policyId, doc.id);
  }

  return db.prepare('SELECT * FROM company_policy_files WHERE id = ?').get(policyId);
}

function findOrCreateCompanyPoliciesPack(providerProfileId) {
  const existing = listPacks(providerProfileId).find(
    (p) => p.display_name === 'Company policies' && (p.workflow === 'both' || !p.workflow)
  );
  if (existing) return existing;

  return createPack(providerProfileId, { display_name: 'Company policies', workflow: 'both' });
}

/**
 * Sync all documents flagged sync_to_onboarding; rebuild default onboarding pack.
 */
export async function syncAllOnboardingPoliciesForOrg(orgId) {
  mirrorLibraryMastersToOrgDocuments(orgId);

  const profile = ensureProviderProfile(orgId);
  const docs = db
    .prepare(
      `
    SELECT id FROM org_company_documents
    WHERE org_id = ? AND sync_to_onboarding = 1
      AND category IN ('policy', 'procedure')
    ORDER BY display_name COLLATE NOCASE
  `
    )
    .all(orgId);

  const synced = [];
  const errors = [];

  for (const { id } of docs) {
    try {
      const pf = await syncCompanyDocumentToPolicyFile(orgId, id);
      synced.push({ document_id: id, policy_file_id: pf.id, display_name: pf.display_name });
    } catch (e) {
      errors.push({ document_id: id, error: e.message });
    }
  }

  const policyFileIds = synced.map((s) => s.policy_file_id);
  let pack = null;
  if (policyFileIds.length) {
    pack = findOrCreateCompanyPoliciesPack(profile.id);
    setPackItems(profile.id, pack.id, policyFileIds, []);

    const defaults = db
      .prepare(
        `SELECT default_staff_onboarding_pack_id, default_participant_onboarding_pack_id FROM provider_profiles WHERE id = ?`
      )
      .get(profile.id);

    const updates = [];
    const vals = [];
    if (!defaults?.default_staff_onboarding_pack_id) {
      updates.push('default_staff_onboarding_pack_id = ?');
      vals.push(pack.id);
    }
    if (!defaults?.default_participant_onboarding_pack_id) {
      updates.push('default_participant_onboarding_pack_id = ?');
      vals.push(pack.id);
    }
    if (updates.length) {
      vals.push(profile.id);
      db.prepare(`UPDATE provider_profiles SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
        ...vals
      );
    }
  }

  return {
    synced_count: synced.length,
    synced,
    errors,
    pack_id: pack?.id || null,
    policy_file_ids: policyFileIds
  };
}

/**
 * Called after org bootstrap — mirror masters and optionally sync policies to onboarding.
 */
export async function bootstrapCompanyDocumentsForOrg(orgId) {
  const settings = getCompanyDocumentSettings(orgId);
  const mirror = mirrorLibraryMastersToOrgDocuments(orgId);
  if (!settings.auto_sync_policies_to_onboarding) {
    return { mirror, onboarding: null };
  }
  const onboarding = await syncAllOnboardingPoliciesForOrg(orgId);
  return { mirror, onboarding };
}
