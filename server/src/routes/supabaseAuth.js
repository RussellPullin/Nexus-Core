import { Router } from 'express';
import http from 'http';
import { isSupabaseJwtConfigured } from '../lib/supabaseJwt.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { db } from '../db/index.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import {
  completeSupabaseSignIn,
  registerOrganizationForUser,
  inviteStaffToOrg,
  fetchSupabaseProfile,
  fetchSupabaseProfileByEmail
} from '../services/nexusSupabaseAuth.service.js';

const router = Router();

function agentDebugLog({ location, message, data, runId, hypothesisId }) {
  try {
    const payload = {
      sessionId: '455d03',
      location,
      message,
      data: data || {},
      timestamp: Date.now(),
      runId,
      hypothesisId
    };
    const body = JSON.stringify(payload);
    const req = http.request(
      'http://127.0.0.1:7395/ingest/9396d2bf-ffd7-4cdc-a66d-39fbe0a7e677',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '455d03' } },
      (res) => res.resume()
    );
    req.on('error', () => {});
    req.end(body);
  } catch {}
}

router.get('/public-config', (req, res) => {
  res.json({
    supabase_auth_enabled: isSupabaseJwtConfigured(),
    supabase_url: process.env.SUPABASE_URL?.trim() || null
  });
});

router.post('/session', async (req, res) => {
  try {
    // #region agent log
    agentDebugLog({ runId: 'pre-fix', hypothesisId: 'H6', location: 'server/src/routes/supabaseAuth.js:/session:entry', message: 'Supabase session exchange attempt received', data: { access_token_present: Boolean(req.body?.access_token), supabase_auth_configured: isSupabaseJwtConfigured() } });
    // #endregion
    if (!isSupabaseJwtConfigured()) {
      return res.status(503).json({ error: 'Supabase auth is not configured on the server', code: 'AUTH_NOT_CONFIGURED' });
    }
    const accessToken = req.body?.access_token;
    if (!accessToken) return res.status(400).json({ error: 'access_token required' });

    const result = await completeSupabaseSignIn(accessToken);
    if (result.needs_org_setup) {
      return res.status(200).json({
        needs_org_setup: true,
        email: result.email
      });
    }

    req.session.user = result.sessionUser;
    const u = db
      .prepare(
        `SELECT id, email, name, role, org_id, billing_interval_minutes, staff_id, signature_data,
         email_provider, email_connected_address, email_reconnect_required, auth_uid
         FROM users WHERE id = ?`
      )
      .get(result.sessionUser.id);

    res.json({
      needs_org_setup: false,
      user: {
        ...u,
        is_super_admin: isSuperAdminEmail(u?.email)
      }
    });
  } catch (err) {
    const code = err.code || 'SESSION_ERROR';
    const status = code === 'INVALID_JWT' ? 401 : 400;
    // #region agent log
    agentDebugLog({ runId: 'pre-fix', hypothesisId: 'H7', location: 'server/src/routes/supabaseAuth.js:/session:catch', message: 'Supabase session exchange failed', data: { code, status, error_message: String(err?.message || 'unknown') } });
    // #endregion
    console.error('[supabaseAuth/session]', err.message);
    res.status(status).json({ error: err.message, code });
  }
});

router.post('/register-org', async (req, res) => {
  try {
    if (!isSupabaseJwtConfigured()) {
      return res.status(503).json({ error: 'Supabase auth is not configured on the server', code: 'AUTH_NOT_CONFIGURED' });
    }
    const { access_token, organization_name } = req.body || {};
    if (!access_token) return res.status(400).json({ error: 'access_token required' });

    const out = await registerOrganizationForUser({
      accessToken: access_token,
      organizationName: organization_name
    });

    const full = await completeSupabaseSignIn(access_token);
    if (!full.needs_org_setup && full.sessionUser) {
      req.session.user = full.sessionUser;
    }

    const u = full.sessionUser
      ? db
          .prepare(
            `SELECT id, email, name, role, org_id, billing_interval_minutes, staff_id, signature_data,
           email_provider, email_connected_address, email_reconnect_required, auth_uid
           FROM users WHERE id = ?`
          )
          .get(full.sessionUser.id)
      : null;

    res.status(201).json({
      org_id: out.org_id,
      organization_name: out.organization_name,
      user: u
        ? {
            ...u,
            is_super_admin: isSuperAdminEmail(u?.email)
          }
        : null
    });
  } catch (err) {
    const code = err.code || 'REGISTER_ORG_ERROR';
    const status =
      code === 'INVALID_JWT' ? 401 : code === 'ORG_ALREADY_SET' ? 409 : code === 'VALIDATION' ? 400 : 400;
    console.error('[supabaseAuth/register-org]', err.message);
    res.status(status).json({ error: err.message, code });
  }
});

router.post('/invite-staff', requireAuth, requireAdminOrDelegate, async (req, res) => {
  try {
    let orgId = req.session.user?.org_id || null;

    if (!orgId) {
      const current = db
        .prepare('SELECT id, email, auth_uid, org_id FROM users WHERE id = ?')
        .get(req.session.user?.id);
      if (current?.org_id) {
        orgId = current.org_id;
      } else if (current) {
        let profile = null;
        if (current.auth_uid) {
          profile = await fetchSupabaseProfile(current.auth_uid);
        }
        if (!profile?.org_id && current.email) {
          profile = await fetchSupabaseProfileByEmail(current.email);
        }
        if (profile?.org_id) {
          orgId = String(profile.org_id).trim();
          db.prepare(
            `UPDATE users
             SET org_id = ?, auth_uid = COALESCE(auth_uid, ?), updated_at = datetime('now')
             WHERE id = ?`
          ).run(orgId, profile.id || current.auth_uid || null, current.id);
        }
      }
      if (orgId) {
        req.session.user.org_id = orgId;
      }
    }

    if (!orgId) {
      return res.status(400).json({
        error: 'Your account has no organisation. Complete setup first.',
        code: 'NO_ORG',
        errorDetail: 'Open /setup-org to create your organisation, then try inviting staff again.',
        setup_path: '/setup-org'
      });
    }

    const { email, full_name } = req.body || {};
    const data = await inviteStaffToOrg({ orgId, email, fullName: full_name });
    res.status(201).json({ ok: true, invited: data.user?.email || email });
  } catch (err) {
    const code = err.code || 'INVITE_ERROR';
    console.error('[supabaseAuth/invite-staff]', err.message);
    res.status(400).json({ error: err.message, code });
  }
});

export default router;
