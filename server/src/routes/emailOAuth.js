/**
 * Gmail / Microsoft OAuth for sending email via Azure relay.
 * Callbacks use signed state (user id) so they work when session cookie is on a different port than the API URL.
 */
import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { saveOAuthTokens, disconnectUserEmail } from '../services/emailOAuthTokens.service.js';

const router = Router();

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

function signState(obj) {
  const secret = process.env.SESSION_SECRET || 'schedule-shift-session-secret-change-in-production';
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== 'string') return null;
  const secret = process.env.SESSION_SECRET || 'schedule-shift-session-secret-change-in-production';
  const i = state.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = state.slice(0, i);
  const sig = state.slice(i + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o.uid || !o.p || o.exp < Date.now()) return null;
    return o;
  } catch {
    return null;
  }
}

router.post('/disconnect', requireAuth, (req, res) => {
  try {
    disconnectUserEmail(req.session.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/google', requireAuth, (req, res) => {
  const cid = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!cid) {
    return res.status(500).send('Server missing GOOGLE_OAUTH_CLIENT_ID. Add it to .env.');
  }
  const redirectUri = `${apiPublicBase(req)}/api/email/oauth/google/callback`;
  const state = signState({
    uid: req.session.user.id,
    p: 'google',
    exp: Date.now() + 15 * 60 * 1000
  });
  const q = new URLSearchParams({
    client_id: cid,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email openid',
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
});

router.get('/google/callback', async (req, res) => {
  const front = `${frontendBase(req)}/settings`;
  const errRedirect = (msg) => res.redirect(`${front}?email_error=${encodeURIComponent(msg)}`);

  try {
    const { code, state, error } = req.query;
    if (error) return errRedirect(String(error));
    const st = verifyState(state);
    if (!st || st.p !== 'google') return errRedirect('Invalid or expired session. Try connecting again.');
    const userId = st.uid;

    const cid = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = `${apiPublicBase(req)}/api/email/oauth/google/callback`;
    const body = new URLSearchParams({
      code: String(code),
      client_id: cid,
      client_secret: secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const tok = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tok.access_token) {
      return errRedirect(tok.error_description || tok.error || 'Google did not return tokens');
    }
    if (!tok.refresh_token) {
      return errRedirect('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
    }

    const ui = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    const profile = await ui.json().catch(() => ({}));
    const email = profile.email?.trim()?.toLowerCase();
    if (!email) return errRedirect('Could not read your Google email address.');

    saveOAuthTokens(userId, {
      provider: 'google',
      connectedAddress: email,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresInSec: tok.expires_in
    });

    res.redirect(`${front}?email_connected=1`);
  } catch (e) {
    console.error('[emailOAuth] google callback', e);
    errRedirect(e.message || 'Connection failed');
  }
});

router.get('/microsoft', requireAuth, (req, res) => {
  const cid = process.env.MICROSOFT_OAUTH_CLIENT_ID;
  if (!cid) {
    return res.status(500).send('Server missing MICROSOFT_OAUTH_CLIENT_ID.');
  }
  const tenant = process.env.MICROSOFT_OAUTH_TENANT || 'common';
  const redirectUri = `${apiPublicBase(req)}/api/email/oauth/microsoft/callback`;
  const state = signState({
    uid: req.session.user.id,
    p: 'microsoft',
    exp: Date.now() + 15 * 60 * 1000
  });
  const q = new URLSearchParams({
    client_id: cid,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'offline_access openid profile Mail.Send User.Read',
    state
  });
  res.redirect(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${q}`);
});

router.get('/microsoft/callback', async (req, res) => {
  const front = `${frontendBase(req)}/settings`;
  const errRedirect = (msg) => res.redirect(`${front}?email_error=${encodeURIComponent(msg)}`);

  try {
    const { code, state, error, error_description } = req.query;
    if (error) return errRedirect(String(error_description || error));
    const st = verifyState(state);
    if (!st || st.p !== 'microsoft') return errRedirect('Invalid or expired session. Try connecting again.');
    const userId = st.uid;

    const cid = process.env.MICROSOFT_OAUTH_CLIENT_ID;
    const secret = process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
    const tenant = process.env.MICROSOFT_OAUTH_TENANT || 'common';
    const redirectUri = `${apiPublicBase(req)}/api/email/oauth/microsoft/callback`;
    const body = new URLSearchParams({
      code: String(code),
      client_id: cid,
      client_secret: secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: 'offline_access openid profile Mail.Send User.Read'
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
      return errRedirect('Microsoft did not return a refresh token. Try again or contact support.');
    }

    const me = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    const profile = await me.json().catch(() => ({}));
    const email = (profile.mail || profile.userPrincipalName || '').trim().toLowerCase();
    if (!email) return errRedirect('Could not read your Microsoft email address.');

    saveOAuthTokens(userId, {
      provider: 'microsoft',
      connectedAddress: email,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresInSec: tok.expires_in
    });

    res.redirect(`${front}?email_connected=1`);
  } catch (e) {
    console.error('[emailOAuth] microsoft callback', e);
    errRedirect(e.message || 'Connection failed');
  }
});

export default router;
