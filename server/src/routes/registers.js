/**
 * In-app compliance register views (same row builder as OneDrive Register/*.xlsx sync).
 */

import { Router } from 'express';
import { requireAdminOrDelegate } from '../middleware/roles.js';
import { db } from '../db/index.js';
import { buildRegisterSnapshotForOrg } from '../services/registerSnapshots.service.js';

const router = Router();

router.get('/snapshot', requireAdminOrDelegate, (req, res) => {
  try {
    const u = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session.user.id);
    const orgId = u?.org_id;
    if (!orgId) return res.status(400).json({ error: 'No organisation on your account.' });
    res.json(buildRegisterSnapshotForOrg(orgId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
