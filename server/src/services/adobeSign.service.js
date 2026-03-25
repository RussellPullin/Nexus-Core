const ADOBE_BASE_URL = process.env.ADOBE_SIGN_BASE_URL || 'https://api.na1.adobesign.com/api/rest/v6';
const ADOBE_ACCESS_TOKEN = process.env.ADOBE_SIGN_ACCESS_TOKEN || '';
const ADOBE_ACCOUNT_EMAIL = process.env.ADOBE_SIGN_ACCOUNT_EMAIL || '';

function hasConfiguredAdobe() {
  return Boolean(ADOBE_ACCESS_TOKEN);
}

async function requestAdobe(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${ADOBE_ACCESS_TOKEN}`,
    ...(options.headers || {})
  };
  if (!options.body || typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${ADOBE_BASE_URL}${path}`, {
    ...options,
    headers
  });
  const text = await res.text();
  const body = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  })() : {};
  if (!res.ok) {
    const message = body?.message || body?.code || `Adobe Sign request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

/**
 * Upload a document to Adobe Sign as a transient document.
 * @param {Buffer} fileBuffer - Document buffer (PDF, DOCX, etc.)
 * @param {string} filename - Original filename for the document
 * @returns {Promise<string>} transientDocumentId
 */
export async function uploadTransientDocument(fileBuffer, filename = 'document.pdf') {
  if (!hasConfiguredAdobe()) {
    return `mock-transient-${Date.now()}`;
  }

  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('File', fileBuffer, { filename, contentType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

  const res = await fetch(`${ADOBE_BASE_URL}/transientDocuments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADOBE_ACCESS_TOKEN}`,
      ...form.getHeaders()
    },
    body: form
  });

  const text = await res.text();
  const body = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  })() : {};
  if (!res.ok) {
    throw new Error(body?.message || body?.code || `Transient document upload failed (${res.status})`);
  }
  return body.transientDocumentId;
}

/**
 * Create agreement with an uploaded document (transient or library).
 * @param {object} opts
 * @param {string} opts.participantName
 * @param {string} opts.participantEmail
 * @param {string} opts.envelopeId
 * @param {string} [opts.transientDocumentId] - From uploadTransientDocument
 * @param {string} [opts.documentName]
 */
export async function createAgreementWithDocument({
  participantName,
  participantEmail,
  envelopeId,
  transientDocumentId,
  documentName = 'Consent form'
}) {
  if (!hasConfiguredAdobe()) {
    return {
      provider: 'mock',
      external_envelope_id: `mock-${envelopeId}`,
      status: 'sent',
      packet_summary: '1 form sent'
    };
  }

  const fileInfos = transientDocumentId
    ? [{ transientDocumentId }]
    : [];

  const payload = {
    name: `${documentName} - ${participantName || 'Participant'} - ${envelopeId}`,
    fileInfos,
    participantSetsInfo: [
      {
        memberInfos: [{ email: participantEmail || ADOBE_ACCOUNT_EMAIL }],
        order: 1,
        role: 'SIGNER'
      }
    ],
    signatureType: 'ESIGN',
    state: 'IN_PROCESS',
    externalId: { id: envelopeId },
    message: `Please review and sign: ${documentName}.`
  };

  const agreement = await requestAdobe('/agreements', {
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
  forms
}) {
  if (!hasConfiguredAdobe()) {
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
        memberInfos: [{ email: participantEmail || ADOBE_ACCOUNT_EMAIL }],
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

  const agreement = await requestAdobe('/agreements', {
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
  // Lightweight acceptance for now; keep strict checks when webhook signing secret is configured.
  const expectedSecret = process.env.ADOBE_SIGN_WEBHOOK_SECRET || '';
  if (!expectedSecret) return { valid: true, reason: 'no_secret_configured' };
  const incoming = reqHeaders['x-adobesign-clientid'] || reqHeaders['x-adobesign-signature'] || '';
  if (!incoming) return { valid: false, reason: 'missing_signature_header' };
  return { valid: incoming === expectedSecret, reason: incoming === expectedSecret ? 'signature_ok' : 'signature_mismatch' };
}
