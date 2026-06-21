/**
 * Phase 4: Public participant self-service intake endpoints.
 *
 *   GET    /api/intake/:token            — fetch the intake shell (participant name, org branding, prior answers)
 *   PUT    /api/intake/:token            — save a partial set of fields (autosave)
 *   POST   /api/intake/:token/submit     — finalise; marks token completed, ensures onboarding row exists
 *
 * Mounted WITHOUT requireAuth — the token itself is the credential.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import {
  resolveIntakeToken,
  upsertFieldsByToken,
  completeIntakeToken
} from '../services/participantIntakeToken.service.js';
import { getOrgRenderContext } from '../services/orgContext.service.js';
import { buildPolicyAttachmentsForEmail } from '../services/onboardingDocumentPacks.service.js';
import { renderLibraryDocument } from '../services/documentLibraryRender.service.js';
import { fillAcroFormWithTokens } from '../services/formFill.service.js';
import { sendEmailViaRelay } from '../services/notification.service.js';

const router = Router();

function tokenError(res, err, fallback = 400) {
  const code = err?.code || 'TOKEN_ERROR';
  const status = code === 'TOKEN_NOT_FOUND' ? 404 : code === 'TOKEN_EXPIRED' ? 410 : fallback;
  res.status(status).json({ error: err?.message || 'Intake token error', code });
}

router.get('/:token', (req, res) => {
  try {
    const record = resolveIntakeToken(req.params.token);
    const intake = db
      .prepare('SELECT field_key, field_value FROM participant_intake_fields WHERE participant_onboarding_id IN (SELECT id FROM participant_onboarding WHERE participant_id = ?)')
      .all(record.participant_id);
    const intakeMap = Object.fromEntries(intake.map((r) => [r.field_key, r.field_value]));
    const ctx = record.organisation_id ? getOrgRenderContext(record.organisation_id) : null;
    res.json({
      participant: record.participant,
      organisation: ctx
        ? {
            id: ctx.org.id,
            name: ctx.org.tradingName || ctx.org.name,
            legal_name: ctx.org.legalName,
            primary_color: ctx.branding.primaryColor,
            accent_color: ctx.branding.accentColor,
            logo_path: Boolean(ctx.branding.logoPath)
          }
        : null,
      expires_at: record.expires_at,
      saved_fields: intakeMap
    });
  } catch (err) {
    tokenError(res, err);
  }
});

router.put('/:token', (req, res) => {
  try {
    const fields = req.body?.fields || {};
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ error: 'fields must be an object' });
    }
    upsertFieldsByToken(req.params.token, fields);
    res.json({ ok: true, saved: Object.keys(fields).length });
  } catch (err) {
    tokenError(res, err);
  }
});

router.post('/:token/submit', (req, res) => {
  try {
    if (req.body?.fields && typeof req.body.fields === 'object' && !Array.isArray(req.body.fields)) {
      upsertFieldsByToken(req.params.token, req.body.fields);
    }
    const result = completeIntakeToken(req.params.token);
    res.json({ ok: true, ...result });

    // Fire-and-forget: send policy pack to participant + notify admin
    sendIntakePoliciesAndNotify(result.participant_id, result.organisation_id).catch((err) => {
      console.warn('[intake-submit] background notification failed:', err?.message);
    });
  } catch (err) {
    tokenError(res, err);
  }
});

/**
 * After a participant submits their intake form:
 *  1. Send the org's participant onboarding policy pack to the participant.
 *  2. Notify the org admin that the intake is complete.
 *
 * Both send from the first org admin user who has email OAuth connected.
 * Failures are logged but do not affect the participant's submission response.
 */
async function sendIntakePoliciesAndNotify(participantId, organisationId) {
  if (!organisationId || !participantId) return;

  const participant = db
    .prepare('SELECT id, name, email FROM participants WHERE id = ?')
    .get(participantId);
  if (!participant?.email?.trim()) return;

  // Find the org's provider profile (has default pack ID)
  const profile = db
    .prepare('SELECT * FROM provider_profiles WHERE organisation_id = ?')
    .get(organisationId);
  if (!profile) return;

  // Find any org admin with email OAuth connected
  const adminUser = db
    .prepare(`
      SELECT id, name, email FROM users
      WHERE org_id = ?
        AND email_provider IS NOT NULL
        AND email_oauth_refresh_encrypted IS NOT NULL
        AND (email_reconnect_required IS NULL OR email_reconnect_required = 0)
      ORDER BY created_at ASC
      LIMIT 1
    `)
    .get(organisationId);
  if (!adminUser) return;

  const org = db
    .prepare('SELECT trading_name, name FROM organisations WHERE id = ?')
    .get(organisationId);
  const orgName = org?.trading_name?.trim() || org?.name?.trim() || 'Your service provider';

  // ── 1. Gather all participant onboarding attachments ─────────────────────
  const allAttachments = [];

  // 1a. Uploaded policy PDFs from the org's participant onboarding pack
  try {
    const { attachments } = buildPolicyAttachmentsForEmail(
      profile.id,
      profile.default_participant_onboarding_pack_id || null,
      'participant_onboarding',
      null
    );
    allAttachments.push(...attachments);
  } catch (err) {
    console.warn('[intake-submit] policy pack build failed:', err?.message);
  }

  // 1b. Document library templates tagged pack=participant_onboarding
  try {
    const fullParticipant = db.prepare('SELECT * FROM participants WHERE id = ?').get(participantId);
    const libMasters = db.prepare(`
      SELECT m.id, m.slug, m.display_name, m.engine
      FROM document_library_masters m
      JOIN org_library_send_stages s ON s.master_id = m.id
      WHERE s.org_id = ?
        AND s.stage = 'participant_intake'
        AND m.is_active = 1
      ORDER BY m.display_name COLLATE NOCASE
    `).all(organisationId);

    for (const master of libMasters) {
      try {
        const rendered = renderLibraryDocument({
          masterId: master.id,
          orgId: organisationId,
          participant: fullParticipant
        });
        let buf = rendered.buffer;
        if (rendered.needsAcroFormFill && buf) {
          buf = await fillAcroFormWithTokens(buf, rendered.tokens);
        }
        if (buf) {
          const safeName = (master.display_name || master.slug).replace(/[/\\?%*:|"<>]/g, '_');
          allAttachments.push({ filename: `${safeName}.pdf`, content: buf, contentType: 'application/pdf' });
        }
      } catch (err) {
        console.warn(`[intake-submit] library doc render failed (${master.slug}):`, err?.message);
      }
    }
  } catch (err) {
    console.warn('[intake-submit] library template query failed:', err?.message);
  }

  // ── 2. Send participant email with all attachments ────────────────────────
  if (allAttachments.length > 0) {
    try {
      const attachmentsForEmail = allAttachments.map((a) => ({
        ...a,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
      }));
      const subject = `${orgName}: welcome — your onboarding documents`;
      const text =
        `Hi ${participant.name || 'there'},\n\n` +
        `Thank you for completing your intake form with ${orgName}.\n\n` +
        `Please find attached your onboarding documents. Take a moment to read through them ` +
        `and keep them for your records.\n\n` +
        `Your coordinator will be in touch shortly to finalise your Service Agreement.\n\n` +
        `If you have any questions please reply to this email.\n`;

      await sendEmailViaRelay(adminUser.id, participant.email.trim(), subject, text, null, attachmentsForEmail, orgName);
      console.log(`[intake-submit] onboarding docs sent to ${participant.email} (${allAttachments.length} attachments)`);
    } catch (err) {
      console.warn('[intake-submit] participant email send failed:', err?.message);
    }
  } else {
    console.log('[intake-submit] no onboarding attachments found — skipping participant email');
  }

  // ── 3. Notify admin that intake is complete ───────────────────────────────
  try {
    const participantName = participant.name || 'A participant';
    const subject = `Nexus: ${participantName} completed their intake form`;
    const text =
      `${participantName} has submitted their intake form and is ready to progress.\n\n` +
      `Next steps:\n` +
      `  1. Review their intake details in Nexus\n` +
      `  2. Add a service schedule (plan allocations) for the participant\n` +
      `  3. Generate and send the Service Agreement for signature\n\n` +
      `Log in to Nexus to continue the onboarding process.\n`;

    await sendEmailViaRelay(adminUser.id, adminUser.email, subject, text, null, null, orgName);
    console.log(`[intake-submit] admin notification sent to ${adminUser.email}`);
  } catch (err) {
    console.warn('[intake-submit] admin notification failed:', err?.message);
  }
}

export default router;
