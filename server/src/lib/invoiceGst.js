/** NDIS invoice amounts are stored ex-GST; GST is applied on PDFs when the participant opts in. */

export function participantInvoiceIncludesGst(raw) {
  return Number(raw) === 1 || raw === true;
}

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Australian GST rate for taxable supplies shown on invoices. */
export function gstBreakdownFromSubtotal(subtotal, includesGst) {
  const sub = roundMoney(subtotal);
  const gst = includesGst ? roundMoney(sub * 0.1) : 0;
  return { subtotal: sub, gst_amount: gst, total_incl_gst: roundMoney(sub + gst) };
}
