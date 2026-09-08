/**
 * Agreements sent or completed during participant onboarding.
 * Covers library-pack envelopes, classic signature_envelopes, and signed form instances.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { db } from '../db/index.js';

function signerSummary(envelopeId) {
  return db
    .prepare(
      `SELECT name, email, role, sequence, status
       FROM signature_envelope_signers
       WHERE envelope_id = ?
       ORDER BY sequence ASC`
    )
    .all(envelopeId);
}

function envelopeStatusFromSigners(signers) {
  if (!signers.length) return 'sent';
  if (signers.some((s) => s.status === 'declined')) return 'declined';
  if (signers.every((s) => s.status === 'signed')) return 'signed';
  if (signers.some((s) => s.status === 'viewed')) return 'viewed';
  return 'sent';
}

function pathsFromEnvelopeDocuments(envelopeId) {
  const docs = db
    .prepare(
      `SELECT document_path, display_name
       FROM signature_envelope_documents
       WHERE envelope_id = ?
       ORDER BY sort_order ASC`
    )
    .all(envelopeId);
  const names = docs.map((d) => d.display_name).filter(Boolean);
  const firstPath = docs[0]?.document_path;
  if (!firstPath) {
    return { signed: null, certificate: null, display_name: names.join(', ') || null };
  }
  const dir = dirname(firstPath);
  const signed = join(dir, 'signed.pdf');
  const certificate = join(dir, 'certificate.pdf');
  return {
    signed: existsSync(signed) ? signed : null,
    certificate: existsSync(certificate) ? certificate : null,
    display_name: names.join(', ') || null
  };
}

function pushEnvelopeItem(items, seen, { envelopeId, displayName, status, sentAt, completedAt }) {
  if (!envelopeId || seen.has(envelopeId)) return;
  seen.add(envelopeId);
  const signers = signerSummary(envelopeId);
  const paths = pathsFromEnvelopeDocuments(envelopeId);
  const resolvedStatus = status === 'signed' ? 'signed' : envelopeStatusFromSigners(signers) || status || 'sent';
  const tracked = db.prepare('SELECT * FROM participant_signature_envelopes WHERE envelope_id = ?').get(envelopeId);
  const signedPath = tracked?.signed_document_path || paths.signed;
  const certPath = tracked?.certificate_document_path || paths.certificate;
  items.push({
    id: `envelope:${envelopeId}`,
    source: 'envelope',
    source_id: envelopeId,
    display_name: displayName || paths.display_name || 'Onboarding agreement',
    status: resolvedStatus,
    sent_at: sentAt || tracked?.sent_at || null,
    completed_at: completedAt || tracked?.completed_at || null,
    signers,
    can_view_signed: Boolean(signedPath && existsSync(signedPath)),
    can_view_certificate: Boolean(certPath && existsSync(certPath))
  });
}

export function listParticipantAgreements(participantId) {
  const participant = db
    .prepare('SELECT id, email, provider_org_id, plan_manager_id FROM participants WHERE id = ?')
    .get(participantId);
  if (!participant) return null;

  const items = [];
  const seen = new Set();

  const tracked = db
    .prepare('SELECT * FROM participant_signature_envelopes WHERE participant_id = ? ORDER BY datetime(sent_at) DESC')
    .all(participantId);
  for (const row of tracked) {
    pushEnvelopeItem(items, seen, {
      envelopeId: row.envelope_id,
      displayName: row.display_name,
      status: row.status,
      sentAt: row.sent_at,
      completedAt: row.completed_at
    });
  }

  const classic = db
    .prepare('SELECT * FROM signature_envelopes WHERE participant_id = ? ORDER BY datetime(created_at) DESC')
    .all(participantId);
  for (const row of classic) {
    const forms = db
      .prepare(
        `SELECT ft.display_name
         FROM envelope_form_instances efi
         JOIN participant_form_instances pfi ON pfi.id = efi.form_instance_id
         JOIN form_templates ft ON ft.id = pfi.form_template_id
         WHERE efi.envelope_id = ?`
      )
      .all(row.id);
    pushEnvelopeItem(items, seen, {
      envelopeId: row.id,
      displayName: forms.map((f) => f.display_name).filter(Boolean).join(', ') || null,
      status: row.status,
      sentAt: row.sent_at,
      completedAt: row.completed_at
    });
  }

  const email = String(participant.email || '').trim().toLowerCase();
  const orgId = participant.provider_org_id || participant.plan_manager_id || null;
  if (email) {
    const discovered = orgId
      ? db
          .prepare(
            `SELECT DISTINCT s.envelope_id
             FROM signature_envelope_signers s
             JOIN signature_envelope_documents d ON d.envelope_id = s.envelope_id
             WHERE lower(s.email) = ?
               AND (d.org_id IS NULL OR d.org_id = ?)
               AND s.envelope_id NOT IN (SELECT envelope_id FROM staff_signature_envelopes)`
          )
          .all(email, orgId)
      : db
          .prepare(
            `SELECT DISTINCT s.envelope_id
             FROM signature_envelope_signers s
             WHERE lower(s.email) = ?
               AND s.envelope_id NOT IN (SELECT envelope_id FROM staff_signature_envelopes)`
          )
          .all(email);
    for (const row of discovered) {
      pushEnvelopeItem(items, seen, { envelopeId: row.envelope_id, status: null, sentAt: null, completedAt: null });
    }
  }

  const onboarding = db.prepare('SELECT id FROM participant_onboarding WHERE participant_id = ?').get(participantId);
  if (onboarding) {
    const linkedFormIds = new Set(
      db
        .prepare(
          `SELECT efi.form_instance_id AS id
           FROM envelope_form_instances efi
           JOIN signature_envelopes se ON se.id = efi.envelope_id
           WHERE se.participant_id = ?`
        )
        .all(participantId)
        .map((r) => r.id)
    );
    const forms = db
      .prepare(
        `SELECT pfi.id, pfi.status, pfi.signed_at, pfi.generated_at, pfi.signed_document_path, pfi.draft_document_path,
                ft.display_name, ft.form_type
         FROM participant_form_instances pfi
         JOIN form_templates ft ON ft.id = pfi.form_template_id
         WHERE pfi.participant_onboarding_id = ?
           AND pfi.status IN ('signed', 'sent', 'viewed')
         ORDER BY datetime(COALESCE(pfi.signed_at, pfi.generated_at, pfi.created_at)) DESC`
      )
      .all(onboarding.id);
    for (const form of forms) {
      if (linkedFormIds.has(form.id)) continue;
      const signedPath = form.signed_document_path && existsSync(form.signed_document_path) ? form.signed_document_path : null;
      const draftPath = form.draft_document_path && existsSync(form.draft_document_path) ? form.draft_document_path : null;
      items.push({
        id: `form:${form.id}`,
        source: 'form',
        source_id: form.id,
        display_name: form.display_name || form.form_type || 'Form',
        status: form.status,
        sent_at: form.generated_at,
        completed_at: form.signed_at,
        signers: [],
        can_view_signed: Boolean(signedPath || (form.status === 'signed' && draftPath) || draftPath),
        can_view_certificate: false
      });
    }
  }

  items.sort((a, b) =>
    String(b.completed_at || b.sent_at || '').localeCompare(String(a.completed_at || a.sent_at || ''))
  );
  return items;
}

export function resolveParticipantAgreementFile(participantId, itemId, kind) {
  const [source, sourceId] = String(itemId || '').split(':');
  if (!sourceId || !['signed', 'certificate'].includes(kind)) return null;

  if (source === 'envelope') {
    const tracked = db
      .prepare('SELECT * FROM participant_signature_envelopes WHERE envelope_id = ? AND participant_id = ?')
      .get(sourceId, participantId);
    const classic = db.prepare('SELECT id FROM signature_envelopes WHERE id = ? AND participant_id = ?').get(sourceId, participantId);
    const paths = pathsFromEnvelopeDocuments(sourceId);
    const filePath =
      kind === 'signed'
        ? tracked?.signed_document_path || paths.signed
        : tracked?.certificate_document_path || paths.certificate;
    if (!filePath || !existsSync(filePath)) {
      if (kind === 'signed') {
        const form = db
          .prepare(
            `SELECT pfi.signed_document_path, pfi.draft_document_path
             FROM envelope_form_instances efi
             JOIN participant_form_instances pfi ON pfi.id = efi.form_instance_id
             WHERE efi.envelope_id = ?
             ORDER BY datetime(COALESCE(pfi.signed_at, pfi.updated_at)) DESC`
          )
          .get(sourceId);
        const fallback = form?.signed_document_path && existsSync(form.signed_document_path)
          ? form.signed_document_path
          : form?.draft_document_path && existsSync(form.draft_document_path)
            ? form.draft_document_path
            : null;
        if (!fallback) return tracked || classic || paths.display_name ? { missing: true } : null;
        return { path: fallback, display_name: paths.display_name || 'agreement' };
      }
      return tracked || classic ? { missing: true } : null;
    }
    return { path: filePath, display_name: tracked?.display_name || paths.display_name || 'agreement' };
  }

  if (source === 'form') {
    const onboarding = db.prepare('SELECT id FROM participant_onboarding WHERE participant_id = ?').get(participantId);
    if (!onboarding) return null;
    const form = db
      .prepare(
        `SELECT pfi.signed_document_path, pfi.certificate_document_path, pfi.draft_document_path, ft.display_name
         FROM participant_form_instances pfi
         JOIN form_templates ft ON ft.id = pfi.form_template_id
         WHERE pfi.id = ? AND pfi.participant_onboarding_id = ?`
      )
      .get(sourceId, onboarding.id);
    if (!form) return null;
    const filePath =
      kind === 'certificate'
        ? form.certificate_document_path
        : form.signed_document_path || form.draft_document_path;
    if (!filePath || !existsSync(filePath)) return { missing: true };
    return { path: filePath, display_name: form.display_name || 'form' };
  }

  return null;
}
