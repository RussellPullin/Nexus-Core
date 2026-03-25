import { isSuperAdminEmail } from '../lib/superAdmin.js';

export function requireSuperAdmin(req, res, next) {
  const email = req.session?.user?.email;
  if (!isSuperAdminEmail(email)) {
    return res.status(403).json({ error: 'Super admin only' });
  }
  next();
}
