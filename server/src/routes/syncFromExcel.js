/**
 * Sync from Excel - CRM (Nexus Core) pulls shifts from the OneDrive Excel file
 * created by the Progress Notes App instead of receiving webhook pushes.
 * Requires session auth (coordinator) or optionally CRM_API_KEY for cron/scripts.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import {
  ONEDRIVE_EXCEL_APP_ONLY_REQUIRED_HINT,
  ONEDRIVE_EXCEL_DELEGATED_OR_ENV_HINT,
  ONEDRIVE_EXCEL_SHIFTER_404_FALLBACK_NOTE
} from '../lib/onedriveExcelSyncHint.js';
import { pullShiftsFromExcel } from '../services/excelPull.service.js';
import { processShifts } from '../services/webhookProcessor.js';
import { mirrorAllShiftsToNexusSupabase } from '../services/nexusPublicShiftsSync.service.js';
import { pullShiftsFromShifterSupabase, debugShifterShiftsByOrg } from '../services/shifterPull.service.js';
import { isShifterRemoteConfigured } from '../services/supabaseStaffShifter.service.js';

const router = Router();

function shouldTryShifterAfterOnedriveNotFound(err) {
  if (!isShifterRemoteConfigured()) return false;
  const m = String(err?.message || err || '');
  return /itemNotFound|item not found|"code":"itemNotFound"|The resource could not be found|Item not found/u.test(m);
}

function hasValidApiKey(req) {
  const expected = process.env.CRM_API_KEY?.trim?.() || process.env.CRM_API_KEY || '';
  if (!expected) return false;
  const apiKey = (req.headers['x-api-key'] || '').trim();
  if (apiKey && apiKey === expected) return true;
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() === expected;
  }
  return false;
}

/**
 * Sync org for Excel/Shifter: signed-in users are scoped to their org (super-admins may pass body/query org_id).
 * CRM_API_KEY without a session must send org_id — intended for per-org cron jobs.
 */
function resolveSyncedOrgId(req) {
  const bodyOrg =
    typeof req.body?.org_id === 'string' && req.body.org_id.trim() ? req.body.org_id.trim() : null;
  const queryOrg =
    typeof req.query?.org_id === 'string' && req.query.org_id.trim() ? req.query.org_id.trim() : null;
  const requested = bodyOrg || queryOrg || null;

  const hasSession = !!req.session?.user;
  if (hasValidApiKey(req) && !hasSession) {
    return requested || null;
  }

  if (!hasSession) return null;

  const uid = req.session.user.id;
  const u = db.prepare('SELECT org_id, email FROM users WHERE id = ?').get(uid);
  const sessionOrg = u?.org_id && String(u.org_id).trim() ? String(u.org_id).trim() : null;
  const superA = isSuperAdminEmail(u?.email);

  if (superA) {
    if (requested) return requested;
    return sessionOrg || null;
  }
  return sessionOrg || null;
}

/**
 * POST /api/sync/from-excel
 * Pull shifts from OneDrive Excel and process them (same logic as webhook).
 * Auth: session (coordinator) OR x-api-key / Authorization: Bearer (CRM_API_KEY)
 */
router.post('/from-excel', async (req, res) => {
  const hasSession = !!req.session?.user;
  const hasKey = hasValidApiKey(req);

  if (!hasSession && !hasKey) {
    return res.status(401).json({
      error: 'Unauthorized. Sign in as coordinator or provide the server API key in x-api-key or Authorization: Bearer.',
    });
  }

  const log = (msg, data) => console.log('[sync-from-excel]', msg, data || '');

  try {
    log('Pulling shifts from OneDrive Excel...');

    const useLlm =
      req.body?.useLlm !== false &&
      req.body?.useLlm !== 'false' &&
      req.query?.useLlm !== 'false';

    const orgId = resolveSyncedOrgId(req);
    if (hasSession && !orgId) {
      return res.status(400).json({
        error: 'Your account has no organisation (or pass org_id as a super admin). Cannot sync.',
        code: 'NO_ORG',
      });
    }
    if (!hasSession && hasKey && !orgId) {
      return res.status(400).json({
        error: 'org_id is required in body or query when using the server API key (CRM_API_KEY).',
        code: 'ORG_ID_REQUIRED',
      });
    }
    let shifts;
    let llmUsed = false;
    let source = 'onedrive_excel';
    let onedrive_error = null;

    try {
      const automationLlm = Boolean(hasKey && !hasSession);
      const pulled = await pullShiftsFromExcel({
        log: (msg, data) => console.log('[sync-from-excel]', msg, data || ''),
        useLlm,
        organizationId: orgId || undefined,
        automationAllowServerLlm: automationLlm
      });
      shifts = pulled.shifts;
      llmUsed = !!pulled.llmUsed;
    } catch (excelErr) {
      onedrive_error = excelErr?.message ? String(excelErr.message) : String(excelErr || '');
      if (orgId && shouldTryShifterAfterOnedriveNotFound(excelErr)) {
        log('OneDrive Excel not found; falling back to Shifter Supabase shifts for this org', { orgId });
        const pulled = await pullShiftsFromShifterSupabase({
          nexusOrgId: orgId,
          log: (msg, data) => console.log('[sync-from-excel]', msg, data || ''),
          logWarn: (msg, data) => console.warn('[sync-from-excel]', msg, data || ''),
        });
        shifts = pulled.shifts;
        llmUsed = false;
        source = 'shifter_supabase_fallback';
      } else {
        throw excelErr;
      }
    }

    if (!shifts || shifts.length === 0) {
      log('No shifts found');
      return res.json({
        ok: true,
        source,
        ...(source === 'shifter_supabase_fallback' && onedrive_error ? { onedrive_error } : {}),
        llm_used: !!llmUsed,
        processed: 0,
        matched: 0,
        unmatched: 0,
        skipped: 0,
      });
    }

    log('Processing shifts', { count: shifts.length });

    const result = processShifts(shifts, {
      orgId,
      log: (msg, data) => console.log('[sync-from-excel]', msg, data || ''),
      logWarn: (msg, data) => console.warn('[sync-from-excel]', msg, data || ''),
      logError: (msg, err) => console.error('[sync-from-excel]', msg, err),
    });

    log('Done', result);

    res.json({
      ok: true,
      source,
      ...(source === 'shifter_supabase_fallback' && onedrive_error ? { onedrive_error } : {}),
      llm_used: !!llmUsed,
      ...result,
    });
  } catch (err) {
    console.error('[sync-from-excel]', err);
    const msg = err.message || 'Sync from Excel failed';
    const onedriveRelated =
      msg === ONEDRIVE_EXCEL_DELEGATED_OR_ENV_HINT ||
      msg === ONEDRIVE_EXCEL_APP_ONLY_REQUIRED_HINT ||
      /Could not read the Progress Notes Excel|OneDrive|ONEDRIVE|Graph|itemNotFound|item not found|Connect Microsoft|Sharing link/i.test(
        msg
      );
    res.status(500).json({
      error: msg,
      ...(onedriveRelated ? { errorDetail: ONEDRIVE_EXCEL_SHIFTER_404_FALLBACK_NOTE } : {})
    });
  }
});

/**
 * POST /api/sync/from-shifter
 * Pull shifts from Shifter Supabase (org-scoped) and process using webhook logic.
 * Auth: session (scoped to user org; super admin may pass org_id) OR CRM_API_KEY with body/query org_id.
 * Optional body/query: from_date, to_date, limit
 */
router.post('/from-shifter', async (req, res) => {
  const hasSession = !!req.session?.user;
  const hasKey = hasValidApiKey(req);

  if (!hasSession && !hasKey) {
    return res.status(401).json({
      error: 'Unauthorized. Sign in or provide the server API key in x-api-key or Authorization: Bearer.',
    });
  }

  const sessionOrgId = req.session?.user?.org_id || null;
  const requestedOrgId = req.body?.org_id || req.query?.org_id || null;
  let orgId;
  if (hasSession) {
    if (!sessionOrgId) {
      return res.status(400).json({
        error: 'Your account has no organisation. Cannot sync for another tenant.',
        code: 'NO_ORG',
      });
    }
    orgId = sessionOrgId;
  } else {
    orgId = requestedOrgId || null;
  }
  if (!orgId) {
    return res.status(400).json({
      error:
        'org_id is required. Shifter data is loaded per Nexus organisation (mapped to a Shifter org). Sign in with a user that has org_id, super admin pass org_id, or CRM_API_KEY with org_id.',
    });
  }

  const fromDate = req.body?.from_date || req.query?.from_date || '';
  const toDate = req.body?.to_date || req.query?.to_date || '';
  const limit = req.body?.limit || req.query?.limit;
  const forceFull =
    req.body?.force_full_reprocess === true ||
    String(req.body?.force_full_reprocess || req.query?.force_full_reprocess || '')
      .toLowerCase() === 'true';
  const rawSkipUnchanged = req.body?.skip_unchanged ?? req.query?.skip_unchanged;
  const skipUnchanged = forceFull
    ? false
    : rawSkipUnchanged === false || String(rawSkipUnchanged || '').toLowerCase() === 'false'
      ? false
      : true;

  try {
    const pulled = await pullShiftsFromShifterSupabase({
      nexusOrgId: orgId,
      fromDate,
      toDate,
      limit,
      log: (msg, data) => console.log('[sync-from-shifter]', msg, data || ''),
      logWarn: (msg, data) => console.warn('[sync-from-shifter]', msg, data || ''),
    });

    const result = processShifts(pulled.shifts, {
      orgId,
      skipUnchanged,
      log: (msg, data) => console.log('[sync-from-shifter]', msg, data || ''),
      logWarn: (msg, data) => console.warn('[sync-from-shifter]', msg, data || ''),
      logError: (msg, err) => console.error('[sync-from-shifter]', msg, err),
    });

    res.json({
      ok: true,
      source: 'shifter_supabase',
      org_id: orgId,
      shifter_org_id: pulled.shifterOrgId,
      table: pulled.table,
      org_column: pulled.orgColumn,
      pulled_rows: pulled.pulledRows,
      mapped_rows: pulled.mappedRows,
      skipped_rows: pulled.skippedRows,
      skip_unchanged: skipUnchanged,
      ...result,
    });
  } catch (err) {
    console.error('[sync-from-shifter]', err);
    res.status(500).json({
      error: err.message || 'Could not pull shifts from Shifter.',
      errorDetail: 'Ask your administrator to check Shifter and server configuration for your organisation.',
    });
  }
});

/**
 * POST /api/sync/from-shifter/debug
 * Inspects Shifter shifts table/org-column candidates for this org and returns sample mapping.
 * Auth: session (scoped to user org; super admin may pass org_id) OR CRM_API_KEY with body/query org_id.
 * Optional body/query: limit (default 10, max 100)
 */
router.post('/from-shifter/debug', async (req, res) => {
  const hasSession = !!req.session?.user;
  const hasKey = hasValidApiKey(req);
  if (!hasSession && !hasKey) {
    return res.status(401).json({
      error: 'Unauthorized. Sign in or provide the server API key in x-api-key or Authorization: Bearer.',
    });
  }

  const sessionOrgId = req.session?.user?.org_id || null;
  const requestedOrgId = req.body?.org_id || req.query?.org_id || null;
  let orgId;
  if (hasSession) {
    if (!sessionOrgId) {
      return res.status(400).json({
        error: 'Your account has no organisation. Cannot debug sync for another tenant.',
        code: 'NO_ORG',
      });
    }
    orgId = sessionOrgId;
  } else {
    orgId = requestedOrgId || null;
  }
  if (!orgId) {
    return res.status(400).json({
      error:
        'org_id is required. Sign in with a user that has org_id, super admin pass org_id, or CRM_API_KEY with org_id.',
    });
  }

  const limit = req.body?.limit || req.query?.limit;
  try {
    const debug = await debugShifterShiftsByOrg({
      nexusOrgId: orgId,
      limit,
    });
    res.json({ ok: true, ...debug });
  } catch (err) {
    console.error('[sync-from-shifter-debug]', err);
    res.status(500).json({
      error: err.message || 'Shifter debug failed',
      errorDetail: 'Ask your administrator to check Shifter and server configuration for your organisation.',
    });
  }
});

/**
 * POST /api/sync/nexus-public-shifts
 * Re-mirror all SQLite shifts to Nexus Core Supabase public.shifts (for Shifter webhooks / drift repair).
 * Auth: signed-in user OR x-api-key / Bearer (CRM_API_KEY) for cron.
 */
router.post('/nexus-public-shifts', async (req, res) => {
  const hasSession = !!req.session?.user;
  const hasKey = hasValidApiKey(req);
  if (!hasSession && !hasKey) {
    return res.status(401).json({
      error: 'Unauthorized. Sign in or provide the server API key in x-api-key or Authorization: Bearer.',
    });
  }
  try {
    const summary = await mirrorAllShiftsToNexusSupabase();
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[sync nexus-public-shifts]', err);
    res.status(500).json({ ok: false, error: err.message || 'Mirror failed' });
  }
});

export default router;
