/**
 * Print-safe layout for A4 billing invoices.
 *
 * Home/office printers commonly clip the outer ~12–15mm. US Letter PDFs printed
 * on A4 paper also clip the right/bottom edges. Keep content inside these bounds.
 */

/** ~19mm — clear of typical non-printable zones when printing A4 */
export const INVOICE_PAGE_MARGIN = 54;

/** Distance from page bottom for the "Page x of y" line (~17mm) */
export const INVOICE_FOOTER_FROM_BOTTOM = 48;

/** Reserve so line items / payment block do not collide with the footer */
export const INVOICE_FOOTER_RESERVE = 56;

/**
 * Column positions for the line-items table, derived from page width so the
 * Total column never runs past the right margin (the old fixed x=520 layout did
 * on A4).
 *
 * @param {number} pageWidth
 * @param {number} [margin=INVOICE_PAGE_MARGIN]
 */
export function invoiceLineItemColumns(pageWidth, margin = INVOICE_PAGE_MARGIN) {
  const left = margin;
  const right = pageWidth - margin;
  const totalW = 42;
  const gstW = 38;
  const priceW = 48;
  const qtyW = 45;
  const gap = 6;

  const totalX = right - totalW;
  const gstX = totalX - gap - gstW;
  const priceX = gstX - gap - priceW;
  const qtyX = priceX - gap - qtyW;
  const itemW = 70;
  const detailsX = left + itemW + gap;
  const detailsW = Math.max(120, qtyX - gap - detailsX);

  return {
    left,
    right,
    contentWidth: right - left,
    itemX: left,
    itemW,
    detailsX,
    detailsW,
    qtyX,
    qtyW,
    priceX,
    priceW,
    gstX,
    gstW,
    totalX,
    totalW,
    metaX: left + Math.floor((right - left) * 0.52),
    summaryX: qtyX,
    summaryW: right - qtyX,
  };
}
