/**
 * Coordinator Tasks Service - support coordinator activity logging and billing.
 * Tasks: email, meeting (f2f/non-f2f), phone, etc. with evidence and optional travel.
 */
import { db } from '../db/index.js';
import { getDefaultLineItemForParticipant } from './progressNoteMatcher.js';
import { getShiftDayType } from '../lib/ndisDay.js';

/**
 * Get default support coordination line item for participant (category 07).
 * Falls back to getDefaultLineItemForParticipant if no 07 item in plan.
 */
export function getSupportCoordLineItem(participantId, activityDate) {
  const dateStr = activityDate?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const dayType = getShiftDayType(`${dateStr}T09:00:00`);

  const fromPlan = db.prepare(`
    SELECT bli.ndis_line_item_id, nli.rate, nli.rate_remote, nli.rate_very_remote, nli.unit, nli.rate_type, nli.support_item_number
    FROM plan_budgets pb
    JOIN ndis_plans np ON np.id = pb.plan_id
    JOIN budget_line_items bli ON bli.budget_id = pb.id
    JOIN ndis_line_items nli ON nli.id = bli.ndis_line_item_id
    WHERE np.participant_id = ? AND np.start_date <= ? AND np.end_date >= ?
      AND (nli.support_category = '07' OR nli.support_item_number LIKE '07_%')
    ORDER BY pb.category
    LIMIT 1
  `).get(participantId, dateStr, dateStr);

  if (fromPlan?.ndis_line_item_id) {
    const rate = fromPlan.rate_remote ?? fromPlan.rate_very_remote ?? fromPlan.rate;
    const itemRateType = fromPlan.rate_type || 'weekday';
    if (itemRateType === dayType || !fromPlan.rate_type) {
      return {
        id: fromPlan.ndis_line_item_id,
        rate: Number(rate) || 0,
        unit: fromPlan.unit || 'hour'
      };
    }
  }

  const fallback = db.prepare(`
    SELECT id, rate, rate_remote, rate_very_remote, unit, rate_type
    FROM ndis_line_items
    WHERE (support_category = '07' OR support_item_number LIKE '07_%')
      AND support_item_number NOT LIKE '07_799%'
      AND (rate_type = ? OR rate_type IS NULL OR rate_type = 'weekday')
    ORDER BY rate_type = ? DESC
    LIMIT 1
  `).get(dayType, dayType);

  if (fallback) {
    const rate = fallback.rate_remote ?? fallback.rate_very_remote ?? fallback.rate;
    return { id: fallback.id, rate: Number(rate) || 0, unit: fallback.unit || 'hour' };
  }

  const fromParticipant = getDefaultLineItemForParticipant(participantId, `${dateStr}T09:00:00`, dateStr);
  if (fromParticipant) return fromParticipant;

  const anyHourly = db.prepare('SELECT id, rate, unit FROM ndis_line_items WHERE unit = ? AND rate > 0 LIMIT 1').get('hour');
  if (anyHourly) return { id: anyHourly.id, rate: Number(anyHourly.rate) || 0, unit: 'hour' };

  return null;
}

/**
 * Round duration to billable units (interval minutes).
 * e.g. 17 min @ 15 min interval = 30 min (2 units of 0.25 hr)
 */
export function roundToBillableUnits(durationMinutes, intervalMinutes) {
  if (!intervalMinutes || intervalMinutes <= 0) return durationMinutes / 60;
  const units = Math.ceil(durationMinutes / intervalMinutes);
  return (units * intervalMinutes) / 60;
}

