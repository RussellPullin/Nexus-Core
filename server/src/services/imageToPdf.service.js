/**
 * Wrap a single-page raster (JPEG/PNG) in a minimal PDF for downstream pdf-lib merge paths.
 */
import { PDFDocument } from 'pdf-lib';

function sniffImageKind(buffer) {
  const b = buffer;
  if (!b || b.length < 3) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  return null;
}

/**
 * @param {Buffer} buffer
 * @param {string} [filename] - hint for .jpg / .jpeg / .png
 * @returns {Promise<Buffer>}
 */
export async function embedRasterImageAsSinglePagePdf(buffer, filename = '') {
  const lower = (filename || '').toLowerCase();
  let kind = sniffImageKind(buffer);
  if (!kind) {
    if (/\.jpe?g$/i.test(lower)) kind = 'jpeg';
    else if (/\.png$/i.test(lower)) kind = 'png';
  }
  if (!kind) {
    throw new Error('Image must be JPEG or PNG bytes for PDF embedding.');
  }

  const pdfDoc = await PDFDocument.create();
  let image;
  if (kind === 'jpeg') {
    image = await pdfDoc.embedJpg(buffer);
  } else {
    image = await pdfDoc.embedPng(buffer);
  }

  const w = image.width;
  const h = image.height;
  const page = pdfDoc.addPage([w, h]);
  page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  return Buffer.from(await pdfDoc.save());
}
