/**
 * Rasterize PDF pages and run Tesseract OCR when the embedded text layer is empty or too thin.
 * Requires `pdftoppm` (poppler-utils). Tesseract runs via tesseract.js (WASM).
 *
 * NDIS plan parsing uses NDIS_PDF_OCR_* env vars.
 * Contract / onboarding form analysis uses CONTRACT_PDF_OCR_* with fallback to NDIS_*.
 */
import { promisify } from 'util';
import { execFile } from 'child_process';
import { mkdtemp, writeFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

function numFromEnv(primary, fallback, defaultVal) {
  const p = process.env[primary];
  if (p !== undefined && p !== '' && !Number.isNaN(Number(p))) return Number(p);
  const f = process.env[fallback];
  if (f !== undefined && f !== '' && !Number.isNaN(Number(f))) return Number(f);
  return defaultVal;
}

function strippedLen(s) {
  return String(s || '').replace(/\s/g, '').length;
}

/** NDIS plan defaults */
const NDIS_MIN_NATIVE = Number(process.env.NDIS_PDF_OCR_MIN_NATIVE_CHARS ?? 380);
const NDIS_MAX_PAGES = Math.min(40, Number(process.env.NDIS_PDF_OCR_MAX_PAGES ?? 28));
const NDIS_DPI = Number(process.env.NDIS_PDF_OCR_DPI ?? 200);
const NDIS_DISABLED = process.env.NDIS_PDF_OCR_DISABLED === '1';

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
    !NDIS_DISABLED && (forceOcr || alwaysOcr || nativeStripped < NDIS_MIN_NATIVE);

  if (!shouldTryOcr) {
    return { text: native, ocrUsed: false };
  }

  let ocrText = '';
  try {
    ocrText = await rasterizeAndOcrPdf(buffer, {
      dpi: NDIS_DPI,
      maxPages: NDIS_MAX_PAGES,
      psmModes: parsePsmList(process.env.NDIS_PDF_OCR_PSM_LIST, ['6', '4']),
      imageMagickPreprocess: process.env.NDIS_PDF_OCR_IMAGE_MAGICK === '1'
    });
  } catch (e) {
    console.warn('[pdfOcrText] NDIS OCR skipped:', e?.message || e);
  }

  const ocrStripped = strippedLen(ocrText);

  if (alwaysOcr || forceOcr) {
    if (ocrStripped > 0) return { text: ocrText, ocrUsed: true };
    return { text: native, ocrUsed: false };
  }

  if (ocrStripped >= Math.max(200, nativeStripped * 1.15)) {
    return { text: ocrText, ocrUsed: true };
  }
  if (nativeStripped < 120 && ocrStripped > nativeStripped) {
    return { text: ocrText, ocrUsed: true };
  }
  return { text: native, ocrUsed: false };
}

/**
 * Contract / custom form template OCR: CONTRACT_PDF_OCR_* overrides, else NDIS_*.
 * @param {Buffer} buffer
 * @param {{ forceOcr?: boolean }} [options]
 * @returns {Promise<{ text: string, ocrUsed: boolean }>}
 */
export async function extractContractPdfText(buffer, options = {}) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  const native = String(data?.text || '');
  const nativeStripped = strippedLen(native);

  /* Low default: many scanned PDFs still have a fat bogus "text" layer from pdf-parse; we want OCR to run for forms. */
  const minNative = numFromEnv('CONTRACT_PDF_OCR_MIN_NATIVE_CHARS', 'NDIS_PDF_OCR_MIN_NATIVE_CHARS', 60);
  const disabled =
    process.env.CONTRACT_PDF_OCR_DISABLED === '1' || (process.env.CONTRACT_PDF_OCR_DISABLED !== '0' && NDIS_DISABLED);

  const forceOcr = options.forceOcr === true || options.forceOcr === 'true';
  const alwaysOcr =
    process.env.CONTRACT_PDF_OCR_ALWAYS === '1' ||
    (process.env.CONTRACT_PDF_OCR_ALWAYS !== '0' && process.env.NDIS_PDF_OCR_ALWAYS === '1');

  const shouldTryOcr = !disabled && (forceOcr || alwaysOcr || nativeStripped < minNative);

  if (!shouldTryOcr) {
    return { text: native, ocrUsed: false };
  }

  const dpi = numFromEnv('CONTRACT_PDF_OCR_DPI', 'NDIS_PDF_OCR_DPI', 300);
  const maxPages = Math.min(60, numFromEnv('CONTRACT_PDF_OCR_MAX_PAGES', 'NDIS_PDF_OCR_MAX_PAGES', 32));
  const psmList = parsePsmList(
    process.env.CONTRACT_PDF_OCR_PSM_LIST,
    parsePsmList(process.env.NDIS_PDF_OCR_PSM_LIST, ['6', '11', '4'])
  );
  const imageMagick =
    process.env.CONTRACT_PDF_OCR_IMAGE_MAGICK === '1' || process.env.NDIS_PDF_OCR_IMAGE_MAGICK === '1';

  let ocrText = '';
  try {
    ocrText = await rasterizeAndOcrPdf(buffer, { dpi, maxPages, psmModes: psmList, imageMagickPreprocess: imageMagick });
  } catch (e) {
    console.warn('[pdfOcrText] contract OCR skipped:', e?.message || e);
  }

  const ocrStripped = strippedLen(ocrText);

  if (alwaysOcr || forceOcr) {
    if (ocrStripped > 0) return { text: ocrText, ocrUsed: true };
    return { text: native, ocrUsed: false };
  }

  if (ocrStripped >= Math.max(180, nativeStripped * 1.12)) {
    return { text: ocrText, ocrUsed: true };
  }
  if (nativeStripped < 100 && ocrStripped > nativeStripped) {
    return { text: ocrText, ocrUsed: true };
  }
  return { text: native, ocrUsed: false };
}

/**
 * @param {string|undefined} raw comma-separated PSM digits
 * @param {string[]} defaults
 */
function parsePsmList(raw, defaults) {
  if (!raw || !String(raw).trim()) return [...defaults];
  const parts = String(raw)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}$/.test(s));
  return parts.length ? parts : [...defaults];
}

/**
 * Optional ImageMagick preprocess (deskew + mild sharpen). Writes over same path with suffix -proc.png
 * @param {string} pngPath
 * @returns {Promise<string>} path to use for OCR (processed or original)
 */
async function maybeMagickPreprocess(imagePath, enabled) {
  if (!enabled) return imagePath;
  const outPath = imagePath.replace(/(\.[a-z0-9]+)?$/i, '-proc.png');
  for (const bin of ['magick', 'convert']) {
    try {
      await execFileAsync(bin, [pngPath, '-deskew', '40%', '-colorspace', 'Gray', '-contrast-stretch', '1%x1%', '-adaptive-sharpen', '0x1', outPath], {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024
      });
      return outPath;
    } catch {
      /* try next binary */
    }
  }
  return pngPath;
}

/**
 * @param {Buffer} buffer
 * @param {{ dpi?: number, maxPages?: number, psmModes?: string[], imageMagickPreprocess?: boolean }} config
 * @returns {Promise<string>}
 */
export async function rasterizeAndOcrPdf(buffer, config = {}) {
  const dpi = config.dpi ?? 200;
  const maxPages = config.maxPages ?? 28;
  const psmModes = config.psmModes?.length ? config.psmModes : ['6', '4'];
  const imageMagickPreprocess = !!config.imageMagickPreprocess;

  const { createWorker, PSM } = await import('tesseract.js');
  const dir = await mkdtemp(join(tmpdir(), 'pdf-ocr-'));
  const pdfPath = join(dir, 'input.pdf');
  const prefix = join(dir, 'page');
  await writeFile(pdfPath, buffer);

  try {
    await execFileAsync('pdftoppm', ['-png', '-r', String(dpi), pdfPath, prefix], {
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
    .slice(0, maxPages);

  if (entries.length === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error('pdftoppm produced no PNG pages');
  }

  const psmMap = {
    '0': PSM.OSD_ONLY,
    '1': PSM.AUTO_OSD,
    '3': PSM.AUTO,
    '4': PSM.SINGLE_COLUMN,
    '6': PSM.SINGLE_BLOCK,
    '11': PSM.SPARSE_TEXT,
    '12': PSM.SPARSE_TEXT_OSD
  };

  const worker = await createWorker('eng');
  const pagePaths = [];
  try {
    for (const name of entries) {
      const src = join(dir, name);
      const usePath = await maybeMagickPreprocess(src, imageMagickPreprocess);
      pagePaths.push(usePath);
    }

    const parts = [];
    let pageNum = 0;
    for (const usePath of pagePaths) {
      pageNum += 1;
      let best = '';
      let bestScore = 0;
      for (const psmStr of psmModes) {
        const mode = psmMap[psmStr] ?? PSM.SINGLE_BLOCK;
        await worker.setParameters({ tessedit_pageseg_mode: mode });
        const { data } = await worker.recognize(usePath);
        const text = String(data?.text || '').trim();
        const score = strippedLen(text);
        const conf = typeof data?.confidence === 'number' ? data.confidence : 0;
        const combined = score * 1 + conf * 0.02;
        if (combined > bestScore || (combined === bestScore && text.length > best.length)) {
          bestScore = combined;
          best = text;
        }
      }
      if (best) parts.push(best);
    }
    return parts.join('\n\n');
  } finally {
    await worker.terminate();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * OCR one or more raster image files (paths) with contract-oriented defaults.
 * @param {string[]} absolutePaths
 * @param {{ psmModes?: string[], imageMagickPreprocess?: boolean }} [opts]
 */
export async function ocrRasterImagePaths(absolutePaths, opts = {}) {
  const { createWorker, PSM } = await import('tesseract.js');
  const psmModes = opts.psmModes?.length ? opts.psmModes : ['6', '11', '4'];
  const imageMagickPreprocess = !!opts.imageMagickPreprocess;
  const psmMap = {
    '4': PSM.SINGLE_COLUMN,
    '6': PSM.SINGLE_BLOCK,
    '11': PSM.SPARSE_TEXT
  };

  const worker = await createWorker('eng');
  try {
    const chunks = [];
    for (const src of absolutePaths) {
      const usePath = await maybeMagickPreprocess(src, imageMagickPreprocess);
      let best = '';
      let bestScore = 0;
      for (const psmStr of psmModes) {
        const mode = psmMap[psmStr] ?? PSM.SINGLE_BLOCK;
        await worker.setParameters({ tessedit_pageseg_mode: mode });
        const { data } = await worker.recognize(usePath);
        const text = String(data?.text || '').trim();
        const score = strippedLen(text);
        const conf = typeof data?.confidence === 'number' ? data.confidence : 0;
        const combined = score + conf * 0.02;
        if (combined > bestScore) {
          bestScore = combined;
          best = text;
        }
      }
      if (best) chunks.push(best);
    }
    return chunks.join('\n\n');
  } finally {
    await worker.terminate();
  }
}

/**
 * Write buffer to a temp file with correct extension, OCR it (single-page or multi-file).
 * @param {Buffer} buffer
 * @param {string} filename
 */
export async function ocrRasterBufferToText(buffer, filename = '') {
  const lower = (filename || '').toLowerCase();
  const ext = /\.jpe?g$/i.test(lower) ? '.jpg' : /\.png$/i.test(lower) ? '.png' : /\.webp$/i.test(lower) ? '.webp' : '.jpg';
  const dir = await mkdtemp(join(tmpdir(), 'img-ocr-'));
  const srcPath = join(dir, `scan${ext}`);
  await writeFile(srcPath, buffer);
  const imageMagick = process.env.CONTRACT_PDF_OCR_IMAGE_MAGICK === '1';

  try {
    const psmModes = parsePsmList(
      process.env.CONTRACT_PDF_OCR_PSM_LIST,
      parsePsmList(process.env.NDIS_PDF_OCR_PSM_LIST, ['6', '11', '4'])
    );
    return await ocrRasterImagePaths([srcPath], { psmModes, imageMagickPreprocess: imageMagick });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
