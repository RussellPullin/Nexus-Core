import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { sendICSByEmail, isEmailConfiguredForUser, sendOpenShiftAvailableEmail, sendOpenShiftFilledEmail } from '../services/notification.service.js';
import { generateICS, generateICSForMultipleShifts } from '../services/calendar.service.js';
import { recordEvent } from '../services/learningEvent.service.js';
import { updateAggregatesForShift } from '../services/featureStore.service.js';
import { pullShiftsFromExcel } from '../services/excelPull.service.js';
import { getEffectiveOrgTzSpecForUser } from '../lib/orgShiftTimezone.js';
import {
  scheduleMirrorShiftToNexusSupabase,
} from '../services/nexusPublicShiftsSync.service.js';
import { syncCaseNoteFromShift } from '../services/shiftCaseNoteSync.service.js';
import {
  recalculateShiftLineItemsFromShift,
  markShiftLineItemsManuallyEdited,
  syncShiftLineItemsLockedAfterDelete,
} from '../services/shiftLineItems.service.js';
import { getProviderOrgIdForUser, requireAdminOrDelegate } from '../middleware/roles.js';
import {
  isParticipantInRequesterTenant,
  isShiftInRequesterTenant,
  tenantParticipantAndStaffClause,
} from '../lib/orgScopeSql.js';
import { getEffectiveNdisRate } from '../lib/ndisRates.js';
import { recordSuppressedShifterShiftId } from '../services/shiftImportSuppression.service.js';
import { hardDeleteShiftRow } from '../services/shiftHardDelete.service.js';
import {
  cleanupAllDuplicateShifts,
  filterSupersededScheduledShifts,
} from '../services/shiftDuplicateCleanup.service.js';
import { findOverlappingSameVisitShift, findShiftBySameSlot, normalizeShiftDateTimePrefix } from '../services/progressNoteMatcher.js';
import { SHIFT_INVOICE_RESOLVE_SQL, findInvalidShiftInvoiceLinks, repairInvalidShiftInvoiceLinks, shiftImportIdentityMatches } from '../services/shiftInvoiceLink.service.js';

const router = Router();

const STAFF_JOIN = 'LEFT JOIN staff st ON s.staff_id = st.id';

function isOpenShiftRow(shift) {
  return shift?.status === 'open' || !shift?.staff_id;
}

async function notifyOpenShiftFilledRecipients(shiftId, assignedStaffId, userId) {
  const recipients = db.prepare(`
    SELECT osr.staff_id, st.name, st.email, st.notify_email
    FROM open_shift_recipients osr
    JOIN staff st ON st.id = osr.staff_id
    WHERE osr.shift_id = ? AND osr.staff_id != ?
  `).all(shiftId, assignedStaffId);
  if (!recipients.length) return;
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  const assigned = db.prepare('SELECT name FROM staff WHERE id = ?').get(assignedStaffId);
  const assignedName = assigned?.name || '';
  for (const r of recipients) {
    try {
      await sendOpenShiftFilledEmail(shift, r, assignedName, userId);
    } catch (err) {
      console.warn('[open-shift] filled notification failed for', r.email, err?.message);
    }
  }
}

function isEnvTruthyTrue(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * SQLite often returns "YYYY-MM-DD HH:MM:SS" while clients send ISO "YYYY-MM-DDTHH:MM:SS".
 * String comparison treats space before "T" at position 10, so shifts on the range start day
 * incorrectly fail `>= start` when compared in JS.
 */
function normalizeShiftTimeForCompare(t) {
  if (t == null) return '';
  return String(t).replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
}

/** Financial batch (valid link only) or legacy one-row-per-shift `invoices` table. */
const SHIFT_INVOICE_RESOLVE = SHIFT_INVOICE_RESOLVE_SQL;

/** Shift row for API (incl. Financial + legacy resolved invoice), or undefined if not in tenant. */
function getShiftByIdForUser(shiftId, userId) {
  const c = tenantParticipantAndStaffClause(userId, 'p', 'st');
  if (!c.orgId) return null;
  return db
    .prepare(
      `
      SELECT s.*, p.name as participant_name, p.ndis_number, p.email as participant_email,
             p.provider_org_id as participant_provider_org_id,
             p.default_ndis_line_item_id as participant_default_ndis_line_item_id,
             p.remoteness as participant_remoteness,
             st.name as staff_name, st.email as staff_email, st.phone as staff_phone,
             ${SHIFT_INVOICE_RESOLVE}
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      ${STAFF_JOIN}
      LEFT JOIN billing_invoices bi_inv ON bi_inv.id = s.billing_invoice_id
      WHERE s.id = ? AND (${c.sql})
    `
    )
    .get(shiftId, ...c.params);
}

router.get('/', (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const c = tenantParticipantAndStaffClause(userId, 'p', 'st');
    if (!c.orgId) {
      return res.json([]);
    }
    const { start, end, participant_id, staff_id, recurring_group_id } = req.query;
    let shifts = db.prepare(`
      SELECT s.*, p.name as participant_name, p.ndis_number, st.name as staff_name, st.email as staff_email, st.phone as staff_phone, st.notify_email, st.notify_sms,
        COALESCE((
          SELECT SUM(sli.quantity * sli.unit_price)
          FROM shift_line_items sli
          WHERE sli.shift_id = s.id
        ), 0) AS charges_total,
        ${SHIFT_INVOICE_RESOLVE}
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      ${STAFF_JOIN}
      LEFT JOIN billing_invoices bi_inv ON bi_inv.id = s.billing_invoice_id
      WHERE (${c.sql})
      ORDER BY s.start_time
    `).all(...c.params);

    if (start) {
      shifts = shifts.filter((s) => normalizeShiftTimeForCompare(s.start_time) >= start);
    }
    if (end) {
      shifts = shifts.filter((s) => normalizeShiftTimeForCompare(s.start_time) <= end);
    }
    if (participant_id) {
      shifts = shifts.filter(s => s.participant_id === participant_id);
    }
    if (staff_id) {
      shifts = shifts.filter(s => s.staff_id === staff_id);
    }
    if (recurring_group_id) {
      shifts = shifts.filter(s => s.recurring_group_id === recurring_group_id);
    }

    // When a worker completes a shift, Shifter often creates a new completed row instead of
    // updating the roster placeholder. Hide the empty scheduled copy once a completed shift
    // exists for the same client on the same date with a close start time.
    shifts = filterSupersededScheduledShifts(shifts);

    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-roster', async (req, res) => {
  try {
    const { start, end } = req.body;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required (YYYY-MM-DD)' });
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not logged in', errorDetail: 'Please log in again.' });
    }
    const c = tenantParticipantAndStaffClause(userId, 'p', 'st');
    if (!c.orgId) {
      return res.status(400).json({ error: 'No organisation on your account.' });
    }
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send rosters.',
        code: 'EMAIL_NOT_CONNECTED',
        errorDetail: 'Open Settings and use Connect email (Gmail or Microsoft 365).'
      });
    }
    console.log('[send-roster] userId:', userId);
    const shifts = db.prepare(`
      SELECT s.*, p.name as participant_name, st.name as staff_name, st.email as staff_email
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      ${STAFF_JOIN}
      WHERE (${c.sql})
        AND s.staff_id IS NOT NULL
        AND s.status != 'open'
        AND s.start_time >= ? AND s.start_time <= ? AND s.roster_sent_at IS NULL
      ORDER BY st.id, s.start_time
    `).all(...c.params, `${start}T00:00:00`, `${end}T23:59:59`);
    const byStaff = {};
    for (const s of shifts) {
      if (!s.staff_id) continue;
      if (!byStaff[s.staff_id]) byStaff[s.staff_id] = { staff: { name: s.staff_name, email: s.staff_email }, shifts: [] };
      byStaff[s.staff_id].shifts.push(s);
    }
    if (Object.keys(byStaff).length === 0) {
      const anyShifts = db.prepare(`
        SELECT 1 FROM shifts s
        JOIN participants p ON s.participant_id = p.id
        ${STAFF_JOIN}
        WHERE (${c.sql})
          AND s.staff_id IS NOT NULL
          AND s.status != 'open'
          AND s.start_time >= ? AND s.start_time <= ?
      `).get(...c.params, `${start}T00:00:00`, `${end}T23:59:59`);
      return res.status(400).json({
        error: anyShifts ? 'No unsent shifts in this date range.' : 'No staff with shifts in this date range.',
        errorDetail: anyShifts ? 'All shifts have already been sent. Move or edit a shift to send again.' : ''
      });
    }
    const results = { sent: 0, skipped: 0, errors: [] };
    const weekLabel = `${new Date(start).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} – ${new Date(end).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const safeFilename = `roster-${start}-to-${end}.ics`;
    const tzSpec = await getEffectiveOrgTzSpecForUser(userId);
    for (const staffId of Object.keys(byStaff)) {
      const { staff: st, shifts: staffShifts } = byStaff[staffId];
      if (!st.email) {
        results.skipped++;
        results.errors.push(`${st.name}: no email`);
        continue;
      }
      try {
        const ics = generateICSForMultipleShifts(staffShifts, { tzSpec });
        await sendICSByEmail(st.email, `Your roster – ${weekLabel}`, ics, safeFilename, staffShifts, userId);
        for (const sh of staffShifts) {
          db.prepare('UPDATE shifts SET roster_sent_at = datetime(\'now\') WHERE id = ?').run(sh.id);
          scheduleMirrorShiftToNexusSupabase(sh.id);
        }
        results.sent++;
        console.log('[send-roster] sent to', st.email);
      } catch (err) {
        console.error('[send-roster] failed for', st.email, ':', err.message);
        results.errors.push(`${st.name}: ${err.message}`);
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /shifts/duplicates - find shifts that look like duplicates (for cleanup).
 * Query: staff_id (optional) - limit to one staff.
 * Primary: bySameSlot = same participant name + staff name + date + time. Secondary: byShifterId = same import ID.
 * Returns: { bySameSlot: [...], byShifterId: [...], summary } with 2+ shifts per group.
 */
router.get('/duplicates', (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const c = tenantParticipantAndStaffClause(userId, 'p', 'st');
    if (!c.orgId) {
      return res.json({ bySameSlot: [], byShifterId: [], summary: { duplicateGroupsBySameSlot: 0, duplicateGroupsByShifterId: 0, totalDuplicateShifts: 0 } });
    }
    const { staff_id } = req.query;
    const tenantWhere = `WHERE (${c.sql})`;
    const baseSql = `
      SELECT s.id, s.participant_id, s.staff_id, s.start_time, s.end_time, s.shifter_shift_id, s.status,
             p.name as participant_name, st.name as staff_name
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      ${STAFF_JOIN}
      ${tenantWhere}
    `;
    const staffFilter = staff_id ? ' AND s.staff_id = ?' : '';
    const baseParams = [...c.params];
    const params = staff_id ? [...baseParams, staff_id] : baseParams;

    // 1) Same shifter_shift_id in more than one row (imported twice)
    const duplicateShifterIds = db
      .prepare(
        `
      SELECT s.shifter_shift_id FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      ${STAFF_JOIN}
      WHERE (${c.sql}) AND s.shifter_shift_id IS NOT NULL AND TRIM(s.shifter_shift_id) != ''
      GROUP BY s.shifter_shift_id HAVING COUNT(*) > 1
    `
      )
      .all(...c.params)
      .map((r) => r.shifter_shift_id);
    const byShifterIdRows =
      duplicateShifterIds.length === 0
        ? []
        : db
            .prepare(
              `
      SELECT s.id, s.participant_id, s.staff_id, s.start_time, s.end_time, s.shifter_shift_id, s.status,
             p.name as participant_name, st.name as staff_name
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      ${STAFF_JOIN}
      WHERE (${c.sql}) AND s.shifter_shift_id IN (${duplicateShifterIds.map(() => '?').join(',')})
      ${staff_id ? ' AND s.staff_id = ?' : ''}
      ORDER BY s.shifter_shift_id, s.start_time
    `
            )
            .all(
              ...(staff_id ? [...c.params, ...duplicateShifterIds, staff_id] : [...c.params, ...duplicateShifterIds])
            );

    const byShifterId = [];
    const seen = new Set();
    for (const row of byShifterIdRows) {
      const key = (row.shifter_shift_id || '').trim();
      if (!key || seen.has(key)) continue;
      const group = byShifterIdRows.filter((r) => (r.shifter_shift_id || '').trim() === key);
      if (group.length > 1) {
        seen.add(key);
        byShifterId.push({ shifter_shift_id: key, shifts: group });
      }
    }

    // 2) Same participant name + staff name + date + time (primary duplicate check)
    const allShifts = db.prepare(`
      ${baseSql}
      ${staffFilter}
      ORDER BY p.name, st.name, s.start_time
    `).all(...params);

    const normalize = (str) => (str || '').trim().toLowerCase();
    const slotKey = (s) =>
      `${normalize(s.participant_name)}|${normalize(s.staff_name)}|${normalizeShiftDateTimePrefix(s.start_time)}`;
    const bySlot = {};
    for (const s of allShifts) {
      const key = slotKey(s);
      if (!bySlot[key]) bySlot[key] = [];
      bySlot[key].push(s);
    }
    const bySameSlot = Object.values(bySlot).filter((arr) => arr.length > 1);

    res.json({
      bySameSlot,
      byShifterId,
      summary: {
        duplicateGroupsBySameSlot: bySameSlot.length,
        duplicateGroupsByShifterId: byShifterId.length,
        totalDuplicateShifts: bySameSlot.reduce((n, g) => n + (Array.isArray(g) ? g.length : 0), 0) + byShifterId.reduce((n, g) => n + (g.shifts?.length ?? 0), 0)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/shifts/suppress-shifter-id
 * Block a Progress/Excel "shiftId" from being re-imported after it was removed from Nexus.
 * Use when the shift row is already gone but Pull from Excel keeps recreating it.
 * Body: { shifter_shift_id, nexus_org_id? } — org defaults to signed-in user's org.
 */
router.post('/suppress-shifter-id', requireAdminOrDelegate, (req, res) => {
  try {
    const shifterShiftId = String(req.body?.shifter_shift_id || '').trim();
    if (!shifterShiftId) {
      return res.status(400).json({ error: 'shifter_shift_id is required' });
    }
    const bodyOrg = String(req.body?.nexus_org_id || '').trim();
    const sessionOrg = getProviderOrgIdForUser(req.session?.user?.id);
    const nexusOrgId = bodyOrg || sessionOrg;
    if (!nexusOrgId) {
      return res.status(400).json({ error: 'nexus_org_id is required (or sign in with an org-scoped user)' });
    }
    const r = recordSuppressedShifterShiftId(nexusOrgId, shifterShiftId, 'manual_suppress');
    if (!r.ok) {
      return res.status(500).json({ error: r.error || 'Failed to record suppression' });
    }
    return res.json({ ok: true, nexus_org_id: nexusOrgId, shifter_shift_id: shifterShiftId });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * Find shifts showing a stale/wrong invoice link (e.g. after Shifter re-import reused a billed row).
 * GET /api/shifts/invalid-invoice-links
 */
router.get('/invalid-invoice-links', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = getProviderOrgIdForUser(req.session?.user?.id) || null;
    const items = findInvalidShiftInvoiceLinks({ orgId });
    return res.json({ count: items.length, items });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Clear billing_invoice_id on shifts whose invoice link is invalid (wrong participant, date, etc.).
 * POST /api/shifts/repair-invoice-links
 */
router.post('/repair-invoice-links', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = getProviderOrgIdForUser(req.session?.user?.id) || null;
    const result = repairInvalidShiftInvoiceLinks({
      orgId,
      log: (msg, data) => console.log('[shifts repair-invoice-links]', msg, data || ''),
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const shift = getShiftByIdForUser(req.params.id, userId);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/refresh-expense', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const shift = getShiftByIdForUser(req.params.id, userId);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (!shift.shifter_shift_id) {
      return res.json(shift);
    }
    const orgId = req.session?.user?.org_id || null;
    const { shifts } = await pullShiftsFromExcel({
      organizationId: orgId || undefined,
      automationAllowServerLlm: false
    }).catch(() => ({
      shifts: [],
    }));
    const excelShift = (shifts || []).find(
      (s) => String(s.shiftId || '').trim() === String(shift.shifter_shift_id).trim()
    );
    if (excelShift && (parseFloat(excelShift.expenses) || 0) > 0) {
      const expensesVal = parseFloat(excelShift.expenses) || 0;
      db.prepare('UPDATE shifts SET expenses = ?, updated_at = datetime(\'now\') WHERE id = ?').run(expensesVal, req.params.id);
      const updated = getShiftByIdForUser(req.params.id, userId);
      return res.json(updated || shift);
    }
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/receipts', (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!isShiftInRequesterTenant(req.params.id, userId)) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = db.prepare('SELECT participant_id, shifter_shift_id FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    const docCols = db.prepare("PRAGMA table_info(participant_documents)").all();
    const hasShiftId = docCols.some((c) => c.name === 'shift_id');
    if (!hasShiftId || !shift.shifter_shift_id) {
      return res.json([]);
    }
    const hasReceiptDesc = docCols.some((c) => c.name === 'receipt_description');
    const receipts = db.prepare(`
      SELECT id, filename, ${hasReceiptDesc ? 'receipt_description, ' : ''}created_at
      FROM participant_documents
      WHERE participant_id = ? AND shift_id = ? AND category = 'Expense Receipt'
      ORDER BY created_at DESC
    `).all(shift.participant_id, shift.shifter_shift_id);
    res.json(receipts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NO emails on create – only via "Send roster" or "Send to staff" button
router.post('/', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const orgId = getProviderOrgIdForUser(userId);
    if (!orgId) {
      return res.status(403).json({ error: 'No organisation on your account.' });
    }
    const { participant_id, staff_id, start_time, end_time, notes, recurring_group_id, status: bodyStatus } = req.body;
    if (!isParticipantInRequesterTenant(participant_id, userId)) {
      return res.status(404).json({ error: 'Participant not found' });
    }
    const isOpen = bodyStatus === 'open' || !staff_id;
    let resolvedStaffId = staff_id || null;
    let shiftStatus = isOpen ? 'open' : 'scheduled';
    if (!isOpen) {
      const staffRow = db.prepare('SELECT id FROM staff WHERE id = ? AND org_id = ?').get(staff_id, orgId);
      if (!staffRow) {
        return res.status(404).json({ error: 'Staff not found' });
      }
    } else {
      resolvedStaffId = null;
    }

    if (!isOpen && resolvedStaffId && start_time && end_time) {
      const existingSlot = findShiftBySameSlot(participant_id, resolvedStaffId, start_time, end_time)
        || findOverlappingSameVisitShift(participant_id, resolvedStaffId, start_time, end_time);
      if (existingSlot) {
        const shift = getShiftByIdForUser(existingSlot.id, userId);
        return res.status(200).json(shift || existingSlot);
      }
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO shifts (id, participant_id, staff_id, start_time, end_time, notes, status, recurring_group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, participant_id, resolvedStaffId, start_time, end_time, notes || null, shiftStatus, recurring_group_id || null);

    const shift = getShiftByIdForUser(id, userId);

    if (!isOpen && resolvedStaffId) {
      try {
        recordEvent({
          event_type: 'shift_created',
          participant_id, staff_id: resolvedStaffId, shift_id: id,
          date: start_time, start_time, end_time
        });
        updateAggregatesForShift({
          participant_id, staff_id: resolvedStaffId,
          day_of_week: new Date(start_time).getDay(),
          time_bucket: null, start_time, end_time,
          shift_type: 'standard', line_items: []
        });
      } catch (e) { console.warn('[shifts] learning event error:', e.message); }
      scheduleMirrorShiftToNexusSupabase(id);
    }
    res.status(201).json(shift || { id, participant_id, staff_id: resolvedStaffId, start_time, end_time, notes, status: shiftStatus, recurring_group_id: recurring_group_id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NO emails on update/move – only via "Send roster" or "Send to staff" button
router.put('/:id', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const orgId = getProviderOrgIdForUser(userId);
    if (!orgId) {
      return res.status(403).json({ error: 'No organisation on your account.' });
    }
    if (!isShiftInRequesterTenant(req.params.id, userId)) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    const { participant_id, staff_id, start_time, end_time, status, notes, recurring_group_id } = req.body;
    const existing = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Shift not found' });

    const wasOpen = isOpenShiftRow(existing);
    const nextParticipantId = participant_id ?? existing.participant_id;
    const nextStaffId = staff_id !== undefined ? (staff_id || null) : existing.staff_id;
    if (!isParticipantInRequesterTenant(nextParticipantId, userId)) {
      return res.status(404).json({ error: 'Participant not found' });
    }
    if (nextStaffId) {
      const staffRow = db.prepare('SELECT id FROM staff WHERE id = ? AND org_id = ?').get(nextStaffId, orgId);
      if (!staffRow) {
        return res.status(404).json({ error: 'Staff not found' });
      }
    }

    let nextStatus = status ?? existing.status;
    if (nextStaffId && wasOpen) {
      nextStatus = 'scheduled';
    } else if (!nextStaffId) {
      nextStatus = 'open';
    } else if (!nextStatus || nextStatus === 'open') {
      nextStatus = nextStaffId ? 'scheduled' : 'open';
    }

    const rgId = recurring_group_id !== undefined ? recurring_group_id : existing.recurring_group_id;
    const assigningFromOpen = wasOpen && nextStaffId && nextStaffId !== existing.staff_id;
    const nextStart = start_time ?? existing.start_time;
    const nextEnd = end_time ?? existing.end_time;
    const clearBilling =
      existing.billing_invoice_id &&
      !shiftImportIdentityMatches(existing, {
        participantId: nextParticipantId,
        staffId: nextStaffId,
        startDateTime: nextStart,
      });

    db.prepare(`
      UPDATE shifts SET
        participant_id = ?, staff_id = ?, start_time = ?, end_time = ?, status = ?, notes = ?,
        recurring_group_id = ?,
        billing_invoice_id = CASE WHEN ? THEN NULL ELSE billing_invoice_id END,
        updated_at = datetime('now'),
        roster_sent_at = NULL
      WHERE id = ?
    `).run(
      nextParticipantId,
      nextStaffId,
      nextStart,
      nextEnd,
      nextStatus,
      notes ?? existing.notes,
      rgId,
      clearBilling ? 1 : 0,
      req.params.id
    );

    try {
      recalculateShiftLineItemsFromShift(req.params.id);
    } catch (e) {
      console.warn('[shifts] recalculateShiftLineItemsFromShift', e?.message || e);
    }

    const shift = getShiftByIdForUser(req.params.id, userId);
    // Invoicing is done via batch (Financial > Batch invoices); no per-shift invoice creation.

    if (nextStaffId) {
      try {
        const changedFields = {};
        if (start_time && start_time !== existing.start_time) changedFields.start_time = { old: existing.start_time, new: start_time };
        if (end_time && end_time !== existing.end_time) changedFields.end_time = { old: existing.end_time, new: end_time };
        if (participant_id && participant_id !== existing.participant_id) changedFields.participant_id = { old: existing.participant_id, new: participant_id };
        if (staff_id && staff_id !== existing.staff_id) changedFields.staff_id = { old: existing.staff_id, new: staff_id };

        for (const [field, vals] of Object.entries(changedFields)) {
          recordEvent({
            event_type: 'shift_edited',
            participant_id: shift.participant_id, staff_id: shift.staff_id, shift_id: shift.id,
            date: shift.start_time, start_time: shift.start_time, end_time: shift.end_time,
            field_name: field, old_value: vals.old, new_value: vals.new
          });
        }
        updateAggregatesForShift({
          participant_id: shift.participant_id, staff_id: shift.staff_id,
          day_of_week: new Date(shift.start_time).getDay(),
          start_time: shift.start_time, end_time: shift.end_time,
          shift_type: 'standard', line_items: []
        });
      } catch (e) { console.warn('[shifts] learning event error:', e.message); }
    }

    if (assigningFromOpen) {
      try {
        await notifyOpenShiftFilledRecipients(req.params.id, nextStaffId, userId);
      } catch (e) {
        console.warn('[open-shift] filled notifications error:', e?.message);
      }
    }

    if (nextStaffId && !wasOpen) {
      scheduleMirrorShiftToNexusSupabase(req.params.id);
    } else if (assigningFromOpen) {
      scheduleMirrorShiftToNexusSupabase(req.params.id);
    }
    syncCaseNoteFromShift(req.params.id);
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  // Shift deletion is intentionally disabled to avoid data loss.
  // Use status updates (e.g. cancel) instead so the shift remains auditable.
  const id = req.params.id;
  if (!isShiftInRequesterTenant(id, req.session?.user?.id)) {
    return res.status(404).json({ error: 'Shift not found' });
  }
  return res.status(405).json({
    error: 'Shift deletion is disabled.',
    errorDetail: 'Cancel the shift instead (keeps history).',
    code: 'SHIFT_DELETE_DISABLED',
  });
});

/**
 * Hard-delete a shift and its dependent rows.
 * Admin/delegate only, explicit confirmation, and opt-in via env flag.
 *
 * POST /api/shifts/:id/hard-delete
 * Body: { confirm: 'DELETE' }
 */
router.post('/:id/hard-delete', requireAdminOrDelegate, (req, res) => {
  const id = req.params.id;
  if (!isShiftInRequesterTenant(id, req.session?.user?.id)) {
    return res.status(404).json({ error: 'Shift not found' });
  }
  if (!isEnvTruthyTrue(process.env.ALLOW_SHIFT_HARD_DELETE)) {
    return res.status(403).json({
      error: 'Hard delete is disabled on this server.',
      errorDetail: 'Set ALLOW_SHIFT_HARD_DELETE to true, 1, or yes, then restart the API.',
      code: 'SHIFT_HARD_DELETE_DISABLED',
    });
  }
  const confirm = String(req.body?.confirm || '').trim().toUpperCase();
  if (confirm !== 'DELETE') {
    return res.status(400).json({
      error: 'Confirmation required.',
      errorDetail: 'Pass JSON body {"confirm":"DELETE"} to hard-delete this shift.',
      code: 'SHIFT_HARD_DELETE_CONFIRM_REQUIRED',
    });
  }

  const nexusOrgId = getProviderOrgIdForUser(req.session?.user?.id) || null;
  const result = hardDeleteShiftRow(id, { suppressShifterId: true, nexusOrgId, reason: 'hard_delete' });
  if (!result.deleted) {
    return res.status(404).json({ error: 'Shift not found' });
  }
  return res.json({ ok: true, deleted: true, id });
});

/**
 * Remove empty, past-date duplicate shifts for the requester's org.
 * Deletes a no-notes / $0 shift only when a noted shift exists for the same participant + worker at
 * an overlapping time and the shift is unbilled. Admin/delegate only.
 *
 * POST /api/shifts/cleanup-duplicates
 */
router.post('/cleanup-duplicates', requireAdminOrDelegate, (req, res) => {
  try {
    const orgId = getProviderOrgIdForUser(req.session?.user?.id) || null;
    const result = cleanupAllDuplicateShifts({
      orgId,
      log: (msg, data) => console.log('[shifts cleanup-duplicates]', msg, data || ''),
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Shift line items (charges)
router.get('/:id/line-items', (req, res) => {
  try {
    if (!isShiftInRequesterTenant(req.params.id, req.session?.user?.id)) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = db.prepare('SELECT id FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    const items = db.prepare(`
      SELECT sli.*, nli.support_item_number, nli.description, nli.unit, nli.rate_type
      FROM shift_line_items sli
      JOIN ndis_line_items nli ON sli.ndis_line_item_id = nli.id
      WHERE sli.shift_id = ?
      ORDER BY sli.id
    `).all(req.params.id);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/line-items', (req, res) => {
  try {
    if (!isShiftInRequesterTenant(req.params.id, req.session?.user?.id)) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = db.prepare(`
      SELECT s.id, s.participant_id, s.start_time, p.remoteness as participant_remoteness
      FROM shifts s
      JOIN participants p ON p.id = s.participant_id
      WHERE s.id = ?
    `).get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    const { ndis_line_item_id, quantity, unit_price, claim_type } = req.body;
    if (!ndis_line_item_id) return res.status(400).json({ error: 'ndis_line_item_id is required' });
    const ndis = db.prepare('SELECT id, rate, rate_remote, rate_very_remote FROM ndis_line_items WHERE id = ?').get(ndis_line_item_id);
    if (!ndis) return res.status(400).json({ error: 'NDIS line item not found' });
    const remoteness = shift.participant_remoteness || 'standard';
    const effectiveRate = getEffectiveNdisRate(ndis, remoteness);
    const isQuotable = (effectiveRate == null || Number(effectiveRate) === 0);
    if (isQuotable && (unit_price == null || unit_price === '')) {
      return res.status(400).json({ error: 'This is a quotable support (no set price). Please enter the agreed unit price.' });
    }
    const price = unit_price != null && unit_price !== '' ? parseFloat(unit_price) : effectiveRate;
    const qty = parseFloat(quantity) || 0;
    if (qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0' });
    const id = uuidv4();
    db.prepare(`
      INSERT INTO shift_line_items (id, shift_id, ndis_line_item_id, quantity, unit_price, claim_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, ndis_line_item_id, qty, price, claim_type || 'standard');
    markShiftLineItemsManuallyEdited(req.params.id);
    const item = db.prepare(`
      SELECT sli.*, nli.support_item_number, nli.description, nli.unit
      FROM shift_line_items sli
      JOIN ndis_line_items nli ON sli.ndis_line_item_id = nli.id
      WHERE sli.id = ?
    `).get(id);

    try {
      recordEvent({
        event_type: 'line_item_selected',
        participant_id: shift.participant_id, shift_id: shift.id,
        date: shift.start_time, start_time: shift.start_time,
        field_name: 'ndis_line_item_id', new_value: ndis_line_item_id,
        metadata: { quantity: qty, unit_price: price, claim_type: claim_type || 'standard' }
      });
      updateAggregatesForShift({
        participant_id: shift.participant_id,
        day_of_week: new Date(shift.start_time).getDay(),
        start_time: shift.start_time,
        shift_type: 'standard',
        line_items: [{ ndis_line_item_id }]
      });
    } catch (e) { console.warn('[shifts] learning event error:', e.message); }

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/line-items/:lineItemId', (req, res) => {
  try {
    if (!isShiftInRequesterTenant(req.params.id, req.session?.user?.id)) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    const existing = db.prepare(`
      SELECT sli.* FROM shift_line_items sli
      WHERE sli.id = ? AND sli.shift_id = ?
    `).get(req.params.lineItemId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Line item not found' });
    const { quantity, unit_price, claim_type } = req.body;
    const qty = quantity != null ? parseFloat(quantity) : existing.quantity;
    const price = unit_price != null ? parseFloat(unit_price) : existing.unit_price;
    if (qty < 0) return res.status(400).json({ error: 'Quantity cannot be negative' });
    db.prepare(`
      UPDATE shift_line_items SET quantity = ?, unit_price = ?, claim_type = ?
      WHERE id = ?
    `).run(qty, price, claim_type ?? existing.claim_type, req.params.lineItemId);
    markShiftLineItemsManuallyEdited(req.params.id);
    const item = db.prepare(`
      SELECT sli.*, nli.support_item_number, nli.description, nli.unit
      FROM shift_line_items sli
      JOIN ndis_line_items nli ON sli.ndis_line_item_id = nli.id
      WHERE sli.id = ?
    `).get(req.params.lineItemId);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/line-items/:lineItemId', (req, res) => {
  if (!isShiftInRequesterTenant(req.params.id, req.session?.user?.id)) {
    return res.status(404).json({ error: 'Shift not found' });
  }
  const result = db.prepare(`
    DELETE FROM shift_line_items WHERE id = ? AND shift_id = ?
  `).run(req.params.lineItemId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Line item not found' });
  syncShiftLineItemsLockedAfterDelete(req.params.id);
  res.status(204).send();
});

router.get('/:id/ics', (req, res) => {
  const userId = req.session?.user?.id;
  const c = tenantParticipantAndStaffClause(userId, 'p', 'st');
  if (!c.orgId) return res.status(404).json({ error: 'Shift not found' });
  const shift = db.prepare(`
    SELECT s.*, p.name as participant_name, st.name as staff_name
    FROM shifts s
    JOIN participants p ON s.participant_id = p.id
    ${STAFF_JOIN}
    WHERE s.id = ? AND (${c.sql})
  `).get(req.params.id, ...c.params);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (isOpenShiftRow(shift)) return res.status(400).json({ error: 'Open shifts cannot be exported until a worker is assigned.' });
  (async () => {
    const tzSpec = await getEffectiveOrgTzSpecForUser(userId);
    const ics = generateICS(shift, shift.participant_name, shift.staff_name, { tzSpec });
    res.setHeader('Content-Type', 'text/calendar');
    res.setHeader('Content-Disposition', `attachment; filename="shift-${req.params.id}.ics"`);
    res.send(ics);
  })().catch((err) => res.status(500).json({ error: err.message }));
});

router.post('/:id/broadcast-open', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const orgId = getProviderOrgIdForUser(userId);
    if (!orgId) {
      return res.status(403).json({ error: 'No organisation on your account.' });
    }
    if (!isShiftInRequesterTenant(req.params.id, userId)) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send shift notifications.',
        code: 'EMAIL_NOT_CONNECTED',
      });
    }
    const shift = getShiftByIdForUser(req.params.id, userId);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (!isOpenShiftRow(shift)) {
      return res.status(400).json({ error: 'This shift already has a worker assigned.' });
    }

    const org = db.prepare('SELECT phone, name FROM organisations WHERE id = ?').get(orgId);
    const adminPhone = org?.phone?.trim() || '';

    const staffMembers = db.prepare(`
      SELECT id, name, email, notify_email
      FROM staff
      WHERE org_id = ?
        AND (archived_at IS NULL OR archived_at = '')
        AND email IS NOT NULL AND TRIM(email) != ''
    `).all(orgId);

    const results = { sent: 0, skipped: 0, errors: [] };
    for (const st of staffMembers) {
      if (!st.notify_email) {
        results.skipped++;
        continue;
      }
      try {
        await sendOpenShiftAvailableEmail(shift, st, adminPhone, userId);
        db.prepare(`
          INSERT INTO open_shift_recipients (shift_id, staff_id, notified_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(shift_id, staff_id) DO UPDATE SET notified_at = datetime('now')
        `).run(shift.id, st.id);
        results.sent++;
      } catch (err) {
        results.errors.push(`${st.name}: ${err.message}`);
      }
    }

    db.prepare(`UPDATE shifts SET open_shift_broadcast_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(shift.id);

    if (results.sent === 0 && results.errors.length > 0) {
      return res.status(400).json({
        error: 'Could not send to any staff.',
        ...results,
      });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/send-ics', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const c = tenantParticipantAndStaffClause(userId, 'p', 'st');
    if (!c.orgId) return res.status(404).json({ error: 'Shift not found' });
    const shift = db.prepare(`
      SELECT s.*, p.name as participant_name, st.name as staff_name, st.email as staff_email
      FROM shifts s
      JOIN participants p ON s.participant_id = p.id
      ${STAFF_JOIN}
      WHERE s.id = ? AND (${c.sql})
    `).get(req.params.id, ...c.params);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (isOpenShiftRow(shift)) {
      return res.status(400).json({ error: 'Assign a worker before sending this shift.' });
    }
    if (!shift.staff_email) return res.status(400).json({ error: 'Staff member has no email address' });
    if (shift.roster_sent_at) {
      return res.status(400).json({
        error: 'Shift already sent',
        errorDetail: 'This shift has already been sent. Move or edit the shift to send again.'
      });
    }
    if (!isEmailConfiguredForUser(userId)) {
      return res.status(400).json({
        error: 'Connect your email in Settings to send rosters.',
        code: 'EMAIL_NOT_CONNECTED',
        errorDetail: 'Open Settings and use Connect email.'
      });
    }
    const tzSpec = await getEffectiveOrgTzSpecForUser(userId);
    const ics = generateICS(shift, shift.participant_name, shift.staff_name, { tzSpec });
    const dateStr = new Date(shift.start_time).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    await sendICSByEmail(shift.staff_email, `Your shift – ${dateStr}`, ics, `shift-${req.params.id}.ics`, [shift], userId);
    db.prepare('UPDATE shifts SET roster_sent_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
    scheduleMirrorShiftToNexusSupabase(req.params.id);
    res.json({ sent: true, to: shift.staff_email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
