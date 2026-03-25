import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';

const USER_SELECT = `id, email, name, role, org_id, auth_uid, billing_interval_minutes, staff_id, signature_data,
  email_provider, email_connected_address, email_reconnect_required`;
const SUPABASE_PLACEHOLDER_PW = '\x00NEXUS_SUPABASE_AUTH\x00';

function shapeUser(row) {
  if (!row) return null;
  return {
    ...row,
    role: row.role || 'admin',
    billing_interval_minutes: row.billing_interval_minutes ?? 15,
    signature_data: row.signature_data || null,
    email_reconnect_required: !!row.email_reconnect_required,
    is_super_admin: isSuperAdminEmail(row.email)
  };
}

const router = Router();

router.get('/ping', (req, res) => res.json({ ok: true }));

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
        error: 'This account uses Supabase sign-in. Use the same email on the login page with Supabase enabled.',
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
      role: user.role || 'admin',
      org_id: user.org_id || null
    };
    const u = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(user.id);
    res.json({ user: shapeUser(u) });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/register', (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const passwordNorm = String(password).trim();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
    const role = anyUser ? 'support_coordinator' : 'admin';
    const id = uuid();
    const hash = bcrypt.hashSync(passwordNorm, 10);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, emailNorm, hash, name || null, role);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role || 'admin', org_id: user.org_id || null };
    const u = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(id);
    res.status(201).json({ user: shapeUser(u) });
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
  const role = user.role || 'admin';
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
    user: {
      ...shapeUser(user),
      org_id: user.org_id || null,
      assigned_participant_count: assignedCount,
      delegate_grant_active: !!delegateGrant
    }
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
    const { sendEmailViaRelay, isEmailConfiguredForUser } = await import('../services/notification.service.js');
    const userId = req.session.user.id;
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        ok: false,
        code: 'EMAIL_NOT_CONNECTED',
        error: 'Connect your email in Settings first, then try again.'
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
    const code = err.code === 'EMAIL_RECONNECT_REQUIRED' ? 'EMAIL_RECONNECT_REQUIRED' : undefined;
    res.status(400).json({
      ok: false,
      code: code || undefined,
      error: err?.message || 'Test failed',
      errorDetail: err?.message
    });
  }
});

router.put('/settings', requireAuth, (req, res) => {
  try {
    const { billing_interval_minutes, staff_id, signature_data } = req.body;
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
    if (updates.length === 0) {
      const user = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(userId);
      return res.json({ user: shapeUser(user) });
    }
    values.push(userId);
    db.prepare(`
      UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now')
      WHERE id = ?
    `).run(...values);
    const user = db.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ?`).get(userId);
    res.json({ user: shapeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
