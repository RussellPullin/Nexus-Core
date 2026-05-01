import { db } from '../db/index.js';
import { assertAgencyShellAccess } from '../services/tenantProduct.service.js';

/**
 * Shift / Shifter features require Nexus Agency shell + org/user agency entitlement.
 */
export function requireAgencyShell(req, res, next) {
  try {
    const uid = req.session?.user?.id;
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    const userRow = db.prepare('SELECT org_id, coordination_access, agency_access FROM users WHERE id = ?').get(uid);
    if (!userRow) return res.status(401).json({ error: 'User not found' });
    assertAgencyShellAccess(req, userRow);
    next();
  } catch (e) {
    const code = e?.code || 'FORBIDDEN';
    const status = code === 'WRONG_ACTIVE_PRODUCT' ? 409 : 403;
    res.status(status).json({ error: e.message || 'Forbidden', code });
  }
}
