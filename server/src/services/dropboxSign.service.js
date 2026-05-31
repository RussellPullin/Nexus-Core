import { randomUUID, createHmac } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { db } from '../db/index.js';

const DROPBOX_SIGN_API_BASE = 'https://api.hellosign.com/v3';

// Temp store for file buffers between uploadTransientDocument and createAgreementWithDocument.
// Keys expire after 5 minutes to prevent memory leaks.
const pendingBuffers = new Map();

function hasConfiguredDropboxForOrg(orgId) {
  if (orgId) {
    const r = db
      .prepare(`SELECT dropbox_sign_access_token FROM business_settings WHERE org_id = ?`)
      .get(orgId);
    if (r?.dropbox_sign_access_token) return true;
  }
  return Boolean(process.env.DROPBOX_SIGN_API_KEY?.trim());
}

async function getDropboxContext(orgId) {
  if (orgId) {
    const row = db
      .prepare(`SELECT dropbox_sign_access_token, dropbox_sign_refresh_token FROM business_settings WHERE org_id = ?`)
      .get(orgId);
    if (row?.dropbox_sign_access_token) {
      try {
        const refreshed = await refreshDropboxAccessToken(orgId, row);
        return { accessToken: refreshed.accessToken, apiKey: null };
      } catch {
        // fall through to API key
      }
    }
  }
  const apiKey = process.env.DROPBOX_SIGN_API_KEY?.trim();
  if (apiKey) return { accessToken: null, apiKey };
  return null;
}

function authHeader(ctx) {
  if (ctx.accessToken) return `Bearer ${ctx.accessToken}`;
  return `Basic ${Buffer.from(`${ctx.apiKey}:`).toString('base64')}`;
}

async function refreshDropboxAccessToken(orgId, row) {
  const clientId = process.env.DROPBOX_SIGN_CLIENT_ID?.trim();
  const clientSecret = process.env.DROPBOX_SIGN_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('Dropbox Sign OAuth not configured.');

  const res = await fetch('https://app.hellosign.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.dropbox_sign_refresh_token,
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `Token refresh failed (${res.status})`);
  const accessToken = body.access_token;
  const newRefresh = body.refresh_token || row.dropbox_sign_refresh_token;
  if (!accessToken) throw new Error('Dropbox Sign refresh missing access_token');
  db.prepare(
    `UPDATE business_settings SET dropbox_sign_access_token = ?, dropbox_sign_refresh_token = ?, updated_at = datetime('now') WHERE org_id = ?`
  ).run(accessToken, newRefresh, orgId);
  return { accessToken };
}

export async function exchangeDropboxAuthorizationCode({ code, redirectUri, state }) {
  const clientId = process.env.DROPBOX_SIGN_CLIENT_ID?.trim();
  const clientSecret = process.env.DROPBOX_SIGN_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('Dropbox Sign OAuth is not configured on this server.');

  const res = await fetch('https://app.hellosign.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      state: state || ''
    }).toString()
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `Token exchange failed (${res.status})`);
  if (!body.access_token) throw new Error('Dropbox Sign token response missing access_token');
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token || null
  };
}

async function requestDropbox(orgId, path, options = {}) {
  const ctx = await getDropboxContext(orgId);
  if (!ctx) throw new Error('Dropbox Sign is not configured for this organisation.');

  const res = await fetch(`${DROPBOX_SIGN_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: authHeader(ctx),
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = body?.error?.error_msg || body?.error?.message || body?.message || `Dropbox Sign error (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

/**
 * Store file buffer temporarily so createAgreementWithDocument can send it.
 * Returns a key the caller passes back as transientDocumentId.
 */
export async function uploadTransientDocument(
  fileBuffer,
  filename = 'document.pdf',
  orgId = null,
  options = {}
) {
  if (!hasConfiguredDropboxForOrg(orgId)) {
    return `mock-transient-${Date.now()}`;
  }
  const key = randomUUID();
  pendingBuffers.set(key, {
    buffer: fileBuffer,
    filename,
    formFieldsPerDocument: options.formFieldsPerDocument || null,
    customFields: options.customFields || null,
    signers: options.signers || null
  });
  setTimeout(() => pendingBuffers.delete(key), 5 * 60 * 1000);
  return key;
}

/**
 * @param {Array<{ name: string, email: string, order?: number, role?: string }>} signers
 *   Index in array is the signer's API index (signers[i] in Dropbox's payload).
 *   If `order` is provided on every signer, the request becomes a sequential signing flow.
 */
async function sendSignatureRequest(orgId, {
  signers,
  // Back-compat single-signer shorthand
  signerName,
  signerEmail,
  title,
  subject,
  message,
  files,
  formFieldsPerDocument = null,
  customFields = null
}) {
  const ctx = await getDropboxContext(orgId);
  if (!ctx) throw new Error('Dropbox Sign is not configured for this organisation.');

  const signerList = (Array.isArray(signers) && signers.length > 0)
    ? signers
    : [{ name: signerName || 'Participant', email: signerEmail || '' }];

  const form = new FormData();
  signerList.forEach((s, i) => {
    form.append(`signers[${i}][email_address]`, s.email || '');
    form.append(`signers[${i}][name]`, s.name || `Signer ${i + 1}`);
    if (Number.isInteger(s.order)) {
      form.append(`signers[${i}][order]`, String(s.order));
    }
  });

  form.append('title', title || 'Document');
  form.append('subject', subject || title || 'Please sign this document');
  form.append('message', message || 'Please review and sign the attached document.');

  if (formFieldsPerDocument?.length) {
    form.append('form_fields_per_document', JSON.stringify(formFieldsPerDocument));
  }
  if (customFields?.length) {
    form.append('custom_fields', JSON.stringify(customFields));
  }

  for (let i = 0; i < files.length; i++) {
    const { buffer, filename } = files[i];
    const mime = filename.endsWith('.pdf')
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    form.append(`file[${i}]`, new Blob([buffer], { type: mime }), filename);
  }

  const res = await fetch(`${DROPBOX_SIGN_API_BASE}/signature_request/send`, {
    method: 'POST',
    headers: { Authorization: authHeader(ctx) },
    body: form
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.error_msg || body?.error?.message || `Signature request failed (${res.status})`;
    throw new Error(msg);
  }
  return body.signature_request?.signature_request_id || body.signature_request_id;
}

export async function createAgreementWithDocument({
  participantName,
  participantEmail,
  envelopeId,
  transientDocumentId,
  documentName = 'Document',
  orgId = null
}) {
  if (!hasConfiguredDropboxForOrg(orgId)) {
    return { provider: 'mock', external_envelope_id: `mock-${envelopeId}`, status: 'sent', packet_summary: '1 form sent' };
  }

  const fileInfo = pendingBuffers.get(transientDocumentId);
  if (!fileInfo) {
    return { provider: 'mock', external_envelope_id: `mock-${envelopeId}`, status: 'sent', packet_summary: '1 form sent' };
  }
  const { formFieldsPerDocument, customFields, buffer, filename, signers: storedSigners } = fileInfo;
  pendingBuffers.delete(transientDocumentId);

  const signers = Array.isArray(storedSigners) && storedSigners.length > 0
    ? storedSigners
    : [{ name: participantName || 'Participant', email: participantEmail || '' }];

  const subject = signers.length > 1
    ? `Action requested: review & sign ${documentName}`
    : `Please sign ${documentName}`;

  const message = signers.length > 1
    ? `${documentName}: the organisation admin signs first to confirm participant details, then the participant signs.`
    : `Please review and sign: ${documentName}.`;

  const signatureRequestId = await sendSignatureRequest(orgId, {
    signers,
    title: `${documentName} – ${participantName || 'Participant'}`,
    subject,
    message,
    files: [{ buffer, filename }],
    formFieldsPerDocument,
    customFields
  });

  return {
    provider: 'dropbox_sign',
    external_envelope_id: signatureRequestId,
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
  if (!hasConfiguredDropboxForOrg(orgId)) {
    return { provider: 'mock', external_envelope_id: `mock-${envelopeId}`, status: 'sent', packet_summary: `${forms.length} form(s) in packet` };
  }

  const files = forms
    .filter((f) => f.draft_document_path && existsSync(f.draft_document_path))
    .map((f) => ({
      buffer: readFileSync(f.draft_document_path),
      filename:
        `${f.display_name || f.form_type || 'form'}-${participantName || 'Participant'}.` +
        (f.draft_document_path.endsWith('.docx') ? 'docx' : 'pdf')
    }));

  if (!files.length) {
    return { provider: 'mock', external_envelope_id: `mock-${envelopeId}`, status: 'sent', packet_summary: `${forms.length} form(s) in packet` };
  }

  const signatureRequestId = await sendSignatureRequest(orgId, {
    signerName: participantName,
    signerEmail: participantEmail,
    title: `Participant onboarding – ${participantName || 'Participant'}`,
    message: `Please review and sign required onboarding forms (${files.length} document(s)).`,
    files
  });

  return {
    provider: 'dropbox_sign',
    external_envelope_id: signatureRequestId,
    status: 'sent',
    packet_summary: `${files.length} form(s) sent`
  };
}

/**
 * Verify Dropbox Sign webhook event_hash.
 * Hash = HMAC-SHA256(key=API_KEY, msg=event_time + event_type)
 */
export function verifyDropboxWebhookPayload(body, _headers) {
  const apiKey =
    process.env.DROPBOX_SIGN_API_KEY?.trim() ||
    process.env.DROPBOX_SIGN_WEBHOOK_SECRET?.trim() ||
    '';
  if (!apiKey) return { valid: true, reason: 'no_secret_configured' };

  const eventTime = body?.event?.event_time || '';
  const eventType = body?.event?.event_type || '';
  const incomingHash = body?.event?.event_hash || '';
  if (!incomingHash) return { valid: false, reason: 'missing_event_hash' };

  const expected = createHmac('sha256', apiKey)
    .update(eventTime + eventType)
    .digest('hex');

  return {
    valid: expected === incomingHash,
    reason: expected === incomingHash ? 'hash_ok' : 'hash_mismatch'
  };
}
