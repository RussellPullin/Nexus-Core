/**
 * Settings API - business setup for invoices (logo, ABN, NDIS provider, payment details)
 */
import { Router } from 'express';
import { randomBytes } from 'crypto';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import multer from 'multer';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, createReadStream } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import { frontendBaseUrl } from '../lib/frontendBaseUrl.js';
import { oauthPublicApiOriginFromEnv } from '../lib/oauthPublicOrigin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const uploadsDir = process.env.DATA_DIR ? join(process.env.DATA_DIR, 'uploads') : join(projectRoot, 'data', 'uploads');

const router = Router();

const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];
const MAX_SIZE = 500 * 1024; // 500KB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
});

function currentUserScope(req) {
  const uid = req.session?.user?.id;
  if (!uid) return { orgId: null, superAdmin: false };
  const u = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(uid);
  return {
    orgId: u?.org_id || null,
    superAdmin: isSuperAdminEmail(u?.email),
  };
}

function resolveTargetOrgId(req) {
  const { orgId, superAdmin } = currentUserScope(req);
  if (superAdmin && req.query?.org_id) return String(req.query.org_id);
  if (superAdmin && req.body?.org_id) return String(req.body.org_id);
  return orgId || null;
}

/** True if a business_settings row exists for this org (avoids INSERT ... ON CONFLICT(org_id), which needs a matching UNIQUE index). */
function hasBusinessSettingsForOrg(orgId) {
  return Boolean(db.prepare('SELECT 1 AS x FROM business_settings WHERE org_id = ?').get(orgId));
}

function getBusinessSettings(orgId = null) {
  if (orgId) {
    const byOrg = db.prepare('SELECT * FROM business_settings WHERE org_id = ?').get(orgId);
    if (byOrg) return byOrg;
    // Do not fall back to id='default' here. A legacy bug returned that row whenever COUNT(DISTINCT users.org_id) was 1,
    // so a brand-new org (sole user in the table for that moment) saw another tenant's invoice + Xero data.
    return null;
  }
  const row = db.prepare('SELECT * FROM business_settings WHERE id = ?').get('default');
  return row || null;
}

/**
 * @param {object | null} row
 * @param {{ noOrgRowYet?: boolean }} [options] When true, omit deployment env fallbacks for tenant fields so a new org starts blank (not another tenant's COMPANY_* env). Also forces Xero to “not connected” so another org’s OAuth state never appears in the UI.
 */
function mergeWithEnv(row, options = {}) {
  const noOrgRowYet = options.noOrgRowYet === true;
  const envDays = parseInt(process.env.PAYMENT_TERMS_DAYS || '7', 10);
  const paymentTerms = Number.isNaN(envDays) ? 7 : envDays;
  const envName = noOrgRowYet ? '' : (process.env.COMPANY_NAME ?? '');
  const envAbn = noOrgRowYet ? '' : (process.env.COMPANY_ABN ?? '');
  const envEmail = noOrgRowYet ? '' : (process.env.COMPANY_EMAIL ?? '');
  const envBsb = noOrgRowYet ? '' : (process.env.COMPANY_BSB ?? '');
  const envAccount = noOrgRowYet ? '' : (process.env.COMPANY_ACCOUNT ?? '');
  return {
    company_name: row?.company_name ?? envName,
    company_abn: row?.company_abn ?? envAbn,
    company_acn: row?.company_acn ?? '',
    ndis_provider_number: row?.ndis_provider_number ?? '',
    company_email: row?.company_email ?? envEmail,
    company_address: row?.company_address ?? '',
    company_phone: row?.company_phone ?? '',
    logo_path: row?.logo_path ?? null,
    account_name: row?.account_name ?? envName,
    bsb: row?.bsb ?? envBsb,
    account_number: row?.account_number ?? envAccount,
    payment_terms_days: row?.payment_terms_days != null ? row.payment_terms_days : paymentTerms,
    accounting_provider: noOrgRowYet ? null : (row?.accounting_provider ?? null),
    xero_client_id: noOrgRowYet ? null : (row?.xero_client_id ?? null),
    xero_redirect_uri: noOrgRowYet ? null : (row?.xero_redirect_uri ?? null),
    xero_tenant_name: noOrgRowYet ? null : (row?.xero_tenant_name ?? null),
    xero_linked: noOrgRowYet ? false : !!(row?.xero_refresh_token && row?.xero_tenant_id),
    /** When true, Settings shows one-click Xero connect (credentials from server env). */
    xero_oauth_via_env: xeroOauthConfiguredViaEnv(),
  };
}

/**
 * Callback URL Xero redirects to (must match the Xero developer app).
 * Prefer XERO_REDIRECT_URI; otherwise derive from OAUTH_PUBLIC_URL (API origin only; see oauthPublicOrigin.js).
 */
function getEffectiveXeroRedirectUri() {
  const explicit = process.env.XERO_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const origin = oauthPublicApiOriginFromEnv();
  if (origin) return `${origin}/api/settings/xero-callback`;
  return '';
}

function isAllowedXeroRedirectUri(redirectUri) {
  if (!redirectUri) return false;
  if (redirectUri.startsWith('https://')) return true;
  if (redirectUri.startsWith('http://localhost')) return true;
  if (redirectUri.startsWith('http://127.0.0.1')) return true;
  return false;
}

/** Single Xero “partner” app for the whole deployment (set on the server). */
function xeroOauthConfiguredViaEnv() {
  const id = process.env.XERO_CLIENT_ID?.trim();
  const secret = process.env.XERO_CLIENT_SECRET?.trim();
  const redirect = getEffectiveXeroRedirectUri();
  return !!(id && secret && redirect);
}

/**
 * OAuth client credentials: env app (preferred) or per-org row in DB.
 * @returns {{ clientId: string, clientSecret: string, redirectUri: string, fromEnv: boolean } | null}
 */
function getXeroOAuthAppCredentials(orgId) {
  if (xeroOauthConfiguredViaEnv()) {
    return {
      clientId: process.env.XERO_CLIENT_ID.trim(),
      clientSecret: process.env.XERO_CLIENT_SECRET.trim(),
      redirectUri: getEffectiveXeroRedirectUri(),
      fromEnv: true,
    };
  }
  const row = getBusinessSettings(orgId);
  if (row?.xero_client_id && row?.xero_client_secret && row?.xero_redirect_uri) {
    return {
      clientId: row.xero_client_id,
      clientSecret: row.xero_client_secret,
      redirectUri: row.xero_redirect_uri,
      fromEnv: false,
    };
  }
  return null;
}

// GET /api/settings/logo - stream logo image (for preview and PDF)
router.get('/logo', (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    const row = getBusinessSettings(orgId);
    const logoPath = row?.logo_path;
    if (!logoPath) {
      return res.status(404).json({ error: 'No logo configured' });
    }
    const fullPath = join(uploadsDir, logoPath);
    if (!existsSync(fullPath)) {
      return res.status(404).json({ error: 'Logo file not found' });
    }
    const ext = logoPath.endsWith('.png') ? 'png' : 'jpeg';
    res.setHeader('Content-Type', `image/${ext}`);
    createReadStream(fullPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/business - return current business settings (merge with env fallbacks)
router.get('/business', (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    const row = getBusinessSettings(orgId);
    const merged = mergeWithEnv(row, { noOrgRowYet: Boolean(orgId) && !row });
    res.setHeader('Cache-Control', 'no-store, private');
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const VALID_ACCOUNTING_PROVIDERS = [null, '', 'xero'];

// PUT /api/settings/business - update business settings (admin/delegate only)
router.put('/business', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    const {
      company_name,
      company_abn,
      company_acn,
      ndis_provider_number,
      company_email,
      company_address,
      company_phone,
      account_name,
      bsb,
      account_number,
      payment_terms_days,
      accounting_provider,
    } = req.body || {};

    const existing = getBusinessSettings(orgId);
    let accountingProviderValue = accounting_provider !== undefined ? (accounting_provider || null) : existing?.accounting_provider;
    if (accountingProviderValue && !VALID_ACCOUNTING_PROVIDERS.includes(accountingProviderValue)) {
      accountingProviderValue = null;
    }
    if (accountingProviderValue === '') accountingProviderValue = null;

    const updates = {
      company_name: company_name !== undefined ? (company_name || null) : existing?.company_name,
      company_abn: company_abn !== undefined ? (company_abn || null) : existing?.company_abn,
      company_acn: company_acn !== undefined ? (company_acn || null) : existing?.company_acn,
      ndis_provider_number: ndis_provider_number !== undefined ? (ndis_provider_number || null) : existing?.ndis_provider_number,
      company_email: company_email !== undefined ? (company_email || null) : existing?.company_email,
      company_address: company_address !== undefined ? (company_address || null) : existing?.company_address,
      company_phone: company_phone !== undefined ? (company_phone || null) : existing?.company_phone,
      account_name: account_name !== undefined ? (account_name || null) : existing?.account_name,
      bsb: bsb !== undefined ? (bsb || null) : existing?.bsb,
      account_number: account_number !== undefined ? (account_number || null) : existing?.account_number,
      payment_terms_days: payment_terms_days !== undefined
        ? (parseInt(payment_terms_days, 10) || 7)
        : (existing?.payment_terms_days ?? 7),
      accounting_provider: accountingProviderValue,
    };

    const bizParams = [
      updates.company_name,
      updates.company_abn,
      updates.company_acn,
      updates.ndis_provider_number,
      updates.company_email,
      updates.company_address,
      updates.company_phone,
      updates.account_name,
      updates.bsb,
      updates.account_number,
      updates.payment_terms_days,
      updates.accounting_provider,
    ];
    if (hasBusinessSettingsForOrg(orgId)) {
      db.prepare(`
        UPDATE business_settings SET
          company_name = ?, company_abn = ?, company_acn = ?, ndis_provider_number = ?,
          company_email = ?, company_address = ?, company_phone = ?, account_name = ?, bsb = ?, account_number = ?,
          payment_terms_days = ?, accounting_provider = ?, updated_at = datetime('now')
        WHERE org_id = ?
      `).run(...bizParams, orgId);
    } else {
      db.prepare(`
        INSERT INTO business_settings (id, org_id, company_name, company_abn, company_acn, ndis_provider_number,
          company_email, company_address, company_phone, account_name, bsb, account_number, payment_terms_days, accounting_provider, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(orgId, orgId, ...bizParams);
    }

    const saved = getBusinessSettings(orgId);
    const merged = mergeWithEnv(saved, { noOrgRowYet: Boolean(orgId) && !saved });
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/logo - upload logo (multipart)
router.post('/logo', requireAdminOrDelegate, upload.single('file'), (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!ALLOWED_MIMES.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Use PNG or JPG.' });
    }
    if (req.file.size > MAX_SIZE) {
      return res.status(400).json({ error: 'File too large. Max 500KB.' });
    }

    mkdirSync(uploadsDir, { recursive: true });
    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const filename = `business-logo.${ext}`;
    const filePath = join(uploadsDir, filename);
    writeFileSync(filePath, req.file.buffer);

    const existing = getBusinessSettings(orgId);
    const oldPath = existing?.logo_path;
    if (oldPath) {
      const oldFullPath = join(uploadsDir, oldPath);
      if (existsSync(oldFullPath) && oldFullPath !== filePath) {
        try { unlinkSync(oldFullPath); } catch {}
      }
    }

    if (hasBusinessSettingsForOrg(orgId)) {
      db.prepare(`UPDATE business_settings SET logo_path = ?, updated_at = datetime('now') WHERE org_id = ?`).run(filename, orgId);
    } else {
      db.prepare(`
        INSERT INTO business_settings (id, org_id, logo_path, updated_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(orgId, orgId, filename);
    }

    res.json({ logo_path: filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/logo - remove logo
router.delete('/logo', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    const existing = getBusinessSettings(orgId);
    const logoPath = existing?.logo_path;
    if (logoPath) {
      const fullPath = join(uploadsDir, logoPath);
      if (existsSync(fullPath)) {
        try { unlinkSync(fullPath); } catch {}
      }
    }

    db.prepare(`
      UPDATE business_settings SET logo_path = NULL, updated_at = datetime('now') WHERE org_id = ?
    `).run(orgId);

    res.json({ logo_path: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Xero OAuth ─────────────────────────────────────────────────────────────
const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
// Granular scopes required for Xero apps created on/after 2 Mar 2026 (broad accounting.transactions is rejected).
const XERO_SCOPES =
  process.env.XERO_OAUTH_SCOPES?.trim() ||
  'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings';

/** Get a valid Xero access token (refresh if needed). Returns { accessToken, tenantId } or throws. */
async function getXeroAccessToken(orgId = null) {
  const row = orgId
    ? db
        .prepare('SELECT xero_refresh_token, xero_tenant_id FROM business_settings WHERE org_id = ?')
        .get(orgId)
    : db
        .prepare('SELECT xero_refresh_token, xero_tenant_id FROM business_settings WHERE id = ?')
        .get('default');
  const creds = getXeroOAuthAppCredentials(orgId);
  if (!creds || !row?.xero_refresh_token || !row?.xero_tenant_id) {
    throw new Error('Xero is not linked. Connect in Settings first.');
  }
  const authHeader = Buffer.from(creds.clientId + ':' + creds.clientSecret).toString('base64');
  const tokenRes = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + authHeader,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.xero_refresh_token,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(errText || 'Xero token refresh failed');
  }
  const tokens = await tokenRes.json();
  const accessToken = tokens.access_token;
  const newRefreshToken = tokens.refresh_token;
  if (!accessToken) throw new Error('No access token in Xero response');
  if (newRefreshToken) {
    if (orgId) {
      db.prepare('UPDATE business_settings SET xero_refresh_token = ?, updated_at = datetime(\'now\') WHERE org_id = ?').run(newRefreshToken, orgId);
    } else {
      db.prepare('UPDATE business_settings SET xero_refresh_token = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newRefreshToken, 'default');
    }
  }
  return { accessToken, tenantId: row.xero_tenant_id };
}

// POST /api/settings/xero/save-and-connect - save credentials and return redirect URL
router.post('/xero/save-and-connect', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    const { client_id, client_secret, redirect_uri } = req.body || {};
    if (!client_id || !client_secret || !redirect_uri) {
      return res.status(400).json({ error: 'Client ID, Client Secret, and Redirect URI are required.' });
    }
    const clientId = String(client_id).trim();
    const clientSecret = String(client_secret).trim();
    const redirectUri = String(redirect_uri).trim();
    if (!redirectUri.startsWith('https://') && !redirectUri.startsWith('http://localhost')) {
      return res.status(400).json({ error: 'Redirect URI must use HTTPS (or http://localhost for testing).' });
    }

    if (hasBusinessSettingsForOrg(orgId)) {
      db.prepare(`
        UPDATE business_settings SET
          xero_client_id = ?, xero_client_secret = ?, xero_redirect_uri = ?,
          accounting_provider = 'xero', updated_at = datetime('now')
        WHERE org_id = ?
      `).run(clientId, clientSecret, redirectUri, orgId);
    } else {
      db.prepare(`
        INSERT INTO business_settings (id, org_id, xero_client_id, xero_client_secret, xero_redirect_uri, accounting_provider, updated_at)
        VALUES (?, ?, ?, ?, ?, 'xero', datetime('now'))
      `).run(orgId, orgId, clientId, clientSecret, redirectUri);
    }

    const state = randomBytes(24).toString('hex');
    req.session.xero_oauth_state = state;
    req.session.xero_oauth_org_id = orgId;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: XERO_SCOPES,
      state,
    });
    const redirectUrl = `${XERO_AUTH_URL}?${params.toString()}`;
    res.json({ redirectUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/xero/connect - start OAuth using server env XERO_CLIENT_* (one click per org)
router.post('/xero/connect', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    if (!xeroOauthConfiguredViaEnv()) {
      return res.status(400).json({
        error:
          'This server is not set up for one-click Xero. On the API server set XERO_CLIENT_ID, XERO_CLIENT_SECRET, and either XERO_REDIRECT_URI or OAUTH_PUBLIC_URL (callback URL is OAUTH_PUBLIC_URL + /api/settings/xero-callback). Restart the server after changing .env.',
      });
    }
    const redirectUri = getEffectiveXeroRedirectUri();
    if (!isAllowedXeroRedirectUri(redirectUri)) {
      return res.status(400).json({
        error:
          'Xero redirect URI must use HTTPS, or http://localhost / http://127.0.0.1 for local dev. Set XERO_REDIRECT_URI or fix OAUTH_PUBLIC_URL.',
      });
    }

    if (hasBusinessSettingsForOrg(orgId)) {
      db.prepare(`
        UPDATE business_settings SET accounting_provider = 'xero', updated_at = datetime('now') WHERE org_id = ?
      `).run(orgId);
    } else {
      db.prepare(`
        INSERT INTO business_settings (id, org_id, accounting_provider, updated_at)
        VALUES (?, ?, 'xero', datetime('now'))
      `).run(orgId, orgId);
    }

    const state = randomBytes(24).toString('hex');
    req.session.xero_oauth_state = state;
    req.session.xero_oauth_org_id = orgId;

    const clientId = process.env.XERO_CLIENT_ID.trim();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: XERO_SCOPES,
      state,
    });
    const redirectUrl = `${XERO_AUTH_URL}?${params.toString()}`;
    res.json({ redirectUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/xero-callback - OAuth callback from Xero
router.get('/xero-callback', requireAdminOrDelegate, async (req, res) => {
  const base = frontendBaseUrl(req);
  const settingsUrl = base.replace(/\/api\/?$/, '').replace(/\/$/, '') + '/settings';

  try {
    const { code, state, error } = req.query || {};
    if (error) {
      return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent(error));
    }
    if (req.session.xero_oauth_state !== state) {
      return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent('Invalid state'));
    }
    delete req.session.xero_oauth_state;

    if (!code) {
      return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent('No authorization code'));
    }

    const orgId = req.session?.xero_oauth_org_id || resolveTargetOrgId(req);
    if (!orgId) {
      return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent('No organisation on your account.'));
    }
    const creds = getXeroOAuthAppCredentials(orgId);
    if (!creds) {
      return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent('Xero credentials not configured'));
    }

    const authHeader = Buffer.from(creds.clientId + ':' + creds.clientSecret).toString('base64');
    const tokenRes = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + authHeader,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: creds.redirectUri,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent(errText || 'Token exchange failed'));
    }

    const tokens = await tokenRes.json();
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    if (!accessToken || !refreshToken) {
      return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent('No tokens in response'));
    }

    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!connRes.ok) {
      return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent('Failed to fetch connections'));
    }
    const connections = await connRes.json();
    const orgConnection = Array.isArray(connections) && connections.find((c) => c.tenantType === 'ORGANISATION');
    const tenantId = orgConnection?.tenantId || (connections[0]?.tenantId ?? null);
    const tenantName = orgConnection?.tenantName || connections[0]?.tenantName || null;

    db.prepare(`
      UPDATE business_settings SET
        xero_refresh_token = ?, xero_tenant_id = ?, xero_tenant_name = ?,
        accounting_provider = 'xero', updated_at = datetime('now')
      WHERE org_id = ?
    `).run(refreshToken, tenantId, tenantName, orgId);
    if (req.session) delete req.session.xero_oauth_org_id;

    return res.redirect(settingsUrl + '?xero=linked');
  } catch (err) {
    return res.redirect(settingsUrl + '?xero=error&message=' + encodeURIComponent(err.message || 'Unknown error'));
  }
});

/** Parse Xero API body; avoids JSON.parse on HTML error pages (opaque "Unexpected token <"). */
function parseXeroApiBodyOrThrow(text, label, httpStatus) {
  const raw = String(text ?? '');
  const t = raw.trimStart();
  if (!t) {
    const e = new Error(`${label}: empty response (HTTP ${httpStatus})`);
    e.detail = '';
    throw e;
  }
  if (t.startsWith('<')) {
    const e = new Error(
      `${label}: Xero returned HTML instead of JSON (HTTP ${httpStatus}). Often an auth or gateway issue — disconnect and reconnect Xero in Settings, or confirm the linked organisation and scopes.`,
    );
    e.detail = raw.slice(0, 600);
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    const e = new Error(`${label}: invalid JSON (${parseErr.message})`);
    e.detail = raw.slice(0, 600);
    throw e;
  }
}

// POST /api/settings/xero/test-invoice - create a dummy invoice in Xero to verify connection
router.post('/xero/test-invoice', requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    const { accessToken, tenantId } = await getXeroAccessToken(orgId);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken,
      'Xero-tenant-id': tenantId,
    };

    // Create a test contact
    const contactRes = await fetch(`${XERO_API_BASE}/Contacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        Contacts: [{ Name: 'Nexus Test - Connection Test' }],
      }),
    });
    const contactText = await contactRes.text();
    if (!contactRes.ok) {
      return res.status(400).json({ error: 'Failed to create Xero contact', detail: contactText.slice(0, 2000) });
    }
    let contactData;
    try {
      contactData = parseXeroApiBodyOrThrow(contactText, 'Xero Contacts', contactRes.status);
    } catch (e) {
      return res.status(502).json({ error: e.message, detail: e.detail });
    }
    const contactId = contactData?.Contacts?.[0]?.ContactID;
    if (!contactId) {
      return res.status(500).json({ error: 'No ContactID in Xero contact response', detail: contactData });
    }

    const today = new Date().toISOString().slice(0, 10);
    const due = new Date();
    due.setDate(due.getDate() + 7);
    const dueStr = due.toISOString().slice(0, 10);

    // Create a dummy sales invoice (ACCREC). AccountCode 200 is common for sales; may need changing per org.
    const invoiceRes = await fetch(`${XERO_API_BASE}/Invoices`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        Invoices: [
          {
            Type: 'ACCREC',
            Contact: { ContactID: contactId },
            DateString: today + 'T00:00:00',
            DueDateString: dueStr + 'T00:00:00',
            LineAmountTypes: 'Exclusive',
            LineItems: [
              {
                Description: 'Test line – Nexus connection check',
                Quantity: 1,
                UnitAmount: 0.01,
                AccountCode: '200',
              },
            ],
          },
        ],
      }),
    });
    const invoiceText = await invoiceRes.text();
    if (!invoiceRes.ok) {
      return res.status(400).json({ error: 'Failed to create Xero invoice', detail: invoiceText.slice(0, 2000) });
    }
    let invoiceData;
    try {
      invoiceData = parseXeroApiBodyOrThrow(invoiceText, 'Xero Invoices', invoiceRes.status);
    } catch (e) {
      return res.status(502).json({ error: e.message, detail: e.detail });
    }
    const inv = invoiceData?.Invoices?.[0];
    res.json({
      success: true,
      message: 'Dummy invoice created in Xero. Check your Xero organisation.',
      contactId,
      invoiceId: inv?.InvoiceID,
      invoiceNumber: inv?.InvoiceNumber,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Xero test failed' });
  }
});

// POST /api/settings/xero/disconnect - remove Xero connection
router.post('/xero/disconnect', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = resolveTargetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    db.prepare(`
      UPDATE business_settings SET
        xero_client_secret = NULL, xero_refresh_token = NULL, xero_tenant_id = NULL, xero_tenant_name = NULL,
        accounting_provider = NULL, updated_at = datetime('now')
      WHERE org_id = ?
    `).run(orgId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
export { getBusinessSettings, mergeWithEnv, uploadsDir, getXeroAccessToken, parseXeroApiBodyOrThrow, XERO_API_BASE };
