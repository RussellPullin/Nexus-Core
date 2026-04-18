/**
 * Location header for returning the browser to Settings after OAuth.
 * Same-origin deploys (e.g. Fly: API + static on one host): relative `/settings?…` so a wrong
 * inferred `req.protocol` / missing FRONTEND_* cannot send users to the wrong origin.
 * Split API/UI: set FRONTEND_BASE_URL (or FRONTEND_ORIGIN / BASE_URL).
 * Local API on :3080 without proxy: absolute URL to Vite (same as frontendBaseUrl).
 *
 * @param {string} searchWithQuestion e.g. `?email_connected=1` or `?email_error=…`
 */
export function buildSettingsRedirectLocation(req, searchWithQuestion) {
  const q = searchWithQuestion.startsWith('?') ? searchWithQuestion : `?${searchWithQuestion}`;
  const explicit =
    process.env.FRONTEND_BASE_URL?.trim() ||
    process.env.FRONTEND_ORIGIN?.trim() ||
    process.env.BASE_URL?.trim();
  let loc;
  let mode;
  if (explicit) {
    mode = 'explicit';
    loc = `${explicit.replace(/\/$/, '')}/settings${q}`;
  } else {
    const host = req.get('host') || '';
    if (process.env.NODE_ENV !== 'production' && host.endsWith(':3080')) {
      mode = 'viteDev';
      const vitePort = process.env.VITE_DEV_PORT || '5174';
      const httpsDev = process.env.VITE_DEV_HTTPS === 'true' || process.env.VITE_DEV_HTTPS === '1';
      loc = `${httpsDev ? 'https' : 'http'}://localhost:${vitePort}/settings${q}`;
    } else {
      mode = 'relative';
      loc = `/settings${q}`;
    }
  }
  // #region agent log
  const dbg = {
    sessionId: 'a4dffc',
    location: 'frontendBaseUrl.js:buildSettingsRedirectLocation',
    message: 'settings redirect location',
    data: { mode, locLen: loc.length, host: req.get('host') || '', proto: req.protocol || '' },
    timestamp: Date.now(),
    hypothesisId: 'A'
  };
  fetch('http://127.0.0.1:7395/ingest/9396d2bf-ffd7-4cdc-a66d-39fbe0a7e677', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'a4dffc' },
    body: JSON.stringify(dbg)
  }).catch(() => {});
  console.error('__NEXUS_DEBUG_A4DFFC__', JSON.stringify(dbg));
  // #endregion
  return loc;
}

/**
 * Browser-facing origin for OAuth redirects back to the SPA (Settings, etc.).
 * Prefer explicit env so API host (e.g. api.example.com) is not used when the app runs on another origin.
 */
export function frontendBaseUrl(req) {
  const explicit =
    process.env.FRONTEND_BASE_URL?.trim() ||
    process.env.FRONTEND_ORIGIN?.trim() ||
    process.env.BASE_URL?.trim();
  let resolved;
  if (explicit) {
    resolved = explicit.replace(/\/$/, '');
  } else {
    const host = req.get('host') || '';
    if (process.env.NODE_ENV !== 'production' && host.endsWith(':3080')) {
      const vitePort = process.env.VITE_DEV_PORT || '5174';
      const httpsDev = process.env.VITE_DEV_HTTPS === 'true' || process.env.VITE_DEV_HTTPS === '1';
      resolved = `${httpsDev ? 'https' : 'http'}://localhost:${vitePort}`;
    } else {
      resolved = `${req.protocol}://${host}`.replace(/\/$/, '');
    }
  }
  // #region agent log
  const dbg = {
    sessionId: 'a4dffc',
    location: 'frontendBaseUrl.js',
    message: 'frontendBaseUrl resolved',
    data: {
      resolved,
      hasFbu: Boolean(process.env.FRONTEND_BASE_URL?.trim()),
      hasFro: Boolean(process.env.FRONTEND_ORIGIN?.trim()),
      hasBaseUrl: Boolean(process.env.BASE_URL?.trim()),
      host: req.get('host') || '',
      nodeEnv: process.env.NODE_ENV || '',
      proto: req.protocol || ''
    },
    timestamp: Date.now(),
    hypothesisId: 'A'
  };
  fetch('http://127.0.0.1:7395/ingest/9396d2bf-ffd7-4cdc-a66d-39fbe0a7e677', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'a4dffc' },
    body: JSON.stringify(dbg)
  }).catch(() => {});
  console.error('__NEXUS_DEBUG_A4DFFC__', JSON.stringify(dbg));
  // #endregion
  return resolved;
}
