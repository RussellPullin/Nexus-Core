/**
 * Pick catalogue unit rate by participant remoteness (aligned with getDefaultLineItemForParticipant).
 * Do not use `rate_remote ?? rate` globally — standard participants must use `rate` only.
 * @param {{ rate?: number|null, rate_remote?: number|null, rate_very_remote?: number|null }} item
 * @param {string} [remoteness] - 'standard' | 'remote' | 'very_remote'
 * @returns {number|null|undefined}
 */
export function getEffectiveNdisRate(item, remoteness) {
  if (!item) return null;
  const r = remoteness === 'very_remote' || remoteness === 'remote' ? remoteness : 'standard';
  if (r === 'very_remote') return item.rate_very_remote ?? item.rate;
  if (r === 'remote') return item.rate_remote ?? item.rate;
  return item.rate;
}
