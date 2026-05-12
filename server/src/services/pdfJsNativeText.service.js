/**
 * Supplemental PDF text extraction using pdf.js (no Poppler).
 * Some designer / print-to-PDF exports expose little or no text to pdf-parse but
 * still have extractable text operators for pdf.js getTextContent().
 */

function strippedLen(s) {
  return String(s || '').replace(/\s/g, '').length;
}

/**
 * @param {Buffer} buffer
 * @param {number} [maxPages]
 * @returns {Promise<string>}
 */
export async function extractPdfTextWithPdfJs(buffer, maxPages = 56) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!raw.length) return '';
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(raw);
    const loadingTask = getDocument({
      data,
      disableWorker: true,
      isEvalSupported: false
    });
    const pdf = await loadingTask.promise;
    const lines = [];
    const n = Math.min(pdf.numPages || 0, maxPages);
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const chunk = tc.items
        .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      lines.push(chunk);
    }
    return lines.join('\n').replace(/\s+/g, ' ').trim();
  } catch (e) {
    console.warn('[pdfJsNativeText]', e?.message || e);
    return '';
  }
}

/**
 * When pdf-parse / OCR pipeline produced thin text, merge pdf.js extraction.
 * @param {Buffer} buffer
 * @param {string} primaryText
 * @returns {Promise<string>}
 */
export async function augmentPdfTextWithPdfJs(buffer, primaryText) {
  const base = String(primaryText || '');
  const js = await extractPdfTextWithPdfJs(buffer);
  if (strippedLen(js) < 25) return base;
  if (strippedLen(base) < 40) return js;
  if (strippedLen(js) > strippedLen(base) * 1.12) return `${js}\n\n${base}`.trim();
  const head = js.slice(0, 100).replace(/\s/g, '');
  if (head.length > 30 && base.replace(/\s/g, '').includes(head)) return base;
  return `${base}\n\n--- pdf.js ---\n\n${js}`.trim();
}
