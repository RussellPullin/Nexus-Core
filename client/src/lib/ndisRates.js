/**
 * Pick catalogue unit rate by participant remoteness (aligned with server shift charges).
 */
export function getEffectiveNdisRate(item, remoteness) {
  if (!item) return null;
  const r = remoteness === 'very_remote' || remoteness === 'remote' ? remoteness : 'standard';
  if (r === 'very_remote') return item.rate_very_remote ?? item.rate;
  if (r === 'remote') return item.rate_remote ?? item.rate;
  return item.rate;
}
