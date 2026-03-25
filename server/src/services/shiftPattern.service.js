/**
 * Shift pattern learning service.
 * Records popular shift structures as shifts are created/updated,
 * so the LLM and UI can suggest structures that match the user's habits.
 *
 * LLM integration: When adding AI-powered shift features (e.g. generate from notes,
 * smart suggestions), pass getTopPatterns(participantId) into the prompt context
 * so the model can adapt to the user's typical structures.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

/**
 * Build a stable signature from line items for pattern matching.
 * Format: "ndis_id:claim_type" sorted by ndis_id.
 * @param {Array<{ndis_line_item_id: string, claim_type?: string}>} lineItems
 * @returns {string}
 */
function buildSignature(lineItems) {
  if (!lineItems || lineItems.length === 0) return '';
  const parts = lineItems
    .map((li) => `${li.ndis_line_item_id}:${li.claim_type || 'standard'}`)
    .sort();
  return parts.join(',');
}

function upsertPattern(participantId, signature, sampleLineItems, durationHours) {
  const existing = db
    .prepare(
      `SELECT id, use_count FROM shift_patterns
       WHERE participant_id IS ? AND line_item_signature = ?`
    )
    .get(participantId, signature);

  if (existing) {
    db.prepare(
      `UPDATE shift_patterns SET use_count = use_count + 1, last_used = datetime('now'), sample_line_items = ?, duration_hours = ?
       WHERE id = ?`
    ).run(sampleLineItems, durationHours, existing.id);
  } else {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO shift_patterns (id, participant_id, line_item_signature, duration_hours, use_count, sample_line_items)
       VALUES (?, ?, ?, ?, 1, ?)`
    ).run(id, participantId, signature, durationHours, sampleLineItems);
  }
}

/**
 * Record a shift's structure for learning. Call after create/update.
 * Records both participant-specific and global patterns.
 * @param {object} shift - { participant_id, line_items }
 * @param {number} durationHours - (end - start) in hours
 */
export function recordShiftPattern(shift, durationHours) {
  const lineItems = shift.line_items || [];
  if (lineItems.length === 0) return;

  const signature = buildSignature(lineItems);
  if (!signature) return;

  const sampleLineItems = JSON.stringify(
    lineItems.map((li) => ({
      ndis_line_item_id: li.ndis_line_item_id,
      quantity: parseFloat(li.quantity) || 1,
      unit_price: parseFloat(li.unit_price) || 0,
      claim_type: li.claim_type || 'standard'
    }))
  );

  const participantId = shift.participant_id || null;
  upsertPattern(participantId, signature, sampleLineItems, durationHours);
  if (participantId) {
    upsertPattern(null, signature, sampleLineItems, durationHours);
  }
}

/**
 * Get top learned patterns for a participant (or global if none).
 * Used by the LLM and UI for suggestions.
 * @param {string|null} participantId
 * @param {number} limit
 * @returns {Array<{line_items: Array, use_count: number, duration_hours: number}>}
 */
export function getTopPatterns(participantId, limit = 5) {
  let rows = [];
  if (participantId) {
    rows = db
      .prepare(
        `SELECT line_item_signature, sample_line_items, use_count, duration_hours
         FROM shift_patterns WHERE participant_id = ?
         ORDER BY use_count DESC, last_used DESC LIMIT ?`
      )
      .all(participantId, limit);
  }
  if (rows.length === 0) {
    rows = db
      .prepare(
        `SELECT line_item_signature, sample_line_items, use_count, duration_hours
         FROM shift_patterns WHERE participant_id IS NULL
         ORDER BY use_count DESC, last_used DESC LIMIT ?`
      )
      .all(limit);
  }
  return rows
    .filter((r) => r.sample_line_items)
    .map((r) => {
      let lineItems = [];
      try {
        lineItems = JSON.parse(r.sample_line_items) || [];
      } catch {
        // ignore
      }
      return {
        line_items: lineItems,
        use_count: r.use_count,
        duration_hours: r.duration_hours
      };
    });
}
