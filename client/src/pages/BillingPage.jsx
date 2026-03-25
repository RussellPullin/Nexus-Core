import { useState, useEffect } from 'react';
import { billing } from '../lib/api';
import { formatDate } from '../lib/dateUtils';

export default function BillingPage() {
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    d.setDate(0);
    return d.toISOString().slice(0, 10);
  });
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [paymentFormInvoice, setPaymentFormInvoice] = useState(null);
  const [invoicePaymentAmount, setInvoicePaymentAmount] = useState('');
  const [invoicePaymentDate, setInvoicePaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [invoicePaymentNote, setInvoicePaymentNote] = useState('');
  const [invoicePaymentSubmitting, setInvoicePaymentSubmitting] = useState(false);

  const loadDraft = async () => {
    setLoading(true);
    try {
      const data = await billing.draftBatch(fromDate, toDate);
      setDraft(data);
      const allIds = new Set();
      data.participants?.forEach((p) => p.items?.forEach((i) => allIds.add(i.id)));
      setSelectedIds(allIds);
    } catch (e) {
      console.error(e);
      setDraft(null);
    } finally {
      setLoading(false);
    }
  };

  const loadInvoices = async () => {
    try {
      const list = await billing.list();
      setInvoices(list);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadInvoices();
  }, []);

  const toggleItem = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleParticipant = (participantId) => {
    const p = draft.participants.find((x) => x.participant_id === participantId);
    if (!p?.items?.length) return;
    const allSelected = p.items.every((i) => selectedIds.has(i.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      p.items.forEach((i) => (allSelected ? next.delete(i.id) : next.add(i.id)));
      return next;
    });
  };

  const handleCreateBatch = async () => {
    if (selectedIds.size === 0) {
      alert('Select at least one line item to include.');
      return;
    }
    setCreating(true);
    try {
      await billing.createBatch({
        from_date: fromDate,
        to_date: toDate,
        selected_ids: Array.from(selectedIds)
      });
      setDraft(null);
      loadInvoices();
    } catch (e) {
      alert(e.message || 'Failed to create batch');
    } finally {
      setCreating(false);
    }
  };

  const openRecordInvoicePayment = (inv) => {
    const out = Number(inv.outstanding);
    if (!(out > 0)) return;
    setPaymentFormInvoice(inv);
    setInvoicePaymentAmount('');
    setInvoicePaymentDate(new Date().toISOString().slice(0, 10));
    setInvoicePaymentNote('');
  };

  const closeRecordInvoicePayment = () => {
    setPaymentFormInvoice(null);
    setInvoicePaymentAmount('');
    setInvoicePaymentNote('');
  };

  const handleRecordInvoicePayment = async (e) => {
    e.preventDefault();
    const amt = parseFloat(invoicePaymentAmount);
    if (!paymentFormInvoice || isNaN(amt) || amt <= 0) {
      alert('Enter a valid amount.');
      return;
    }
    const maxOut = Number(paymentFormInvoice.outstanding) || 0;
    if (amt > maxOut + 0.01) {
      alert(`Amount cannot exceed outstanding ($${maxOut.toFixed(2)}).`);
      return;
    }
    setInvoicePaymentSubmitting(true);
    try {
      await billing.recordInvoicePayment(paymentFormInvoice.id, {
        amount: amt,
        paid_at: invoicePaymentDate,
        note: invoicePaymentNote || undefined
      });
      await loadInvoices();
      closeRecordInvoicePayment();
    } catch (e) {
      alert(e.message || 'Failed to record payment');
    } finally {
      setInvoicePaymentSubmitting(false);
    }
  };

  const selectedTotal = draft?.participants?.reduce((sum, p) => {
    const pTotal = p.items?.filter((i) => selectedIds.has(i.id)).reduce((s, i) => s + i.total, 0) || 0;
    return sum + pTotal;
  }, 0) || 0;

  // Participants with at least one selected item = number of invoices that will be created (one per client per batch)
  const participantsWithSelection = draft?.participants?.filter((p) =>
    p.items?.some((i) => selectedIds.has(i.id))
  ).length ?? 0;

  return (
    <div className="billing-page">
      <div className="page-header">
        <h2>Billing</h2>
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginTop: 0 }}>Create batch invoice</h3>
        <p style={{ color: '#64748b', marginBottom: '1rem' }}>
          Select a time period to gather all unbilled tasks and shifts. Uncheck any items you don&apos;t want to include, then confirm.
        </p>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="form-input" />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="form-input" />
          </div>
          <button type="button" className="btn btn-primary" onClick={loadDraft} disabled={loading}>
            {loading ? 'Loading...' : 'Load draft'}
          </button>
        </div>
      </div>

      {draft && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginTop: 0 }}>Draft batch – {formatDate(fromDate) || '-'} to {formatDate(toDate) || '-'}</h3>
          <p style={{ color: '#64748b', marginBottom: '1rem' }}>
            Uncheck any line items to exclude from the batch. Each participant will receive one invoice with their selected items.
          </p>

          {draft.participants?.length === 0 ? (
            <p className="muted">No unbilled tasks or shifts in this period.</p>
          ) : (
            <>
              {draft.participants.map((p) => {
                const pSelected = p.items?.filter((i) => selectedIds.has(i.id)) || [];
                const pTotal = pSelected.reduce((s, i) => s + i.total, 0);
                const allChecked = p.items?.length > 0 && p.items.every((i) => selectedIds.has(i.id));
                return (
                  <div key={p.participant_id} className="billing-participant-block">
                    <div className="billing-participant-header" onClick={() => toggleParticipant(p.participant_id)}>
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={() => toggleParticipant(p.participant_id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <strong>{p.participant_name}</strong>
                      <span style={{ color: '#64748b', fontSize: '0.9rem' }}>{p.ndis_number}</span>
                      <span style={{ marginLeft: 'auto', fontWeight: 600 }}>${pTotal.toFixed(2)}</span>
                    </div>
                    <div className="billing-line-items">
                      {p.items?.map((item) => (
                        <div key={item.id} className="billing-line-item">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(item.id)}
                            onChange={() => toggleItem(item.id)}
                          />
                          <span className="billing-line-date">{item.line_date ? formatDate(item.line_date) : ''}</span>
                          <span className="billing-line-desc">{item.description}</span>
                          <span className="billing-line-qty">{item.quantity} {item.unit}</span>
                          <span className="billing-line-total">${item.total.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}

              <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span><strong>Selected total:</strong> ${selectedTotal.toFixed(2)}</span>
                <button type="button" className="btn btn-primary" onClick={handleCreateBatch} disabled={creating || selectedIds.size === 0}>
                  {creating ? 'Creating...' : `Confirm & create ${participantsWithSelection} invoice(s) (1 per participant)`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Billing invoices</h3>
        <p style={{ color: '#64748b', marginBottom: '1rem' }}>
          Amounts match the PDF (GST-inclusive when applicable). Record payments per invoice; when fully paid, status becomes paid.
        </p>
        {invoices.length === 0 ? (
          <p className="muted">No billing invoices yet. Create a batch above.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Participant</th>
                  <th>Period</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Paid</th>
                  <th style={{ textAlign: 'right' }}>Outstanding</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const total = Number(inv.total) || 0;
                  const paid = Number(inv.paid) || 0;
                  const outstanding = Number(inv.outstanding) || 0;
                  return (
                  <tr key={inv.id}>
                    <td>{inv.invoice_number}</td>
                    <td>{inv.participant_name}</td>
                    <td>{inv.period_from ? formatDate(inv.period_from) : ''} – {inv.period_to ? formatDate(inv.period_to) : ''}</td>
                    <td style={{ textAlign: 'right' }}>${total.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style={{ textAlign: 'right' }}>${paid.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style={{ textAlign: 'right', fontWeight: outstanding > 0 ? 600 : 400 }}>
                      {outstanding > 0
                        ? `$${outstanding.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '–'}
                    </td>
                    <td><span className={`badge badge-${inv.status === 'paid' ? 'paid' : inv.status}`}>{inv.status}</span></td>
                    <td>
                      <a href={billing.pdfUrl(inv.id)} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ fontSize: '0.8rem', marginRight: '0.25rem' }}>PDF</a>
                      {outstanding > 0 && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ fontSize: '0.8rem', marginRight: '0.25rem' }}
                          onClick={() => openRecordInvoicePayment(inv)}
                        >
                          Record payment
                        </button>
                      )}
                      {inv.status === 'draft' && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ fontSize: '0.8rem' }}
                          onClick={async () => {
                            try {
                              await billing.updateStatus(inv.id, 'sent');
                              loadInvoices();
                            } catch (e) {
                              alert(e.message);
                            }
                          }}
                        >
                          Mark sent
                        </button>
                      )}
                    </td>
                  </tr>
                );})}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {paymentFormInvoice && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={closeRecordInvoicePayment}>
          <div style={{ background: 'var(--bg, #fff)', padding: '1.5rem', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.15)', minWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Record payment – {paymentFormInvoice.invoice_number}</h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: '#64748b' }}>{paymentFormInvoice.participant_name}</p>
            <form onSubmit={handleRecordInvoicePayment}>
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label>Amount ($)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={Number(paymentFormInvoice.outstanding) || 0}
                  value={invoicePaymentAmount}
                  onChange={(e) => setInvoicePaymentAmount(e.target.value)}
                  className="form-input"
                  required
                />
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
                  Outstanding: ${(Number(paymentFormInvoice.outstanding) || 0).toFixed(2)} · Total: ${(Number(paymentFormInvoice.total) || 0).toFixed(2)}
                </p>
              </div>
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label>Date</label>
                <input type="date" value={invoicePaymentDate} onChange={(e) => setInvoicePaymentDate(e.target.value)} className="form-input" />
              </div>
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label>Note (optional)</label>
                <input type="text" value={invoicePaymentNote} onChange={(e) => setInvoicePaymentNote(e.target.value)} className="form-input" placeholder="e.g. EFT ref" />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={closeRecordInvoicePayment}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={invoicePaymentSubmitting}>
                  {invoicePaymentSubmitting ? 'Saving...' : 'Record payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
