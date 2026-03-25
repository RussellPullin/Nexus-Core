/**
 * Format a Date as yyyy-mm-dd in local time (for API date range queries)
 * @param {Date} d - Date object
 * @returns {string} yyyy-mm-dd
 */
export function formatDateLocal(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Format a date as dd/mm/yyyy for display (Australian order).
 * @param {string|Date} d - yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, or Date
 * @returns {string} dd/mm/yyyy
 */
export function formatDate(d) {
  if (!d) return '';
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }
  if (typeof d === 'string') {
    const t = d.trim();
    if (!t) return '';
    const slash = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
    if (slash) {
      const [, dayStr, monthStr, yearStr] = slash;
      const date = new Date(+yearStr, +monthStr - 1, +dayStr);
      if (isNaN(date.getTime())) return '';
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
      const date = new Date(`${t.slice(0, 10)}T12:00:00`);
      if (!isNaN(date.getTime())) {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}/${month}/${year}`;
      }
    }
    const fallback = new Date(t);
    if (!isNaN(fallback.getTime())) {
      const day = String(fallback.getDate()).padStart(2, '0');
      const month = String(fallback.getMonth() + 1).padStart(2, '0');
      const year = fallback.getFullYear();
      return `${day}/${month}/${year}`;
    }
  }
  return '';
}

/**
 * Parse dd/mm/yyyy or dd-mm-yyyy to yyyy-mm-dd for HTML date input
 * @param {string} s - dd/mm/yyyy or dd-mm-yyyy
 * @returns {string} yyyy-mm-dd
 */
export function toInputDate(s) {
  if (!s || typeof s !== 'string') return '';
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}

/**
 * Format yyyy-mm-dd from input to dd/mm/yyyy for display
 * @param {string} iso - yyyy-mm-dd
 * @returns {string} dd/mm/yyyy
 */
export function fromInputDate(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const [y, m, d] = iso.split('-');
  if (y && m && d) return `${d}/${m}/${y}`;
  return iso;
}
