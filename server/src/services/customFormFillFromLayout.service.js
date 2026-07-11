/**
 * Pre-fill custom form PDFs from signing_layout text/date/signature fields (intake or
 * admin-supplied merge data). Checkbox fields are left for DocuSeal overlays. Signature fields
 * are embedded as an image only when the merge value is a data URL; a plain string is drawn as
 * a typed-name signature (this codebase's existing convention, e.g. staff policy acknowledgement).
 * Untouched when no merge value exists for a signature field (the normal case for
 * DocuSeal-collected signatures), so existing participant/library-master flows are unaffected.
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

function dataUrlToImageBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  if (!match) return null;
  try {
    return { format: match[1].startsWith('jp') ? 'jpg' : 'png', buffer: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
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
    if (!f || f.type === 'checkbox') continue;
    const page = pages[(f.page || 1) - 1];
    if (!page) continue;

    const value =
      resolvePdfFieldMergeValue(mergeData, f.merge_key, options) ||
      resolvePdfFieldMergeValue(mergeData, f.api_id, options);
    if (!value) continue;

    const pageH = page.getHeight();
    const rectY = pageH - f.y - f.height;

    if (f.type === 'signature') {
      const image = dataUrlToImageBuffer(value);
      if (image) {
        try {
          const embedded = image.format === 'jpg' ? await doc.embedJpg(image.buffer) : await doc.embedPng(image.buffer);
          page.drawImage(embedded, { x: f.x, y: rectY, width: f.width, height: f.height });
        } catch (err) {
          console.warn('[customFormFillFromLayout] could not embed signature image:', err.message);
        }
        continue;
      }
      if (!String(value).trim()) continue; // no signature supplied — leave for DocuSeal overlay as before
      // Typed-name signature (falls through to the text-draw below).
    }

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
