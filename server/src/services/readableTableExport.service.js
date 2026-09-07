/**
 * Readable Excel + PDF table exports (registers, pay summaries, etc.).
 * Prefer clear titles, frozen headers, status colouring, and print-friendly PDF layout.
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { sanitizePdfText } from '../lib/pdfInvoiceText.js';

const STATUS_FILL = {
  Current: 'DCFCE7',
  Valid: 'DCFCE7',
  'Expiring Soon': 'FEF3C7',
  'Expiring soon': 'FEF3C7',
  Expired: 'FEE2E2',
  Missing: 'FEE2E2',
  Ready: 'DCFCE7',
  'Not ready': 'FEE2E2'
};

const STATUS_PDF_RGB = {
  Current: [22, 101, 52],
  Valid: [22, 101, 52],
  'Expiring Soon': [146, 64, 14],
  'Expiring soon': [146, 64, 14],
  Expired: [153, 27, 27],
  Missing: [153, 27, 27],
  Ready: [22, 101, 52],
  'Not ready': [153, 27, 27]
};

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return String(value);
}

function estimateColWidth(header, rows, colIndex) {
  let max = String(header || '').length;
  for (const row of rows) {
    const v = row?.[colIndex];
    const len = String(v ?? '').length;
    if (len > max) max = len;
  }
  return Math.min(Math.max(max + 2, 12), 42);
}

/**
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   metaLines?: string[],
 *   columns: string[],
 *   rows: Array<Array<string|number|null|undefined>>,
 *   sheetName?: string,
 *   primaryColor?: string
 * }} opts
 * @returns {Promise<Buffer>}
 */
export async function buildReadableExcelBuffer(opts) {
  const {
    title,
    subtitle = '',
    metaLines = [],
    columns,
    rows,
    sheetName = 'Export',
    primaryColor = '1D4ED8'
  } = opts;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexus Core';
  wb.created = new Date();
  const ws = wb.addWorksheet(String(sheetName).slice(0, 31) || 'Export', {
    views: [{ state: 'frozen', ySplit: 1 + (subtitle ? 1 : 0) + metaLines.length + 1 }]
  });

  const colCount = Math.max(columns.length, 1);
  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: `FF${String(primaryColor).replace(/^#/, '').toUpperCase().padStart(6, '1D4ED8').slice(0, 6)}` }
  };

  let rowIdx = 1;
  ws.mergeCells(rowIdx, 1, rowIdx, colCount);
  const titleCell = ws.getCell(rowIdx, 1);
  titleCell.value = title || 'Export';
  titleCell.font = { bold: true, size: 16, color: { argb: 'FF0F172A' } };
  titleCell.alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(rowIdx).height = 24;
  rowIdx += 1;

  if (subtitle) {
    ws.mergeCells(rowIdx, 1, rowIdx, colCount);
    const sub = ws.getCell(rowIdx, 1);
    sub.value = subtitle;
    sub.font = { size: 11, color: { argb: 'FF475569' } };
    sub.alignment = { wrapText: true };
    rowIdx += 1;
  }

  for (const line of metaLines) {
    ws.mergeCells(rowIdx, 1, rowIdx, colCount);
    const meta = ws.getCell(rowIdx, 1);
    meta.value = line;
    meta.font = { size: 9, color: { argb: 'FF64748B' } };
    rowIdx += 1;
  }

  const headerRowIdx = rowIdx;
  const headerRow = ws.getRow(headerRowIdx);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = headerFill;
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } }
    };
  });
  headerRow.height = 20;
  rowIdx += 1;

  for (let r = 0; r < rows.length; r += 1) {
    const dataRow = ws.getRow(rowIdx);
    const values = rows[r] || [];
    columns.forEach((_, i) => {
      const cell = dataRow.getCell(i + 1);
      const raw = values[i];
      cell.value = cellText(raw);
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.font = { size: 10, color: { argb: 'FF0F172A' } };
      if (r % 2 === 1) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' }
        };
      }
      const statusKey = String(raw ?? '');
      if (STATUS_FILL[statusKey]) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${STATUS_FILL[statusKey]}` }
        };
        cell.font = { ...cell.font, bold: true };
      }
      cell.border = {
        bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } }
      };
    });
    rowIdx += 1;
  }

  columns.forEach((col, i) => {
    ws.getColumn(i + 1).width = estimateColWidth(col, rows, i);
  });

  if (columns.length) {
    const endCol = String.fromCharCode(64 + Math.min(columns.length, 26));
    ws.autoFilter = {
      from: { row: headerRowIdx, column: 1 },
      to: { row: headerRowIdx, column: columns.length }
    };
    // Keep filter range valid even when >26 cols (ExcelJS accepts object form above).
    void endCol;
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

/**
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   metaLines?: string[],
 *   columns: string[],
 *   rows: Array<Array<string|number|null|undefined>>,
 *   landscape?: boolean
 * }} opts
 * @returns {Promise<Buffer>}
 */
export function buildReadablePdfBuffer(opts) {
  const {
    title,
    subtitle = '',
    metaLines = [],
    columns,
    rows,
    landscape = true
  } = opts;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 36,
        size: 'A4',
        layout: landscape ? 'landscape' : 'portrait',
        info: { Title: title || 'Export', Author: 'Nexus Core' }
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      let y = doc.page.margins.top;

      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text(sanitizePdfText(title || 'Export'), {
        width: pageWidth,
        continued: false
      });
      y = doc.y + 4;

      if (subtitle) {
        doc.fillColor('#475569').font('Helvetica').fontSize(10).text(sanitizePdfText(subtitle), {
          width: pageWidth
        });
        y = doc.y + 2;
      }

      for (const line of metaLines) {
        doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(sanitizePdfText(line), {
          width: pageWidth
        });
        y = doc.y;
      }

      y = Math.max(y + 8, doc.y + 8);
      doc.y = y;

      const colCount = Math.max(columns.length, 1);
      const colWidth = pageWidth / colCount;
      const headerHeight = 22;
      const rowPad = 4;
      const fontSize = colCount > 8 ? 7 : colCount > 5 ? 8 : 9;

      const drawHeader = () => {
        doc.save();
        doc.rect(doc.page.margins.left, doc.y, pageWidth, headerHeight).fill('#1d4ed8');
        let x = doc.page.margins.left;
        columns.forEach((col) => {
          doc
            .fillColor('#ffffff')
            .font('Helvetica-Bold')
            .fontSize(fontSize)
            .text(sanitizePdfText(col), x + 3, doc.y + 6, {
              width: colWidth - 6,
              height: headerHeight - 8,
              ellipsis: true
            });
          x += colWidth;
        });
        doc.restore();
        doc.y += headerHeight;
      };

      drawHeader();

      for (let r = 0; r < rows.length; r += 1) {
        const values = rows[r] || [];
        const heights = columns.map((_, i) => {
          const text = sanitizePdfText(String(values[i] ?? ''));
          return Math.max(
            16,
            doc.heightOfString(text, { width: colWidth - 6, align: 'left' }) + rowPad * 2
          );
        });
        const rowHeight = Math.min(Math.max(...heights, 16), 72);

        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          drawHeader();
        }

        const rowTop = doc.y;
        if (r % 2 === 1) {
          doc.save();
          doc.rect(doc.page.margins.left, rowTop, pageWidth, rowHeight).fill('#f8fafc');
          doc.restore();
        }

        let x = doc.page.margins.left;
        columns.forEach((_, i) => {
          const raw = String(values[i] ?? '');
          const rgb = STATUS_PDF_RGB[raw];
          doc
            .fillColor(rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : '#0f172a')
            .font(rgb ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(fontSize)
            .text(sanitizePdfText(raw), x + 3, rowTop + rowPad, {
              width: colWidth - 6,
              height: rowHeight - rowPad,
              ellipsis: true
            });
          x += colWidth;
        });

        doc
          .strokeColor('#e2e8f0')
          .lineWidth(0.5)
          .moveTo(doc.page.margins.left, rowTop + rowHeight)
          .lineTo(doc.page.margins.left + pageWidth, rowTop + rowHeight)
          .stroke();

        doc.y = rowTop + rowHeight;
      }

      if (!rows.length) {
        doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('No rows to export.', {
          width: pageWidth
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsvString(columns, rows) {
  return [columns, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n');
}
