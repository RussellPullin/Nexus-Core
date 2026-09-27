/**
 * Xero line items have no service-date field — the date has to live in Description.
 * Keep the line scannable: date + item number first, support name on the next line.
 */

const MONTHS_AU = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse YYYY-MM-DD without timezone shift (new Date('YYYY-MM-DD') is UTC midnight). */
export function formatServiceDateForInvoice(lineDate) {
  if (lineDate == null) return '';
  const raw = String(lineDate).trim().slice(0, 10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const month = MONTHS_AU[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return '';
  return `${day} ${month} ${m[1]}`;
}

/**
 * @param {{ support_item_number?: string|null, description?: string|null, line_date?: string|null }} li
 * @returns {string}
 */
export function buildXeroLineDescription(li = {}) {
  const itemNo =
    li.support_item_number && String(li.support_item_number).trim() !== '-'
      ? String(li.support_item_number).trim()
      : '';
  const desc = String(li.description || '').trim() || 'Support';
  const dateStr = formatServiceDateForInvoice(li.line_date);

  const head = [dateStr, itemNo].filter(Boolean).join(' · ');
  const text = head ? `${head}\n${desc}` : desc;
  return text.slice(0, 4000);
}
