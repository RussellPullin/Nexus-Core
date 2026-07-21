/**
 * Phase 2: One-click participant onboarding orchestrator.
 *
 * Composes existing services into a single idempotent run:
 *   1. Resolve provider org for this participant.
 *   2. assertProviderOnboardingReady — fail fast with structured reason if not ready.
 *   3. Ensure the org has every master template cloned (Phase 1 helper, idempotent).
 *   4. initializeParticipantOnboarding — creates participant_onboarding row + initial intake row.
 *   5. generateFormPack — produces every participant_form_instances PDF (Service Agreement,
 *      consent, support plan, custom forms) for the org's currently active templates.
 *   6. Optionally email the policy/onboarding pack via the existing email-pack flow.
 *   7. Emit a structured audit event so the timeline reflects the orchestrated run.
 *
 * IMPORTANT: This service deliberately does NOT touch any signing layer. Signature
 * handoff (native e-signature) is performed by the user separately via existing endpoints —
 * the orchestrator only prepares everything those flows expect to find.
 */
import { db } from '../db/index.js';
import {
  initializeParticipantOnboarding,
  generateFormPack,
  getOnboardingByParticipant,
  assertProviderOnboardingReady,
  createAuditEvent
} from './onboarding.service.js';
import { cloneAllLibraryMastersForOrg } from './documentLibrary.service.js';

/**
 * @param {object} params
 * @param {string}  params.participantId
 * @param {string|null} [params.providerOrganisationId] — overrides participant.plan_manager_id
 * @param {string|null} [params.userId]                — for actor + audit + signature lookups
 * @param {string}      [params.actorType='user']
 * @param {string|null} [params.actorId]
 * @param {string|null} [params.sourceIp]
 * @param {string|null} [params.userAgent]
 * @returns {Promise<OrchestrationResult>}
 *
 * @typedef {{ name: string, ok: boolean, detail?: any, error?: string, error_code?: string, skipped?: boolean }} StepResult
 * @typedef {{
 *   participant_id: string,
 *   provider_organisation_id: string,
 *   ready: boolean,
 *   completed_steps: number,
 *   total_steps: number,
 *   steps: StepResult[],
 *   onboarding: object | null,
 *   next_action: 'send_for_signature' | 'send_pack' | 'awaiting_intake' | 'blocked',
 *   blocking_reason?: string,
 *   blocking_code?: string
 * }} OrchestrationResult
 */
export async function orchestrateParticipantOnboarding({
  participantId,
  providerOrganisationId = null,
  userId = null,
  actorType = 'user',
  actorId = null,
  sourceIp = null,
  userAgent = null
}) {
  if (!participantId) throw new Error('participantId required');

  const steps = [];
  /** @param {StepResult} step */
  const pushStep = (step) => {
    steps.push(step);
    return step;
  };

  // --- 1. Resolve provider org ----
  const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(participantId);
  if (!participant) {
    return {
      participant_id: participantId,
      provider_organisation_id: '',
      ready: false,
      completed_steps: 0,
      total_steps: 0,
      steps: [{ name: 'resolve_participant', ok: false, error: 'Participant not found' }],
      onboarding: null,
      next_action: 'blocked',
      blocking_reason: 'Participant not found'
    };
  }
  const providerOrgId =
    providerOrganisationId ||
    participant.provider_org_id ||
    participant.plan_manager_id ||
    db.prepare('SELECT id FROM organisations ORDER BY created_at ASC LIMIT 1').get()?.id ||
    null;
  pushStep({
    name: 'resolve_provider_org',
    ok: Boolean(providerOrgId),
    detail: { provider_organisation_id: providerOrgId }
  });
  if (!providerOrgId) {
    return finalize(participantId, '', steps, null, 'blocked', 'No provider organisation available');
  }

  const actorCtx = { actorType, actorId: actorId || userId || null, sourceIp, userAgent };

  // --- 2. Readiness gate ---
  try {
    const readiness = assertProviderOnboardingReady(providerOrgId);
    pushStep({ name: 'provider_readiness', ok: true, detail: { profile_id: readiness.profile?.id } });
  } catch (err) {
    pushStep({ name: 'provider_readiness', ok: false, error: err.message, error_code: err.code || 'NOT_READY' });
    return finalize(participantId, providerOrgId, steps, null, 'blocked', err.message, err.code || 'NOT_READY');
  }

  // --- 3. Ensure master library cloned for this org (idempotent) ---
  try {
    const cloneResult = cloneAllLibraryMastersForOrg(providerOrgId);
    pushStep({ name: 'ensure_library_clones', ok: true, detail: cloneResult });
  } catch (err) {
    pushStep({ name: 'ensure_library_clones', ok: false, error: err.message });
    // Non-fatal — continue, the structured nexus templates will still work.
  }

  // --- 4. Initialise onboarding (idempotent — returns existing onboarding if any) ---
  let onboarding;
  try {
    onboarding = initializeParticipantOnboarding({
      participantId,
      providerOrganisationId: providerOrgId,
      ...actorCtx
    });
    pushStep({
      name: 'initialize_onboarding',
      ok: true,
      detail: { onboarding_id: onboarding?.id, status: onboarding?.status }
    });
  } catch (err) {
    pushStep({ name: 'initialize_onboarding', ok: false, error: err.message });
    return finalize(participantId, providerOrgId, steps, null, 'blocked', err.message);
  }

  // --- 5. Generate form pack — skip if every active form is already signed ---
  const allSigned =
    onboarding.forms?.length > 0 &&
    onboarding.forms.every((f) => f.status === 'signed' || f.status === 'superseded');
  if (allSigned) {
    pushStep({ name: 'generate_form_pack', ok: true, skipped: true, detail: 'All forms already signed' });
  } else {
    try {
      const generated = await generateFormPack({ participantId, userId, ...actorCtx });
      pushStep({
        name: 'generate_form_pack',
        ok: true,
        detail: {
          count: Array.isArray(generated?.generated_form_ids) ? generated.generated_form_ids.length : null
        }
      });
    } catch (err) {
      pushStep({
        name: 'generate_form_pack',
        ok: false,
        error: err.message,
        error_code: err.code || 'GENERATE_FAILED'
      });
      // Non-fatal for orchestration: leave onboarding partially prepared.
    }
  }

  // --- 6. Refresh state for response ---
  const finalState = getOnboardingByParticipant(participantId);

  // --- 7. Audit ---
  createAuditEvent({
    participantId,
    participantOnboardingId: finalState?.id,
    actorType,
    actorId: actorId || userId || null,
    eventType: 'participant_onboarding_orchestrated',
    entityType: 'onboarding',
    entityId: finalState?.id,
    newValue: {
      steps: steps.map(({ name, ok, error_code, skipped }) => ({ name, ok, error_code, skipped })),
      next_action: deriveNextAction(steps, finalState)
    },
    sourceIp,
    userAgent
  });

  return finalize(participantId, providerOrgId, steps, finalState, deriveNextAction(steps, finalState));
}

function deriveNextAction(steps, onboarding) {
  const failedRequired = steps.find((s) => !s.ok && !['ensure_library_clones'].includes(s.name));
  if (failedRequired) return 'blocked';
  const forms = onboarding?.forms || [];
  const pendingSignature = forms.some((f) => ['generated', 'draft', 'sent', 'viewed'].includes(f.status));
  if (pendingSignature) return 'send_for_signature';
  if (!forms.length) return 'awaiting_intake';
  return 'send_pack';
}

function finalize(participantId, providerOrgId, steps, onboarding, nextAction, blockingReason, blockingCode) {
  const ready = nextAction !== 'blocked';
  /** @type {OrchestrationResult} */
  const result = {
    participant_id: participantId,
    provider_organisation_id: providerOrgId,
    ready,
    completed_steps: steps.filter((s) => s.ok).length,
    total_steps: steps.length,
    steps,
    onboarding,
    next_action: nextAction
  };
  if (blockingReason) result.blocking_reason = blockingReason;
  if (blockingCode) result.blocking_code = blockingCode;
  return result;
}
