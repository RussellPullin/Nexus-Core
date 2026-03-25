/**
 * Smart defaults API – returns learned preferences for personalisation.
 * Used by the frontend to pre-fill forms (shifts, budgets) based on usage patterns.
 */

import { Router } from 'express';
import { getLearnedPreferences } from '../services/preferenceLearning.service.js';
import { getTopPatterns } from '../services/shiftPattern.service.js';
import { db } from '../db/index.js';

const router = Router();

/**
 * GET /api/smart-defaults
 * Returns learned preferences for the whole organisation.
 */
router.get('/', (req, res) => {
  try {
    const prefs = getLearnedPreferences();
    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/smart-defaults/shift-suggestions
 * Returns shift line item suggestions for a participant (or global).
 * Combines shift patterns with learned preferences.
 */
router.get('/shift-suggestions', (req, res) => {
  try {
    const { participant_id } = req.query;
    const patterns = getTopPatterns(participant_id || null, 5);
    const prefs = getLearnedPreferences();

    const suggestions = {
      patterns,
      preferred_line_item_ids: prefs.top_line_items?.slice(0, 10).map(li => li.id) || [],
      pricing_tier: prefs.pricing_tier,
      support_coordinator_level: prefs.support_coordinator_level
    };

    res.json(suggestions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/smart-defaults/budget-line-items/:category
 * Returns suggested line items for a budget category based on learned usage.
 */
router.get('/budget-line-items/:category', (req, res) => {
  try {
    const { category } = req.params;
    const prefs = getLearnedPreferences();

    const byCategory = prefs.budget_line_items_by_category?.[category] || prefs.top_line_items_by_category?.[category] || [];
    const lineItemIds = byCategory.map(li => li.id).filter(Boolean);

    if (lineItemIds.length === 0) {
      return res.json({ suggested_ids: [], items: [] });
    }

    const placeholders = lineItemIds.map(() => '?').join(',');
    const items = db.prepare(`
      SELECT id, support_item_number, description, rate, rate_remote, rate_very_remote, unit, support_category
      FROM ndis_line_items WHERE id IN (${placeholders})
    `).all(...lineItemIds);

    res.json({ suggested_ids: lineItemIds, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
