import { Router } from 'express';
import { isSupabaseJwtConfigured } from '../lib/supabaseJwt.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { db } from '../db/index.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import { getRelayConfigFromEnv } from '../lib/emailSendConfig.js';
import {
  findShifterOrganizationByName,
  getSupabaseServiceRoleClient,
  isShifterRemoteConfigured,
  pushScheduleShiftIntegrationToShifter
} from '../services/supabaseStaffShifter.service.js';
import {
  completeSupabaseSignIn,
  registerOrganizationForUser,
  inviteStaffToOrg,
  fetchSupabaseProfile,
  fetchSupabaseProfileByEmail
} from '../services/nexusSupabaseAuth.service.js';

const router = Router();

function trimApiBase(u) {
  if (!u || typeof u !== 'string') return null;
  const t = u.trim().replace(/\/$/, '');
  return t || null;
}

function defaultShiftApiBaseFromEnv() {
  return (
    trimApiBase(process.env.NEXUS_PUBLIC_API_URL) ||
    trimApiBase(process.env.OAUTH_PUBLIC_URL) ||
    trimApiBase(process.env.FRONTEND_BASE_URL) ||
    null
  );
}

/**
 * Webhook/sync URLs for external shift apps. Prefer Supabase Admin profile nexus_shift_api_base_url,
 * then NEXUS_PUBLIC_API_URL / OAUTH_PUBLIC_URL / FRONTEND_BASE_URL; otherwise client uses browser origin.
 */
async function resolveShiftIntegrationUrls(admin, orgId) {
  const { data: rows, error } = await admin
    .from('profiles')
    .select('email, nexus_shift_api_base_url')
    .eq('org_id', orgId)
    .eq('role', 'Admin');
  if (error) {
    console.warn('[shifter-org-link] profiles for shift URLs:', error.message);
  }
  const sorted = (rows || []).slice().sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
  const hit = sorted.find((r) => trimApiBase(r.nexus_shift_api_base_url));
  let base = hit ? trimApiBase(hit.nexus_shift_api_base_url) : null;
  let source = 'client_origin';
  let profileEmail = null;
  if (base) {
    source = 'supabase_profile';
    profileEmail = hit.email || null;
  } else {
    const envB = defaultShiftApiBaseFromEnv();
    if (envB) {
      base = envB;
      source = 'env';
    }
  }
  if (base) {
    return {
      shift_api_base_url: base,
      shift_urls_source: source,
      shift_url_profile_email: profileEmail,
      webhook_url: `${base}/api/webhooks/progress-app`,
      sync_url: `${base}/api/sync/from-excel`,
    };
  }
  return {
    shift_api_base_url: null,
    shift_urls_source: 'client_origin',
    shift_url_profile_email: null,
    webhook_url: null,
    sync_url: null,
  };
}

/** Prefer RPC so the update is plain SQL (avoids PostgREST PATCH / schema-cache column errors on organizations). */
async function persistOrgShifterLink(admin, orgId, shifterOrganizationId) {
  const { error: rpcErr } = await admin.rpc('set_org_shifter_link', {
    p_org_id: orgId,
    p_shifter_organization_id: shifterOrganizationId
  });
  if (!rpcErr) return { error: null };
  const rpcMsg = String(rpcErr.message || '');
  const rpcMissing =
    /function .* does not exist/i.test(rpcMsg) || /Could not find the function/i.test(rpcMsg);
  if (!rpcMissing) return { error: rpcErr };

  const { error: updErr } = await admin
    .from('organizations')
    .update({ shifter_organization_id: shifterOrganizationId })
    .eq('id', orgId);
  return { error: updErr };
}

router.get('/public-config', (req, res) => {
  res.json({
    supabase_auth_enabled: isSupabaseJwtConfigured(),
    supabase_url: process.env.SUPABASE_URL?.trim() || null
  });
});

router.post('/session', async (req, res) => {
  try {
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
        is_super_admin: isSuperAdminEmail(u?.email),
        email_relay_configured: Boolean(getRelayConfigFromEnv()?.url)
      }
    });
  } catch (err) {
    const code = err.code || 'SESSION_ERROR';
    const status = code === 'INVALID_JWT' ? 401 : 400;
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
            is_super_admin: isSuperAdminEmail(u?.email),
            email_relay_configured: Boolean(getRelayConfigFromEnv()?.url)
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

router.get('/shifter-org-link', requireAuth, requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = req.session.user?.org_id || null;
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.', code: 'NO_ORG' });
    const admin = getSupabaseServiceRoleClient();
    if (!admin) {
      return res.status(503).json({ error: 'Supabase is not configured on the server', code: 'AUTH_NOT_CONFIGURED' });
    }
    const { data, error } = await admin
      .from('organizations')
      .select('id, name, shifter_organization_id')
      .eq('id', orgId)
      .maybeSingle();
    if (error) {
      return res.status(400).json({ error: error.message || 'Failed to read organisation link', code: 'SUPABASE_ORG' });
    }
    if (!data) return res.status(404).json({ error: 'Organisation not found in Supabase', code: 'ORG_NOT_FOUND' });
    const shiftUrls = await resolveShiftIntegrationUrls(admin, orgId);
    const crmKeySet = Boolean(String(process.env.CRM_API_KEY || '').trim());
    return res.json({
      org_id: data.id,
      organization_name: data.name || null,
      shifter_organization_id: data.shifter_organization_id || null,
      linked: Boolean(data.shifter_organization_id),
      ...shiftUrls,
      /** True when Fly/host has CRM_API_KEY — required for webhook auth; never exposes the key. */
      crm_api_key_configured: crmKeySet,
      /** True when SHIFTER_SUPABASE_URL + SHIFTER_SERVICE_ROLE_KEY set — allows Nexus to write webhook into Shifter DB. */
      shifter_remote_configured: isShifterRemoteConfigured(),
    });
  } catch (err) {
    const code = err.code || 'SHIFTER_LINK_READ_ERROR';
    res.status(400).json({ error: err.message, code });
  }
});

router.post('/link-shifter-org', requireAuth, requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = req.session.user?.org_id || null;
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.', code: 'NO_ORG' });
    const admin = getSupabaseServiceRoleClient();
    if (!admin) {
      return res.status(503).json({ error: 'Supabase is not configured on the server', code: 'AUTH_NOT_CONFIGURED' });
    }

    let rawName = String(req.body?.shifter_org_name ?? '').trim();
    if (!rawName) {
      const { data: orgRow, error: orgReadErr } = await admin
        .from('organizations')
        .select('name')
        .eq('id', orgId)
        .maybeSingle();
      if (orgReadErr) {
        return res.status(400).json({ error: orgReadErr.message || 'Failed to read organisation', code: 'SUPABASE_ORG' });
      }
      rawName = String(orgRow?.name ?? '').trim();
    }
    if (!rawName) {
      return res.status(400).json({
        error:
          'Your Nexus Core organisation has no name yet. Add a name to your organisation, then use Link to Shifter again.',
        code: 'NO_ORG_NAME'
      });
    }

    const shifterOrg = await findShifterOrganizationByName(rawName);
    if (!shifterOrg?.id) {
      return res.status(404).json({ error: 'No matching Shifter organisation found for that name', code: 'SHIFTER_ORG_NOT_FOUND' });
    }

    const { error: linkErr } = await persistOrgShifterLink(admin, orgId, shifterOrg.id);
    if (linkErr) {
      return res.status(400).json({ error: linkErr.message || 'Failed to save Shifter link', code: 'SUPABASE_ORG' });
    }

    const shiftUrls = await resolveShiftIntegrationUrls(admin, orgId);
    const crmKey = process.env.CRM_API_KEY?.trim?.() || process.env.CRM_API_KEY || '';
    let schedule_shift_push = { skipped: true, reason: 'no_webhook_url' };
    if (!shiftUrls.webhook_url) {
      schedule_shift_push = { skipped: true, reason: 'nexus_shift_api_base_unresolved' };
    } else {
      schedule_shift_push = await pushScheduleShiftIntegrationToShifter(shifterOrg.id, {
        webhookUrl: shiftUrls.webhook_url,
        apiKey: crmKey,
        nexusOrgId: orgId,
      });
      if (schedule_shift_push && !schedule_shift_push.ok && !schedule_shift_push.skipped) {
        console.warn('[link-shifter-org] schedule_shift_push failed:', schedule_shift_push);
      }
    }

    return res.json({
      ok: true,
      org_id: orgId,
      shifter_organization_id: shifterOrg.id,
      source: shifterOrg.source || null,
      schedule_shift_push,
      shift_api_base_url: shiftUrls.shift_api_base_url,
      shift_urls_source: shiftUrls.shift_urls_source,
      crm_api_key_configured: Boolean(String(process.env.CRM_API_KEY || '').trim()),
      shifter_remote_configured: isShifterRemoteConfigured(),
    });
  } catch (err) {
    const code = err.code || 'SHIFTER_LINK_ERROR';
    res.status(400).json({ error: err.message, code });
  }
});

router.post('/unlink-shifter-org', requireAuth, requireAdminOrDelegate, async (req, res) => {
  try {
    const orgId = req.session.user?.org_id || null;
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.', code: 'NO_ORG' });
    const admin = getSupabaseServiceRoleClient();
    if (!admin) {
      return res.status(503).json({ error: 'Supabase is not configured on the server', code: 'AUTH_NOT_CONFIGURED' });
    }

    const { error: unlinkErr } = await persistOrgShifterLink(admin, orgId, null);
    if (unlinkErr) {
      return res.status(400).json({ error: unlinkErr.message || 'Failed to remove Shifter link', code: 'SUPABASE_ORG' });
    }

    return res.json({ ok: true, org_id: orgId, shifter_organization_id: null });
  } catch (err) {
    const code = err.code || 'SHIFTER_UNLINK_ERROR';
    res.status(400).json({ error: err.message, code });
  }
});

export default router;
