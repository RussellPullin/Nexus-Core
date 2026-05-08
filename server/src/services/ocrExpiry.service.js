/**
 * Extract document expiry date (YYYY-MM-DD) from compliance uploads via PDF text + OCR or image OCR.
 */

import { readFileSync } from 'fs';
import { extname } from 'path';
import { extractNdisPlanPdfText } from './pdfOcrText.service.js';

const MONTH_NAMES =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/gi;

/** e.g. 15 March 2026 */
const DAY_MONTH_NAME_YEAR =
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/gi;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** @param {number} y @param {number} m 1-12 @param {number} d */
function toIso(y, m, d) {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function parseMonthNameDayYear(match) {
  const map = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12
  };
  const d = parseInt(match[1], 10);
  const mon = map[match[2].toLowerCase().slice(0, 3)];
  const y = parseInt(match[3], 10);
  return toIso(y, mon, d);
}

function parseMonthNameDate(match) {
  const map = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12
  };
  const mon = map[match[1].toLowerCase().slice(0, 3)];
  const d = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);
  return toIso(y, mon, d);
}

/**
 * Collect date candidates as ISO strings from OCR-ish text.
 * @param {string} text
 * @returns {string[]}
 */
export function extractIsoDatesFromText(text) {
  const raw = String(text || '');
  const found = new Set();

  let m;
  const reIso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = reIso.exec(raw)) !== null) {
    const iso = toIso(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
    if (iso) found.add(iso);
  }

  const reDmy = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/g;
  while ((m = reDmy.exec(raw)) !== null) {
    let d = parseInt(m[1], 10);
    let mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    // Try DMY first (AU), then MDY if invalid
    let iso = toIso(y, mo, d);
    if (!iso && mo <= 12 && d <= 12) {
      iso = toIso(y, d, mo);
    }
    if (iso) found.add(iso);
  }

  for (const mm of raw.matchAll(MONTH_NAMES)) {
    const iso = parseMonthNameDate(mm);
    if (iso) found.add(iso);
  }

  for (const mm of raw.matchAll(DAY_MONTH_NAME_YEAR)) {
    const iso = parseMonthNameDayYear(mm);
    if (iso) found.add(iso);
  }

  return [...found];
}

/**
 * Pick best expiry: prefer dates near expiry keywords; else latest plausible future date (≤ 15 years).
 * @param {string} text
 * @returns {string|null} YYYY-MM-DD
 */
export function pickExpiryFromText(text) {
  const candidates = extractIsoDatesFromText(text);
  if (!candidates.length) return null;

  const lower = text.toLowerCase();
  const expiryHints =
    /expiry|expires|exp\.|valid\s*to|valid\s*until|card\s*expires|recommend\s*renewal|renew\s*by/i;
  const lines = text.split(/\r?\n/);

  const nearKeyword = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!expiryHints.test(line) && !expiryHints.test(lines[i + 1] || '') && !expiryHints.test(lines[i - 1] || '')) {
      continue;
    }
    const chunk = [lines[i - 1], line, lines[i + 1]].filter(Boolean).join(' ');
    for (const iso of extractIsoDatesFromText(chunk)) {
      nearKeyword.add(iso);
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxFuture = new Date(today);
  maxFuture.setFullYear(maxFuture.getFullYear() + 15);
  const minPast = new Date(today);
  minPast.setFullYear(minPast.getFullYear() - 10);

  /** Typical card/cert expiry: not ancient; may be slightly past (renewal flow). */
  const plausibleExpiry = (iso) => {
    const d = new Date(iso + 'T12:00:00');
    return d >= minPast && d <= maxFuture;
  };

  const pool = nearKeyword.size ? [...nearKeyword].filter(plausibleExpiry) : candidates.filter(plausibleExpiry);
  if (!pool.length) {
    const any = candidates.filter(plausibleExpiry);
    if (!any.length) return null;
    any.sort((a, b) => new Date(b) - new Date(a));
    return any[0];
  }
  pool.sort((a, b) => new Date(b) - new Date(a));
  return pool[0];
}

async function ocrImageFile(imagePath) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(imagePath);
    return String(data?.text || '');
  } finally {
    await worker.terminate();
  }
}

/**
 * @param {string} filePath - Full path to uploaded image or PDF
 * @returns {Promise<string|null>} Expiry date YYYY-MM-DD or null
 */
export async function extractExpiryFromDocument(filePath) {
  const ext = extname(filePath || '').toLowerCase();
  try {
    const buf = readFileSync(filePath);

    if (ext === '.pdf') {
      let { text } = await extractNdisPlanPdfText(buf, { forceOcr: false });
      let picked = pickExpiryFromText(text);
      if (!picked) {
        const second = await extractNdisPlanPdfText(buf, { forceOcr: true });
        picked = pickExpiryFromText(second.text);
      }
      return picked;
    }

    if (['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'].includes(ext)) {
      const text = await ocrImageFile(filePath);
      return pickExpiryFromText(text);
    }

    return null;
  } catch (e) {
    console.warn('[ocrExpiry]', filePath, e?.message || e);
    return null;
  }
}
