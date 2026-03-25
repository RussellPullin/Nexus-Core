import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';

const router = Router();
router.use(requireAuth);

function requesterScope(req) {
  const u = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(req.session?.user?.id);
  return { orgId: u?.org_id || null, superAdmin: isSuperAdminEmail(u?.email) };
}

// Standalone contacts - must be before /:id
router.get('/contacts/all', (req, res) => {
  try {
    const scope = requesterScope(req);
    const { search } = req.query;
    let contacts = db.prepare(`
      SELECT c.*, o.name as org_name
      FROM contacts c
      LEFT JOIN organisations o ON c.organisation_id = o.id
      ${scope.orgId && !scope.superAdmin ? 'WHERE o.owner_org_id = ?' : ''}
      ORDER BY c.name
    `).all(...(scope.orgId && !scope.superAdmin ? [scope.orgId] : []));
    if (search) {
      const s = search.toLowerCase();
      contacts = contacts.filter(c => c.name && c.name.toLowerCase().includes(s));
    }
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List organisations
router.get('/', (req, res) => {
  try {
    const scope = requesterScope(req);
    const { search, type } = req.query;
    let orgs = db.prepare(`
      SELECT o.*, 
        (SELECT COUNT(*) FROM contacts c WHERE c.organisation_id = o.id) as contact_count,
        (SELECT COUNT(*) FROM participants p WHERE p.plan_manager_id = o.id) as participant_count
      FROM organisations o
      ${scope.orgId && !scope.superAdmin ? 'WHERE o.owner_org_id = ?' : ''}
      ORDER BY o.name
    `).all(...(scope.orgId && !scope.superAdmin ? [scope.orgId] : []));

    if (search) {
      const s = search.toLowerCase();
      orgs = orgs.filter(o => 
        (o.name && o.name.toLowerCase().includes(s)) ||
        (o.abn && o.abn.includes(search))
      );
    }
    if (type) {
      if (type === 'plan_manager') {
        const planManagerIds = new Set(
          db.prepare('SELECT DISTINCT plan_manager_id FROM participants WHERE plan_manager_id IS NOT NULL').all()
            .map(r => r.plan_manager_id)
        );
        orgs = orgs.filter(o => {
          const t = (o.type || '').toLowerCase();
          const isPlanManagerType = t.includes('plan') && t.includes('manager');
          const isReferencedAsPlanManager = planManagerIds.has(o.id);
          return isPlanManagerType || isReferencedAsPlanManager;
        });
      } else {
        orgs = orgs.filter(o => o.type === type);
      }
    }
    res.json(orgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single organisation with contacts
router.get('/:id', (req, res) => {
  try {
    const scope = requesterScope(req);
    const org = scope.orgId && !scope.superAdmin
      ? db.prepare('SELECT * FROM organisations WHERE id = ? AND owner_org_id = ?').get(req.params.id, scope.orgId)
      : db.prepare('SELECT * FROM organisations WHERE id = ?').get(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const contacts = db.prepare('SELECT * FROM contacts WHERE organisation_id = ?').all(req.params.id);
    const participants = db.prepare('SELECT id, name, ndis_number FROM participants WHERE plan_manager_id = ?').all(req.params.id);
    res.json({ ...org, contacts, participants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create organisation (admin/delegate only)
router.post('/', requireAdminOrDelegate, (req, res) => {
  try {
    const scope = requesterScope(req);
    const ownerOrgId = scope.superAdmin ? (req.body?.owner_org_id || scope.orgId || null) : scope.orgId;
    if (!ownerOrgId) return res.status(400).json({ error: 'No organisation on your account. Complete setup first.' });
    const id = uuidv4();
    const { name, type, abn, ndis_reg_number, email, phone, address, website } = req.body;
    db.prepare(`
      INSERT INTO organisations (id, owner_org_id, name, type, abn, ndis_reg_number, email, phone, address, website)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ownerOrgId, name || '', type || null, abn || null, ndis_reg_number || null, email || null, phone || null, address || null, website || null);
    res.status(201).json({ id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update organisation (admin/delegate only)
router.put('/:id', requireAdminOrDelegate, (req, res) => {
  try {
    const scope = requesterScope(req);
    const existing = scope.orgId && !scope.superAdmin
      ? db.prepare('SELECT id FROM organisations WHERE id = ? AND owner_org_id = ?').get(req.params.id, scope.orgId)
      : db.prepare('SELECT id FROM organisations WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Organisation not found' });
    const { name, type, abn, ndis_reg_number, email, phone, address, website } = req.body;
    db.prepare(`
      UPDATE organisations SET
        name = ?, type = ?, abn = ?, ndis_reg_number = ?, email = ?, phone = ?, address = ?, website = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, type, abn, ndis_reg_number, email, phone, address, website, req.params.id);
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete organisation (admin/delegate only)
router.delete('/:id', requireAdminOrDelegate, (req, res) => {
  try {
    const scope = requesterScope(req);
    const id = req.params.id;
    const existing = scope.orgId && !scope.superAdmin
      ? db.prepare('SELECT id FROM organisations WHERE id = ? AND owner_org_id = ?').get(id, scope.orgId)
      : db.prepare('SELECT id FROM organisations WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Organisation not found' });
    // Clear plan_manager_id for participants before deleting (avoids foreign key violation)
    db.prepare('UPDATE participants SET plan_manager_id = NULL WHERE plan_manager_id = ?').run(id);
    // Delete contacts linked to this organisation
    db.prepare('DELETE FROM contacts WHERE organisation_id = ?').run(id);
    db.prepare('DELETE FROM organisations WHERE id = ?').run(id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contacts (organisation-scoped)
router.get('/:id/contacts', (req, res) => {
  const scope = requesterScope(req);
  const org = scope.orgId && !scope.superAdmin
    ? db.prepare('SELECT id FROM organisations WHERE id = ? AND owner_org_id = ?').get(req.params.id, scope.orgId)
    : db.prepare('SELECT id FROM organisations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  const contacts = db.prepare('SELECT * FROM contacts WHERE organisation_id = ?').all(req.params.id);
  res.json(contacts);
});

router.post('/:id/contacts', requireAdminOrDelegate, (req, res) => {
  try {
    const scope = requesterScope(req);
    const org = scope.orgId && !scope.superAdmin
      ? db.prepare('SELECT id FROM organisations WHERE id = ? AND owner_org_id = ?').get(req.params.id, scope.orgId)
      : db.prepare('SELECT id FROM organisations WHERE id = ?').get(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organisation not found' });
    const id = uuidv4();
    const { name, email, phone, role } = req.body;
    db.prepare(`
      INSERT INTO contacts (id, organisation_id, name, email, phone, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, name || '', email || null, phone || null, role || null);
    res.status(201).json({ id, organisation_id: req.params.id, name, email, phone, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/contacts/:contactId', requireAdminOrDelegate, (req, res) => {
  const scope = requesterScope(req);
  const org = scope.orgId && !scope.superAdmin
    ? db.prepare('SELECT id FROM organisations WHERE id = ? AND owner_org_id = ?').get(req.params.id, scope.orgId)
    : db.prepare('SELECT id FROM organisations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  const { name, email, phone, role } = req.body;
  db.prepare(`
    UPDATE contacts SET name = ?, email = ?, phone = ?, role = ?, updated_at = datetime('now')
    WHERE id = ? AND organisation_id = ?
  `).run(name, email, phone, role, req.params.contactId, req.params.id);
  res.json({ id: req.params.contactId, ...req.body });
});

router.delete('/:id/contacts/:contactId', requireAdminOrDelegate, (req, res) => {
  const scope = requesterScope(req);
  const org = scope.orgId && !scope.superAdmin
    ? db.prepare('SELECT id FROM organisations WHERE id = ? AND owner_org_id = ?').get(req.params.id, scope.orgId)
    : db.prepare('SELECT id FROM organisations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organisation not found' });
  db.prepare('DELETE FROM contacts WHERE id = ? AND organisation_id = ?').run(req.params.contactId, req.params.id);
  res.status(204).send();
});

export default router;
