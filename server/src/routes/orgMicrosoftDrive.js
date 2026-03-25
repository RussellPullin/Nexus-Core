/**
 * Per-org Microsoft 365 connection for OneDrive document archive (delegated OAuth).
 * Add redirect URI: {OAUTH_PUBLIC_URL}/api/integrations/microsoft-drive/callback
 * Azure app needs Files.ReadWrite.All (admin consent typical for org-wide).
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/roles.js';
import { db } from '../db/index.js';
import { signOAuthState, verifyOAuthState } from '../lib/oauthState.js';
import { saveOnedriveLink, clearOnedriveLink, getOnedriveLinkRow } from '../services/orgOnedriveTokens.service.js';
import { ensureNexusCoreLayout, listRegister } from '../services/orgOnedriveSync.service.js';

const router = Router();

const DRIVE_SCOPES =
  'offline_access openid profile User.Read Files.ReadWrite.All';

function apiPublicBase(req) {
  const env = process.env.OAUTH_PUBLIC_URL?.trim();
  if (env) return env.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function frontendBase(req) {
  const env = process.env.FRONTEND_ORIGIN?.trim();
  if (env) return env.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

router.get('/status', requireAuth, (req, res) => {
  try {
    const u = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session.user.id);
    const orgId = u?.org_id || null;
    if (!orgId) {
      return res.json({ connected: false, organization_id: null, message: 'No organisation on your account.' });
    }
    const row = getOnedriveLinkRow(orgId);
    res.json({
      connected: Boolean(row?.refresh_token_encrypted),
      organization_id: orgId,
      connected_at: row?.connected_at || null,
      nexus_core_ready: Boolean(row?.nexus_core_folder_id)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/register', requireAuth, requireAdmin, (req, res) => {
  try {
    const u = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session.user.id);
    const orgId = u?.org_id;
    if (!orgId) return res.status(400).json({ error: 'No organisation' });
    const rows = listRegister(orgId, {
      entityType: req.query.entity_type || null,
      entityId: req.query.entity_id || null,
      limit: req.query.limit ? Number(req.query.limit) : 200
    });
    res.json({ items: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/disconnect', requireAuth, requireAdmin, (req, res) => {
  try {
    const u = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session.user.id);
    if (!u?.org_id) return res.status(400).json({ error: 'No organisation' });
    clearOnedriveLink(u.org_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/start', requireAuth, requireAdmin, (req, res) => {
  const cid = process.env.MICROSOFT_OAUTH_CLIENT_ID?.trim();
  if (!cid) {
    return res.status(500).send('Server missing MICROSOFT_OAUTH_CLIENT_ID.');
  }
  const u = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session.user.id);
  if (!u?.org_id) {
    return res.status(400).send('Your user has no organisation. Complete organisation setup first.');
  }
  const tenant = process.env.MICROSOFT_OAUTH_TENANT || 'common';
  const redirectUri = `${apiPublicBase(req)}/api/integrations/microsoft-drive/callback`;
  const state = signOAuthState({
    uid: req.session.user.id,
    orgId: u.org_id,
    p: 'ms_drive',
    exp: Date.now() + 20 * 60 * 1000
  });
  const q = new URLSearchParams({
    client_id: cid,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: DRIVE_SCOPES,
    state,
    prompt: 'consent'
  });
  res.redirect(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${q}`);
});

router.get('/callback', async (req, res) => {
  const front = `${frontendBase(req)}/settings`;
  const errRedirect = (msg) => res.redirect(`${front}?ms_drive_error=${encodeURIComponent(msg)}`);

  try {
    const { code, state, error, error_description } = req.query;
    if (error) return errRedirect(String(error_description || error));
    const st = verifyOAuthState(state);
    if (!st || st.p !== 'ms_drive' || !st.orgId) return errRedirect('Invalid or expired session. Try connecting again.');

    const cid = process.env.MICROSOFT_OAUTH_CLIENT_ID?.trim();
    const secret = process.env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim();
    const tenant = process.env.MICROSOFT_OAUTH_TENANT || 'common';
    const redirectUri = `${apiPublicBase(req)}/api/integrations/microsoft-drive/callback`;
    const body = new URLSearchParams({
      code: String(code),
      client_id: cid,
      client_secret: secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: DRIVE_SCOPES
    });
    const tokRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const tok = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tok.access_token) {
      return errRedirect(tok.error_description || tok.error || 'Microsoft did not return tokens');
    }
    if (!tok.refresh_token) {
      return errRedirect('No refresh token returned. Try again with prompt=consent.');
    }

    const me = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName,mail', {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    const profile = await me.json().catch(() => ({}));
    const graphUserId = profile.id;
    if (!graphUserId) return errRedirect('Could not read Microsoft account id.');

    let tid = null;
    try {
      const parts = String(tok.access_token).split('.');
      if (parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        tid = payload.tid || null;
      }
    } catch {
      tid = null;
    }

    saveOnedriveLink({
      organizationId: st.orgId,
      graphUserId,
      azureTenantId: tid,
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      expiresInSec: tok.expires_in,
      connectedByUserId: st.uid
    });

    try {
      await ensureNexusCoreLayout(st.orgId);
    } catch (layoutErr) {
      console.error('[orgMicrosoftDrive] layout', layoutErr);
      return errRedirect(
        'Microsoft connected but folder setup failed: ' + (layoutErr.message || 'unknown') + '. Check Graph permissions.'
      );
    }

    res.redirect(`${front}?ms_drive_connected=1`);
  } catch (e) {
    console.error('[orgMicrosoftDrive] callback', e);
    errRedirect(e.message || 'Connection failed');
  }
});

export default router;
