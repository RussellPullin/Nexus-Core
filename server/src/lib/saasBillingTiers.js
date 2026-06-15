/**
 * Nexus Core SaaS billing: flat $69/month per org, AUD + GST (10%).
 * TaxType in Xero = 'OUTPUT2'.
 */

export const MONTHLY_FLAT_RATE = 69.0;

/**
 * @returns {{ subtotal: number, gst: number, total: number }}
 */
export function calculateInvoiceAmount() {
  return { subtotal: MONTHLY_FLAT_RATE, total: MONTHLY_FLAT_RATE };
}
