/**
 * Logo uploads must be a real PNG or JPEG — that's all pdf-lib can embed onto
 * documents. Browsers happily report a WebP (or an SVG, HEIC, …) renamed to
 * `.png` as `image/png`, so the multer mimetype check isn't enough: sniff the
 * actual bytes and reject anything we can't stamp onto a document.
 */

/** @param {Buffer} buf @returns {'png'|'jpeg'|'webp'|'gif'|'svg'|'unknown'} */
export function sniffImageFormat(buf) {
  if (!buf || buf.length < 12) return 'unknown';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  const head = buf.slice(0, 512).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'svg';
  return 'unknown';
}

/**
 * Throw a user-facing Error unless `buf` is a PNG or JPEG.
 * @param {Buffer} buf
 */
export function assertEmbeddableLogo(buf) {
  const fmt = sniffImageFormat(buf);
  if (fmt === 'png' || fmt === 'jpeg') return fmt;
  const hint =
    fmt === 'webp'
      ? 'This file is a WebP image (often saved with a .png name). Open it and re-save / export it as PNG or JPEG, then upload again.'
      : fmt === 'svg'
        ? 'SVG logos can\'t be stamped onto documents. Export it as a PNG (ideally 600px+ wide) and upload that.'
        : `Unsupported image format (${fmt}). Please upload a PNG or JPEG.`;
  const err = new Error(hint);
  err.code = 'LOGO_FORMAT_UNSUPPORTED';
  err.status = 400;
  throw err;
}
