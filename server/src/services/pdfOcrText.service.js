/**
 * Rasterize PDF pages and run Tesseract OCR when the embedded text layer is empty or too thin (scanned plans).
 * Requires `pdftoppm` (poppler-utils), e.g. apt install poppler-utils. Tesseract runs via tesseract.js (WASM).
 */
import { promisify } from 'util';
import { execFile } from 'child_process';
import { mkdtemp, writeFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const MIN_NATIVE_STRIPPED = Number(process.env.NDIS_PDF_OCR_MIN_NATIVE_CHARS ?? 380);
const MAX_OCR_PAGES = Math.min(40, Number(process.env.NDIS_PDF_OCR_MAX_PAGES ?? 28));
const OCR_DPI = Number(process.env.NDIS_PDF_OCR_DPI ?? 200);
const OCR_DISABLED = process.env.NDIS_PDF_OCR_DISABLED === '1';

function strippedLen(s) {
  return String(s || '').replace(/\s/g, '').length;
}

/**
 * @param {Buffer} buffer
 * @param {{ forceOcr?: boolean }} [options]
 * @returns {Promise<{ text: string, ocrUsed: boolean }>}
 */
export async function extractNdisPlanPdfText(buffer, options = {}) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  const native = String(data?.text || '');
  const nativeStripped = strippedLen(native);

  const forceOcr = options.forceOcr === true || options.forceOcr === 'true';
  const alwaysOcr = process.env.NDIS_PDF_OCR_ALWAYS === '1';

  const shouldTryOcr =
    !OCR_DISABLED && (forceOcr || alwaysOcr || nativeStripped < MIN_NATIVE_STRIPPED);

  if (!shouldTryOcr) {
    return { text: native, ocrUsed: false };
  }

  let ocrText = '';
  try {
    ocrText = await rasterizeAndOcrPdf(buffer);
  } catch (e) {
    console.warn('[pdfOcrText] OCR skipped:', e?.message || e);
  }

  const ocrStripped = strippedLen(ocrText);

  if (alwaysOcr || forceOcr) {
    if (ocrStripped > 0) return { text: ocrText, ocrUsed: true };
    return { text: native, ocrUsed: false };
  }

  // Thin native layer: prefer OCR when it adds substantial text
  if (ocrStripped >= Math.max(200, nativeStripped * 1.15)) {
    return { text: ocrText, ocrUsed: true };
  }
  if (nativeStripped < 120 && ocrStripped > nativeStripped) {
    return { text: ocrText, ocrUsed: true };
  }
  return { text: native, ocrUsed: false };
}

async function rasterizeAndOcrPdf(buffer) {
  const { createWorker } = await import('tesseract.js');
  const dir = await mkdtemp(join(tmpdir(), 'ndis-plan-ocr-'));
  const pdfPath = join(dir, 'input.pdf');
  const prefix = join(dir, 'page');
  await writeFile(pdfPath, buffer);

  try {
    await execFileAsync('pdftoppm', ['-png', '-r', String(OCR_DPI), pdfPath, prefix], {
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    const msg = e?.message || String(e);
    if (/ENOENT|pdftoppm/i.test(msg)) {
      throw new Error('pdftoppm not found — install poppler-utils (e.g. apt install poppler-utils, brew install poppler)');
    }
    throw e;
  }

  const entries = (await readdir(dir))
    .filter((f) => /^page-\d+\.png$/i.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/)?.[1] || 0);
      const nb = Number(b.match(/(\d+)/)?.[1] || 0);
      return na - nb;
    })
    .slice(0, MAX_OCR_PAGES);

  if (entries.length === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error('pdftoppm produced no PNG pages');
  }

  const worker = await createWorker('eng');

  const parts = [];
  try {
    for (const name of entries) {
      const { data } = await worker.recognize(join(dir, name));
      if (data?.text?.trim()) parts.push(data.text.trim());
    }
  } finally {
    await worker.terminate();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return parts.join('\n\n');
}
