import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeComplianceDocStatus,
  documentTypeLabel,
  isIndependentSupportWorker,
  INDEPENDENT_WORKER_REQUIRED_DOC_TYPES
} from '../../../shared/staffComplianceDocs.js';
import {
  buildReadableExcelBuffer,
  buildReadablePdfBuffer,
  buildCsvString
} from '../services/readableTableExport.service.js';

test('independent support worker detection', () => {
  assert.equal(isIndependentSupportWorker('independent_support_worker'), true);
  assert.equal(isIndependentSupportWorker('independent'), true);
  assert.equal(isIndependentSupportWorker('employee'), false);
});

test('document labels prefer display name for other certificates', () => {
  assert.equal(documentTypeLabel('yellow_card'), 'Yellow Card');
  assert.equal(documentTypeLabel('other', 'CPR Certificate'), 'CPR Certificate');
});

test('expiry status windows', () => {
  assert.equal(computeComplianceDocStatus('2020-01-01', '2026-09-07'), 'expired');
  assert.equal(computeComplianceDocStatus('2026-09-20', '2026-09-07'), 'expiring_soon');
  assert.equal(computeComplianceDocStatus('2027-09-07', '2026-09-07'), 'valid');
  assert.equal(computeComplianceDocStatus(null, '2026-09-07'), 'missing_expiry');
});

test('independent worker required docs include yellow and blue cards', () => {
  assert.ok(INDEPENDENT_WORKER_REQUIRED_DOC_TYPES.includes('yellow_card'));
  assert.ok(INDEPENDENT_WORKER_REQUIRED_DOC_TYPES.includes('blue_card'));
});

test('readable excel and pdf buffers generate', async () => {
  const columns = ['Worker', 'Certificate', 'Status', 'Expiry'];
  const rows = [
    ['Alex Worker', 'Yellow Card', 'Valid', '2027-01-01'],
    ['Alex Worker', 'Blue Card', 'Expiring Soon', '2026-09-20']
  ];
  const xlsx = await buildReadableExcelBuffer({
    title: 'Staff Compliance',
    subtitle: 'Test org',
    metaLines: ['Generated for unit test'],
    columns,
    rows,
    sheetName: 'Compliance'
  });
  assert.ok(Buffer.isBuffer(xlsx));
  assert.ok(xlsx.length > 500);

  const pdf = await buildReadablePdfBuffer({
    title: 'Staff Compliance',
    subtitle: 'Test org',
    metaLines: ['Generated for unit test'],
    columns,
    rows
  });
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.slice(0, 4).toString() === '%PDF');

  const csv = buildCsvString(columns, rows);
  assert.match(csv, /Yellow Card/);
});
