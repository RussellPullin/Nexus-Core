/**
 * Sync from Excel - CRM (Nexus Core) pulls shifts from the OneDrive Excel file
 * created by the Progress Notes App instead of receiving webhook pushes.
 * Requires session auth (coordinator) or optionally CRM_API_KEY for cron/scripts.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import { pullShiftsFromExcel } from '../services/excelPull.service.js';
import { processShifts } from '../services/webhookProcessor.js';
import { mirrorAllShiftsToNexusSupabase } from '../services/nexusPublicShiftsSync.service.js';
import { pullShiftsFromShifterSupabase, debugShifterShiftsByOrg } from '../services/shifterPull.service.js';

const router = Router();

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
      error: 'Unauthorized. Sign in as coordinator or provide x-api-key / Authorization: Bearer (CRM_API_KEY).',
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
    if (!orgId) {
      return res.status(400).json({
        error:
          'org_id is required. Each organisation uses its own Microsoft OneDrive under Settings. Sign in with a user that has org_id, or as super admin pass org_id, or use CRM_API_KEY with org_id in the body or query.',
      });
    }

    const { shifts, llmUsed } = await pullShiftsFromExcel({
      log: (msg, data) => console.log('[sync-from-excel]', msg, data || ''),
      useLlm,
      orgId,
    });

    if (!shifts || shifts.length === 0) {
      log('No shifts found in Excel');
      return res.json({
        ok: true,
        source: 'onedrive_excel',
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
      source: 'onedrive_excel',
      llm_used: !!llmUsed,
      ...result,
    });
  } catch (err) {
    console.error('[sync-from-excel]', err);
    const hint =
      'Connect Microsoft OneDrive under Settings for this organisation (the account that owns the Progress Notes Excel file). Optional path: ONEDRIVE_EXCEL_PATH in server env.';
    res.status(500).json({
      error: err.message || 'Sync from Excel failed',
      errorDetail: hint,
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
      error: 'Unauthorized. Sign in or provide x-api-key / Authorization: Bearer (CRM_API_KEY).',
    });
  }

  const orgId = resolveSyncedOrgId(req);
  if (!orgId) {
    return res.status(400).json({
      error:
        'org_id is required. Shifter data is loaded per Nexus organisation (mapped to a Shifter org). Sign in with a user that has org_id, super admin pass org_id, or CRM_API_KEY with org_id.',
    });
  }

  const fromDate = req.body?.from_date || req.query?.from_date || '';
  const toDate = req.body?.to_date || req.query?.to_date || '';
  const limit = req.body?.limit || req.query?.limit;

  try {
    const pulled = await pullShiftsFromShifterSupabase({
      nexusOrgId: orgId,
      fromDate,
      toDate,
      limit,
      log: (msg, data) => console.log('[sync-from-shifter]', msg, data || ''),
    });

    const result = processShifts(pulled.shifts, {
      orgId,
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
      ...result,
    });
  } catch (err) {
    console.error('[sync-from-shifter]', err);
    res.status(500).json({
      error: err.message || 'Sync from Shifter Supabase failed',
      errorDetail:
        'Check SHIFTER_SUPABASE_URL/SHIFTER_SERVICE_ROLE_KEY and that org_id maps to a Shifter org (public.organizations.shifter_organization_id).',
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
      error: 'Unauthorized. Sign in or provide x-api-key / Authorization: Bearer (CRM_API_KEY).',
    });
  }

  const orgId = resolveSyncedOrgId(req);
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
      errorDetail:
        'Check SHIFTER_SUPABASE_URL/SHIFTER_SERVICE_ROLE_KEY and that org_id maps to a Shifter org (public.organizations.shifter_organization_id).',
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
      error: 'Unauthorized. Sign in or provide x-api-key / Authorization: Bearer (CRM_API_KEY).',
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
