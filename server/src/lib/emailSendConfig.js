/**
 * Email send config: OAuth-connected mailbox + global Azure relay URL from env.
 */
import { db } from '../db/index.js';

export function normalizeRelayUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (/\/api\/sendemail$/i.test(u)) {
    u = u.replace(/\/api\/sendemail$/i, '/api/sendEmail');
  } else if (!/\/api\/sendEmail$/i.test(u)) {
    u = u.replace(/\/$/, '') + '/api/sendEmail';
  }
  return u;
}

export function getRelayConfigFromEnv() {
  const url = normalizeRelayUrl(process.env.AZURE_EMAIL_FUNCTION_URL || '');
  if (!url) return null;
  return {
    url,
    apiKey: process.env.AZURE_EMAIL_API_KEY?.trim() || undefined
  };
}

const dbPrepareUser = db.prepare(`
  SELECT email_provider, email_connected_address, email_oauth_refresh_encrypted, email_reconnect_required
  FROM users WHERE id = ?
`);

/** @returns {{ provider: 'google'|'microsoft', from: string } | null} */
export function getEmailConfigForUser(userId) {
  const row = dbPrepareUser.get(userId);
  if (!row) return null;
  const provider = row.email_provider;
  const from = row.email_connected_address?.trim();
  if (!provider || !from) return null;
  if (provider !== 'google' && provider !== 'microsoft') return null;
  if (row.email_reconnect_required) return null;
  if (!row.email_oauth_refresh_encrypted) return null;
  return { provider, from };
}
