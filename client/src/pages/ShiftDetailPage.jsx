import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { shifts, ndis, invoices } from '../lib/api';
import { formatDate } from '../lib/dateUtils';

const CLAIM_TYPES = [
  { value: 'standard', label: 'Direct Service' },
  { value: 'provider_travel', label: 'Provider Travel' },
  { value: 'participant_travel', label: 'Travel with Participant' },
  { value: 'non_face_to_face', label: 'Non-Face-to-Face' }
];

function toDatetimeLocal(dt) {
  if (!dt) return '';
  const s = String(dt).slice(0, 19).replace(' ', 'T');
  return s.slice(0, 16);
}

export default function ShiftDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [shift, setShift] = useState(null);
  const [lineItems, setLineItems] = useState([]);
  const [ndisItems, setNdisItems] = useState([]);
  const [invoice, setInvoice] = useState(null);
  const [tab, setTab] = useState('finance');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [addChargeForm, setAddChargeForm] = useState({ ndis_line_item_id: '', quantity: '1', unit_price: '', claim_type: 'standard' });
  const [editingQty, setEditingQty] = useState(null);
  const [qtyValue, setQtyValue] = useState('');
  const [travelItems, setTravelItems] = useState({ km: [], time: [] });
  const [showAddTravel, setShowAddTravel] = useState(false);
  const [addTravelQty, setAddTravelQty] = useState('');
  const [shiftReceipts, setShiftReceipts] = useState([]);

  const loadShiftData = async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    try {
      let [s, items, invList, receipts] = await Promise.all([
        shifts.get(id),
        shifts.lineItems.list(id),
        invoices.list({ shift_id: id }),
        shifts.receipts(id).catch(() => [])
      ]);
      if (s?.shifter_shift_id && (parseFloat(s?.expenses) || 0) === 0) {
        try {
          const refreshed = await shifts.refreshExpense(id);
          if (refreshed && (parseFloat(refreshed.expenses) || 0) > 0) s = refreshed;
        } catch (_) { /* ignore */ }
      }
      setShift(s);
      setLineItems(items);
      setNotes(s?.notes || '');
      setInvoice(invList?.[0] || null);
      setShiftReceipts(Array.isArray(receipts) ? receipts : []);
    } catch (e) {
      console.error(e);
      const msg = (e?.message || '').toLowerCase();
      setNotFound(msg.includes('404') || msg.includes('not found') || msg.includes('shift not found'));
      setLoadError(e?.message || 'Failed to load shift');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    loadShiftData();
  }, [id]);

  // When existing line items exist, filter by same support_category so next items suit the first
  const getSupportCategoryFromItem = (item) => {
    const num = item?.support_item_number || '';
    const prefix = num.split('_')[0];
    return /^\d{2}$/.test(prefix) ? prefix : null;
  };

  // Travel rule: when hourly line item is e.g. 04_104, travel time uses same item (04_104), travel km uses 04_799
  const mainHourlyItem = lineItems.find((li) => {
    const num = li?.support_item_number || '';
    return num && !num.includes('_799');
  });
  const travelCategory = mainHourlyItem ? getSupportCategoryFromItem(mainHourlyItem) : null;

  useEffect(() => {
    if (tab === 'finance') {
      ndis.travelItems(travelCategory).then((t) => setTravelItems(t || { km: [], time: [] })).catch(() => setTravelItems({ km: [], time: [] }));
    }
  }, [tab, travelCategory]);

  const loadNdisItems = async (supportCategoryFilter) => {
    try {
      const params = supportCategoryFilter ? { support_category: supportCategoryFilter } : {};
      const list = await ndis.list(params);
      setNdisItems(list || []);
    } catch (e) {
      console.error(e);
      setNdisItems([]);
    }
  };

  const handleSaveNotes = async () => {
    try {
      await shifts.update(id, { ...shift, notes });
    } catch (err) {
      alert(err.message);
    }
  };

  const openAddCharge = async () => {
    const supportCategory = lineItems.length > 0 ? getSupportCategoryFromItem(lineItems[0]) : null;
    const defaultItemId = lineItems.length === 0 && shift?.participant_default_ndis_line_item_id
      ? shift.participant_default_ndis_line_item_id
      : null;
    await loadNdisItems(defaultItemId ? null : supportCategory);
    const last = lineItems[lineItems.length - 1];
    setAddChargeForm({
      ndis_line_item_id: defaultItemId || '',
      quantity: last ? String(last.quantity) : '1',
      unit_price: '',
      claim_type: last?.claim_type || 'standard'
    });
    setShowAddCharge(true);
  };

  const handleAddCharge = async (e) => {
    e.preventDefault();
    let qty = parseFloat(addChargeForm.quantity) || 1;
    const selected = ndisItems.find((n) => n.id === addChargeForm.ndis_line_item_id);
    const wholeUnit = selected && ['each', 'day', 'week', 'year'].includes((selected.unit || '').toLowerCase());
    if (wholeUnit) qty = Math.round(qty);
    const effectiveRate = selected && (selected.rate_remote ?? selected.rate_very_remote ?? selected.rate);
    const isQuotable = effectiveRate == null || Number(effectiveRate) === 0;
    if (isQuotable && (!addChargeForm.unit_price || String(addChargeForm.unit_price).trim() === '')) {
      alert('This is a quotable support (no set price). Please enter the agreed unit price.');
      return;
    }
    const payload = {
      ndis_line_item_id: addChargeForm.ndis_line_item_id,
      quantity: qty,
      claim_type: addChargeForm.claim_type
    };
    if (isQuotable && addChargeForm.unit_price != null && String(addChargeForm.unit_price).trim() !== '') {
      payload.unit_price = parseFloat(addChargeForm.unit_price);
    }
    try {
      const added = await shifts.lineItems.add(id, payload);
      setLineItems((prev) => [...prev, added]);
      setShowAddCharge(false);
      setAddChargeForm({ ndis_line_item_id: '', quantity: '1', unit_price: '', claim_type: 'standard' });
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUpdateQuantity = async (lineItem) => {
    let qty = parseFloat(qtyValue);
    if (isNaN(qty) || qty < 0) return;
    const wholeUnit = ['each', 'day', 'week', 'year'].includes((lineItem.unit || '').toLowerCase());
    if (wholeUnit) qty = Math.round(qty);
    try {
      const updated = await shifts.lineItems.update(id, lineItem.id, { quantity: qty });
      setLineItems((prev) => prev.map((li) => (li.id === lineItem.id ? updated : li)));
      setEditingQty(null);
      setQtyValue('');
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteCharge = async (lineItem) => {
    if (!confirm('Remove this charge?')) return;
    try {
      await shifts.lineItems.delete(id, lineItem.id);
      setLineItems((prev) => prev.filter((li) => li.id !== lineItem.id));
    } catch (err) {
      alert(err.message);
    }
  };

  const totalCost = lineItems.reduce((sum, li) => sum + (li.quantity || 0) * (li.unit_price || 0), 0);
  const claimTypeLabel = (v) => CLAIM_TYPES.find((c) => c.value === v)?.label || v;

  // Exclude travel items from dropdown when charges exist – use quick-add buttons instead
  const isTravelItem = (n) => (n?.support_item_number || '').startsWith('07_799') || (n?.support_item_number || '').startsWith('07_001');
  const displayNdisItems = lineItems.length > 0 ? ndisItems.filter((n) => !isTravelItem(n)) : ndisItems;

  const openAddTravelKm = () => {
    setAddTravelQty('');
    setShowAddTravel('km');
  };

  const handleAddTravelKm = async (e) => {
    e?.preventDefault?.();
    const item = travelItems.km[0];
    if (!item) {
      alert('No travel (km) item in NDIS catalogue. Import the NDIS Support Catalogue first.');
      return;
    }
    const qty = parseFloat(addTravelQty);
    if (isNaN(qty) || qty <= 0) {
      alert('Enter a valid quantity (km).');
      return;
    }
    try {
      const added = await shifts.lineItems.add(id, {
        ndis_line_item_id: item.id,
        quantity: qty,
        claim_type: 'participant_travel'
      });
      setLineItems((prev) => [...prev, added]);
      setShowAddTravel(false);
      setAddTravelQty('');
    } catch (err) {
      alert(err.message);
    }
  };

  const openAddTravelTime = () => {
    setAddTravelQty('');
    setShowAddTravel('time');
  };

  const handleAddTravelTime = async (e) => {
    e?.preventDefault?.();
    // Travel rule: use same line item as hourly (e.g. 04_104) when present; else 07_001 for Support Coordination
    const item = mainHourlyItem
      ? { id: mainHourlyItem.ndis_line_item_id }
      : travelItems.time[0];
    if (!item?.id) {
      alert('Add an hourly charge first, or ensure a travel (time) item exists in the NDIS catalogue.');
      return;
    }
    const qty = parseFloat(addTravelQty);
    if (isNaN(qty) || qty <= 0) {
      alert('Enter a valid quantity (hours).');
      return;
    }
    try {
      const added = await shifts.lineItems.add(id, {
        ndis_line_item_id: item.id,
        quantity: qty,
        claim_type: 'provider_travel'
      });
      setLineItems((prev) => [...prev, added]);
      setShowAddTravel(false);
      setAddTravelQty('');
    } catch (err) {
      alert(err.message);
    }
  };

  if (loading && !loadError) {
    return (
      <div className="card">
        <p>Loading shift...</p>
      </div>
    );
  }

  if (loadError || notFound || !shift) {
    return (
      <div className="card">
        <p>{loadError || 'Shift not found. It may have been deleted or the link is invalid.'}</p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          {loadError && (
            <button type="button" className="btn btn-primary" onClick={() => loadShiftData()}>
              Retry
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/shifts')}>
            Back to Shifts
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="page-header" style={{ marginBottom: '1rem' }}>
          <div>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginRight: '0.5rem', marginBottom: '0.5rem' }}
              onClick={() => navigate('/shifts')}
            >
              ← Back
            </button>
            <h2 style={{ margin: '0.5rem 0 0', display: 'inline-block' }}>
              {shift.participant_name} – {formatDate(shift.start_time)}
            </h2>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <a href={shifts.icsUrl(id)} download className="btn btn-secondary">
              Download ICS
            </a>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!shift.roster_sent_at}
              onClick={async () => {
                try {
                  await shifts.sendIcs(id);
                  setShift((prev) => ({ ...prev, roster_sent_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }));
                } catch (err) {
                  alert(err?.message || 'Failed to send');
                }
              }}
              title={shift.roster_sent_at ? 'Already sent – move or edit shift to send again' : 'Email shift to staff'}
            >
              {shift.roster_sent_at ? 'Sent ✓' : 'Send to staff'}
            </button>
            {invoice && (
              <Link to="/invoices" className="btn btn-primary">
                View Invoice
              </Link>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}>
          <button
            type="button"
            className={`btn ${tab === 'notes' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ borderRadius: '6px 6px 0 0', marginBottom: '-1px' }}
            onClick={() => setTab('notes')}
          >
            Notes
          </button>
          <button
            type="button"
            className={`btn ${tab === 'finance' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ borderRadius: '6px 6px 0 0', marginBottom: '-1px' }}
            onClick={() => setTab('finance')}
          >
            Finance
          </button>
        </div>

        {tab === 'notes' && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Session Notes</h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={8}
              style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid #e2e8f0' }}
              placeholder="Notes from the worker..."
            />
            <button type="button" className="btn btn-primary" style={{ marginTop: '0.5rem' }} onClick={handleSaveNotes}>
              Save Notes
            </button>
          </div>
        )}

        {tab === 'finance' && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Charges</h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" onClick={openAddCharge}>
                  Add Charge
                </button>
                {lineItems.length > 0 && travelItems.km?.length > 0 && (
                  <button type="button" className="btn btn-secondary" onClick={openAddTravelKm} title="Add travel with participant (km)">
                    + Travel (km)
                  </button>
                )}
                {lineItems.length > 0 && (mainHourlyItem || travelItems.time?.length > 0) && (
                  <button type="button" className="btn btn-secondary" onClick={openAddTravelTime} title="Add provider travel time (same line item as hourly, e.g. 04_104)">
                    + Travel (time)
                  </button>
                )}
              </div>
            </div>

            {lineItems.length === 0 ? (
              <div className="empty-state" style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                <p>No charges yet. Add charges from the NDIS pricing catalogue.</p>
                <button type="button" className="btn btn-primary" onClick={openAddCharge}>
                  Add Charge
                </button>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Quantity</th>
                      <th>Total cost</th>
                      <th>Claim Type</th>
                      <th style={{ width: 60 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((li) => (
                      <tr key={li.id}>
                        <td>
                          <span title={li.description}>
                            {li.support_item_number} – {li.description?.slice(0, 50)}
                            {li.description?.length > 50 ? '…' : ''}
                          </span>
                        </td>
                        <td>
                          {editingQty === li.id ? (
                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                              <input
                                type="number"
                                className="no-spinner"
                                value={qtyValue}
                                onChange={(e) => setQtyValue(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleUpdateQuantity(li)}
                                step="any"
                                min={0}
                                style={{ width: 80, padding: '0.25rem' }}
                                autoFocus
                              />
                              <span style={{ fontSize: '0.85rem', color: '#64748b' }}>{li.unit}</span>
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                                onClick={() => handleUpdateQuantity(li)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                                onClick={() => { setEditingQty(null); setQtyValue(''); }}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '0.25rem',
                                textAlign: 'left',
                                color: '#3b82f6'
                              }}
                              onClick={() => {
                                setEditingQty(li.id);
                                setQtyValue(String(li.quantity));
                              }}
                            >
                              {li.quantity} {li.unit}
                            </button>
                          )}
                        </td>
                        <td>${((li.quantity || 0) * (li.unit_price || 0)).toFixed(2)}</td>
                        <td>{claimTypeLabel(li.claim_type)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                            onClick={() => handleDeleteCharge(li)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {lineItems.length > 0 && (
              <p style={{ fontWeight: 600, marginTop: '1rem', fontSize: '1.1rem' }}>
                Total: ${totalCost.toFixed(2)}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ width: 280, flexShrink: 0 }}>
        <h3 style={{ marginTop: 0 }}>Session Details</h3>
        <p><strong>Participant:</strong><br /><Link to={`/participants/${shift.participant_id}`}>{shift.participant_name}</Link></p>
        <p><strong>Staff:</strong><br />{shift.staff_name}</p>
        <p><strong>Date:</strong><br />{formatDate(shift.start_time)}</p>
        <p><strong>Time:</strong><br />
          {shift.start_time ? new Date(shift.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}
          {' – '}
          {shift.end_time ? new Date(shift.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}
        </p>
        <p><strong>Expenses:</strong><br />
          {(parseFloat(shift.expenses) || 0) > 0 ? (
            <>Y<br />${Number(shift.expenses).toFixed(2)}</>
          ) : (
            <>
              N
              {shift.shifter_shift_id ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ marginTop: '0.25rem', fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                  onClick={async () => {
                    try {
                      const refreshed = await shifts.refreshExpense(id);
                      if (refreshed) setShift(refreshed);
                    } catch (e) {
                      alert(e?.message || 'Failed to refresh');
                    }
                  }}
                >
                  Refresh from Excel
                </button>
              ) : (
                <span style={{ fontSize: '0.7rem', color: '#64748b', display: 'block', marginTop: 2 }}>
                  Run Sync from Excel to pull expense data
                </span>
              )}
            </>
          )}
        </p>
        <p><strong>Receipt:</strong><br />{shiftReceipts.length > 0 ? 'Y' : 'N'}</p>
        <p>
          <strong>Status:</strong><br />
          <span className={`badge badge-${shift.status}`}>{shift.status}</span>
        </p>
        {invoice && (
          <p>
            <strong>Invoice:</strong><br />
            <span className={`badge badge-${invoice.status}`}>{invoice.invoice_number}</span>
            {' '}({invoice.status})
          </p>
        )}
        {shiftReceipts.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <strong>Expense Receipts</strong>
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
              {shiftReceipts.map((r) => (
                <li key={r.id} style={{ marginBottom: '0.25rem' }}>
                  <a href={`/api/participants/${shift.participant_id}/documents/${r.id}/file`} target="_blank" rel="noopener noreferrer">
                    {r.receipt_description || r.filename}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {showAddCharge && (
        <div
          className="modal-overlay"
          onClick={() => setShowAddCharge(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
        >
          <div
            className="modal card"
            style={{ maxWidth: 480, maxHeight: '90vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Add Charge</h3>
            {lineItems.length > 0 && (
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.5rem' }}>
                Showing items from same category as first charge. <button type="button" onClick={() => loadNdisItems()} style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>Show all items</button>
              </p>
            )}
            <form onSubmit={handleAddCharge}>
              <div className="form-group">
                <label>NDIS Line Item *</label>
                <select
                  value={addChargeForm.ndis_line_item_id}
                  onChange={(e) => setAddChargeForm({ ...addChargeForm, ndis_line_item_id: e.target.value })}
                  required
                  style={{ width: '100%' }}
                >
                  <option value="">Select...</option>
                  {displayNdisItems.map((n) => {
                    const effRate = n.rate_remote ?? n.rate_very_remote ?? n.rate;
                    const quotable = effRate == null || Number(effRate) === 0;
                    return (
                      <option key={n.id} value={n.id}>
                        {n.support_item_number} – {n.description?.slice(0, 60)}
                        {n.description?.length > 60 ? '…' : ''} {quotable ? '(Quotable – enter agreed price)' : `($${Number(effRate).toFixed(2)}/${n.unit || 'hr'})`}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="form-group">
                <label>Quantity *</label>
                <input
                  type="number"
                  className="no-spinner"
                  value={addChargeForm.quantity}
                  onChange={(e) => setAddChargeForm({ ...addChargeForm, quantity: e.target.value })}
                  step="any"
                  min="0.01"
                  required
                />
              </div>
              {(() => {
                const selected = ndisItems.find((n) => n.id === addChargeForm.ndis_line_item_id);
                const effRate = selected && (selected.rate_remote ?? selected.rate_very_remote ?? selected.rate);
                const isQuotable = selected && (effRate == null || Number(effRate) === 0);
                return isQuotable ? (
                  <div className="form-group">
                    <label>Agreed unit price ($) *</label>
                    <input
                      type="number"
                      className="no-spinner"
                      value={addChargeForm.unit_price}
                      onChange={(e) => setAddChargeForm({ ...addChargeForm, unit_price: e.target.value })}
                      step="0.01"
                      min="0"
                      required
                      placeholder="Enter agreed price per unit"
                    />
                  </div>
                ) : null;
              })()}
              <div className="form-group">
                <label>Claim Type</label>
                <select
                  value={addChargeForm.claim_type}
                  onChange={(e) => setAddChargeForm({ ...addChargeForm, claim_type: e.target.value })}
                >
                  {CLAIM_TYPES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button type="submit" className="btn btn-primary">Add</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddCharge(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddTravel && (
        <div
          className="modal-overlay"
          onClick={() => setShowAddTravel(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
        >
          <div
            className="modal card"
            style={{ maxWidth: 360 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{showAddTravel === 'km' ? 'Add Travel (km)' : 'Add Travel (time)'}</h3>
            <form onSubmit={showAddTravel === 'km' ? handleAddTravelKm : handleAddTravelTime}>
              <div className="form-group">
                <label>Quantity ({showAddTravel === 'km' ? 'km' : 'hours'}) *</label>
                <input
                  type="number"
                  className="no-spinner"
                  value={addTravelQty}
                  onChange={(e) => setAddTravelQty(e.target.value)}
                  step="any"
                  min="0.01"
                  required
                  placeholder={showAddTravel === 'km' ? 'e.g. 15' : 'e.g. 0.5'}
                  autoFocus
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button type="submit" className="btn btn-primary">Add</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddTravel(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
