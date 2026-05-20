import { db } from '../db/index.js';

const DEFAULT_REST_BASE = process.env.ADOBE_SIGN_BASE_URL || 'https://api.na1.adobesign.com/api/rest/v6';
const LEGACY_ENV_TOKEN = process.env.ADOBE_SIGN_ACCESS_TOKEN || '';
const ADOBE_ACCOUNT_EMAIL = process.env.ADOBE_SIGN_ACCOUNT_EMAIL || '';

/**
 * REST API base (…/api/rest/v6) from OAuth api_access_point, e.g. https://api.na1.adobesign.com/
 * @param {string} apiAccessPoint
 */
function restV6BaseFromApiAccessPoint(apiAccessPoint) {
  const raw = String(apiAccessPoint || '').trim();
  if (!raw) return DEFAULT_REST_BASE.replace(/\/$/, '');
  const u = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  return `${u.origin}/api/rest/v6`;
}

/**
 * @param {string | null | undefined} orgId
 * @returns {Promise<{ accessToken: string, restBaseUrl: string, accountEmail: string } | null>}
 */
async function getAdobeRestContext(orgId) {
  const envToken = LEGACY_ENV_TOKEN.trim();
  const envRest = DEFAULT_REST_BASE.replace(/\/$/, '');

  if (!orgId) {
    if (envToken) {
      return { accessToken: envToken, restBaseUrl: envRest, accountEmail: ADOBE_ACCOUNT_EMAIL };
    }
    return null;
  }

  const row = db
    .prepare(
      `SELECT adobe_sign_refresh_token, adobe_sign_api_access_point FROM business_settings WHERE org_id = ?`
    )
    .get(orgId);

  if (row?.adobe_sign_refresh_token && row?.adobe_sign_api_access_point) {
    const refreshed = await refreshAdobeAccessToken(orgId, row);
    const restBase =
      process.env.ADOBE_SIGN_BASE_URL?.trim() || restV6BaseFromApiAccessPoint(refreshed.apiAccessPoint);
    return {
      accessToken: refreshed.accessToken,
      restBaseUrl: restBase.replace(/\/$/, ''),
      accountEmail: ADOBE_ACCOUNT_EMAIL
    };
  }

  if (envToken) {
    return { accessToken: envToken, restBaseUrl: envRest, accountEmail: ADOBE_ACCOUNT_EMAIL };
  }

  return null;
}

function hasConfiguredAdobeForOrg(orgId) {
  if (orgId) {
    const r = db
      .prepare(`SELECT adobe_sign_refresh_token, adobe_sign_api_access_point FROM business_settings WHERE org_id = ?`)
      .get(orgId);
    if (r?.adobe_sign_refresh_token && r?.adobe_sign_api_access_point) return true;
  }
  return Boolean(LEGACY_ENV_TOKEN.trim());
}

/**
 * @param {string} orgId
 * @param {{ adobe_sign_refresh_token: string, adobe_sign_api_access_point: string }} row
 */
async function refreshAdobeAccessToken(orgId, row) {
  const clientId = process.env.ADOBE_SIGN_CLIENT_ID?.trim();
  const clientSecret = process.env.ADOBE_SIGN_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Adobe Sign OAuth client is not configured (ADOBE_SIGN_CLIENT_ID / ADOBE_SIGN_CLIENT_SECRET).');
  }
  const tokenUrl = new URL('oauth/v2/refresh', row.adobe_sign_api_access_point).href;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.adobe_sign_refresh_token,
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    throw new Error(body.message || body.code || `Adobe Sign token refresh failed (${res.status})`);
  }
  const accessToken = body.access_token;
  const newRefresh = body.refresh_token || row.adobe_sign_refresh_token;
  let apiAccessPoint = (body.api_access_point || row.adobe_sign_api_access_point || '').trim();
  if (!accessToken) throw new Error('Adobe Sign refresh response missing access_token');
  if (newRefresh) {
    db.prepare(
      `UPDATE business_settings SET adobe_sign_refresh_token = ?, adobe_sign_api_access_point = ?, updated_at = datetime('now') WHERE org_id = ?`
    ).run(newRefresh, apiAccessPoint, orgId);
  }
  return { accessToken, apiAccessPoint };
}

/**
 * Exchange authorization code after OAuth redirect (Settings callback).
 * @param {{ code: string, redirectUri: string, apiAccessPoint: string }} opts
 */
export async function exchangeAdobeAuthorizationCode({ code, redirectUri, apiAccessPoint }) {
  const clientId = process.env.ADOBE_SIGN_CLIENT_ID?.trim();
  const clientSecret = process.env.ADOBE_SIGN_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Adobe Sign OAuth is not configured on this server.');
  }
  const base = String(apiAccessPoint || '').trim();
  if (!base) throw new Error('Missing Adobe api_access_point');
  const tokenUrl = new URL('oauth/token', base.endsWith('/') ? base : `${base}/`).href;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri
    }).toString()
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(body.message || body.code || `Adobe Sign token exchange failed (${res.status})`);
  }
  const refreshToken = body.refresh_token;
  const apiPoint = (body.api_access_point || base).trim();
  const webPoint = (body.web_access_point || '').trim();
  if (!refreshToken) throw new Error('Adobe Sign token response missing refresh_token');
  return {
    refresh_token: refreshToken,
    api_access_point: apiPoint,
    web_access_point: webPoint || null
  };
}

async function requestAdobe(orgId, path, options = {}) {
  const ctx = await getAdobeRestContext(orgId);
  if (!ctx) {
    throw new Error('Adobe Sign is not configured for this organisation.');
  }
  const base = ctx.restBaseUrl.replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${ctx.accessToken}`,
    ...(options.headers || {})
  };
  if (!options.body || typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers
  });
  const resText = await res.text();
  const body = resText
    ? (() => {
        try {
          return JSON.parse(resText);
        } catch {
          return { raw: resText };
        }
      })()
    : {};
  if (!res.ok) {
    const message = body?.message || body?.code || `Adobe Sign request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

/**
 * Upload a document to Adobe Sign as a transient document.
 * @param {Buffer} fileBuffer
 * @param {string} filename
 * @param {string | null} [orgId]
 */
export async function uploadTransientDocument(fileBuffer, filename = 'document.pdf', orgId = null) {
  if (!hasConfiguredAdobeForOrg(orgId)) {
    return `mock-transient-${Date.now()}`;
  }

  const ctx = await getAdobeRestContext(orgId);
  if (!ctx) {
    return `mock-transient-${Date.now()}`;
  }

  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('File', fileBuffer, {
    filename,
    contentType: filename.endsWith('.pdf')
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });

  const base = ctx.restBaseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/transientDocuments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      ...form.getHeaders()
    },
    body: form
  });

  const text = await res.text();
  const body = text
    ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return {};
        }
      })()
    : {};
  if (!res.ok) {
    throw new Error(body?.message || body?.code || `Transient document upload failed (${res.status})`);
  }
  return body.transientDocumentId;
}

/**
 * @param {object} opts
 * @param {string | null} [opts.orgId]
 */
export async function createAgreementWithDocument({
  participantName,
  participantEmail,
  envelopeId,
  transientDocumentId,
  documentName = 'Consent form',
  orgId = null
}) {
  if (!hasConfiguredAdobeForOrg(orgId)) {
    return {
      provider: 'mock',
      external_envelope_id: `mock-${envelopeId}`,
      status: 'sent',
      packet_summary: '1 form sent'
    };
  }

  const ctx = await getAdobeRestContext(orgId);
  if (!ctx) {
    return {
      provider: 'mock',
      external_envelope_id: `mock-${envelopeId}`,
      status: 'sent',
      packet_summary: '1 form sent'
    };
  }

  const fileInfos = transientDocumentId ? [{ transientDocumentId }] : [];

  const payload = {
    name: `${documentName} - ${participantName || 'Participant'} - ${envelopeId}`,
    fileInfos,
    participantSetsInfo: [
      {
        memberInfos: [{ email: participantEmail || ctx.accountEmail || ADOBE_ACCOUNT_EMAIL }],
        order: 1,
        role: 'SIGNER'
      }
    ],
    signatureType: 'ESIGN',
    state: 'IN_PROCESS',
    externalId: { id: envelopeId },
    message: `Please review and sign: ${documentName}.`
  };

  const agreement = await requestAdobe(orgId, '/agreements', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  return {
    provider: 'adobe_sign',
    external_envelope_id: agreement.id,
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
  if (!hasConfiguredAdobeForOrg(orgId)) {
    return {
      provider: 'mock',
      external_envelope_id: `mock-${envelopeId}`,
      status: 'sent',
      packet_summary: `${forms.length} form(s) in packet`
    };
  }

  const ctx = await getAdobeRestContext(orgId);
  if (!ctx) {
    return {
      provider: 'mock',
      external_envelope_id: `mock-${envelopeId}`,
      status: 'sent',
      packet_summary: `${forms.length} form(s) in packet`
    };
  }

  const payload = {
    name: `Participant onboarding - ${participantName || 'Participant'} - ${envelopeId}`,
    participantSetsInfo: [
      {
        memberInfos: [{ email: participantEmail || ctx.accountEmail || ADOBE_ACCOUNT_EMAIL }],
        order: 1,
        role: 'SIGNER'
      }
    ],
    signatureType: 'ESIGN',
    state: 'IN_PROCESS',
    externalId: {
      id: envelopeId
    },
    message: `Please review and sign required onboarding forms (${forms.length} form(s)).`
  };

  const agreement = await requestAdobe(orgId, '/agreements', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  return {
    provider: 'adobe_sign',
    external_envelope_id: agreement.id,
    status: 'sent',
    packet_summary: `${forms.length} form(s) sent`
  };
}

export function verifyWebhookPayload(_payload, reqHeaders = {}) {
  // Accept ADOBE_SIGN_WEBHOOK_SECRET; fall back to ADOBE_SIGN_CLIENT_ID (Adobe sends the client ID in x-adobesign-clientid).
  const expectedSecret =
    process.env.ADOBE_SIGN_WEBHOOK_SECRET?.trim() ||
    process.env.ADOBE_SIGN_CLIENT_ID?.trim() ||
    '';
  if (!expectedSecret) return { valid: true, reason: 'no_secret_configured' };
  const incoming = reqHeaders['x-adobesign-clientid'] || reqHeaders['x-adobesign-signature'] || '';
  if (!incoming) return { valid: false, reason: 'missing_signature_header' };
  return { valid: incoming === expectedSecret, reason: incoming === expectedSecret ? 'signature_ok' : 'signature_mismatch' };
}

/**
 * @param {string | null} orgId
 * @param {string} externalEnvelopeId
 * @param {string} path
 * @returns {Promise<Buffer | null>}
 */
async function fetchAdobeBinary(orgId, externalEnvelopeId, path) {
  if (!externalEnvelopeId || String(externalEnvelopeId).startsWith('mock-')) return null;
  if (!hasConfiguredAdobeForOrg(orgId)) return null;
  const ctx = await getAdobeRestContext(orgId);
  if (!ctx) return null;
  const base = ctx.restBaseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${ctx.accessToken}` }
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Adobe Sign fetch failed (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Download the merged signed PDF (all documents combined) for a completed Adobe Sign agreement.
 * Returns null for mock envelopes or orgs without Adobe configured.
 * @param {string | null} orgId
 * @param {string} externalEnvelopeId
 */
export async function downloadAgreementCombinedDocument(orgId, externalEnvelopeId) {
  return fetchAdobeBinary(
    orgId,
    externalEnvelopeId,
    `/agreements/${encodeURIComponent(externalEnvelopeId)}/combinedDocument?attachSupportingDocuments=true&attachAuditReport=false`
  );
}

/**
 * Download the audit certificate PDF for a completed Adobe Sign agreement.
 * @param {string | null} orgId
 * @param {string} externalEnvelopeId
 */
export async function downloadAgreementAuditTrail(orgId, externalEnvelopeId) {
  return fetchAdobeBinary(
    orgId,
    externalEnvelopeId,
    `/agreements/${encodeURIComponent(externalEnvelopeId)}/auditTrail`
  );
}
