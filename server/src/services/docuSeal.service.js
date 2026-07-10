/**
 * DocuSeal e-signature integration (self-hosted, single Nexus Core instance — replaces Dropbox Sign).
 * API docs: https://nexus-core-docuseal.fly.dev/docs/api (POST /submissions/pdf).
 */
import { randomUUID, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync } from 'fs';

const DOCUSEAL_BASE_URL = (process.env.DOCUSEAL_BASE_URL || 'https://nexus-core-docuseal.fly.dev').replace(/\/$/, '');

// Temp store for file buffers between uploadTransientDocument and createAgreementWithDocument.
// Keys expire after 5 minutes to prevent memory leaks.
const pendingBuffers = new Map();

export function hasDocuSealConfigured() {
  return Boolean(process.env.DOCUSEAL_API_KEY?.trim());
}

async function requestDocuSeal(path, options = {}) {
  const apiKey = process.env.DOCUSEAL_API_KEY?.trim();
  if (!apiKey) throw new Error('DocuSeal is not configured on this server. Set DOCUSEAL_API_KEY.');

  // Self-hosted DocuSeal mounts its API under /api (unlike the hosted api.docuseal.com
  // subdomain the public OpenAPI docs describe, which has no such prefix).
  const res = await fetch(`${DOCUSEAL_BASE_URL}/api${path}`, {
    ...options,
    headers: {
      'X-Auth-Token': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = body?.error || body?.message || `DocuSeal error (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

/**
 * Store file buffer temporarily so createAgreementWithDocument can send it.
 * Returns a key the caller passes back as transientDocumentId.
 */
export async function uploadTransientDocument(fileBuffer, filename = 'document.pdf', orgId = null, options = {}) {
  if (!hasDocuSealConfigured()) {
    return `mock-transient-${Date.now()}`;
  }
  const key = randomUUID();
  pendingBuffers.set(key, {
    buffer: fileBuffer,
    filename,
    fields: options.formFieldsPerDocument?.[0] || null,
    signers: options.signers || null
  });
  setTimeout(() => pendingBuffers.delete(key), 5 * 60 * 1000);
  return key;
}

/**
 * @param {Array<{ name: string, email: string, order?: number, role?: string }>} signers
 * @param {Array<{ buffer: Buffer, filename: string, fields?: object[] }>} documents - each document carries its own fields
 */
async function sendSubmission(orgId, {
  signers,
  signerName,
  signerEmail,
  title,
  subject,
  message,
  documents
}) {
  const signerList = (Array.isArray(signers) && signers.length > 0)
    ? signers
    : [{ name: signerName || 'Participant', email: signerEmail || '', role: 'Signer 1' }];

  const submitters = signerList.map((s, i) => ({
    name: s.name || `Signer ${i + 1}`,
    email: s.email || '',
    role: s.role || `Signer ${i + 1}`,
    order: Number.isInteger(s.order) ? s.order : i
  }));

  const submissionDocuments = documents.map((d) => ({
    name: d.filename,
    file: d.buffer.toString('base64'),
    fields: d.fields || []
  }));

  const body = await requestDocuSeal('/submissions/pdf', {
    method: 'POST',
    body: JSON.stringify({
      name: title || 'Document',
      order: 'preserved',
      documents: submissionDocuments,
      submitters
    })
  });

  return body?.id ?? body?.[0]?.submission_id ?? body?.submission_id;
}

export async function createAgreementWithDocument({
  participantName,
  participantEmail,
  envelopeId,
  transientDocumentId,
  documentName = 'Document',
  orgId = null
}) {
  if (!hasDocuSealConfigured()) {
    return { provider: 'mock', external_envelope_id: `mock-${envelopeId}`, status: 'sent', packet_summary: '1 form sent' };
  }

  const fileInfo = pendingBuffers.get(transientDocumentId);
  if (!fileInfo) {
    return { provider: 'mock', external_envelope_id: `mock-${envelopeId}`, status: 'sent', packet_summary: '1 form sent' };
  }
  const { fields, buffer, filename, signers: storedSigners } = fileInfo;
  pendingBuffers.delete(transientDocumentId);

  const signers = Array.isArray(storedSigners) && storedSigners.length > 0
    ? storedSigners
    : [{ name: participantName || 'Participant', email: participantEmail || '', role: 'Signer 1' }];

  const submissionId = await sendSubmission(orgId, {
    signers,
    title: `${documentName} – ${participantName || 'Participant'}`,
    documents: [{ buffer, filename, fields }]
  });

  return {
    provider: 'docuseal',
    external_envelope_id: String(submissionId),
    status: 'sent',
    packet_summary: '1 form sent'
  };
}

export async function createAgreementPacket({
  participantName,
  participantEmail,
  envelopeId,
  forms,
  orgId = null
}) {
  if (!hasDocuSealConfigured()) {
    return { provider: 'mock', external_envelope_id: `mock-${envelopeId}`, status: 'sent', packet_summary: `${forms.length} form(s) in packet` };
  }

  const documents = forms
    .filter((f) => f.draft_document_path && existsSync(f.draft_document_path))
    .map((f) => ({
      buffer: readFileSync(f.draft_document_path),
      filename:
        `${f.display_name || f.form_type || 'form'}-${participantName || 'Participant'}.` +
        (f.draft_document_path.endsWith('.docx') ? 'docx' : 'pdf')
    }));

  if (!documents.length) {
    return { provider: 'mock', external_envelope_id: `mock-${envelopeId}`, status: 'sent', packet_summary: `${forms.length} form(s) in packet` };
  }

  const submissionId = await sendSubmission(orgId, {
    signerName: participantName,
    signerEmail: participantEmail,
    title: `Participant onboarding – ${participantName || 'Participant'}`,
    documents
  });

  return {
    provider: 'docuseal',
    external_envelope_id: String(submissionId),
    status: 'sent',
    packet_summary: `${documents.length} form(s) sent`
  };
}

/**
 * Send one or more PDFs in a single DocuSeal submission (used for branded library documents,
 * each carrying its own field layout).
 * @param {Array<{ buffer: Buffer, filename: string, formFields?: object[] }>} documents
 */
export async function sendMultiDocumentAgreement(orgId, {
  signers,
  signerName,
  signerEmail,
  title,
  subject,
  message,
  documents
}) {
  if (!hasDocuSealConfigured()) {
    throw new Error('DocuSeal is not configured on this server.');
  }
  return sendSubmission(orgId, {
    signers,
    signerName,
    signerEmail,
    title,
    subject,
    message,
    documents: (documents || []).map((d) => ({ buffer: d.buffer, filename: d.filename, fields: d.formFields || [] }))
  });
}

/**
 * Verify a DocuSeal webhook by shared secret query param (?key=...), since DocuSeal's own
 * webhook URL is a plain callback with no built-in request signing. Register the webhook URL
 * in DocuSeal as: https://<nexus-core host>/api/webhooks/docuseal?key=<DOCUSEAL_WEBHOOK_SECRET>
 */
export function verifyDocuSealWebhookKey(providedKey) {
  const expected = process.env.DOCUSEAL_WEBHOOK_SECRET?.trim() || '';
  if (!expected) return { valid: true, reason: 'no_secret_configured' };
  if (!providedKey) return { valid: false, reason: 'missing_key' };
  const a = Buffer.from(String(providedKey));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { valid: false, reason: 'key_mismatch' };
  return { valid: timingSafeEqual(a, b), reason: 'checked' };
}

/**
 * Fetch a DocuSeal-generated file (signed document or audit-log certificate) so it can be
 * archived the same way a Dropbox Sign signed PDF/certificate was.
 */
export async function fetchDocuSealFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download DocuSeal file (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
