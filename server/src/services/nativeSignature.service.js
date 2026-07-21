/**
 * Native Nexus Core e-signature integration.
 *
 * Exports: uploadTransientDocument, createAgreementWithDocument, createAgreementPacket,
 * sendMultiDocumentAgreement. The existing *DocuSealFields.service.js field-builder services
 * produce a uniform field shape ({name,type,role,required,areas:[{x,y,w,h,page}]}) which this
 * file converts into SigningLayout (see formTemplateSigningLayout.service.js).
 *
 * No external signing provider — signing happens on this app's own /sign/:token page, and
 * completion is reported by calling onboarding.service.js's markEnvelopeCompleted() directly.
 */
import { randomUUID, randomBytes, createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { sendEmailViaRelay } from './notification.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
// Must respect DATA_DIR (the persistent Fly volume mount) like staff.js does — signed
// documents/certificates written under projectRoot alone live in the container's ephemeral
// image layer and are silently lost on every deploy.
const dataDir = process.env.DATA_DIR || join(projectRoot, 'data');
const envelopesDir = join(dataDir, 'onboarding', 'envelopes');

function ensureEnvelopeDir(envelopeId) {
  const dir = join(envelopesDir, envelopeId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function hasNativeSignatureConfigured() {
  return true;
}

const ROLE_TO_SIGNER = {
  'Organisation admin': 'org',
  Participant: 'participant',
  Staff: 'staff'
};

/**
 * Convert the field-builder fields[] (from *DocuSealFields.service.js builders)
 * into this app's SigningLayout shape.
 * @param {Array<{name:string,type:string,role:string,required?:boolean,areas:Array<{x:number,y:number,w:number,h:number,page:number}>}>} fields
 */
function fieldsToLayout(fields) {
  const layoutFields = (fields || []).flatMap((f) =>
    (f.areas || []).map((a) => ({
      id: randomUUID(),
      page: a.page || 1,
      x: a.x,
      y: a.y,
      width: a.w,
      height: a.h,
      type: f.type === 'date' ? 'date' : f.type === 'checkbox' ? 'checkbox' : f.type === 'signature' ? 'signature' : 'text',
      merge_key: f.name,
      label: f.label || null,
      fillable: f.fillable === true,
      signer: ROLE_TO_SIGNER[f.role] || 'participant',
      required: f.required === true
    }))
  );
  const maxPage = layoutFields.reduce((m, f) => Math.max(m, f.page), 1);
  return { page_width: 595, page_height: 842, page_count: maxPage, fields: layoutFields };
}

/** Fallback used only where no field builder ran (the legacy packet-bundling path never had one — see createAgreementPacket). */
// merge_key is unique per call (not a fixed string) so a packet bundling several documents,
// each falling back to this layout, never collides on the same field key.
function singleSignatureLayout() {
  return {
    page_width: 595,
    page_height: 842,
    page_count: 1,
    fields: [
      { id: randomUUID(), page: 1, x: 72, y: 700, width: 180, height: 40, type: 'signature', merge_key: `signature_${randomUUID()}`, signer: 'participant', required: true }
    ]
  };
}

// Temp store for file buffers between uploadTransientDocument and createAgreementWithDocument.
// Keys expire after 5 minutes to prevent memory leaks.
const pendingBuffers = new Map();

/**
 * Store file buffer temporarily so createAgreementWithDocument can send it.
 * Returns a key the caller passes back as transientDocumentId.
 */
export async function uploadTransientDocument(fileBuffer, filename = 'document.pdf', orgId = null, options = {}) {
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

function findAdminEmailSender(orgId) {
  if (!orgId) return null;
  return db
    .prepare(
      `SELECT id, name, email FROM users
       WHERE org_id = ?
         AND email_provider IS NOT NULL
         AND email_oauth_refresh_encrypted IS NOT NULL
         AND (email_reconnect_required IS NULL OR email_reconnect_required = 0)
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(orgId);
}

function orgDisplayName(orgId) {
  if (!orgId) return 'Nexus Core';
  const org = db.prepare('SELECT trading_name, name FROM organisations WHERE id = ?').get(orgId);
  return org?.trading_name?.trim() || org?.name?.trim() || 'Nexus Core';
}

function insertSigner(envelopeId, signer, sequence) {
  const raw = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const id = randomUUID();
  db.prepare(
    `INSERT INTO signature_envelope_signers (id, envelope_id, name, email, role, sequence, status, token_hash)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, envelopeId, signer.name || null, signer.email || null, signer.role || null, sequence, tokenHash);
  return { id, token: raw };
}

/** Insert signer rows (each carrying its own raw token, only ever held in memory — see notifySignersWithTokens). */
function createSigners(envelopeId, signers, fallback) {
  const list = Array.isArray(signers) && signers.length > 0
    ? signers
    : [{ name: fallback?.name || 'Signer', email: fallback?.email || '', role: 'Participant' }];

  return list.map((s, i) => {
    const sequence = Number.isInteger(s.order) ? s.order : i;
    const { id, token } = insertSigner(envelopeId, s, sequence);
    return { id, envelope_id: envelopeId, sequence, raw_token: token, email: s.email, name: s.name };
  });
}

function insertDocument({ envelopeId, orgId = null, formInstanceId = null, displayName, buffer, filename, layout, sortOrder = 0 }) {
  const dir = ensureEnvelopeDir(envelopeId);
  const documentPath = join(dir, `${randomUUID()}-${filename}`.replace(/[^a-zA-Z0-9._-]/g, '_'));
  writeFileSync(documentPath, buffer);
  db.prepare(
    `INSERT INTO signature_envelope_documents (id, envelope_id, org_id, form_instance_id, display_name, document_path, signing_layout_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), envelopeId, orgId, formInstanceId, displayName || filename, documentPath, JSON.stringify(layout), sortOrder);
  return documentPath;
}

/** Email the earliest-sequence signer(s) their signing link, using the raw tokens still held in memory from this request. */
async function notifySignersWithTokens(envelopeId, orgId, documentNames, signerRows) {
  if (!signerRows.length) return;
  const minSequence = Math.min(...signerRows.map((s) => s.sequence));
  const toNotify = signerRows.filter((s) => s.sequence === minSequence);

  const admin = findAdminEmailSender(orgId);
  if (!admin) {
    console.warn('[nativeSignature] no admin with email OAuth connected — cannot send signing link(s)');
    return;
  }
  const orgName = orgDisplayName(orgId);
  const baseUrl = (process.env.FRONTEND_BASE_URL || process.env.BASE_URL || 'http://localhost:5174').replace(/\/$/, '');

  for (const signer of toNotify) {
    if (!signer.email?.trim()) continue;
    try {
      const signUrl = `${baseUrl}/sign/${signer.raw_token}`;
      const subject = `${orgName}: please sign ${documentNames}`;
      const text =
        `Hi ${signer.name || 'there'},\n\n` +
        `${orgName} has sent you ${documentNames} for signature.\n\n` +
        `Sign here: ${signUrl}\n\n` +
        `If you have any questions, reply to this email.\n`;
      await sendEmailViaRelay(admin.id, signer.email.trim(), subject, text, null, null, orgName);
      db.prepare(`UPDATE signature_envelope_signers SET sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(signer.id);
    } catch (err) {
      console.warn('[nativeSignature] failed to email signer', signer.email, err?.message);
    }
  }
}

export async function createAgreementWithDocument({
  participantName,
  participantEmail,
  envelopeId,
  transientDocumentId,
  documentName = 'Document',
  orgId = null
}) {
  const fileInfo = pendingBuffers.get(transientDocumentId);
  if (!fileInfo) {
    return { provider: 'native', external_envelope_id: envelopeId, status: 'sent', packet_summary: '1 form sent' };
  }
  const { buffer, filename, fields, signers: storedSigners } = fileInfo;
  pendingBuffers.delete(transientDocumentId);

  insertDocument({
    envelopeId,
    orgId,
    displayName: documentName,
    buffer,
    filename,
    layout: fields?.length ? fieldsToLayout(fields) : singleSignatureLayout()
  });

  const signerRows = createSigners(envelopeId, storedSigners, { name: participantName, email: participantEmail });
  await notifySignersWithTokens(envelopeId, orgId, documentName, signerRows);

  return { provider: 'native', external_envelope_id: envelopeId, status: 'sent', packet_summary: '1 form sent' };
}

/**
 * Bundle multiple already-generated forms into one envelope (the hybrid/packet bundling path).
 * This path does not receive precise field layouts, so each document gets one generic signature field.
 */
export async function createAgreementPacket({
  participantName,
  participantEmail,
  envelopeId,
  forms,
  orgId = null
}) {
  const validForms = (forms || []).filter((f) => f.draft_document_path && existsSync(f.draft_document_path));
  if (!validForms.length) {
    return { provider: 'native', external_envelope_id: envelopeId, status: 'sent', packet_summary: `${forms.length} form(s) in packet` };
  }

  validForms.forEach((f, i) => {
    const buffer = readFileSync(f.draft_document_path);
    const filename =
      `${f.display_name || f.form_type || 'form'}-${participantName || 'Participant'}.` +
      (f.draft_document_path.endsWith('.docx') ? 'docx' : 'pdf');
    insertDocument({
      envelopeId,
      orgId,
      formInstanceId: f.id,
      displayName: f.display_name || f.form_type,
      buffer,
      filename,
      layout: singleSignatureLayout(),
      sortOrder: i
    });
  });

  const signerRows = createSigners(envelopeId, null, { name: participantName, email: participantEmail });
  await notifySignersWithTokens(envelopeId, orgId, `${validForms.length} form(s)`, signerRows);

  return { provider: 'native', external_envelope_id: envelopeId, status: 'sent', packet_summary: `${validForms.length} form(s) sent` };
}

/**
 * Send one or more PDFs as a single envelope (used for branded library documents, each carrying
 * its own field layout via documents[].formFields — converted via fieldsToLayout above).
 * Requires options.envelopeId — the caller (libraryDocumentSignature.service.js) already generates
 * one before calling this. No signature_envelopes row is required for this path (the library-master
 * send flow — including staff onboarding, which has no participant_id — never creates one);
 * completion is handled entirely via signature_envelope_documents/_signers.
 */
export async function sendMultiDocumentAgreement(orgId, {
  signers,
  signerName,
  signerEmail,
  title,
  documents,
  envelopeId,
  /** When false, create the session but do not email links (caller opens /sign/:token in-app). */
  notify = true
}) {
  if (!envelopeId) throw new Error('sendMultiDocumentAgreement requires options.envelopeId for the native signature service.');

  (documents || []).forEach((d, i) => {
    insertDocument({
      envelopeId,
      orgId,
      displayName: d.filename,
      buffer: d.buffer,
      filename: d.filename,
      layout: d.formFields?.length ? fieldsToLayout(d.formFields) : singleSignatureLayout(),
      sortOrder: i
    });
  });

  const signerRows = createSigners(envelopeId, signers, { name: signerName, email: signerEmail });
  if (notify !== false) {
    await notifySignersWithTokens(envelopeId, orgId, title || 'your documents', signerRows);
  }

  return { envelopeId, signers: signerRows };
}
