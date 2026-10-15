import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import PDFDocument from 'pdfkit';
import {
  INVOICE_FOOTER_FROM_BOTTOM,
  INVOICE_PAGE_MARGIN,
  invoiceLineItemColumns,
} from './invoicePdfLayout.js';

/** ~12mm — floor many consumer printers still print */
const MIN_SAFE_MM = 12;
const PT_PER_MM = 72 / 25.4;
const MIN_SAFE_PT = MIN_SAFE_MM * PT_PER_MM;

describe('invoicePdfLayout', () => {
  it('uses margins larger than typical printer clip zones', () => {
    assert.ok(INVOICE_PAGE_MARGIN >= MIN_SAFE_PT);
    assert.ok(INVOICE_FOOTER_FROM_BOTTOM >= MIN_SAFE_PT);
  });

  it('keeps the Total column inside the right margin on A4', () => {
    const doc = new PDFDocument({ size: 'A4', margin: INVOICE_PAGE_MARGIN });
    const col = invoiceLineItemColumns(doc.page.width, INVOICE_PAGE_MARGIN);
    doc.end();

    assert.equal(doc.page.width.toFixed(2), '595.28');
    assert.ok(col.totalX >= col.left);
    assert.ok(col.totalX + col.totalW <= col.right + 0.01);
    assert.ok(col.right <= doc.page.width - INVOICE_PAGE_MARGIN + 0.01);
    assert.ok(col.detailsW >= 120);
    // Old layout ended at x=565; that is past A4 right margin (541).
    assert.ok(col.totalX + col.totalW < 565);
  });

  it('does not use the old Letter-only fixed columns that overflow A4', () => {
    const a4Width = 595.28;
    const col = invoiceLineItemColumns(a4Width, INVOICE_PAGE_MARGIN);
    const oldTotalEnd = 520 + 45;
    assert.ok(oldTotalEnd > a4Width - INVOICE_PAGE_MARGIN);
    assert.ok(col.totalX + col.totalW <= a4Width - INVOICE_PAGE_MARGIN + 0.01);
  });
});
