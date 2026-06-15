import { db } from '../db/index.js';

export const SESSION_REPLACED_CODE = 'SESSION_REPLACED';
export const SESSION_REPLACED_MESSAGE = 'You were signed out because this account was used on another device.';

export function markActiveSession(req, userId) {
  if (!req?.sessionID || !userId) return;
  req.session.active_session_id = req.sessionID;
  db.prepare(
    `UPDATE users
     SET active_session_id = ?, active_session_started_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(req.sessionID, userId);
}

export function getActiveSessionStatus(req) {
  const userId = req?.session?.user?.id;
  if (!userId) return { ok: false, status: 401, error: 'Not authenticated' };

  const row = db.prepare('SELECT active_session_id FROM users WHERE id = ?').get(userId);
  if (!row) return { ok: false, status: 401, error: 'User not found' };

  const activeSessionId = row.active_session_id || null;
  if (!activeSessionId) return { ok: true };

  if (activeSessionId !== req.sessionID) {
    return {
      ok: false,
      status: 401,
      error: SESSION_REPLACED_MESSAGE,
      code: SESSION_REPLACED_CODE
    };
  }

  return { ok: true };
}

export function sendSessionAuthFailure(req, res, status) {
  const body = { error: status.error };
  if (status.code) body.code = status.code;

  if (req?.session) {
    req.session.destroy(() => res.status(status.status || 401).json(body));
    return;
  }

  res.status(status.status || 401).json(body);
}
