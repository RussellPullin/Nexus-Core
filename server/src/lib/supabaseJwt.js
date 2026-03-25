import { getSupabaseServiceRoleClient } from '../services/supabaseStaffShifter.service.js';

/**
 * Verify a Supabase-issued access token via Supabase Auth API.
 * @param {string} accessToken
 * @returns {Promise<{ sub: string, email?: string }>}
 */
export async function verifySupabaseAccessToken(accessToken) {
  const admin = getSupabaseServiceRoleClient();
  if (!admin || !accessToken) {
    const err = new Error('Supabase JWT verification is not configured');
    err.code = 'AUTH_CONFIG';
    throw err;
  }
  try {
    const { data, error } = await admin.auth.getUser(String(accessToken).trim());
    if (error || !data?.user?.id) {
      const err = new Error('Invalid token payload');
      err.code = 'INVALID_JWT';
      throw err;
    }
    return {
      sub: data.user.id,
      email: data.user.email || undefined
    };
  } catch (e) {
    if (e.code === 'AUTH_CONFIG' || e.code === 'INVALID_JWT') throw e;
    const err = new Error('Invalid or expired token');
    err.code = 'INVALID_JWT';
    throw err;
  }
}

export function isSupabaseJwtConfigured() {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}
