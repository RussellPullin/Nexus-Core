/**
 * PDFKit standard fonts map tab (0x09) and some Unicode poorly — labels/numbers can show as wrong symbols in Acrobat.
 */
export function sanitizePdfText(value) {
  if (value == null) return '';
  let s = String(value);
  s = s.replace(/\t/g, ' ');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/[\u2018\u2019\u2032]/g, "'");
  s = s.replace(/[\u201C\u201D\u2033]/g, '"');
  s = s.replace(/[\u2013\u2014\u2212]/g, '-');
  s = s.replace(/\u00A0/g, ' ');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return s;
}
