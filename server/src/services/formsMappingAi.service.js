/**
 * Prompts and validation for AI-assisted custom form field → merge-key mapping.
 */

import { PARTICIPANT_CONTRACT_MERGE_KEYS, STAFF_CONTRACT_MERGE_KEYS } from '../../../shared/contractFormMergeKeys.js';

/** @param {'staff'|'participant'} workflowKind */
export function allowedMergeKeysForWorkflow(workflowKind) {
  return workflowKind === 'staff' ? STAFF_CONTRACT_MERGE_KEYS : PARTICIPANT_CONTRACT_MERGE_KEYS;
}

/**
 * @param {unknown} parsed
 * @param {string[]} allowed
 * @returns {Record<string, string>}
 */
export function normalizeAiMergeMap(parsed, allowed) {
  const allow = new Set(allowed);
  const raw =
    parsed && typeof parsed === 'object' && parsed.merge_map != null && typeof parsed.merge_map === 'object'
      ? parsed.merge_map
      : parsed && typeof parsed === 'object'
        ? parsed
        : null;
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const skip = new Set(['merge_map', 'fields', 'notes', 'field_labels']);
  for (const [k, v] of Object.entries(raw)) {
    if (skip.has(k)) continue;
    const key = String(k || '').trim();
    const val = String(v || '').trim();
    if (!key || key.length > 220 || !allow.has(val)) continue;
    out[key] = val;
  }
  return out;
}

/**
 * @param {'staff'|'participant'} workflowKind
 * @param {{ placeholders: string[], pdfFormFields?: string[], textExcerpt?: string }} ctx
 */
export function buildSuggestMappingPrompt(workflowKind, ctx) {
  const allowed = allowedMergeKeysForWorkflow(workflowKind);
  const kindLabel = workflowKind === 'staff' ? 'staff employment / HR onboarding' : 'NDIS participant onboarding';
  const placeholders = Array.isArray(ctx.placeholders) ? ctx.placeholders : [];
  const pdfFields = Array.isArray(ctx.pdfFormFields) ? ctx.pdfFormFields : [];
  const excerpt = String(ctx.textExcerpt || '').trim().slice(0, 28000);

  return `You map PDF or Word form field names and placeholders to merge data keys for ${kindLabel}.

Respond with ONLY one JSON object (no markdown). Use exactly this shape: {"merge_map":{...}}

Rules:
- Keys: each key must be an exact PDF AcroForm field name (when listed below), OR a Word placeholder like {Name}, OR another stable label from the document that should receive merged data.
- Values: each value must be exactly one string from the allowed list (use only these strings as values).
- Do not invent values outside the allowed list.
- Map every meaningful fill-in field you can from the lists and excerpt.

Allowed merge keys (values only): ${JSON.stringify(allowed)}

Known PDF AcroForm field names (match keys exactly when applicable): ${JSON.stringify(pdfFields)}

Field names / placeholders to consider (hints): ${JSON.stringify(placeholders)}

Document text excerpt (may be truncated):
---
${excerpt || '(no excerpt — map from field names only)'}
---
`;
}
