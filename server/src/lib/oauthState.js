import crypto from 'crypto';

export function signOAuthState(obj) {
  const secret = process.env.SESSION_SECRET || 'schedule-shift-session-secret-change-in-production';
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const secret = process.env.SESSION_SECRET || 'schedule-shift-session-secret-change-in-production';
  const i = state.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = state.slice(0, i);
  const sig = state.slice(i + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o.exp || o.exp < Date.now()) return null;
    return o;
  } catch {
    return null;
  }
}
