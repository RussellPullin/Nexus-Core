/**
 * Phase 7: NDIS Practice Standards mapping.
 *
 * The Practice Standards are organised into Core + Supplementary modules. We seed the
 * reference rows on first boot and let each org track evidence + review status per row.
 *
 * Evidence pointers reference the document library by slug (Phase 1/5 work), so the
 * compliance dashboard can deep-link the auditor straight to the policy/register PDF.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

const REFERENCE = [
  // ---- Core module: Rights & Responsibilities ----
  { module: 'core', standard_code: 'CORE.1.1', title: 'Person-centred supports',
    intent: 'Each participant accesses supports that promote, uphold and respect their legal and human rights.',
    evidence: ['policy-privacy-and-dignity', 'policy-code-of-conduct', 'form-progress-note'] },
  { module: 'core', standard_code: 'CORE.1.2', title: 'Individual values & beliefs',
    intent: 'Each participant accesses supports that respect their culture, diversity, values and beliefs.',
    evidence: ['policy-equal-opportunity'] },
  { module: 'core', standard_code: 'CORE.1.3', title: 'Privacy & dignity',
    intent: 'Each participant accesses supports that respect and protect their privacy and dignity.',
    evidence: ['policy-privacy-and-dignity', 'policy-information-management'] },
  { module: 'core', standard_code: 'CORE.1.4', title: 'Independence & informed choice',
    intent: 'Each participant is supported to exercise informed choice and control.',
    evidence: ['policy-code-of-conduct', 'guide-service-user-handbook'] },
  { module: 'core', standard_code: 'CORE.1.5', title: 'Violence, abuse, neglect, exploitation & discrimination',
    intent: 'Each participant accesses supports free from violence, abuse, neglect, exploitation and discrimination.',
    evidence: ['policy-equal-opportunity', 'procedure-incident-reporting'] },

  // ---- Core module: Provider Governance & Operational Management ----
  { module: 'core', standard_code: 'CORE.2.1', title: 'Governance & operational management',
    intent: 'Each participant\'s supports are overseen by robust governance and operational management systems.',
    evidence: ['policy-risk-management', 'policy-continuous-improvement'] },
  { module: 'core', standard_code: 'CORE.2.2', title: 'Risk management',
    intent: 'Risks to participants, workers and the provider are identified and managed.',
    evidence: ['policy-risk-management', 'register-risk', 'register-hazard'] },
  { module: 'core', standard_code: 'CORE.2.3', title: 'Quality management',
    intent: 'Each participant benefits from a quality management system relevant and proportionate to the scope of supports.',
    evidence: ['policy-continuous-improvement', 'register-continuous-improvement'] },
  { module: 'core', standard_code: 'CORE.2.4', title: 'Information management',
    intent: 'Management of each participant\'s information ensures it is identifiable, accurately recorded, current and confidential.',
    evidence: ['policy-information-management', 'policy-privacy-and-dignity'] },
  { module: 'core', standard_code: 'CORE.2.5', title: 'Feedback & complaints',
    intent: 'Each participant has knowledge of and access to provider\'s feedback and complaints management system.',
    evidence: ['policy-complaints-management', 'procedure-complaints-handling', 'register-complaints', 'form-complaint'] },
  { module: 'core', standard_code: 'CORE.2.6', title: 'Incident management',
    intent: 'Each participant is safeguarded by the provider\'s incident management system.',
    evidence: ['policy-incident-management', 'procedure-incident-reporting', 'register-incident', 'form-incident-report'] },
  { module: 'core', standard_code: 'CORE.2.7', title: 'Human resource management',
    intent: 'Each participant\'s support needs are met by workers who are competent in their role.',
    evidence: ['policy-worker-screening', 'procedure-worker-recruitment', 'procedure-worker-training', 'register-worker-compliance', 'register-training'] },
  { module: 'core', standard_code: 'CORE.2.8', title: 'Continuity of supports',
    intent: 'Each participant has access to timely, appropriate and uninterrupted supports.',
    evidence: ['procedure-service-delivery', 'policy-emergency-and-disaster'] },

  // ---- Core module: Provision of Supports ----
  { module: 'core', standard_code: 'CORE.3.1', title: 'Access to supports',
    intent: 'Each participant accesses the most appropriate supports that meet their needs, goals and preferences.',
    evidence: ['procedure-intake-and-onboarding', 'guide-service-user-handbook'] },
  { module: 'core', standard_code: 'CORE.3.2', title: 'Support planning',
    intent: 'Each participant is actively involved in support planning, review and on-going monitoring.',
    evidence: ['procedure-service-delivery'] },
  { module: 'core', standard_code: 'CORE.3.3', title: 'Service agreements',
    intent: 'Each participant has a service agreement that sets out expectations, supports and fees.',
    evidence: ['procedure-intake-and-onboarding'] },
  { module: 'core', standard_code: 'CORE.3.4', title: 'Responsive support provision',
    intent: 'Each participant accesses responsive, timely, competent and appropriate supports.',
    evidence: ['procedure-service-delivery', 'form-progress-note'] },
  { module: 'core', standard_code: 'CORE.3.5', title: 'Transitions to/from a provider',
    intent: 'Each participant experiences a planned and coordinated transition to or from the provider.',
    evidence: ['procedure-service-termination'] },

  // ---- Core module: Service Environment ----
  { module: 'core', standard_code: 'CORE.4.1', title: 'Safe environment',
    intent: 'Each participant accesses supports in a safe environment that is appropriate to their needs.',
    evidence: ['policy-whs', 'register-hazard', 'register-assets'] },

  // ---- Supplementary: high-intensity supports ----
  { module: 'supplementary', standard_code: 'SUP.HIDS', title: 'High-intensity daily personal activities',
    intent: 'Workers delivering high-intensity supports are competent in skill descriptors and high-intensity training.',
    evidence: ['register-training', 'register-worker-compliance'] },
  { module: 'supplementary', standard_code: 'SUP.MED', title: 'Medication management',
    intent: 'Medication is administered safely and only by workers competent to do so.',
    evidence: ['policy-medication-management', 'procedure-medication-administration', 'form-medication-chart'] },
  { module: 'supplementary', standard_code: 'SUP.RP', title: 'Implementing behaviour support plans',
    intent: 'Each regulated restrictive practice is authorised and reported.',
    evidence: ['policy-restrictive-practices', 'register-restrictive-practices', 'form-restrictive-practice-authorisation'] },

  // ---- Supplementary: organisation governance ----
  { module: 'supplementary', standard_code: 'SUP.GOV', title: 'Conflict of interest',
    intent: 'Conflicts of interest are declared and managed.',
    evidence: ['policy-conflict-of-interest', 'register-conflict-of-interest'] }
];

/**
 * Idempotent seed of the reference table. Called on boot from `index.js`.
 */
export function seedPracticeStandardsIfNeeded() {
  const existing = db.prepare('SELECT COUNT(*) as c FROM ndis_practice_standards').get();
  if (existing?.c >= REFERENCE.length) return { seeded: 0, total: existing.c };
  const insert = db.prepare(`
    INSERT INTO ndis_practice_standards (id, module, standard_code, title, intent, evidence_required_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(standard_code) DO UPDATE SET
      module = excluded.module,
      title = excluded.title,
      intent = excluded.intent,
      evidence_required_json = excluded.evidence_required_json,
      sort_order = excluded.sort_order
  `);
  let seeded = 0;
  REFERENCE.forEach((row, idx) => {
    insert.run(
      uuidv4(),
      row.module,
      row.standard_code,
      row.title,
      row.intent || null,
      JSON.stringify(row.evidence || []),
      idx
    );
    seeded += 1;
  });
  return { seeded, total: seeded };
}

/**
 * Compliance dashboard payload combining the reference standards with this org's
 * recorded status + the matching document library evidence (per-org clone state).
 *
 * @param {string} orgId
 */
export function getOrgPracticeStandards(orgId) {
  if (!orgId) throw new Error('orgId required');
  const standards = db.prepare('SELECT * FROM ndis_practice_standards ORDER BY sort_order').all();
  const statusByStandard = new Map(
    db
      .prepare('SELECT * FROM org_practice_standard_status WHERE organisation_id = ?')
      .all(orgId)
      .map((r) => [r.standard_id, r])
  );
  const libraryRows = db
    .prepare(
      `SELECT m.id as master_id, m.slug, m.display_name, m.category, c.id as clone_id, c.is_active as clone_active
       FROM document_library_masters m
       LEFT JOIN document_library_org_clones c ON c.master_id = m.id AND c.org_id = ?`
    )
    .all(orgId);
  const libBySlug = new Map(libraryRows.map((r) => [r.slug, r]));

  return standards.map((s) => {
    const status = statusByStandard.get(s.id) || null;
    const required = (() => {
      try { return JSON.parse(s.evidence_required_json || '[]'); } catch { return []; }
    })();
    const evidence = required.map((slug) => libBySlug.get(slug) || { slug, missing: true });
    const cloned = evidence.filter((e) => e.clone_id && e.clone_active).length;
    const missing = evidence.filter((e) => e.missing || !e.clone_id || !e.clone_active);
    return {
      id: s.id,
      module: s.module,
      standard_code: s.standard_code,
      title: s.title,
      intent: s.intent,
      status: status?.status || 'unreviewed',
      last_reviewed_at: status?.last_reviewed_at || null,
      review_due_at: status?.review_due_at || null,
      notes: status?.notes || null,
      evidence,
      evidence_coverage: required.length === 0 ? 1 : cloned / required.length,
      missing_evidence: missing
    };
  });
}

/**
 * Upsert the org's status for a standard. The compliance UI calls this when an admin
 * records a review outcome or links additional evidence.
 */
export function upsertOrgStandardStatus({
  orgId,
  standardId,
  status,
  notes,
  evidencePolicySlug,
  evidenceRegisterSlug,
  lastReviewedAt,
  reviewDueAt,
  userId
}) {
  if (!orgId || !standardId) throw new Error('orgId and standardId required');
  const existing = db
    .prepare('SELECT id FROM org_practice_standard_status WHERE organisation_id = ? AND standard_id = ?')
    .get(orgId, standardId);
  if (existing?.id) {
    db.prepare(`
      UPDATE org_practice_standard_status
      SET status = COALESCE(?, status),
          notes = COALESCE(?, notes),
          evidence_policy_slug = COALESCE(?, evidence_policy_slug),
          evidence_register_slug = COALESCE(?, evidence_register_slug),
          last_reviewed_at = COALESCE(?, last_reviewed_at),
          review_due_at = COALESCE(?, review_due_at),
          updated_by_user_id = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      status || null,
      notes || null,
      evidencePolicySlug || null,
      evidenceRegisterSlug || null,
      lastReviewedAt || null,
      reviewDueAt || null,
      userId || null,
      existing.id
    );
    return { id: existing.id, updated: true };
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO org_practice_standard_status (
      id, organisation_id, standard_id, status, notes,
      evidence_policy_slug, evidence_register_slug,
      last_reviewed_at, review_due_at, updated_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    orgId,
    standardId,
    status || 'unreviewed',
    notes || null,
    evidencePolicySlug || null,
    evidenceRegisterSlug || null,
    lastReviewedAt || null,
    reviewDueAt || null,
    userId || null
  );
  return { id, updated: false };
}
