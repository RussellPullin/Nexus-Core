/**
 * Named collections of company_policy_files PDFs for staff / participant onboarding emails and acknowledgement flows.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

const WORKFLOWS = new Set(['staff_onboarding', 'participant_onboarding', 'both']);

export function normalizeWorkflow(w) {
  const s = String(w || '').trim();
  if (WORKFLOWS.has(s)) return s;
  return 'both';
}

export function packMatchesWorkflow(packWorkflow, target) {
  const pw = packWorkflow || 'both';
  if (pw === 'both') return true;
  return pw === target;
}

export function listPacks(providerProfileId) {
  return db
    .prepare(
      `
    SELECT p.*,
      (SELECT COUNT(*) FROM onboarding_document_pack_items i WHERE i.pack_id = p.id) AS item_count
    FROM onboarding_document_packs p
    WHERE p.provider_profile_id = ?
    ORDER BY p.display_name COLLATE NOCASE
  `
    )
    .all(providerProfileId);
}

export function getPack(providerProfileId, packId) {
  return db
    .prepare(`SELECT * FROM onboarding_document_packs WHERE id = ? AND provider_profile_id = ?`)
    .get(packId, providerProfileId);
}

export function createPack(providerProfileId, { display_name, workflow }) {
  const name = String(display_name || '').trim();
  if (!name) throw new Error('display_name is required');
  const wf = normalizeWorkflow(workflow);
  const id = uuidv4();
  db.prepare(
    `
    INSERT INTO onboarding_document_packs (id, provider_profile_id, display_name, workflow)
    VALUES (?, ?, ?, ?)
  `
  ).run(id, providerProfileId, name, wf);
  return db.prepare(`SELECT * FROM onboarding_document_packs WHERE id = ?`).get(id);
}

export function updatePack(providerProfileId, packId, { display_name, workflow }) {
  const existing = getPack(providerProfileId, packId);
  if (!existing) return null;
  const name = display_name != null ? String(display_name).trim() : existing.display_name;
  if (!name) throw new Error('display_name cannot be empty');
  const wf = workflow != null ? normalizeWorkflow(workflow) : existing.workflow;
  db.prepare(
    `
    UPDATE onboarding_document_packs SET display_name = ?, workflow = ?, updated_at = datetime('now') WHERE id = ? AND provider_profile_id = ?
  `
  ).run(name, wf, packId, providerProfileId);
  return getPack(providerProfileId, packId);
}

export function deletePack(providerProfileId, packId) {
  const existing = getPack(providerProfileId, packId);
  if (!existing) return false;
  db.prepare(`DELETE FROM onboarding_document_packs WHERE id = ? AND provider_profile_id = ?`).run(packId, providerProfileId);
  return true;
}

export function getPackItemsDetailed(packId) {
  return db
    .prepare(
      `
    SELECT pi.policy_file_id AS id, pi.sort_order, pf.display_name, pf.file_path, pf.provider_profile_id
    FROM onboarding_document_pack_items pi
    JOIN company_policy_files pf ON pf.id = pi.policy_file_id
    WHERE pi.pack_id = ?
    ORDER BY pi.sort_order ASC, pi.policy_file_id ASC
  `
    )
    .all(packId);
}

export function setPackItems(providerProfileId, packId, policyFileIds) {
  const pack = getPack(providerProfileId, packId);
  if (!pack) throw new Error('Pack not found');
  const ids = Array.isArray(policyFileIds) ? policyFileIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  db.prepare(`DELETE FROM onboarding_document_pack_items WHERE pack_id = ?`).run(packId);
  const insert = db.prepare(`
    INSERT INTO onboarding_document_pack_items (id, pack_id, policy_file_id, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  let order = 0;
  const seen = new Set();
  for (const pid of ids) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const pol = db
      .prepare(`SELECT id FROM company_policy_files WHERE id = ? AND provider_profile_id = ?`)
      .get(pid, providerProfileId);
    if (!pol) throw new Error(`Policy file not in this organisation: ${pid}`);
    insert.run(uuidv4(), packId, pid, order++);
  }
  return getPackItemsDetailed(packId);
}

/**
 * Policy rows for listing in staff onboarding UI / acknowledgements.
 * @param {string|null} providerProfileId
 * @param {string|null} documentPackId - staff_onboarding.document_pack_id
 */
export function listPoliciesForStaffOnboarding(providerProfileId, documentPackId) {
  if (!providerProfileId) return [];
  if (documentPackId) {
    const pack = db.prepare(`SELECT id FROM onboarding_document_packs WHERE id = ? AND provider_profile_id = ?`).get(documentPackId, providerProfileId);
    if (pack) {
      return db
        .prepare(
          `
        SELECT pf.id, pf.display_name, pf.file_path
        FROM onboarding_document_pack_items pi
        JOIN company_policy_files pf ON pf.id = pi.policy_file_id
        WHERE pi.pack_id = ? AND pf.provider_profile_id = ?
        ORDER BY pi.sort_order ASC, pi.policy_file_id ASC
      `
        )
        .all(documentPackId, providerProfileId);
    }
  }
  return db
    .prepare(`SELECT id, display_name, file_path FROM company_policy_files WHERE provider_profile_id = ? ORDER BY display_name COLLATE NOCASE`)
    .all(providerProfileId);
}

/**
 * Build email attachments from pack or legacy “all policies”.
 * @param {'staff_onboarding'|'participant_onboarding'} targetWorkflow
 * @returns {{ attachments: Array<{ filename: string, content: Buffer, contentType: string }>, resolvedPackId: string|null }}
 */
export function buildPolicyAttachmentsForEmail(providerProfileId, explicitPackId, targetWorkflow, projectRoot) {
  if (!providerProfileId) return { attachments: [], resolvedPackId: null };

  let packId = explicitPackId ? String(explicitPackId).trim() : '';
  if (!packId) {
    const row = db.prepare(`SELECT default_staff_onboarding_pack_id, default_participant_onboarding_pack_id FROM provider_profiles WHERE id = ?`).get(providerProfileId);
    packId =
      targetWorkflow === 'staff_onboarding'
        ? row?.default_staff_onboarding_pack_id || ''
        : row?.default_participant_onboarding_pack_id || '';
  }

  let policies = [];
  let resolvedPackId = null;

  if (packId) {
    const pack = db.prepare(`SELECT id, workflow FROM onboarding_document_packs WHERE id = ? AND provider_profile_id = ?`).get(packId, providerProfileId);
    if (pack && packMatchesWorkflow(pack.workflow, targetWorkflow)) {
      const rows = getPackItemsDetailed(pack.id);
      policies = rows.filter((r) => r.provider_profile_id === providerProfileId);
      resolvedPackId = policies.length ? pack.id : null;
    }
  }

  if (!policies.length) {
    policies = db
      .prepare(`SELECT id, display_name, file_path FROM company_policy_files WHERE provider_profile_id = ? ORDER BY display_name COLLATE NOCASE`)
      .all(providerProfileId);
    resolvedPackId = null;
  }

  const attachments = [];
  for (const pf of policies) {
    const fullPath = join(projectRoot, pf.file_path);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath);
      const filename = `${(pf.display_name || 'policy').replace(/[/\\?%*:|"<>]/g, '_')}.pdf`;
      attachments.push({ filename, content, contentType: 'application/pdf' });
    } catch {
      /* skip */
    }
  }
  return { attachments, resolvedPackId };
}

export function setProviderPackDefaults(providerProfileId, { default_staff_onboarding_pack_id, default_participant_onboarding_pack_id }) {
  const updates = [];
  const vals = [];

  if (default_staff_onboarding_pack_id !== undefined) {
    const raw = default_staff_onboarding_pack_id;
    const id = raw === null || raw === '' ? null : String(raw);
    if (id) {
      const p = getPack(providerProfileId, id);
      if (!p) throw new Error('Invalid default staff pack');
      if (!packMatchesWorkflow(p.workflow, 'staff_onboarding')) {
        throw new Error('That pack is not available for staff onboarding (choose Staff or Both workflow).');
      }
    }
    updates.push('default_staff_onboarding_pack_id = ?');
    vals.push(id);
  }

  if (default_participant_onboarding_pack_id !== undefined) {
    const raw = default_participant_onboarding_pack_id;
    const id = raw === null || raw === '' ? null : String(raw);
    if (id) {
      const p = getPack(providerProfileId, id);
      if (!p) throw new Error('Invalid default participant pack');
      if (!packMatchesWorkflow(p.workflow, 'participant_onboarding')) {
        throw new Error('That pack is not available for participant onboarding (choose Participant or Both workflow).');
      }
    }
    updates.push('default_participant_onboarding_pack_id = ?');
    vals.push(id);
  }

  if (!updates.length) {
    return db
      .prepare(`SELECT id, default_staff_onboarding_pack_id, default_participant_onboarding_pack_id FROM provider_profiles WHERE id = ?`)
      .get(providerProfileId);
  }

  vals.push(providerProfileId);
  db.prepare(`UPDATE provider_profiles SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
  return db
    .prepare(`SELECT id, default_staff_onboarding_pack_id, default_participant_onboarding_pack_id FROM provider_profiles WHERE id = ?`)
    .get(providerProfileId);
}
