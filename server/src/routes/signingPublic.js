/**
 * Native e-signature: public signer-facing endpoints — no requireAuth, the token is the credential.
 *
 *   GET  /api/sign/:token                        — resolve signer, turn-gating, docs + fields + branding
 *   GET  /api/sign/:token/document/:documentId    — stream the raw PDF for pdfjs-dist rendering
 *   PUT  /api/sign/:token                         — autosave partial values + in-progress signature
 *   POST /api/sign/:token/submit                  — finalize this signer's turn (advance, or complete envelope)
 *   POST /api/sign/:token/decline                 — decline with a reason
 */
import { Router } from 'express';
import { createHash, randomUUID, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import PDFKitDocument from 'pdfkit';
import { db } from '../db/index.js';
import { getOrgRenderContext } from '../services/orgContext.service.js';
import { sendEmailViaRelay } from '../services/notification.service.js';
import { markEnvelopeCompleted, createAuditEvent } from '../services/onboarding.service.js';

const router = Router();

const ROLE_TO_LAYOUT_SIGNER = {
  'Organisation admin': 'org',
  Participant: 'participant',
  Staff: 'staff'
};

function hashToken(raw) {
  return createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function tokenError(res, err, fallback = 400) {
  const code = err?.code || 'TOKEN_ERROR';
  const status = code === 'TOKEN_NOT_FOUND' ? 404 : fallback;
  res.status(status).json({ error: err?.message || 'Signing link error', code });
}

function resolveSigner(token) {
  if (!token) {
    const e = new Error('Token required');
    e.code = 'TOKEN_REQUIRED';
    throw e;
  }
  const row = db.prepare('SELECT * FROM signature_envelope_signers WHERE token_hash = ?').get(hashToken(token));
  if (!row) {
    const e = new Error('Signing link not found.');
    e.code = 'TOKEN_NOT_FOUND';
    throw e;
  }
  return row;
}

/** Every signature_envelope_documents row is stamped with org_id at creation time, regardless
 * of whether a backing signature_envelopes row exists (see nativeSignature.service.js). */
function envelopeOrgId(envelopeId) {
  const row = db.prepare('SELECT org_id FROM signature_envelope_documents WHERE envelope_id = ? LIMIT 1').get(envelopeId);
  return row?.org_id || null;
}

function isAheadOfTurn(signer) {
  const earlier = db
    .prepare(
      `SELECT COUNT(*) AS c FROM signature_envelope_signers
       WHERE envelope_id = ? AND sequence < ? AND status != 'signed'`
    )
    .get(signer.envelope_id, signer.sequence);
  return (earlier?.c || 0) > 0;
}

router.get('/:token', (req, res) => {
  try {
    const signer = resolveSigner(req.params.token);
    if (signer.status === 'declined') {
      return res.json({ terminal: true, status: 'declined' });
    }
    if (signer.status === 'signed') {
      return res.json({ terminal: true, status: 'signed' });
    }
    if (isAheadOfTurn(signer)) {
      return res.json({ waiting: true });
    }

    // A backing signature_envelopes row exists for the primary /send-form, /send-signatures
    // paths (created via createEnvelopeRecords) but not for the library-master onboarding-pack
    // path — envelope_id is a plain grouping key there. Both are valid; treat it as optional.
    const envelope = db.prepare('SELECT * FROM signature_envelopes WHERE id = ?').get(signer.envelope_id) || null;

    if (signer.status === 'pending') {
      db.prepare(
        `UPDATE signature_envelope_signers SET status = 'viewed', viewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(signer.id);
      createAuditEvent({
        participantId: envelope?.participant_id || null,
        participantOnboardingId: envelope?.participant_onboarding_id || null,
        actorType: 'external_signer',
        actorId: signer.id,
        eventType: 'signature_link_viewed',
        entityType: 'envelope',
        entityId: signer.envelope_id,
        newValue: { signer_email: signer.email, role: signer.role },
        sourceIp: req.headers['x-forwarded-for'] || req.ip || null,
        userAgent: req.headers['user-agent'] || null
      });
    }

    const layoutSignerKey = ROLE_TO_LAYOUT_SIGNER[signer.role] || null;
    const documents = db
      .prepare('SELECT * FROM signature_envelope_documents WHERE envelope_id = ? ORDER BY sort_order ASC')
      .all(signer.envelope_id)
      .map((doc) => {
        let layout;
        try {
          layout = JSON.parse(doc.signing_layout_json);
        } catch {
          layout = { fields: [] };
        }
        const fields = (layout.fields || []).filter((f) => !layoutSignerKey || f.signer === layoutSignerKey);
        return {
          id: doc.id,
          display_name: doc.display_name,
          page_width: layout.page_width || 595,
          page_height: layout.page_height || 842,
          page_count: layout.page_count || 1,
          fields
        };
      });

    const orgId = envelopeOrgId(signer.envelope_id);
    const ctx = orgId ? getOrgRenderContext(orgId) : null;

    let savedValues = {};
    try {
      savedValues = signer.values_json ? JSON.parse(signer.values_json) : {};
    } catch {
      savedValues = {};
    }

    res.json({
      envelope_status: envelope?.status || 'sent',
      documents,
      saved_values: savedValues,
      saved_signature_data: signer.signature_data || null,
      organisation: ctx
        ? {
            name: ctx.org.tradingName || ctx.org.name,
            primary_color: ctx.branding.primaryColor,
            accent_color: ctx.branding.accentColor
          }
        : null
    });
  } catch (err) {
    tokenError(res, err);
  }
});

router.get('/:token/document/:documentId', (req, res) => {
  try {
    const signer = resolveSigner(req.params.token);
    if (isAheadOfTurn(signer)) return res.status(403).json({ error: 'Not your turn yet.' });
    const doc = db
      .prepare('SELECT * FROM signature_envelope_documents WHERE id = ? AND envelope_id = ?')
      .get(req.params.documentId, signer.envelope_id);
    if (!doc || !existsSync(doc.document_path)) return res.status(404).json({ error: 'Document not found.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.send(readFileSync(doc.document_path));
  } catch (err) {
    tokenError(res, err);
  }
});

router.put('/:token', (req, res) => {
  try {
    const signer = resolveSigner(req.params.token);
    if (signer.status === 'signed' || signer.status === 'declined') {
      return res.status(400).json({ error: 'This signing link is no longer active.' });
    }
    const { values, signature_data: signatureData } = req.body || {};
    let existing = {};
    try {
      existing = signer.values_json ? JSON.parse(signer.values_json) : {};
    } catch {
      existing = {};
    }
    const merged = { ...existing, ...(values && typeof values === 'object' ? values : {}) };
    db.prepare(
      `UPDATE signature_envelope_signers SET values_json = ?, signature_data = COALESCE(?, signature_data), updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(merged), signatureData || null, signer.id);
    res.json({ ok: true });
  } catch (err) {
    tokenError(res, err);
  }
});

function toPdfSafeText(str) {
  return String(str ?? '')
    .replace(/→/g, '->')
    .replace(/[–—]/g, '-')
    .replace(/[^\t\n\r\x20-\x7E]/g, '?');
}

function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
}

/** Draw one field's value onto a pdf-lib page — same coordinate math as customFormFillFromLayout.service.js. */
async function drawFieldValue(doc, page, font, field, value) {
  const pageH = page.getHeight();
  const rectY = pageH - field.y - field.height;

  if (field.type === 'signature') {
    const buf = dataUrlToBuffer(value);
    if (!buf) return;
    try {
      const image = await doc.embedPng(buf);
      page.drawImage(image, { x: field.x, y: rectY, width: field.width, height: field.height });
    } catch (err) {
      console.warn('[signingPublic] failed to embed signature image:', err?.message);
    }
    return;
  }

  page.drawRectangle({ x: field.x, y: rectY, width: field.width, height: field.height, color: rgb(1, 1, 1), borderWidth: 0 });
  const drawY = rectY + Math.max(2, (field.height - 10) / 2);
  const size = Math.min(11, Math.max(8, field.height - 4));

  if (field.type === 'checkbox') {
    if (value) page.drawText('X', { x: field.x + 2, y: drawY, size, font });
    return;
  }
  // date or any other text-like value
  page.drawText(toPdfSafeText(value), { x: field.x + 2, y: drawY, size, font, maxWidth: Math.max(20, field.width - 4) });
}

/** Flatten every document in the envelope with all signers' values, merged into one final PDF buffer. */
async function flattenEnvelopeDocuments(envelopeId) {
  const documents = db
    .prepare('SELECT * FROM signature_envelope_documents WHERE envelope_id = ? ORDER BY sort_order ASC')
    .all(envelopeId);
  const signers = db.prepare('SELECT * FROM signature_envelope_signers WHERE envelope_id = ?').all(envelopeId);
  const valuesBySigner = new Map(
    signers.map((s) => {
      let values = {};
      try {
        values = s.values_json ? JSON.parse(s.values_json) : {};
      } catch {
        values = {};
      }
      return [s.role, { values, signature_data: s.signature_data }];
    })
  );

  const flattenedDocs = [];
  for (const docRow of documents) {
    const bytes = readFileSync(docRow.document_path);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = pdf.getPages();
    let layout;
    try {
      layout = JSON.parse(docRow.signing_layout_json);
    } catch {
      layout = { fields: [] };
    }
    for (const field of layout.fields || []) {
      if (field.type === 'text') continue; // already pre-filled server-side before send
      const roleEntry = [...valuesBySigner.entries()].find(([role]) => ROLE_TO_LAYOUT_SIGNER[role] === field.signer);
      if (!roleEntry) continue;
      const [, signerData] = roleEntry;
      const key = field.merge_key || field.api_id || field.name;
      const value = field.type === 'signature' ? signerData.signature_data : signerData.values[key];
      if (value == null || value === '') continue;
      const page = pages[(field.page || 1) - 1];
      if (!page) continue;
      await drawFieldValue(pdf, page, font, field, value);
    }
    flattenedDocs.push(await pdf.save());
  }

  if (flattenedDocs.length === 1) return Buffer.from(flattenedDocs[0]);

  // Merge multiple documents into one PDF (matches archiveSignedEnvelopeDocument's
  // single-buffer-per-envelope assumption).
  const merged = await PDFDocument.create();
  for (const bytes of flattenedDocs) {
    const src = await PDFDocument.load(bytes);
    const copied = await merged.copyPages(src, src.getPageIndices());
    copied.forEach((p) => merged.addPage(p));
  }
  return Buffer.from(await merged.save());
}

/** Build a signing certificate PDF listing every signer's identity, timestamps, IP, and a hash of the final document. */
function buildCertificatePdf({ envelopeId, signers, documentHash }) {
  return new Promise((resolvePromise) => {
    const doc = new PDFKitDocument({ margin: 48, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolvePromise(Buffer.concat(chunks)));

    doc.fontSize(18).text('Signing Certificate', { align: 'left' });
    doc.moveDown();
    doc.fontSize(10).text(`Envelope ID: ${envelopeId}`);
    doc.text(`Completed: ${new Date().toISOString()}`);
    doc.text(`Document SHA-256: ${documentHash}`);
    doc.moveDown();

    signers.forEach((s, i) => {
      doc.fontSize(12).text(`Signer ${i + 1}: ${s.name || '(no name)'} <${s.email || 'no email'}>`);
      doc.fontSize(10);
      doc.text(`Role: ${s.role || 'n/a'}`);
      doc.text(`Status: ${s.status}`);
      doc.text(`Consent given: ${s.consent_given ? 'Yes' : 'No'}`);
      doc.text(`Viewed at: ${s.viewed_at || 'n/a'}`);
      doc.text(`Signed at: ${s.signed_at || 'n/a'}`);
      doc.text(`IP address: ${s.source_ip || 'n/a'}`);
      doc.text(`User agent: ${s.user_agent || 'n/a'}`);
      doc.moveDown();
    });

    doc.end();
  });
}

router.post('/:token/submit', async (req, res) => {
  try {
    const signer = resolveSigner(req.params.token);
    if (signer.status === 'signed' || signer.status === 'declined') {
      return res.status(400).json({ error: 'This signing link is no longer active.' });
    }
    if (isAheadOfTurn(signer)) return res.status(403).json({ error: 'Not your turn yet.' });

    const { values, signature_data: signatureData, consent_given: consentGiven } = req.body || {};
    if (consentGiven !== true) {
      return res.status(400).json({ error: 'You must consent to sign this document electronically.', code: 'CONSENT_REQUIRED' });
    }

    const layoutSignerKey = ROLE_TO_LAYOUT_SIGNER[signer.role] || null;
    const documents = db.prepare('SELECT * FROM signature_envelope_documents WHERE envelope_id = ?').all(signer.envelope_id);
    const mergedValues = { ...(values && typeof values === 'object' ? values : {}) };
    for (const docRow of documents) {
      let layout;
      try {
        layout = JSON.parse(docRow.signing_layout_json);
      } catch {
        layout = { fields: [] };
      }
      for (const field of layout.fields || []) {
        if (!field.required || field.type === 'text' || (layoutSignerKey && field.signer !== layoutSignerKey)) continue;
        const key = field.merge_key || field.api_id || field.name;
        const value = field.type === 'signature' ? signatureData : mergedValues[key];
        if (value == null || value === '') {
          return res.status(400).json({ error: `Missing required field: ${field.label || key}`, code: 'FIELD_REQUIRED' });
        }
      }
    }

    const sourceIp = req.headers['x-forwarded-for'] || req.ip || null;
    const userAgent = req.headers['user-agent'] || null;

    db.prepare(
      `UPDATE signature_envelope_signers
       SET status = 'signed', signed_at = datetime('now'), values_json = ?, signature_data = COALESCE(?, signature_data),
           consent_given = 1, source_ip = ?, user_agent = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(JSON.stringify(mergedValues), signatureData || null, sourceIp, userAgent, signer.id);

    const counts = db
      .prepare(`SELECT COUNT(*) AS total, SUM(status = 'signed') AS signed_count FROM signature_envelope_signers WHERE envelope_id = ?`)
      .get(signer.envelope_id);
    const allSigned = Number(counts.signed_count || 0) === Number(counts.total || 0);

    // Optional — see the comment above the signature_envelope_documents migration in db/index.js.
    const envelope = db.prepare('SELECT * FROM signature_envelopes WHERE id = ?').get(signer.envelope_id) || null;

    if (!allSigned) {
      const next = db
        .prepare(`SELECT * FROM signature_envelope_signers WHERE envelope_id = ? AND status = 'pending' ORDER BY sequence ASC LIMIT 1`)
        .get(signer.envelope_id);
      if (next?.email?.trim()) {
        try {
          const orgId = envelopeOrgId(signer.envelope_id);
          const admin = db
            .prepare(
              `SELECT id, name, email FROM users WHERE org_id = ? AND email_provider IS NOT NULL AND email_oauth_refresh_encrypted IS NOT NULL
               AND (email_reconnect_required IS NULL OR email_reconnect_required = 0) ORDER BY created_at ASC LIMIT 1`
            )
            .get(orgId);
          if (admin) {
            const org = db.prepare('SELECT trading_name, name FROM organisations WHERE id = ?').get(orgId);
            const orgName = org?.trading_name?.trim() || org?.name?.trim() || 'Nexus Core';
            const baseUrl = (process.env.FRONTEND_BASE_URL || process.env.BASE_URL || 'http://localhost:5174').replace(/\/$/, '');
            // The next signer's raw token was never persisted — re-issue a fresh token for them
            // rather than trying to recover the original.
            const raw = randomBytes(32).toString('base64url');
            db.prepare(`UPDATE signature_envelope_signers SET token_hash = ?, sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
              .run(hashToken(raw), next.id);
            const signUrl = `${baseUrl}/sign/${raw}`;
            await sendEmailViaRelay(
              admin.id,
              next.email.trim(),
              `${orgName}: please sign`,
              `Hi ${next.name || 'there'},\n\n${orgName} has sent you a document for signature.\n\nSign here: ${signUrl}\n`,
              null,
              null,
              orgName
            );
          }
        } catch (err) {
          console.warn('[signingPublic] failed to notify next signer:', err?.message);
        }
      }
      return res.json({ ok: true, envelope_status: envelope?.status || 'sent', completed: false, next_signer_notified: true });
    }

    // Last signer — flatten, certify, and complete.
    const signedBuffer = await flattenEnvelopeDocuments(signer.envelope_id);
    const documentHash = createHash('sha256').update(signedBuffer).digest('hex');
    const allSigners = db.prepare('SELECT * FROM signature_envelope_signers WHERE envelope_id = ? ORDER BY sequence ASC').all(signer.envelope_id);
    const certificateBuffer = await buildCertificatePdf({ envelopeId: signer.envelope_id, signers: allSigners, documentHash });

    try {
      if (documents[0]?.document_path) {
        const dir = dirname(documents[0].document_path);
        writeFileSync(join(dir, 'signed.pdf'), signedBuffer);
        writeFileSync(join(dir, 'certificate.pdf'), certificateBuffer);
      }
    } catch (err) {
      console.warn('[signingPublic] failed to persist a durable copy of signed/certificate PDFs:', err?.message);
    }

    if (envelope) {
      // Primary /send-form, /send-signatures path — a signature_envelopes row exists, so use
      // the shared completion pipeline (archives to participant_form_instances, flips
      // participant_onboarding to complete, OneDrive push).
      markEnvelopeCompleted({
        envelopeId: signer.envelope_id,
        externalEventId: null,
        eventType: 'agreement_signed',
        payload: { signers: allSigners.map((s) => ({ name: s.name, email: s.email, role: s.role, signed_at: s.signed_at })) },
        signedBuffer,
        certificateBuffer,
        sourceIp,
        userAgent,
        providerName: 'native'
      });
    } else {
      // Library-master onboarding-pack path — no signature_envelopes row to update; the signed
      // PDF/certificate are already persisted above and every signer row is already 'signed'.
      createAuditEvent({
        actorType: 'external_signer',
        actorId: signer.id,
        eventType: 'signature_completed',
        entityType: 'envelope',
        entityId: signer.envelope_id,
        newValue: { document_hash: documentHash },
        sourceIp,
        userAgent
      });
    }

    res.json({ ok: true, envelope_status: 'signed', completed: true });
  } catch (err) {
    console.error('[signingPublic submit]', err);
    tokenError(res, err, 500);
  }
});

router.post('/:token/decline', (req, res) => {
  try {
    const signer = resolveSigner(req.params.token);
    if (signer.status === 'signed' || signer.status === 'declined') {
      return res.status(400).json({ error: 'This signing link is no longer active.' });
    }
    const reason = String(req.body?.reason || '').trim() || 'No reason given';
    const sourceIp = req.headers['x-forwarded-for'] || req.ip || null;
    const userAgent = req.headers['user-agent'] || null;

    db.prepare(
      `UPDATE signature_envelope_signers SET status = 'declined', declined_at = datetime('now'), decline_reason = ?, source_ip = ?, user_agent = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(reason, sourceIp, userAgent, signer.id);

    // signature_events has a hard FK to signature_envelopes, so both this update and that
    // insert are conditional on a backing row existing (see the comment above the
    // signature_envelope_documents migration in db/index.js).
    const envelope = db.prepare('SELECT * FROM signature_envelopes WHERE id = ?').get(signer.envelope_id) || null;
    if (envelope) {
      db.prepare(`UPDATE signature_envelopes SET status = 'declined', updated_at = datetime('now') WHERE id = ?`).run(signer.envelope_id);
      db.prepare(
        `INSERT INTO signature_events (id, envelope_id, provider_name, event_type, event_timestamp, payload_json)
         VALUES (?, ?, 'native', 'agreement_declined', datetime('now'), ?)`
      ).run(randomUUID(), signer.envelope_id, JSON.stringify({ signer_id: signer.id, email: signer.email, reason }));
    }

    createAuditEvent({
      participantId: envelope?.participant_id || null,
      participantOnboardingId: envelope?.participant_onboarding_id || null,
      actorType: 'external_signer',
      actorId: signer.id,
      eventType: 'signature_declined',
      entityType: 'envelope',
      entityId: signer.envelope_id,
      newValue: { reason },
      sourceIp,
      userAgent
    });

    try {
      const orgId = envelopeOrgId(signer.envelope_id);
      const admin = orgId
        ? db
            .prepare(
              `SELECT id, name, email FROM users WHERE org_id = ? AND email_provider IS NOT NULL AND email_oauth_refresh_encrypted IS NOT NULL
               AND (email_reconnect_required IS NULL OR email_reconnect_required = 0) ORDER BY created_at ASC LIMIT 1`
            )
            .get(orgId)
        : null;
      if (admin) {
        sendEmailViaRelay(
          admin.id,
          admin.email,
          'Nexus: a signer declined a document',
          `${signer.name || signer.email} declined to sign.\n\nReason: ${reason}\n`,
          null,
          null,
          null
        ).catch(() => {});
      }
    } catch {
      /* best-effort notification only */
    }

    res.json({ ok: true, status: 'declined' });
  } catch (err) {
    tokenError(res, err);
  }
});

export default router;
