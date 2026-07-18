/**
 * Split onboarding pack send: policy PDFs via email, signature forms via native e-signature.
 */

import {
  buildOnboardingAttachments,
  splitOnboardingMasters,
  validateOnboardingMasterIds
} from './onboardingDocumentPacks.service.js';
import {
  assertNativeSignatureReady,
  getProviderSignatureMode,
  sendLibraryMastersForSignature
} from './libraryDocumentSignature.service.js';

/**
 * Resolve master selection and split into policy vs signature form masters.
 * @param {string|null} orgId
 * @param {'staff_onboarding'|'participant_onboarding'} workflow
 * @param {string[]|null|undefined} masterIds - null/undefined = all pack docs; array = explicit selection
 */
export function resolveOnboardingSendSplit(orgId, workflow, masterIds) {
  const hasSelection = Array.isArray(masterIds);
  if (hasSelection) {
    validateOnboardingMasterIds(orgId, workflow, masterIds);
  }
  const effectiveIds = hasSelection ? masterIds : null;
  return {
    hasSelection,
    ...splitOnboardingMasters(orgId, workflow, effectiveIds)
  };
}

/**
 * Build email PDF attachments (policies + optional extra org PDFs only).
 */
export async function buildPolicyEmailAttachments(
  orgId,
  providerProfileId,
  workflow,
  { policyMasterIds, hasSelection, staff, participant, includeExtraPdfs = true } = {}
) {
  const masterIds = hasSelection ? (policyMasterIds?.length ? policyMasterIds : []) : null;
  const { attachments } = await buildOnboardingAttachments(orgId, providerProfileId, workflow, {
    participant,
    staff,
    masterIds,
    includeExtraPdfs,
    signatureFilter: 'policy_only'
  });
  return attachments;
}

/**
 * Send signature-required library masters via the native e-signature service.
 * Fails fast if the native e-signature service is not configured/enabled when forms are selected.
 */
export async function sendOnboardingSignatureForms({
  orgId,
  workflow,
  formMasters,
  staff = null,
  participant = null,
  signatureMode = null,
  orgName = null,
  adminFieldValuesByMasterId = {}
}) {
  if (!formMasters?.length) return [];
  assertNativeSignatureReady(orgId);
  const mode = signatureMode || getProviderSignatureMode(orgId);
  return sendLibraryMastersForSignature({
    orgId,
    workflow,
    formMasters,
    staff,
    participant,
    signatureMode: mode,
    orgName,
    adminFieldValuesByMasterId
  });
}

/**
 * Full split send orchestration (attachments + the native e-signature service forms).
 * Does not send email — callers attach `policyAttachments` and compose message.
 */
export async function prepareSplitOnboardingSend({
  orgId,
  providerProfileId,
  workflow,
  masterIds,
  staff = null,
  participant = null,
  includeExtraPdfs = true,
  signatureMode = null,
  orgName = null,
  adminFieldValuesByMasterId = {}
}) {
  const split = resolveOnboardingSendSplit(orgId, workflow, masterIds);
  if (split.formMasters.length) {
    assertNativeSignatureReady(orgId);
  }

  const policyAttachments = await buildPolicyEmailAttachments(orgId, providerProfileId, workflow, {
    policyMasterIds: split.policyMasterIds,
    hasSelection: split.hasSelection,
    staff,
    participant,
    includeExtraPdfs
  });

  const signatureRequests = await sendOnboardingSignatureForms({
    orgId,
    workflow,
    formMasters: split.formMasters,
    staff,
    participant,
    signatureMode,
    orgName,
    adminFieldValuesByMasterId
  });

  return {
    ...split,
    policyAttachments,
    signatureRequests,
    attachment_count: policyAttachments.length,
    signature_request_count: signatureRequests.length
  };
}
