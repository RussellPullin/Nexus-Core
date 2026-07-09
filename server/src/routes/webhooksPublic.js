/**
 * Public webhooks — no session auth required.
 *
 * POST /api/webhooks/progress-app   — Progress Notes app shift sync (CRM API key)
 * POST /api/webhooks/docuseal       — DocuSeal (self-hosted) event notifications
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { processShifts } from '../services/webhookProcessor.js';
import { db } from '../db/index.js';
import { verifyDocuSealWebhookKey, fetchDocuSealFile } from '../services/docuSeal.service.js';
import { markEnvelopeCompleted } from '../services/onboarding.service.js';

const router = Router();

function hasValidCrmApiKey(req) {
  const expected = process.env.CRM_API_KEY?.trim?.() || process.env.CRM_API_KEY || '';
  if (!expected) return false;
  const apiKey = (req.headers['x-api-key'] || '').trim();
  if (apiKey && apiKey === expected) return true;
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() === expected;
  }
  return false;
}

/**
 * POST /api/webhooks/progress-app
 * Body: JSON array of shifts, or { shifts: [...], org_id?: uuid }.
 * Auth: x-api-key or Authorization: Bearer — same value as CRM_API_KEY on the server.
 */
router.post('/progress-app', (req, res) => {
  try {
    if (!process.env.CRM_API_KEY?.trim?.() && !process.env.CRM_API_KEY) {
      return res.status(503).json({
        error: 'Webhooks are not configured on this server yet.',
        code: 'WEBHOOK_NOT_CONFIGURED',
      });
    }
    if (!hasValidCrmApiKey(req)) {
      return res.status(401).json({
        error: 'Invalid or missing API key',
        code: 'UNAUTHORIZED',
        errorDetail: 'Send header x-api-key or Authorization: Bearer with the API key your administrator configured for Nexus.',
      });
    }

    const body = req.body;
    let shifts;
    let orgId = null;
    if (Array.isArray(body)) {
      shifts = body;
    } else if (body && typeof body === 'object') {
      orgId = body.org_id || body.organization_id || null;
      if (Array.isArray(body.shifts)) shifts = body.shifts;
      else if (Array.isArray(body.data)) shifts = body.data;
      else if (Array.isArray(body.records)) shifts = body.records;
      else shifts = null;
    } else {
      shifts = null;
    }

    if (!Array.isArray(shifts)) {
      return res.status(400).json({
        error: 'Expected a JSON array of shifts or an object with a shifts array',
        code: 'INVALID_PAYLOAD',
      });
    }

    const result = processShifts(shifts, {
      orgId: orgId ? String(orgId).trim() : null,
      // Never let a scheduled placeholder echoed through the webhook become a billable
      // 'completed' shift. Genuine completions carry a progress note / mood / clock-out
      // and still pass; bare scheduled rows are left untouched (not billed).
      requireCompletionEvidence: true,
      log: (msg, data) => console.log('[webhook progress-app]', msg, data || ''),
      logWarn: (msg, data) => console.warn('[webhook progress-app]', msg, data || ''),
      logError: (msg, err) => console.error('[webhook progress-app]', msg, err),
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[webhook progress-app]', err);
    res.status(500).json({ error: err.message || 'Webhook processing failed' });
  }
});

// ── DocuSeal webhooks ──────────────────────────────────────────────────────
// Webhook URL to register in DocuSeal (Settings → Webhooks):
//   https://nexus-core-crm.fly.dev/api/webhooks/docuseal?key=<DOCUSEAL_WEBHOOK_SECRET>
// Events subscribed: form.viewed, form.completed, form.declined

router.post('/docuseal', async (req, res) => {
  try {
    const verification = verifyDocuSealWebhookKey(req.query?.key);
    if (!verification.valid) {
      console.warn('[webhook docuseal] verification failed:', verification.reason);
      return res.status(401).json({ error: 'Invalid webhook key' });
    }

    const eventType = req.body?.event_type || '';
    const data = req.body?.data || {};
    const submissionId = data?.submission?.id != null ? String(data.submission.id) : null;

    if (!submissionId) {
      return res.status(200).json({ ok: true });
    }

    const envelope = db
      .prepare('SELECT * FROM signature_envelopes WHERE external_envelope_id = ?')
      .get(submissionId);

    if (envelope) {
      const submissionCompleted = eventType === 'form.completed' && data?.submission?.status === 'completed';

      if (submissionCompleted) {
        let signedBuffer = null;
        let certificateBuffer = null;
        try {
          const docUrl = data?.submission?.documents?.[0]?.url || data?.documents?.[0]?.url || null;
          if (docUrl) signedBuffer = await fetchDocuSealFile(docUrl);
        } catch (e) {
          console.warn('[webhook docuseal] failed to fetch signed document:', e?.message);
        }
        try {
          const certUrl = data?.submission?.audit_log_url || data?.audit_log_url || null;
          if (certUrl) certificateBuffer = await fetchDocuSealFile(certUrl);
        } catch (e) {
          console.warn('[webhook docuseal] failed to fetch audit log certificate:', e?.message);
        }

        markEnvelopeCompleted({
          envelopeId: envelope.id,
          externalEventId: data?.id != null ? String(data.id) : null,
          eventType: 'agreement_signed',
          payload: req.body,
          signedBuffer,
          certificateBuffer,
          // DocuSeal reports the signer's own IP/user-agent at time of signing (captured
          // client-side on the hosted signing page), unlike a webhook-caller IP.
          sourceIp: data?.ip || req.headers['x-forwarded-for'] || req.ip || null,
          userAgent: data?.ua || req.headers['user-agent'] || null
        });
      } else {
        db.prepare(`
          INSERT INTO signature_events (
            id, envelope_id, provider_name, external_event_id, event_type, event_timestamp, payload_json
          ) VALUES (?, ?, 'docuseal', ?, ?, datetime('now'), ?)
        `).run(
          randomUUID(),
          envelope.id,
          data?.id != null ? String(data.id) : null,
          eventType,
          JSON.stringify(req.body)
        );
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhook docuseal]', err);
    res.status(200).json({ ok: true });
  }
});

export default router;
