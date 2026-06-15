import { getActiveSessionStatus, sendSessionAuthFailure } from '../lib/activeSession.js';

export function requireAuth(req, res, next) {
  if (req.session?.user) {
    const activeStatus = getActiveSessionStatus(req);
    if (!activeStatus.ok) {
      return sendSessionAuthFailure(req, res, activeStatus);
    }
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}
