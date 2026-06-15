/**
 * Xero OAuth for Nexus Core SaaS billing (separate from per-org NDIS Xero).
 * GET /api/saas/xero/connect          → redirect to Xero (requires BILLING_AUTH_SECRET)
 * GET /api/saas/xero/callback         → store tokens in xero_saas_tokens
 *
 * Required env vars:
 *   XERO_SAAS_CLIENT_ID    (or XERO_CLIENT_ID fallback)
 *   XERO_SAAS_CLIENT_SECRET (or XERO_CLIENT_SECRET fallback)
 *   XERO_SAAS_REDIRECT_URI  (e.g. https://your-nexus-domain.com/api/saas/xero/callback)
 *   BILLING_AUTH_SECRET     (any random string to gate the connect URL)
 */

import { Router } from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const router = Router();
const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

const SCOPES = 'openid profile email accounting.transactions accounting.contacts offline_access';

const pendingStates = new Map();

function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

// GET /api/saas/xero/connect
router.get('/connect', (req, res) => {
  const secret = process.env.BILLING_AUTH_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).send('Unauthorized. Pass ?secret=<BILLING_AUTH_SECRET>');
  }

  const clientId = process.env.XERO_SAAS_CLIENT_ID || process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_SAAS_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.status(500).send('XERO_SAAS_CLIENT_ID and XERO_SAAS_REDIRECT_URI required in env');
  }

  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  for (const [k, ts] of pendingStates) {
    if (Date.now() - ts > 10 * 60 * 1000) pendingStates.delete(k);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });

  res.redirect(`${XERO_AUTH_URL}?${params.toString()}`);
});

// GET /api/saas/xero/callback
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Xero denied: ${error}`);
  if (!code || !state) return res.status(400).send('Missing code or state');
  if (!pendingStates.has(state)) return res.status(400).send('Invalid or expired state');
  pendingStates.delete(state);

  try {
    const clientId = process.env.XERO_SAAS_CLIENT_ID || process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_SAAS_CLIENT_SECRET || process.env.XERO_CLIENT_SECRET;
    const redirectUri = process.env.XERO_SAAS_REDIRECT_URI;

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return res.status(500).send(`Token exchange failed: ${tokenRes.status} ${text}`);
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 1800) * 1000);

    const connectRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const connections = connectRes.ok ? await connectRes.json() : [];
    const tenantId = connections?.[0]?.tenantId || null;

    const supabase = getSupabase();
    const { error: upsertErr } = await supabase.from('xero_saas_tokens').upsert(
      {
        id: 1,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt.toISOString(),
        tenant_id: tenantId,
      },
      { onConflict: 'id' }
    );

    if (upsertErr) return res.status(500).send(`DB error: ${upsertErr.message}`);

    console.log(`[saasXeroOAuth] Connected. Tenant: ${tenantId}`);
    res.send(`
      <h2>Nexus Core Xero Connected</h2>
      <p>SaaS billing is now live. Monthly invoices will be created automatically.</p>
      ${tenantId ? `<p><strong>Tenant ID:</strong> <code>${tenantId}</code> — set as <code>XERO_SAAS_TENANT_ID</code> in env if needed.</p>` : ''}
      <p>You can close this tab.</p>
    `);
  } catch (err) {
    console.error('[saasXeroOAuth] Callback error:', err);
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

export default router;
