/**
 * PLACEHOLDER: integrate OCR service for expiry extraction from compliance documents.
 * Returns extracted expiry date (YYYY-MM-DD) or null if not detected.
 * Until integrated, callers should use manual expiry_date from the request body.
 */

/**
 * @param {string} filePath - Full path to uploaded image or PDF
 * @returns {Promise<string|null>} Expiry date YYYY-MM-DD or null
 */
export async function extractExpiryFromDocument(filePath) {
  // PLACEHOLDER: integrate OCR service here; otherwise use manual expiry from request body
  (async () => {})(filePath);
  return null;
}
