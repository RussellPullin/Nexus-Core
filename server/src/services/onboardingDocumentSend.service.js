/**
 * Split onboarding pack send: policy PDFs via email, signature forms via native e-signature.
 */

import { db } from '../db/index.js';
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
 * Worker Declarations' body text lists the org's policies by name via a docxtemplater loop
 * (`{#policies}`) rather than a static hardcoded list. The org's actual named policies
 * (Privacy and Dignity Policy, Governance Policy, etc.) live in the separate `policy_library`
 * pack, which is mutually exclusive with `staff_onboarding` — they're never selectable as pack
 * documents. The only real mechanism that attaches policies to a staff send is the org's
 * `company_policy_files` uploads (the same ones `buildOnboardingAttachments` emails as PDFs),
 * so the declaration's list mirrors those rather than the onboarding-pack document selection.
 */
function withWorkerDeclarationsPolicyList(split, adminFieldValuesByMasterId, providerProfileId, includeExtraPdfs) {
  const workerDeclarations = split.formMasters.find((m) => m.slug === 'worker-declarations');
  if (!workerDeclarations) return adminFieldValuesByMasterId;
  const policies =
    includeExtraPdfs !== false && providerProfileId
      ? db
          .prepare(`SELECT display_name FROM company_policy_files WHERE provider_profile_id = ? ORDER BY display_name COLLATE NOCASE`)
          .all(providerProfileId)
          .map((row) => row.display_name)
      : [];
  return {
    ...adminFieldValuesByMasterId,
    [workerDeclarations.id]: {
      ...(adminFieldValuesByMasterId[workerDeclarations.id] || {}),
      policies
    }
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
    adminFieldValuesByMasterId: withWorkerDeclarationsPolicyList(split, adminFieldValuesByMasterId, providerProfileId, includeExtraPdfs)
  });

  return {
    ...split,
    policyAttachments,
    signatureRequests,
    attachment_count: policyAttachments.length,
    signature_request_count: signatureRequests.length
  };
}
