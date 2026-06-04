/**
 * Pre-fill custom form PDFs from signing_layout text/date fields (intake merge data).
 * Signature and checkbox fields are left for Dropbox Sign overlays.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { resolvePdfFieldMergeValue } from './staffContractFill.service.js';
import { defaultCoverUnderlying } from './formTemplateSigningLayout.service.js';

function fieldCoversUnderlying(f) {
  if (f.cover_underlying === false) return false;
  if (f.cover_underlying === true) return true;
  return defaultCoverUnderlying(f.type, f.api_id, f.merge_key);
}

function toPdfSafeText(str) {
  return String(str ?? '')
    .replace(/\u2192/g, '->')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\t\n\r\x20-\x7E]/g, '?');
}

/**
 * @param {Buffer} pdfBytes
 * @param {import('./formTemplateSigningLayout.service.js').SigningLayout} signingLayout
 * @param {Record<string, string>} mergeData
 * @param {{ workflow?: string }} [options]
 */
export async function fillCustomFormFromLayout(pdfBytes, signingLayout, mergeData, options = {}) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const fields = signingLayout?.fields || [];

  for (const f of fields) {
    if (!f || f.type === 'signature' || f.type === 'checkbox') continue;
    const page = pages[(f.page || 1) - 1];
    if (!page) continue;

    const value =
      resolvePdfFieldMergeValue(mergeData, f.merge_key, options) ||
      resolvePdfFieldMergeValue(mergeData, f.api_id, options);
    if (!value) continue;

    const pageH = page.getHeight();
    const rectY = pageH - f.y - f.height;
    if (fieldCoversUnderlying(f)) {
      page.drawRectangle({
        x: f.x,
        y: rectY,
        width: f.width,
        height: f.height,
        color: rgb(1, 1, 1),
        borderWidth: 0
      });
    }
    const drawY = rectY + Math.max(2, (f.height - 10) / 2);
    const size = Math.min(11, Math.max(8, f.height - 4));
    page.drawText(toPdfSafeText(value), {
      x: f.x + 2,
      y: drawY,
      size,
      font,
      maxWidth: Math.max(20, f.width - 4)
    });
  }

  return Buffer.from(await doc.save());
}
