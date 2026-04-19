import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { normalizeAppRole } from '../../../shared/appRoles.js';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import { getEmailConfigForUser, getRelayConfigFromEnv } from '../lib/emailSendConfig.js';

const USER_SELECT = `id, email, name, role, org_id, auth_uid, billing_interval_minutes, staff_id, signature_data,
  ollama_local_base_url,
  email_provider, email_connected_address, email_reconnect_required`;
const SUPABASE_PLACEHOLDER_PW = '\x00NEXUS_SUPABASE_AUTH\x00';

/** @param {unknown} raw */
function normalizeOllamaLocalBaseUrl(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const s = String(raw).trim().slice(0, 512);
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const allowed =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host === 'host.docker.internal';
  if (!allowed) return null;
  return u.toString().replace(/\/$/, '');
}

function secureEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function shapeUser(row) {
  if (!row) return null;
  return {
    ...row,
    role: normalizeAppRole(row.role),
    billing_interval_minutes: row.billing_interval_minutes ?? 15,
    signature_data: row.signature_data || null,
    ollama_local_base_url: row.ollama_local_base_url || null,
    email_reconnect_required: !!row.email_reconnect_required,
    is_super_admin: isSuperAdminEmail(row.email)
  };
}

/** True when AZURE_EMAIL_FUNCTION_URL is set so roster/test mail can be sent via the relay. */
function withEmailRelayFlag(user) {
  if (!user) return null;
  return {
    ...user,
    email_relay_configured: Boolean(getRelayConfigFromEnv()?.url)
  };
}

const router = Router();

router.get('/ping', (req, res) => res.json({ ok: true }));

/** Public: whether local email/password registration will create the first (admin) account — needs organisation name. */
router.get('/registration-info', (req, res) => {
  try {
    const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
    res.json({ first_account: !anyUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const passwordNorm = String(password).trim();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    let isSupabaseOnlyAccount = false;
    if (user.auth_uid) {
      const hasHash = Boolean(user.password_hash && String(user.password_hash).trim());
      const usesPlaceholder =
        hasHash && bcrypt.compareSync(SUPABASE_PLACEHOLDER_PW, String(user.password_hash));
      isSupabaseOnlyAccount = !hasHash || usesPlaceholder;
    }
    if (isSupabaseOnlyAccount) {
      return res.status(401).json({
        error: 'This account uses cloud sign-in. Use organisation cloud sign-in on the login page with the same email.',
        code: 'USE_SUPABASE_AUTH'
      });
    }
    const ok = bcrypt.compareSync(passwordNorm, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: normalizeAppRole(user.role),
      org_id: user.org_id || null
    };
    const u = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(user.id);
    res.json({ user: withEmailRelayFlag(shapeUser(u)) });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/emergency-login', (req, res) => {
  try {
    const enabled = ['1', 'true', 'yes'].includes(
      String(process.env.NEXUS_ENABLE_EMERGENCY_LOGIN || '').trim().toLowerCase()
    );
    const configuredToken = String(process.env.NEXUS_EMERGENCY_LOGIN_TOKEN || '').trim();
    if (!enabled || !configuredToken) {
      return res.status(404).json({ error: 'Not found' });
    }

    const { email, token } = req.body || {};
    const emailNorm = String(email || '').trim().toLowerCase();
    const tokenNorm = String(token || '').trim();
    if (!emailNorm || !tokenNorm) {
      return res.status(400).json({ error: 'email and token are required' });
    }
    if (!secureEquals(tokenNorm, configuredToken)) {
      return res.status(401).json({ error: 'Invalid emergency token' });
    }

    const user = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE email = ?`).get(emailNorm);
    if (!user) return res.status(404).json({ error: 'User not found' });

    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: normalizeAppRole(user.role),
      org_id: user.org_id || null
    };
    return res.json({
      user: withEmailRelayFlag(shapeUser(user)),
      emergency_login: true
    });
  } catch (err) {
    console.error('[auth] emergency login error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/register', (req, res) => {
  try {
    const { email, password, name, organization_name, org_name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const passwordNorm = String(password).trim();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const orgLabelRaw = organization_name ?? org_name;
    const orgLabel = String(orgLabelRaw ?? '').trim();
    if (!orgLabel) {
      return res.status(400).json({ error: 'Organisation name is required.' });
    }
    if (orgLabel.length > 256) {
      return res.status(400).json({ error: 'Organisation name is too long.' });
    }

    const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
    const role = anyUser ? 'support_coordinator' : 'admin';
    const id = uuid();
    const hash = bcrypt.hashSync(passwordNorm, 10);

    let orgIdForUser = null;
    if (!anyUser) {
      const orgId = uuid();
      db.prepare(`
        INSERT INTO organisations (id, owner_org_id, name, type, created_at, updated_at)
        VALUES (?, ?, ?, 'provider', datetime('now'), datetime('now'))
      `).run(orgId, orgId, orgLabel);
      orgIdForUser = orgId;
    } else {
      const anchor = db
        .prepare(
          `
        SELECT id FROM organisations
        WHERE owner_org_id IS NOT NULL AND id = owner_org_id
          AND lower(trim(name)) = lower(?)
        LIMIT 1
      `
        )
        .get(orgLabel);
      if (!anchor) {
        return res.status(400).json({
          error:
            'No organisation matches that name. Use the exact name your administrator gave you, or ask them to invite you.',
          code: 'ORG_NOT_FOUND'
        });
      }
      orgIdForUser = anchor.id;
    }

    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, org_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, emailNorm, hash, name || null, role, orgIdForUser);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    req.session.user = { id: user.id, email: user.email, name: user.name, role: normalizeAppRole(user.role), org_id: user.org_id || null };
    const u = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(id);
    res.status(201).json({ user: withEmailRelayFlag(shapeUser(u)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(req.session.user.id);
  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: 'User not found' });
  }
  const role = normalizeAppRole(user.role);
  req.session.user.role = role;
  req.session.user.org_id = user.org_id || null;
  const assignedCount = db.prepare('SELECT COUNT(*) as c FROM user_participants WHERE user_id = ?').get(req.session.user.id)?.c ?? 0;
  const delegateGrant = role === 'delegate'
    ? db.prepare(`
        SELECT 1 FROM delegate_grants
        WHERE user_id = ? AND full_control = 1
          AND (expires_at IS NULL OR expires_at >= date('now'))
      `).get(req.session.user.id)
    : null;
  res.json({
    user: withEmailRelayFlag({
      ...shapeUser(user),
      org_id: user.org_id || null,
      assigned_participant_count: assignedCount,
      delegate_grant_active: !!delegateGrant
    })
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

router.put('/password', requireAuth, (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password required' });
    }
    const userId = req.session.user.id;
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const ok = bcrypt.compareSync(String(current_password).trim(), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = bcrypt.hashSync(String(new_password).trim(), 10);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test-email', requireAuth, async (req, res) => {
  try {
    const { sendEmailViaRelay } = await import('../services/notification.service.js');
    const userId = req.session.user.id;
    if (!getEmailConfigForUser(userId)) {
      return res.status(400).json({
        ok: false,
        code: 'EMAIL_NOT_CONNECTED',
        error: 'Connect your email in Settings first, then try again.'
      });
    }
    if (!getRelayConfigFromEnv()?.url) {
      return res.status(400).json({
        ok: false,
        code: 'EMAIL_RELAY_NOT_CONFIGURED',
        error:
          'Your inbox is connected, but the server is not set up to send outgoing mail yet. Ask your administrator to finish email setup.'
      });
    }
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
    await sendEmailViaRelay(
      userId,
      u.email,
      'Schedule Shift – Test email',
      'This is a test email. Your connected inbox is working correctly.',
      null,
      null
    );
    res.json({ ok: true, message: 'Test email sent to your login address.' });
  } catch (err) {
    let code =
      err.code === 'EMAIL_RECONNECT_REQUIRED'
        ? 'EMAIL_RECONNECT_REQUIRED'
        : err.code === 'EMAIL_RELAY_NOT_CONFIGURED'
          ? 'EMAIL_RELAY_NOT_CONFIGURED'
          : err.code === 'EMAIL_RELAY_SELF_URL'
            ? 'EMAIL_RELAY_SELF_URL'
            : err.code === 'EMAIL_RELAY_PLACEHOLDER_URL'
              ? 'EMAIL_RELAY_PLACEHOLDER_URL'
              : err.code === 'EMAIL_RELAY_AUTH_FAILED'
                ? 'EMAIL_RELAY_AUTH_FAILED'
                : undefined;
    res.status(400).json({
      ok: false,
      code: code || undefined,
      error: err?.message || 'Test failed'
    });
  }
});

router.put('/settings', requireAuth, (req, res) => {
  try {
    const { billing_interval_minutes, staff_id, signature_data, ollama_local_base_url } = req.body;
    const userId = req.session.user.id;

    const updates = [];
    const values = [];
    if (billing_interval_minutes !== undefined) {
      updates.push('billing_interval_minutes = ?');
      values.push(billing_interval_minutes === null || billing_interval_minutes === '' ? 15 : Math.max(1, Math.min(60, Number(billing_interval_minutes) || 15)));
    }
    if (staff_id !== undefined) {
      updates.push('staff_id = ?');
      values.push(staff_id || null);
    }
    if (signature_data !== undefined) {
      updates.push('signature_data = ?');
      const val = signature_data === null || signature_data === '' ? null : String(signature_data).slice(0, 500000);
      values.push(val);
    }
    if (ollama_local_base_url !== undefined) {
      const norm = normalizeOllamaLocalBaseUrl(ollama_local_base_url);
      if (norm === null && ollama_local_base_url !== null && String(ollama_local_base_url).trim() !== '') {
        return res.status(400).json({
          error: 'Invalid Ollama URL. Use http://127.0.0.1:11434 or http://localhost:11434 (or host.docker.internal in Docker).'
        });
      }
      updates.push('ollama_local_base_url = ?');
      values.push(norm === undefined ? null : norm);
    }
    if (updates.length === 0) {
      const user = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(userId);
      return res.json({ user: withEmailRelayFlag(shapeUser(user)) });
    }
    values.push(userId);
    db.prepare(`
      UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now')
      WHERE id = ?
    `).run(...values);
    const user = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(userId);
    res.json({ user: withEmailRelayFlag(shapeUser(user)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
