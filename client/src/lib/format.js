export function formatRate(rate) {
  const n = parseFloat(rate);
  if (rate == null || rate === '' || isNaN(n)) return '-';
  return `$${n.toFixed(2)}`;
}
