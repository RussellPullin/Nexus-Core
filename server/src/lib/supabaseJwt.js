import { getSupabaseServiceRoleClient } from '../services/supabaseStaffShifter.service.js';

function safeJwtClaims(token) {
  try {
    const raw = String(token || '').trim();
    const parts = raw.split('.');
    if (parts.length < 2) return { parts: parts.length, issHost: null, aud: null };
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const obj = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const issHost = (() => {
      try {
        return obj?.iss ? new URL(String(obj.iss)).host : null;
      } catch {
        return null;
      }
    })();
    return { parts: parts.length, issHost, aud: obj?.aud || null };
  } catch {
    return { parts: 0, issHost: null, aud: null };
  }
}

/**
 * Verify a Supabase-issued access token via Supabase Auth API.
 * @param {string} accessToken
 * @returns {Promise<{ sub: string, email?: string }>}
 */
export async function verifySupabaseAccessToken(accessToken) {
  const admin = getSupabaseServiceRoleClient();
  const claims = safeJwtClaims(accessToken);
  const configuredHost = (() => {
    try {
      return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : null;
    } catch {
      return null;
    }
  })();
  // #region agent log
  fetch('http://127.0.0.1:7395/ingest/9396d2bf-ffd7-4cdc-a66d-39fbe0a7e677',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'455d03'},body:JSON.stringify({sessionId:'455d03',runId:'pre-fix',hypothesisId:'H9',location:'server/src/lib/supabaseJwt.js:verify:entry',message:'Verifying Supabase access token',data:{token_present:Boolean(accessToken),jwt_parts:claims.parts,token_iss_host:claims.issHost,configured_supabase_host:configuredHost,issuer_matches:claims.issHost&&configuredHost?claims.issHost===configuredHost:null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!admin || !accessToken) {
    const err = new Error('Supabase JWT verification is not configured');
    err.code = 'AUTH_CONFIG';
    throw err;
  }
  try {
    const { data, error } = await admin.auth.getUser(String(accessToken).trim());
    if (error || !data?.user?.id) {
      // #region agent log
      fetch('http://127.0.0.1:7395/ingest/9396d2bf-ffd7-4cdc-a66d-39fbe0a7e677',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'455d03'},body:JSON.stringify({sessionId:'455d03',runId:'pre-fix',hypothesisId:'H10',location:'server/src/lib/supabaseJwt.js:verify:getUser',message:'Supabase getUser failed',data:{has_error:Boolean(error),error_message:error?.message||null,user_id_present:Boolean(data?.user?.id),token_iss_host:claims.issHost,configured_supabase_host:configuredHost},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
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
