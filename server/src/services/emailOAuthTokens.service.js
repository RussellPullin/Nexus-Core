import { db } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';

const FIVE_MIN_MS = 5 * 60 * 1000;

function markReconnectRequired(userId) {
  db.prepare(`
    UPDATE users SET email_reconnect_required = 1, updated_at = datetime('now') WHERE id = ?
  `).run(userId);
}

export function disconnectUserEmail(userId) {
  db.prepare(`
    UPDATE users SET
      email_provider = NULL,
      email_connected_address = NULL,
      email_oauth_access_encrypted = NULL,
      email_oauth_refresh_encrypted = NULL,
      email_token_expires_at = NULL,
      email_reconnect_required = 0,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(userId);
}

export function saveOAuthTokens(userId, { provider, connectedAddress, accessToken, refreshToken, expiresInSec }) {
  const now = Date.now();
  const expiresAt = expiresInSec ? now + expiresInSec * 1000 : now + 3600 * 1000;
  db.prepare(`
    UPDATE users SET
      email_provider = ?,
      email_connected_address = ?,
      email_oauth_access_encrypted = ?,
      email_oauth_refresh_encrypted = ?,
      email_token_expires_at = ?,
      email_reconnect_required = 0,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    provider,
    connectedAddress,
    encrypt(accessToken),
    refreshToken ? encrypt(refreshToken) : null,
    expiresAt,
    userId
  );
}

/**
 * @returns {Promise<string>} access token
 * @throws {Error} with .code EMAIL_RECONNECT_REQUIRED
 */
export async function getValidAccessToken(userId) {
  const row = db.prepare(`
    SELECT email_provider, email_oauth_access_encrypted, email_oauth_refresh_encrypted,
           email_token_expires_at, email_reconnect_required
    FROM users WHERE id = ?
  `).get(userId);

  if (!row?.email_oauth_refresh_encrypted) {
    const err = new Error('Connect your email in Settings to send messages.');
    err.code = 'EMAIL_NOT_CONNECTED';
    throw err;
  }
  if (row.email_reconnect_required) {
    const err = new Error('Your email connection expired. Please reconnect in Settings.');
    err.code = 'EMAIL_RECONNECT_REQUIRED';
    throw err;
  }

  const refresh = decrypt(row.email_oauth_refresh_encrypted);
  if (!refresh) {
    markReconnectRequired(userId);
    const err = new Error('Your email connection expired. Please reconnect in Settings.');
    err.code = 'EMAIL_RECONNECT_REQUIRED';
    throw err;
  }

  const expiresAt = row.email_token_expires_at || 0;
  if (expiresAt > Date.now() + FIVE_MIN_MS && row.email_oauth_access_encrypted) {
    const access = decrypt(row.email_oauth_access_encrypted);
    if (access) return access;
  }

  const provider = row.email_provider;
  try {
    if (provider === 'google') {
      return await refreshGoogle(userId, refresh);
    }
    if (provider === 'microsoft') {
      return await refreshMicrosoft(userId, refresh);
    }
  } catch (e) {
    if (e?.code === 'EMAIL_RECONNECT_REQUIRED') throw e;
    markReconnectRequired(userId);
    const err = new Error('Your email connection expired. Please reconnect in Settings.');
    err.code = 'EMAIL_RECONNECT_REQUIRED';
    throw err;
  }
  markReconnectRequired(userId);
  const err = new Error('Your email connection expired. Please reconnect in Settings.');
  err.code = 'EMAIL_RECONNECT_REQUIRED';
  throw err;
}

async function refreshGoogle(userId, refreshToken) {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Google OAuth not configured on server');

  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      const err = new Error('Reconnect your Gmail in Settings.');
      err.code = 'EMAIL_RECONNECT_REQUIRED';
      throw err;
    }
    throw new Error(data.error_description || data.error || 'Google token refresh failed');
  }
  const expiresIn = data.expires_in || 3600;
  let newRefresh = refreshToken;
  if (data.refresh_token) newRefresh = data.refresh_token;
  db.prepare(`
    UPDATE users SET
      email_oauth_access_encrypted = ?,
      email_oauth_refresh_encrypted = ?,
      email_token_expires_at = ?,
      email_reconnect_required = 0,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    encrypt(data.access_token),
    encrypt(newRefresh),
    Date.now() + expiresIn * 1000,
    userId
  );
  return data.access_token;
}

async function refreshMicrosoft(userId, refreshToken) {
  const id = process.env.MICROSOFT_OAUTH_CLIENT_ID;
  const secret = process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
  const tenant = process.env.MICROSOFT_OAUTH_TENANT || 'common';
  if (!id || !secret) throw new Error('Microsoft OAuth not configured on server');

  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access openid profile Mail.Send User.Read'
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      const err = new Error('Reconnect your Microsoft account in Settings.');
      err.code = 'EMAIL_RECONNECT_REQUIRED';
      throw err;
    }
    throw new Error(data.error_description || data.error || 'Microsoft token refresh failed');
  }
  const expiresIn = data.expires_in || 3600;
  let newRefresh = refreshToken;
  if (data.refresh_token) newRefresh = data.refresh_token;
  db.prepare(`
    UPDATE users SET
      email_oauth_access_encrypted = ?,
      email_oauth_refresh_encrypted = ?,
      email_token_expires_at = ?,
      email_reconnect_required = 0,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    encrypt(data.access_token),
    encrypt(newRefresh),
    Date.now() + expiresIn * 1000,
    userId
  );
  return data.access_token;
}
