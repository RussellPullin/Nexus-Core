/**
 * Phase 3: One-click staff onboarding orchestrator.
 *
 * Mirrors the participant orchestrator. Composes existing services into a single idempotent run:
 *   1. Resolve provider org for the staff member.
 *   2. assertStaffOnboardingReady — fail fast with structured reason if not ready.
 *   3. Ensure the org has every master template cloned (Phase 1 helper, idempotent).
 *   4. Ensure staff_onboarding row exists for this staff member (creates with status 'in_progress').
 *   5. Resolve the policy attachment pack so the caller knows what will be sent.
 *   6. Emit a structured audit event so the timeline reflects the orchestrated run.
 *
 * IMPORTANT: This service deliberately does NOT touch any signing layer or send emails.
 * The existing `POST /api/staff/:id/start-onboarding` route still owns the email + token-link
 * send. The orchestrator just guarantees that, once it returns ok, that route will succeed.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { assertStaffOnboardingReady, createAuditEvent } from './onboarding.service.js';
import { cloneAllLibraryMastersForOrg } from './documentLibrary.service.js';
import { buildOnboardingAttachments } from './onboardingDocumentPacks.service.js';

/**
 * @param {object} params
 * @param {string} params.staffId
 * @param {string|null} [params.providerOrganisationId]
 * @param {string|null} [params.userId]
 * @param {string} [params.actorType='user']
 * @param {string|null} [params.actorId]
 * @param {string|null} [params.sourceIp]
 * @param {string|null} [params.userAgent]
 * @param {string} [params.projectRoot]
 * @returns {Promise<StaffOrchestrationResult>}
 *
 * @typedef {{ name: string, ok: boolean, detail?: any, error?: string, error_code?: string, skipped?: boolean }} StepResult
 * @typedef {{
 *   staff_id: string,
 *   provider_organisation_id: string,
 *   ready: boolean,
 *   completed_steps: number,
 *   total_steps: number,
 *   steps: StepResult[],
 *   staff_onboarding_id: string | null,
 *   pack_id: string | null,
 *   attachment_count: number,
 *   next_action: 'send_invite_email' | 'awaiting_staff_form' | 'blocked',
 *   blocking_reason?: string,
 *   blocking_code?: string
 * }} StaffOrchestrationResult
 */
export async function orchestrateStaffOnboarding({
  staffId,
  providerOrganisationId = null,
  userId = null,
  actorType = 'user',
  actorId = null,
  sourceIp = null,
  userAgent = null,
  projectRoot = process.cwd()
}) {
  if (!staffId) throw new Error('staffId required');

  const steps = [];
  const push = (s) => {
    steps.push(s);
    return s;
  };

  // --- 1. Resolve provider org for staff member ---
  const staff = db.prepare('SELECT id, org_id, name, email FROM staff WHERE id = ?').get(staffId);
  if (!staff) {
    return finalize(staffId, '', steps, null, null, 0, 'blocked', 'Staff not found');
  }
  const providerOrgId = providerOrganisationId || staff.org_id || null;
  push({ name: 'resolve_provider_org', ok: Boolean(providerOrgId), detail: { provider_organisation_id: providerOrgId } });
  if (!providerOrgId) {
    return finalize(staffId, '', steps, null, null, 0, 'blocked', 'Staff has no organisation', 'PROVIDER_ORG_MISSING');
  }

  // --- 2. Readiness gate ---
  let profileId = null;
  try {
    const readiness = assertStaffOnboardingReady(providerOrgId);
    profileId = readiness.profile?.id || null;
    push({ name: 'staff_readiness', ok: true, detail: { profile_id: profileId } });
  } catch (err) {
    push({ name: 'staff_readiness', ok: false, error: err.message, error_code: err.code || 'NOT_READY' });
    return finalize(staffId, providerOrgId, steps, null, null, 0, 'blocked', err.message, err.code || 'NOT_READY');
  }

  // --- 3. Ensure master library cloned for this org (idempotent) ---
  try {
    const cloneResult = cloneAllLibraryMastersForOrg(providerOrgId);
    push({ name: 'ensure_library_clones', ok: true, detail: cloneResult });
  } catch (err) {
    push({ name: 'ensure_library_clones', ok: false, error: err.message });
    // Non-fatal — continue.
  }

  // --- 4. Ensure staff_onboarding row exists ---
  let onboardingRow = db.prepare('SELECT * FROM staff_onboarding WHERE staff_id = ?').get(staffId);
  if (!onboardingRow) {
    const newId = uuidv4();
    db.prepare(`
      INSERT INTO staff_onboarding (id, staff_id, provider_profile_id, status, current_step, started_at, last_activity_at)
      VALUES (?, ?, ?, 'in_progress', 1, datetime('now'), datetime('now'))
    `).run(newId, staffId, profileId);
    onboardingRow = db.prepare('SELECT * FROM staff_onboarding WHERE id = ?').get(newId);
    push({ name: 'initialize_staff_onboarding', ok: true, detail: { staff_onboarding_id: newId, created: true } });
  } else {
    db.prepare(`
      UPDATE staff_onboarding
      SET provider_profile_id = COALESCE(provider_profile_id, ?),
          status = CASE WHEN status = 'complete' THEN status ELSE 'in_progress' END,
          last_activity_at = datetime('now'),
          updated_at = datetime('now')
      WHERE staff_id = ?
    `).run(profileId, staffId);
    push({
      name: 'initialize_staff_onboarding',
      ok: true,
      detail: { staff_onboarding_id: onboardingRow.id, created: false }
    });
  }

  // --- 5. Resolve branded onboarding attachments (does not send anything) ---
  let attachmentCount = 0;
  try {
    const staffFull = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    const { attachments } = await buildOnboardingAttachments(
      providerOrgId,
      profileId,
      'staff_onboarding',
      { staff: staffFull }
    );
    attachmentCount = attachments?.length || 0;
    push({
      name: 'resolve_onboarding_documents',
      ok: attachmentCount > 0,
      detail: { attachment_count: attachmentCount },
      error: attachmentCount === 0 ? 'No staff onboarding documents available.' : undefined,
      error_code: attachmentCount === 0 ? 'EMPTY_STAFF_DOCUMENTS' : undefined
    });
  } catch (err) {
    push({ name: 'resolve_onboarding_documents', ok: false, error: err.message });
  }

  // --- 6. Audit ---
  createAuditEvent({
    actorType,
    actorId: actorId || userId || null,
    eventType: 'staff_onboarding_orchestrated',
    entityType: 'staff_onboarding',
    entityId: onboardingRow.id,
    newValue: {
      staff_id: staffId,
      provider_organisation_id: providerOrgId,
      attachment_count: attachmentCount,
      steps: steps.map(({ name, ok, error_code, skipped }) => ({ name, ok, error_code, skipped }))
    },
    sourceIp,
    userAgent
  });

  const nextAction = attachmentCount > 0 ? 'send_invite_email' : 'awaiting_staff_form';
  return finalize(staffId, providerOrgId, steps, onboardingRow.id, null, attachmentCount, nextAction);
}

function finalize(staffId, providerOrgId, steps, staffOnboardingId, packId, attachmentCount, nextAction, blockingReason, blockingCode) {
  const ready = nextAction !== 'blocked';
  /** @type {StaffOrchestrationResult} */
  const result = {
    staff_id: staffId,
    provider_organisation_id: providerOrgId,
    ready,
    completed_steps: steps.filter((s) => s.ok).length,
    total_steps: steps.length,
    steps,
    staff_onboarding_id: staffOnboardingId,
    pack_id: packId,
    attachment_count: attachmentCount,
    next_action: nextAction
  };
  if (blockingReason) result.blocking_reason = blockingReason;
  if (blockingCode) result.blocking_code = blockingCode;
  return result;
}
