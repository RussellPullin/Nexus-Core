/**
 * Phase 6: Daily task automation.
 *
 * One service that owns every recurring sweep Nexus needs to run each day:
 *   - participant form renewals (re-uses Phase 0 helper)
 *   - staff document expiry scanning
 *   - generation of "Today's tasks" snapshot per coordinator
 *   - register refresh trigger (delegates to existing register sync if available)
 *
 * Designed to be triggered by an external cron via `POST /api/automation/tick` so the
 * caller doesn't have to know the implementation. Each step is independent and one
 * step's failure never blocks the others.
 */
import { db } from '../db/index.js';
import { upsertRenewalTasksForParticipant, createAuditEvent } from './onboarding.service.js';

/**
 * @typedef {{
 *   step: string,
 *   ok: boolean,
 *   detail?: any,
 *   error?: string
 * }} StepReport
 *
 * @returns {Promise<{ tick_id: string, started_at: string, finished_at: string, steps: StepReport[] }>}
 */
export async function runDailyAutomationTick({ orgId = null, actorType = 'system', actorId = null } = {}) {
  const startedAt = new Date().toISOString();
  /** @type {StepReport[]} */
  const steps = [];
  const tickId = `tick_${Date.now()}`;

  const push = (s) => {
    steps.push(s);
    return s;
  };

  // ---- Step 1: participant form renewals ----
  try {
    const targets = orgId
      ? db
          .prepare(
            `SELECT po.id
             FROM participant_onboarding po
             JOIN provider_profiles pp ON pp.id = po.provider_profile_id
             WHERE pp.organisation_id = ?`
          )
          .all(orgId)
      : db.prepare('SELECT id FROM participant_onboarding').all();
    let totalCreated = 0;
    for (const t of targets) {
      try {
        totalCreated += upsertRenewalTasksForParticipant(t.id) || 0;
      } catch (e) {
        console.warn('[automation] renewal scan failed for', t.id, e?.message);
      }
    }
    push({
      step: 'participant_renewals',
      ok: true,
      detail: { onboardings_scanned: targets.length, tasks_created: totalCreated }
    });
  } catch (err) {
    push({ step: 'participant_renewals', ok: false, error: err.message });
  }

  // ---- Step 2: staff compliance expiry sweep ----
  try {
    const horizonDays = 30;
    const horizon = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const expiring = db
      .prepare(
        `SELECT scd.id, scd.staff_id, scd.document_type, scd.expiry_date, s.org_id, s.name as staff_name
         FROM staff_compliance_documents scd
         JOIN staff s ON s.id = scd.staff_id
         WHERE scd.expiry_date IS NOT NULL
           AND scd.expiry_date <= ?
           AND (scd.status IS NULL OR scd.status != 'archived')
           ${orgId ? 'AND s.org_id = ?' : ''}`
      )
      .all(...(orgId ? [horizon, orgId] : [horizon]));
    push({ step: 'staff_compliance_scan', ok: true, detail: { horizon_days: horizonDays, expiring: expiring.length } });
    for (const row of expiring) {
      try {
        createAuditEvent({
          actorType,
          actorId,
          eventType: 'staff_compliance_expiring',
          entityType: 'staff_compliance_document',
          entityId: row.id,
          newValue: {
            staff_id: row.staff_id,
            document_type: row.document_type,
            expiry_date: row.expiry_date,
            horizon_days: horizonDays
          }
        });
      } catch (e) {
        console.warn('[automation] audit emit failed for staff doc', row.id, e?.message);
      }
    }
  } catch (err) {
    push({ step: 'staff_compliance_scan', ok: false, error: err.message });
  }

  // ---- Step 3: intake-token cleanup ----
  try {
    const result = db
      .prepare(
        `UPDATE participant_intake_tokens
         SET status = 'expired'
         WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < datetime('now')`
      )
      .run();
    push({ step: 'intake_token_cleanup', ok: true, detail: { expired: result.changes } });
  } catch (err) {
    push({ step: 'intake_token_cleanup', ok: false, error: err.message });
  }

  // ---- Step 4: optional register refresh (only if the legacy register service is present) ----
  try {
    const mod = await import('./registerSnapshots.service.js').catch(() => null);
    if (mod?.refreshAllRegisters) {
      const detail = await mod.refreshAllRegisters({ orgId });
      push({ step: 'register_refresh', ok: true, detail });
    } else if (mod?.buildRegisterSnapshot) {
      // Fallback: at least call the read path so cached views warm up.
      mod.buildRegisterSnapshot();
      push({ step: 'register_refresh', ok: true, detail: { mode: 'warmed_cache' } });
    } else {
      push({ step: 'register_refresh', ok: true, detail: 'no register service available — skipped' });
    }
  } catch (err) {
    push({ step: 'register_refresh', ok: false, error: err.message });
  }

  // ---- Step 5: audit the tick itself ----
  const finishedAt = new Date().toISOString();
  try {
    createAuditEvent({
      actorType,
      actorId,
      eventType: 'automation_tick',
      entityType: 'automation',
      entityId: tickId,
      newValue: { steps, started_at: startedAt, finished_at: finishedAt, scoped_org_id: orgId }
    });
  } catch (e) {
    console.warn('[automation] could not audit tick:', e?.message);
  }

  return { tick_id: tickId, started_at: startedAt, finished_at: finishedAt, steps };
}

/**
 * Lightweight "today" summary for a coordinator dashboard. Composes:
 *   - open coordinator tasks for this user
 *   - participant onboardings missing intake or signatures
 *   - staff compliance docs expiring within 30 days
 *
 * @param {string} userId
 * @param {string|null} [orgId]
 */
export function getCoordinatorDailyDigest(userId, orgId = null) {
  if (!userId) throw new Error('userId required');

  /** @type {{ open_tasks: any[], expiring_documents: any[], pending_form_instances: any[] }} */
  const digest = { open_tasks: [], expiring_documents: [], pending_form_instances: [] };

  try {
    digest.open_tasks = db
      .prepare(
        `SELECT id, title, due_at, priority, status, participant_id
         FROM coordinator_tasks
         WHERE (assigned_user_id = ? OR created_by_user_id = ?)
           AND status IN ('open', 'in_progress')
         ORDER BY COALESCE(due_at, '9999-12-31') ASC
         LIMIT 50`
      )
      .all(userId, userId);
  } catch {
    /* table may not exist in legacy installs */
  }

  try {
    const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    digest.expiring_documents = db
      .prepare(
        `SELECT scd.id, scd.staff_id, s.name as staff_name, scd.document_type, scd.expiry_date
         FROM staff_compliance_documents scd
         JOIN staff s ON s.id = scd.staff_id
         WHERE scd.expiry_date IS NOT NULL
           AND scd.expiry_date <= ?
           ${orgId ? 'AND s.org_id = ?' : ''}
         ORDER BY scd.expiry_date ASC
         LIMIT 50`
      )
      .all(...(orgId ? [horizon, orgId] : [horizon]));
  } catch {
    /* ignore */
  }

  try {
    digest.pending_form_instances = db
      .prepare(
        `SELECT pfi.id, pfi.participant_id, pfi.status, pfi.due_at, ft.display_name, ft.form_type
         FROM participant_form_instances pfi
         JOIN form_templates ft ON ft.id = pfi.form_template_id
         WHERE pfi.status IN ('generated', 'sent', 'viewed')
         ORDER BY COALESCE(pfi.due_at, '9999-12-31') ASC
         LIMIT 50`
      )
      .all();
  } catch {
    /* ignore */
  }

  return digest;
}
