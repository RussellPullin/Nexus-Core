import { useState, useEffect, Fragment } from 'react';
import { billing, invoices } from '../lib/api';
import { formatDate } from '../lib/dateUtils';

export default function FinancialPage() {
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
  const [billingInvoices, setBillingInvoices] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [expandedParticipantId, setExpandedParticipantId] = useState(null);
  const [activeTab, setActiveTab] = useState('charges'); // 'charges' | 'batches' | 'invoices'
  const [shiftInvoices, setShiftInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [batches, setBatches] = useState([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [paymentFormInvoice, setPaymentFormInvoice] = useState(null);
  const [invoicePaymentAmount, setInvoicePaymentAmount] = useState('');
  const [invoicePaymentDate, setInvoicePaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [invoicePaymentNote, setInvoicePaymentNote] = useState('');
  const [invoicePaymentSubmitting, setInvoicePaymentSubmitting] = useState(false);
  const [sendingBatchRef, setSendingBatchRef] = useState(null);

  const loadDraft = async () => {
    setLoading(true);
    setDraft(null);
    setExpandedParticipantId(null);
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

  const loadBillingInvoices = async () => {
    try {
      const list = await billing.list();
      setBillingInvoices(list);
    } catch (e) {
      console.error(e);
    }
  };

  const loadAllInvoices = async () => {
    setInvoicesLoading(true);
    try {
      const [billingList, shiftList] = await Promise.all([billing.list(), invoices.list()]);
      setBillingInvoices(billingList);
      setShiftInvoices(shiftList);
    } catch (e) {
      console.error(e);
      // Keep existing lists on error so a failed refresh does not hide invoices after a successful create.
    } finally {
      setInvoicesLoading(false);
    }
  };

  const loadBatches = async () => {
    setBatchesLoading(true);
    try {
      const list = await billing.listBatches();
      setBatches(list);
    } catch (e) {
      console.error(e);
      // Do not clear batches on transient errors
    } finally {
      setBatchesLoading(false);
    }
  };

  useEffect(() => {
    loadBillingInvoices();
  }, []);

  useEffect(() => {
    if (activeTab === 'invoices') loadAllInvoices();
    if (activeTab === 'batches') loadBatches();
  }, [activeTab]);

  const toggleItem = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleParticipantSelection = (participantId) => {
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
      setExpandedParticipantId(null);
      await Promise.all([loadAllInvoices(), loadBatches()]);
      setActiveTab('batches');
    } catch (e) {
      alert(e.message || 'Failed to create batch');
    } finally {
      setCreating(false);
    }
  };

  const selectedTotal = draft?.participants?.reduce((sum, p) => {
    const pTotal = p.items?.filter((i) => selectedIds.has(i.id)).reduce((s, i) => s + i.total, 0) || 0;
    return sum + pTotal;
  }, 0) || 0;

  const participantsWithSelection = draft?.participants?.filter((p) =>
    p.items?.some((i) => selectedIds.has(i.id))
  ).length ?? 0;

  const handleDeleteInvoice = async (type, id) => {
    if (!window.confirm('Delete this invoice? The charges can be included in a new batch.')) return;
    try {
      if (type === 'batch') {
        await billing.delete(id);
        loadBatches();
      } else await invoices.delete(id);
      loadAllInvoices();
    } catch (e) {
      alert(e.message || 'Failed to delete invoice');
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
      await Promise.all([loadAllInvoices(), loadBatches()]);
      closeRecordInvoicePayment();
    } catch (e) {
      alert(e.message || 'Failed to record payment');
    } finally {
      setInvoicePaymentSubmitting(false);
    }
  };

  return (
    <div className="financial-page">
      <div className="page-header">
        <h2>Financial</h2>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <ul className="tabs" style={{ display: 'flex', gap: '0.5rem', listStyle: 'none', margin: 0, padding: 0, borderBottom: '1px solid #e2e8f0' }}>
          <li>
            <button
              type="button"
              className={activeTab === 'charges' ? 'active' : ''}
              onClick={() => setActiveTab('charges')}
              style={{ padding: '0.5rem 1rem', border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'charges' ? '2px solid var(--primary, #2563eb)' : '2px solid transparent', marginBottom: '-1px' }}
            >
              Batch invoices
            </button>
          </li>
          <li>
            <button
              type="button"
              className={activeTab === 'batches' ? 'active' : ''}
              onClick={() => setActiveTab('batches')}
              style={{ padding: '0.5rem 1rem', border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'batches' ? '2px solid var(--primary, #2563eb)' : '2px solid transparent', marginBottom: '-1px' }}
            >
              Invoice Batches
            </button>
          </li>
          <li>
            <button
              type="button"
              className={activeTab === 'invoices' ? 'active' : ''}
              onClick={() => setActiveTab('invoices')}
              style={{ padding: '0.5rem 1rem', border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'invoices' ? '2px solid var(--primary, #2563eb)' : '2px solid transparent', marginBottom: '-1px' }}
            >
              Invoices
            </button>
          </li>
        </ul>
      </div>

      {activeTab === 'charges' && (
        <>
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <h3 style={{ marginTop: 0 }}>Batch invoices</h3>
            <p style={{ color: '#64748b', marginBottom: '1rem' }}>
              Choose a period (e.g. one week). You&apos;ll see one draft invoice per participant. Click an invoice to view its line items, then confirm the batch when you&apos;re happy.
            </p>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Batch period – From</label>
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="form-input" />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>To</label>
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="form-input" />
              </div>
              <button type="button" className="btn btn-primary" onClick={loadDraft} disabled={loading}>
                {loading ? 'Loading...' : 'Show draft invoices'}
              </button>
            </div>
          </div>

          {draft && (
            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ marginTop: 0 }}>Draft invoices for {formatDate(fromDate)} – {formatDate(toDate)}</h3>
              <p style={{ color: '#64748b', marginBottom: '1rem', marginTop: '0.25rem' }}>One invoice per participant. Click an invoice to view line items.</p>
              {draft.participants?.length === 0 ? (
                <p className="muted">No draft invoices for this period.</p>
              ) : (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 32 }} />
                          <th style={{ width: 90 }}>Invoice</th>
                          <th>Participant</th>
                          <th>NDIS #</th>
                          <th style={{ textAlign: 'right' }}>Total</th>
                          <th style={{ textAlign: 'center', width: 120 }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {draft.participants.map((p, index) => {
                          const total = p.items?.reduce((s, i) => s + i.total, 0) ?? 0;
                          const isExpanded = expandedParticipantId === p.participant_id;
                          const itemCount = p.items?.length ?? 0;
                          return (
                            <Fragment key={p.participant_id}>
                              <tr
                                key={p.participant_id}
                                style={{ cursor: 'pointer', background: isExpanded ? 'var(--bg-subtle, #f8fafc)' : undefined }}
                                onClick={() => setExpandedParticipantId(isExpanded ? null : p.participant_id)}
                              >
                                <td>
                                  <span style={{ fontSize: '0.85rem' }}>{isExpanded ? '▼' : '▶'}</span>
                                </td>
                                <td style={{ color: '#64748b', fontWeight: 500 }}>Invoice {index + 1}</td>
                                <td><strong>{p.participant_name}</strong></td>
                                <td style={{ color: '#64748b' }}>{p.ndis_number || '–'}</td>
                                <td style={{ textAlign: 'right', fontWeight: 600 }}>${total.toFixed(2)}</td>
                                <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ fontSize: '0.8rem' }}
                                    onClick={() => setExpandedParticipantId(isExpanded ? null : p.participant_id)}
                                  >
                                    {isExpanded ? 'Hide line items' : 'View line items'} ({itemCount})
                                  </button>
                                </td>
                              </tr>
                              {isExpanded && p.items?.length > 0 && (
                                <tr key={`${p.participant_id}-detail`}>
                                  <td colSpan={6} style={{ padding: 0, verticalAlign: 'top', borderTop: 'none' }}>
                                    <div style={{ padding: '0.75rem 1rem 1rem 2rem', background: 'var(--bg-subtle, #f8fafc)', borderBottom: '1px solid #e2e8f0' }}>
                                      <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.9rem', fontWeight: 600 }}>Line items – uncheck to exclude from batch</p>
                                      <table style={{ width: '100%', fontSize: '0.9rem' }}>
                                        <thead>
                                          <tr>
                                            <th style={{ width: 32 }} />
                                            <th>Date</th>
                                            <th>Description</th>
                                            <th>Item</th>
                                            <th style={{ textAlign: 'right' }}>Qty</th>
                                            <th style={{ textAlign: 'right' }}>Total</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {p.items.map((item) => (
                                            <tr key={item.id}>
                                              <td>
                                                <input
                                                  type="checkbox"
                                                  checked={selectedIds.has(item.id)}
                                                  onChange={() => toggleItem(item.id)}
                                                  onClick={(e) => e.stopPropagation()}
                                                />
                                              </td>
                                              <td>{item.line_date ? formatDate(item.line_date) : ''}</td>
                                              <td>{item.description}</td>
                                              <td style={{ color: '#64748b' }}>{item.support_item_number}</td>
                                              <td style={{ textAlign: 'right' }}>{item.quantity} {item.unit}</td>
                                              <td style={{ textAlign: 'right' }}>${item.total.toFixed(2)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                                        <button
                                          type="button"
                                          className="btn btn-secondary"
                                          style={{ fontSize: '0.8rem' }}
                                          onClick={(e) => { e.stopPropagation(); toggleParticipantSelection(p.participant_id); }}
                                        >
                                          {p.items.every((i) => selectedIds.has(i.id)) ? 'Deselect all' : 'Select all'}
                                        </button>
                                      </p>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <span><strong>{participantsWithSelection} invoices</strong>, total ${selectedTotal.toFixed(2)}</span>
                    <button type="button" className="btn btn-primary" onClick={handleCreateBatch} disabled={creating || selectedIds.size === 0}>
                      {creating ? 'Creating...' : 'Confirm batch'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {activeTab === 'batches' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Invoice Batches</h3>
          <p style={{ color: '#64748b', marginBottom: '1rem' }}>
            Draft batches: <strong>Send batch to Xero</strong> creates an <em>authorised</em> accounts-receivable invoice in Xero for each participant (using your chart of accounts). Link Xero under Settings first. Nexus then marks each invoice sent and stores the Xero ID. Record payments in Nexus or reconcile in Xero.
          </p>
          {batchesLoading ? (
            <p>Loading...</p>
          ) : batches.length === 0 ? (
            <p className="muted">No batches yet. Use &quot;Batch invoices&quot; to create a batch.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Reference</th>
                    <th>Created</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>Outstanding</th>
                    <th style={{ width: 140 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => {
                    const createdDate = batch.created ? (() => {
                      const d = new Date(batch.created);
                      if (isNaN(d.getTime())) return '';
                      const day = String(d.getDate()).padStart(2, '0');
                      const month = String(d.getMonth() + 1).padStart(2, '0');
                      const year = d.getFullYear();
                      const h = d.getHours();
                      const m = d.getMinutes();
                      const ampm = h >= 12 ? 'pm' : 'am';
                      const h12 = h % 12 || 12;
                      return `${day}/${month}/${year} ${h12}:${String(m).padStart(2, '0')}${ampm}`;
                    })() : '';
                    return (
                      <tr key={batch.reference}>
                        <td>
                          <span className={`badge badge-${batch.status === 'finalised' ? 'success' : 'secondary'}`}>
                            {batch.status === 'finalised' ? 'Finalised' : 'Draft'}
                          </span>
                        </td>
                        <td><strong>{batch.reference}</strong></td>
                        <td style={{ color: '#64748b' }}>{createdDate}</td>
                        <td style={{ textAlign: 'right' }}>${batch.total.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td style={{ textAlign: 'right' }}>
                          {batch.outstanding === 0 ? '–' : `$${batch.outstanding.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                        </td>
                        <td>
                          {batch.status === 'draft' && (
                            <button
                              type="button"
                              className="btn btn-primary"
                              style={{ fontSize: '0.8rem' }}
                              disabled={sendingBatchRef === batch.batch_ref}
                              onClick={async () => {
                                setSendingBatchRef(batch.batch_ref);
                                try {
                                  const r = await billing.sendBatch(batch.batch_ref);
                                  await Promise.all([loadBatches(), loadBillingInvoices()]);
                                  if (r?.errors?.length) {
                                    const detail = r.errors
                                      .map((e) => `${e.invoice_number || e.billing_invoice_id}: ${e.error}`)
                                      .join('\n');
                                    alert(`${r.message || 'Some invoices failed in Xero.'}\n\n${detail}`);
                                  } else if (r?.message) {
                                    alert(r.message);
                                  }
                                } catch (e) {
                                  alert(e.message || 'Failed to send batch to Xero');
                                } finally {
                                  setSendingBatchRef(null);
                                }
                              }}
                            >
                              {sendingBatchRef === batch.batch_ref ? 'Sending to Xero…' : 'Send batch to Xero'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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

      {activeTab === 'invoices' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Invoices</h3>
          <p style={{ color: '#64748b', marginBottom: '1rem' }}>
            Batch invoices show total (GST-inclusive), paid, and outstanding per invoice. Use Record payment to match remittances; when fully paid, status becomes paid.
          </p>
          {invoicesLoading ? (
            <p>Loading...</p>
          ) : billingInvoices.length === 0 && shiftInvoices.length === 0 ? (
            <p className="muted">No invoices yet. Use &quot;Batch invoices&quot; to create a batch.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice #</th>
                    <th>Participant</th>
                    <th>Period / Date</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th style={{ textAlign: 'right' }}>Paid</th>
                    <th style={{ textAlign: 'right' }}>Outstanding</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {billingInvoices.map((inv) => {
                    const total = Number(inv.total) || 0;
                    const paid = Number(inv.paid) || 0;
                    const outstanding = Number(inv.outstanding) || 0;
                    return (
                    <tr key={`batch-${inv.id}`}>
                      <td>{inv.invoice_number}</td>
                      <td>{inv.participant_name}</td>
                      <td>{inv.period_from ? formatDate(inv.period_from) : ''} – {inv.period_to ? formatDate(inv.period_to) : ''}</td>
                      <td><span className="badge badge-secondary">Batch</span></td>
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
                            style={{ fontSize: '0.8rem', marginRight: '0.25rem' }}
                            onClick={async () => {
                              try {
                                await billing.updateStatus(inv.id, 'sent');
                                loadAllInvoices();
                              } catch (e) {
                                alert(e.message);
                              }
                            }}
                          >
                            Mark sent
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: '0.8rem' }}
                          onClick={() => handleDeleteInvoice('batch', inv.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );})}
                  {shiftInvoices.map((inv) => (
                    <tr key={`shift-${inv.id}`}>
                      <td>{inv.invoice_number}</td>
                      <td>{inv.participant_name}</td>
                      <td>{inv.start_time ? formatDate(inv.start_time) : '–'}</td>
                      <td><span className="badge badge-secondary">Shift</span></td>
                      <td style={{ textAlign: 'right', color: '#94a3b8' }}>–</td>
                      <td style={{ textAlign: 'right', color: '#94a3b8' }}>–</td>
                      <td style={{ textAlign: 'right', color: '#94a3b8' }}>–</td>
                      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                      <td>
                        <a href={invoices.pdfUrl(inv.id)} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ fontSize: '0.8rem', marginRight: '0.25rem' }}>PDF</a>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: '0.8rem' }}
                          onClick={() => handleDeleteInvoice('shift', inv.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
