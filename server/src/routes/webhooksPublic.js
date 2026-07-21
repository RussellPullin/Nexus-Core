/**
 * Public webhooks — no session auth required.
 *
 * POST /api/webhooks/progress-app   — Progress Notes app shift sync (CRM API key)
 */
import { Router } from 'express';
import { processShifts } from '../services/webhookProcessor.js';

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

export default router;
