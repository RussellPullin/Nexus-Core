/**
 * Email send config: OAuth-connected mailbox + global Azure relay URL from env.
 */
import { db } from '../db/index.js';

/**
 * Azure / Fly secrets often paste the host without https://; fetch() then throws "Failed to parse URL".
 */
export function ensureUrlHasScheme(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost\b/i.test(s) || /^127\.0\.0\.1(?:[:\/]|$)/i.test(s)) return `http://${s}`;
  return `https://${s}`;
}

/** True when env still contains the docs/example placeholder (invalid or wrong host). */
export function relayHostLooksLikeDocPlaceholder(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw.trim();
  if (/<your-function-app>/i.test(s)) return true;
  try {
    const h = new URL(ensureUrlHasScheme(s)).hostname.toLowerCase();
    return h === 'your-function-app.azurewebsites.net';
  } catch {
    return false;
  }
}

export function normalizeRelayUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let raw = url.trim();
  if (!raw) return null;
  raw = ensureUrlHasScheme(raw);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  let path = (parsed.pathname || '/').replace(/\/$/, '') || '/';
  if (/\/api\/sendemail$/i.test(path)) {
    path = path.replace(/\/api\/sendemail$/i, '/api/sendEmail');
  } else if (!/\/api\/sendEmail$/i.test(path)) {
    path = path === '/' ? '/api/sendEmail' : `${path}/api/sendEmail`;
  }
  parsed.pathname = path.startsWith('/') ? path : `/${path}`;
  return parsed.toString();
}

/** Strip BOM / outer quotes (common when copying secrets or shell-quoting Fly values). */
export function normalizeRelayApiKeySecret(raw) {
  if (raw == null || typeof raw !== 'string') return undefined;
  let s = raw.trim().replace(/^\uFEFF/, '');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s || undefined;
}

export function getRelayConfigFromEnv() {
  const raw = process.env.AZURE_EMAIL_FUNCTION_URL || '';
  if (relayHostLooksLikeDocPlaceholder(raw)) return null;
  const url = normalizeRelayUrl(raw);
  if (!url) return null;
  return {
    url,
    apiKey: normalizeRelayApiKeySecret(process.env.AZURE_EMAIL_API_KEY)
  };
}

/**
 * True when AZURE_EMAIL_FUNCTION_URL points at this Nexus API host (common Fly mistake: paste app URL, not Azure).
 * Relay uses server-side fetch with no session cookie → POST /api/sendEmail hits requireAuth → 401 { error: "Not authenticated" }.
 */
export function relayUrlPointsToThisNexusApi(relayUrlString) {
  let relayHost;
  try {
    relayHost = new URL(relayUrlString).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!relayHost) return false;
  const hosts = [];
  for (const key of ['OAUTH_PUBLIC_URL', 'BASE_URL', 'FRONTEND_BASE_URL']) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    try {
      hosts.push(new URL(raw).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  const flyApp = process.env.FLY_APP_NAME?.trim().toLowerCase();
  if (flyApp) hosts.push(`${flyApp}.fly.dev`);
  return hosts.some((h) => h && h === relayHost);
}

const dbPrepareUser = db.prepare(`
  SELECT email_provider, email_connected_address, email_oauth_refresh_encrypted, email_reconnect_required
  FROM users WHERE id = ?
`);
const dbPrepareUserByIdFold = db.prepare(`
  SELECT email_provider, email_connected_address, email_oauth_refresh_encrypted, email_reconnect_required
  FROM users WHERE lower(id) = lower(?)
  LIMIT 1
`);

/** @returns {{ provider: 'google'|'microsoft', from: string } | null} */
export function getEmailConfigForUser(userId) {
  let row = dbPrepareUser.get(userId);
  if (!row) row = dbPrepareUserByIdFold.get(userId);
  if (!row) return null;
  const provider = row.email_provider;
  const from = row.email_connected_address?.trim();
  if (!provider || !from) return null;
  if (provider !== 'google' && provider !== 'microsoft') return null;
  if (row.email_reconnect_required) return null;
  if (!row.email_oauth_refresh_encrypted) return null;
  return { provider, from };
}
