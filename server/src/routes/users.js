import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireAdminOrDelegate } from '../middleware/roles.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';

const router = Router();

// All routes require auth
router.use(requireAuth);

// List users (admin or delegate with grant)
router.get('/', requireAdminOrDelegate, (req, res) => {
  try {
    const requester = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(req.session.user.id);
    const tenantFilter =
      requester?.org_id && !isSuperAdminEmail(requester.email) ? 'WHERE u.org_id = ?' : '';
    const users = db
      .prepare(`
      SELECT u.id, u.email, u.name, u.role, u.org_id, u.staff_id, u.created_at,
             s.name as staff_name
      FROM users u
      LEFT JOIN staff s ON s.id = u.staff_id
      ${tenantFilter}
      ORDER BY u.email
    `)
      .all(...(tenantFilter ? [requester.org_id] : []));
    const withAssignments = users.map((u) => {
      const count = db.prepare('SELECT COUNT(*) as c FROM user_participants WHERE user_id = ?').get(u.id)?.c ?? 0;
      const grant = u.role === 'delegate'
        ? db.prepare(`
            SELECT id, granted_by, expires_at FROM delegate_grants
            WHERE user_id = ? AND full_control = 1
              AND (expires_at IS NULL OR expires_at >= date('now'))
          `).get(u.id)
        : null;
      return { ...u, assigned_participant_count: count, delegate_grant: grant };
    });
    res.json(withAssignments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user role (admin only)
router.put('/:id/role', requireAdmin, (req, res) => {
  try {
    const requester = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(req.session.user.id);
    const orgScoped = requester?.org_id && !isSuperAdminEmail(requester.email);
    const { role } = req.body;
    if (!['admin', 'support_coordinator', 'delegate'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const { id } = req.params;
    const existing = orgScoped
      ? db.prepare('SELECT id FROM users WHERE id = ? AND org_id = ?').get(id, requester.org_id)
      : db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, id);
    const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(id);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List user-participant assignments (admin/delegate)
router.get('/user-participants', requireAdminOrDelegate, (req, res) => {
  try {
    const requester = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(req.session.user.id);
    const orgScoped = requester?.org_id && !isSuperAdminEmail(requester.email);
    const { user_id } = req.query;
    let rows = db.prepare(`
      SELECT up.id, up.user_id, up.participant_id, up.created_at,
             u.email as user_email, u.name as user_name,
             p.name as participant_name, p.ndis_number
      FROM user_participants up
      JOIN users u ON u.id = up.user_id
      JOIN participants p ON p.id = up.participant_id
      ${orgScoped ? 'WHERE u.org_id = ? AND p.provider_org_id = ?' : ''}
      ORDER BY u.email, p.name
    `).all(...(orgScoped ? [requester.org_id, requester.org_id] : []));
    if (user_id) rows = rows.filter((r) => r.user_id === user_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign participant to user (admin/delegate)
router.post('/user-participants', requireAdminOrDelegate, (req, res) => {
  try {
    const requester = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(req.session.user.id);
    const orgScoped = requester?.org_id && !isSuperAdminEmail(requester.email);
    const { user_id, participant_id } = req.body;
    if (!user_id || !participant_id) {
      return res.status(400).json({ error: 'user_id and participant_id required' });
    }
    const user = orgScoped
      ? db.prepare('SELECT id, role FROM users WHERE id = ? AND org_id = ?').get(user_id, requester.org_id)
      : db.prepare('SELECT id, role FROM users WHERE id = ?').get(user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'support_coordinator') {
      return res.status(400).json({ error: 'Can only assign participants to support coordinators' });
    }
    const participant = orgScoped
      ? db.prepare('SELECT id FROM participants WHERE id = ? AND provider_org_id = ?').get(participant_id, requester.org_id)
      : db.prepare('SELECT id FROM participants WHERE id = ?').get(participant_id);
    if (!participant) return res.status(404).json({ error: 'Participant not found' });
    const id = uuidv4();
    db.prepare('INSERT INTO user_participants (id, user_id, participant_id) VALUES (?, ?, ?)').run(id, user_id, participant_id);
    const row = db.prepare(`
      SELECT up.*, u.email as user_email, p.name as participant_name
      FROM user_participants up
      JOIN users u ON u.id = up.user_id
      JOIN participants p ON p.id = up.participant_id
      WHERE up.id = ?
    `).get(id);
    res.status(201).json(row);
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Assignment already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Remove participant assignment (admin/delegate)
router.delete('/user-participants/:id', requireAdminOrDelegate, (req, res) => {
  try {
    const requester = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(req.session.user.id);
    const orgScoped = requester?.org_id && !isSuperAdminEmail(requester.email);
    const result = orgScoped
      ? db.prepare(`
          DELETE FROM user_participants
          WHERE id = ?
            AND user_id IN (SELECT id FROM users WHERE org_id = ?)
        `).run(req.params.id, requester.org_id)
      : db.prepare('DELETE FROM user_participants WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grant delegate permissions (admin only)
router.post('/delegate-grants', requireAdmin, (req, res) => {
  try {
    const requester = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(req.session.user.id);
    const orgScoped = requester?.org_id && !isSuperAdminEmail(requester.email);
    const { user_id, expires_at } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const user = orgScoped
      ? db.prepare('SELECT id, role FROM users WHERE id = ? AND org_id = ?').get(user_id, requester.org_id)
      : db.prepare('SELECT id, role FROM users WHERE id = ?').get(user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'delegate') {
      return res.status(400).json({ error: 'User must have delegate role to receive grant' });
    }
    const adminId = req.session.user.id;
    const existing = db.prepare(`
      SELECT id FROM delegate_grants
      WHERE user_id = ? AND full_control = 1
        AND (expires_at IS NULL OR expires_at >= date('now'))
    `).get(user_id);
    if (existing) return res.status(400).json({ error: 'User already has active delegate grant' });
    const id = uuidv4();
    db.prepare(`
      INSERT INTO delegate_grants (id, user_id, granted_by, full_control, expires_at)
      VALUES (?, ?, ?, 1, ?)
    `).run(id, user_id, adminId, expires_at || null);
    const grant = db.prepare('SELECT * FROM delegate_grants WHERE id = ?').get(id);
    res.status(201).json(grant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revoke delegate grant (admin only)
router.delete('/delegate-grants/:userId', requireAdmin, (req, res) => {
  try {
    const requester = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(req.session.user.id);
    const orgScoped = requester?.org_id && !isSuperAdminEmail(requester.email);
    const result = orgScoped
      ? db.prepare(`
          DELETE FROM delegate_grants
          WHERE user_id = ?
            AND user_id IN (SELECT id FROM users WHERE org_id = ?)
        `).run(req.params.userId, requester.org_id)
      : db.prepare('DELETE FROM delegate_grants WHERE user_id = ?').run(req.params.userId);
    res.json({ revoked: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
