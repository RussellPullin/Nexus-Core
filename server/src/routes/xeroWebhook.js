/**
 * Xero app webhooks: intent challenge (GET), signed POST events → payment sync for linked billing invoices.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { syncBillingInvoiceFromXeroByXeroId } from '../services/xeroPaymentSync.service.js';

const router = Router();

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Xero sends this when registering the webhook URL. */
router.get('/', (req, res) => {
  const ch = req.query?.challenge;
  if (ch != null && ch !== '') {
    return res.type('text/plain').send(String(ch));
  }
  res.sendStatus(404);
});

router.post('/', async (req, res) => {
  const key = process.env.XERO_WEBHOOK_KEY?.trim();
  if (!key) {
    console.warn('[xero-webhook] XERO_WEBHOOK_KEY not set — rejecting');
    return res.status(503).json({ error: 'Webhook key not configured' });
  }

  const raw = req.body;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''), 'utf8');
  const sig = req.get('x-xero-signature');
  if (!sig) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const expected = createHmac('sha256', key).update(buf).digest('base64');
  if (!safeEqual(sig, expected)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  const results = [];

  for (const ev of events) {
    const cat = String(ev.eventCategory || '').toUpperCase();
    const typ = String(ev.eventType || '').toUpperCase();
    const tenantId = ev.tenantId;
    const resourceId = ev.resourceId;

    if (cat !== 'INVOICE' || !tenantId || !resourceId) {
      results.push({ skipped: true, eventCategory: cat });
      continue;
    }
    if (typ !== 'UPDATE' && typ !== 'CREATE') {
      results.push({ skipped: true, eventType: typ });
      continue;
    }

    try {
      const r = await syncBillingInvoiceFromXeroByXeroId(resourceId, tenantId, 'Synced from Xero (webhook)');
      results.push({ resourceId, ...r });
    } catch (e) {
      console.warn('[xero-webhook] sync failed', resourceId, e?.message || e);
      results.push({ resourceId, error: e?.message || String(e) });
    }
  }

  res.status(200).json({ ok: true, processed: results.length, results });
});

export default router;
