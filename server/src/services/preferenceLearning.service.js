/**
 * Preference learning service – learns how the user works with the CRM.
 * Records usage patterns so the system becomes more personalised over time:
 * - Shift line items and structures
 * - Budget line items per category
 * - Pricing tier (weekday/standard vs remote)
 * - Support coordinator level (Level 2 most common)
 * - Common therapies (OT, Speech, Psychology)
 *
 * Used by the LLM layer and smart-defaults API to suggest better options.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';

const PREFERENCE_TYPES = {
  LINE_ITEM_SHIFT: 'line_item_shift',
  LINE_ITEM_BUDGET: 'line_item_budget',
  PRICING_TIER: 'pricing_tier',
  SUPPORT_COORDINATOR: 'support_coordinator',
  THERAPY: 'therapy',
  CATEGORY_LINE_ITEM: 'category_line_item'
};

function upsertPreference(type, contextKey, value, metadata = null) {
  const existing = db.prepare(
    `SELECT id, use_count FROM usage_preferences
     WHERE preference_type = ? AND context_key = ? AND preference_value = ?`
  ).get(type, contextKey, value);

  const metaStr = metadata ? JSON.stringify(metadata) : null;
  if (existing) {
    db.prepare(
      `UPDATE usage_preferences SET use_count = use_count + 1, last_used = datetime('now'), metadata = COALESCE(?, metadata)
       WHERE id = ?`
    ).run(metaStr, existing.id);
  } else {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO usage_preferences (id, preference_type, context_key, preference_value, use_count, metadata)
       VALUES (?, ?, ?, ?, 1, ?)`
    ).run(id, type, contextKey, value, metaStr);
  }
}

/**
 * Infer support coordinator level from support item number or description.
 * NDIS format: 07_001_0107_7_1 (Level 1), 07_002_0107_7_1 (Level 2), 07_003_0107_7_1 (Level 3)
 */
function inferSupportCoordinatorLevel(supportItemNumber, description = '') {
  const desc = (description || '').toLowerCase();
  const num = String(supportItemNumber || '');
  if (desc.includes('level 3') || num.includes('003')) return 'level_3';
  if (desc.includes('level 2') || num.includes('002')) return 'level_2';
  if (desc.includes('level 1') || num.includes('001')) return 'level_1';
  return null;
}

/**
 * Infer therapy type from description (OT, Speech, Psychology).
 */
function inferTherapyType(description = '', category = '') {
  const desc = (description || '').toLowerCase();
  const cat = String(category || '');
  if (desc.includes('occupational') || desc.includes(' o.t ') || desc.includes('ot ') || desc.includes('daily living')) return 'occupational_therapy';
  if (desc.includes('speech') || desc.includes('language') || desc.includes('communication')) return 'speech_pathology';
  if (desc.includes('psycholog') || desc.includes('behaviour') || desc.includes('mental health') || cat === '12') return 'psychology';
  return null;
}

/**
 * Record a shift's line items for learning.
 */
export function recordShiftLineItems(lineItems, participantRemoteness = 'standard') {
  if (!lineItems?.length) return;

  upsertPreference(PREFERENCE_TYPES.PRICING_TIER, 'global', participantRemoteness || 'standard');

  for (const li of lineItems) {
    const item = db.prepare('SELECT * FROM ndis_line_items WHERE id = ?').get(li.ndis_line_item_id);
    if (!item) continue;

    upsertPreference(PREFERENCE_TYPES.LINE_ITEM_SHIFT, 'global', li.ndis_line_item_id, {
      support_item_number: item.support_item_number,
      category: item.support_category
    });

    const category = item.support_category || item.support_item_number?.slice(0, 2);
    if (category) {
      upsertPreference(PREFERENCE_TYPES.CATEGORY_LINE_ITEM, category, li.ndis_line_item_id, {
        support_item_number: item.support_item_number
      });
    }

    if (category === '07') {
      const level = inferSupportCoordinatorLevel(item.support_item_number, item.description);
      if (level) upsertPreference(PREFERENCE_TYPES.SUPPORT_COORDINATOR, 'global', level);
    }

    const therapy = inferTherapyType(item.description, category);
    if (therapy) upsertPreference(PREFERENCE_TYPES.THERAPY, 'global', therapy);
  }
}

/**
 * Record a budget line item selection for learning.
 */
export function recordBudgetLineItemSelection(category, ndisLineItemId) {
  if (!category || !ndisLineItemId) return;

  const item = db.prepare('SELECT * FROM ndis_line_items WHERE id = ?').get(ndisLineItemId);
  if (!item) return;

  upsertPreference(PREFERENCE_TYPES.LINE_ITEM_BUDGET, category, ndisLineItemId, {
    support_item_number: item.support_item_number,
    description: item.description?.slice(0, 100)
  });

  upsertPreference(PREFERENCE_TYPES.CATEGORY_LINE_ITEM, category, ndisLineItemId, {
    support_item_number: item.support_item_number
  });

  if (category === '07') {
    const level = inferSupportCoordinatorLevel(item.support_item_number, item.description);
    if (level) upsertPreference(PREFERENCE_TYPES.SUPPORT_COORDINATOR, 'global', level);
  }

  const therapy = inferTherapyType(item.description, category);
  if (therapy) upsertPreference(PREFERENCE_TYPES.THERAPY, 'global', therapy);
}

/**
 * Record participant remoteness when a shift is created (for pricing tier default).
 */
export function recordPricingTierUsage(remoteness) {
  return upsertPreference(PREFERENCE_TYPES.PRICING_TIER, 'global', remoteness || 'standard');
}

/**
 * Get learned preferences for smart defaults and LLM context.
 */
export function getLearnedPreferences() {
  const prefs = {
    pricing_tier: 'standard',
    support_coordinator_level: 'level_2',
    top_line_items: [],
    top_line_items_by_category: {},
    top_therapies: ['occupational_therapy', 'speech_pathology', 'psychology'],
    budget_line_items_by_category: {}
  };

  const pricing = db.prepare(
    `SELECT preference_value, use_count FROM usage_preferences
     WHERE preference_type = ? AND context_key = ? ORDER BY use_count DESC LIMIT 1`
  ).get(PREFERENCE_TYPES.PRICING_TIER, 'global');
  if (pricing) prefs.pricing_tier = pricing.preference_value;

  const sc = db.prepare(
    `SELECT preference_value, use_count FROM usage_preferences
     WHERE preference_type = ? AND context_key = ? ORDER BY use_count DESC LIMIT 1`
  ).get(PREFERENCE_TYPES.SUPPORT_COORDINATOR, 'global');
  if (sc) prefs.support_coordinator_level = sc.preference_value;

  const shiftItems = db.prepare(
    `SELECT preference_value, use_count, metadata FROM usage_preferences
     WHERE preference_type = ? AND context_key = ? ORDER BY use_count DESC LIMIT 20`
  ).all(PREFERENCE_TYPES.LINE_ITEM_SHIFT, 'global');
  prefs.top_line_items = shiftItems.map(r => {
    let meta = {};
    try { if (r.metadata) meta = JSON.parse(r.metadata); } catch { /* ignore */ }
    return { id: r.preference_value, use_count: r.use_count, ...meta };
  });

  const categoryItems = db.prepare(
    `SELECT context_key, preference_value, use_count, metadata FROM usage_preferences
     WHERE preference_type = ? ORDER BY context_key, use_count DESC`
  ).all(PREFERENCE_TYPES.CATEGORY_LINE_ITEM);
  for (const r of categoryItems) {
    if (!prefs.top_line_items_by_category[r.context_key]) prefs.top_line_items_by_category[r.context_key] = [];
    if (prefs.top_line_items_by_category[r.context_key].length < 5) {
      let meta = {};
      try { if (r.metadata) meta = JSON.parse(r.metadata); } catch { /* ignore */ }
      prefs.top_line_items_by_category[r.context_key].push({ id: r.preference_value, use_count: r.use_count, ...meta });
    }
  }

  const therapies = db.prepare(
    `SELECT preference_value, use_count FROM usage_preferences
     WHERE preference_type = ? AND context_key = ? ORDER BY use_count DESC LIMIT 10`
  ).all(PREFERENCE_TYPES.THERAPY, 'global');
  if (therapies.length > 0) {
    prefs.top_therapies = therapies.map(r => r.preference_value);
  }

  const budgetItems = db.prepare(
    `SELECT context_key, preference_value, use_count, metadata FROM usage_preferences
     WHERE preference_type = ? ORDER BY context_key, use_count DESC`
  ).all(PREFERENCE_TYPES.LINE_ITEM_BUDGET);
  for (const r of budgetItems) {
    const cat = r.context_key;
    if (!prefs.budget_line_items_by_category[cat]) prefs.budget_line_items_by_category[cat] = [];
    if (prefs.budget_line_items_by_category[cat].length < 5) {
      let meta = {};
      try { if (r.metadata) meta = JSON.parse(r.metadata); } catch { /* ignore */ }
      prefs.budget_line_items_by_category[cat].push({ id: r.preference_value, use_count: r.use_count, ...meta });
    }
  }

  return prefs;
}

/**
 * Build context string for LLM prompts – describes how this user typically works.
 */
export function buildLLMContext() {
  const p = getLearnedPreferences();
  const parts = [];

  parts.push(`Pricing: User typically uses ${p.pricing_tier === 'standard' ? 'weekday/standard' : p.pricing_tier} pricing.`);
  parts.push(`Support coordinator: Most common is ${p.support_coordinator_level.replace('_', ' ')}.`);

  if (p.top_therapies?.length > 0) {
    const names = p.top_therapies.map(t => t.replace(/_/g, ' '));
    parts.push(`Most common therapies in plans: ${names.join(', ')}.`);
  }

  if (p.top_line_items?.length > 0) {
    const nums = p.top_line_items.slice(0, 5).map(li => li.support_item_number || li.id).filter(Boolean);
    if (nums.length) parts.push(`Frequently used shift line items: ${nums.join(', ')}.`);
  }

  return parts.join(' ');
}

export default {
  recordShiftLineItems,
  recordBudgetLineItemSelection,
  recordPricingTierUsage,
  getLearnedPreferences,
  buildLLMContext,
  PREFERENCE_TYPES
};
