import { Router } from 'express';
import { db } from '../db/index.js';
import { generateInvoicePDF, getInvoiceData } from '../services/invoice.service.js';

const router = Router();

// Extract support category (01-15) from support_item_number
function getSupportCategory(supportItem) {
  if (!supportItem || typeof supportItem !== 'string') return null;
  const parts = supportItem.trim().split('_');
  const prefix = parts[0] || supportItem.slice(0, 2);
  return /^\d{2}$/.test(prefix) ? prefix : null;
}

// Download CSV of NDIA-managed invoice line items (for NDIA portal submission)
router.get('/ndia-managed-csv', (req, res) => {
  try {
    const invoices = db.prepare(`
      SELECT i.*, s.start_time, s.end_time, p.name as participant_name, p.ndis_number, p.ndia_managed_services,
             st.name as staff_name
      FROM invoices i
      JOIN shifts s ON i.shift_id = s.id
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      ORDER BY s.start_time DESC
    `).all();
    let ndiaList = [];
    for (const inv of invoices) {
      try {
        const cats = typeof inv.ndia_managed_services === 'string'
          ? JSON.parse(inv.ndia_managed_services || '[]')
          : (inv.ndia_managed_services || []);
        if (!Array.isArray(cats) || cats.length === 0) continue;
      } catch {
        continue;
      }
      const lineItems = db.prepare(`
        SELECT sli.*, nli.support_item_number, nli.support_category, nli.description, nli.unit
        FROM shift_line_items sli
        JOIN ndis_line_items nli ON sli.ndis_line_item_id = nli.id
        WHERE sli.shift_id = ?
      `).all(inv.shift_id);
      const supportDate = inv.start_time ? new Date(inv.start_time).toISOString().slice(0, 10) : '';
      const ndiaCats = (() => { try { return JSON.parse(inv.ndia_managed_services || '[]'); } catch { return []; } })();
      for (const li of lineItems) {
        const cat = getSupportCategory(li.support_item_number) || li.support_category;
        if (!cat || !ndiaCats.includes(cat)) continue;
        const total = (li.quantity || 0) * (li.unit_price || 0);
        ndiaList.push({
          invoice_number: inv.invoice_number,
          participant_name: inv.participant_name,
          ndis_number: inv.ndis_number,
          support_date: supportDate,
          staff_name: inv.staff_name,
          support_item_number: li.support_item_number,
          description: li.description,
          quantity: li.quantity,
          unit: li.unit,
          unit_price: li.unit_price,
          total
        });
      }
    }
    const headers = ['Invoice #', 'Participant', 'NDIS Number', 'Support Date', 'Staff', 'Support Item', 'Description', 'Quantity', 'Unit', 'Unit Price', 'Total'];
    const escape = (v) => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = ndiaList.map((r) => [
      r.invoice_number, r.participant_name, r.ndis_number, r.support_date, r.staff_name,
      r.support_item_number, r.description, r.quantity, r.unit, r.unit_price, r.total
    ].map(escape).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="ndia-managed-invoices.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    let invoices = db.prepare(`
      SELECT i.*, s.start_time, s.end_time, p.name as participant_name, p.ndis_number, st.name as staff_name
      FROM invoices i
      JOIN shifts s ON i.shift_id = s.id
      JOIN participants p ON s.participant_id = p.id
      JOIN staff st ON s.staff_id = st.id
      ORDER BY i.created_at DESC
    `).all();
    if (req.query.shift_id) {
      invoices = invoices.filter((inv) => inv.shift_id === req.query.shift_id);
    }
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM invoices WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
    return res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const data = getInvoiceData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const pdf = await generateInvoicePDF(req.params.id);
    if (!pdf) return res.status(404).send('Invoice not found');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${req.params.id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/status', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE invoices SET status = ?, updated_at = datetime("now") WHERE id = ?').run(status, req.params.id);
  res.json({ id: req.params.id, status });
});

export default router;
