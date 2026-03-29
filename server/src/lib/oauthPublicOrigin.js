/**
 * OAuth redirect_uri must be built as: {API origin}{fixed path}.
 * OAUTH_PUBLIC_URL should be the API origin only, e.g. https://nexus-core-crm.fly.dev
 * If someone pastes the full callback URL into .env, we strip to origin so paths are not doubled.
 */

/** Suffixes users sometimes paste into OAUTH_PUBLIC_URL; also handles accidental duplicates. */
const OAUTH_CALLBACK_PATH_SUFFIXES = [
  '/api/integrations/microsoft-drive/callback',
  '/api/email/oauth/microsoft/callback',
  '/api/email/oauth/google/callback',
  '/api/settings/xero-callback'
];

function stripKnownOAuthPathSuffixes(s) {
  let out = s.replace(/\/$/, '');
  let guard = 0;
  while (guard++ < 8) {
    let stripped = false;
    for (const suf of OAUTH_CALLBACK_PATH_SUFFIXES) {
      const low = out.toLowerCase();
      if (low.endsWith(suf.toLowerCase())) {
        out = out.slice(0, -suf.length).replace(/\/$/, '');
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  return out;
}

function originFromUrlString(s) {
  const href = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  return new URL(href).origin;
}

export function oauthPublicApiOriginFromEnv() {
  const raw = process.env.OAUTH_PUBLIC_URL?.trim();
  if (!raw) return '';
  const normalized = stripKnownOAuthPathSuffixes(raw);
  try {
    return originFromUrlString(normalized);
  } catch {
    // Never return a value that still contains a path — that doubles redirect_uri when routes append /api/.../callback
    const m = normalized.match(/^(https?:\/\/[^/?#]+)/i);
    if (m) return m[1].replace(/\/$/, '');
    return '';
  }
}

/** API public origin: env (normalized) or infer from the incoming request. */
export function oauthApiPublicOrigin(req) {
  const fromEnv = oauthPublicApiOriginFromEnv();
  if (fromEnv) return fromEnv;
  const host = req.get('host') || '';
  const proto = req.protocol || 'https';
  return `${proto}://${host}`.replace(/\/$/, '');
}
