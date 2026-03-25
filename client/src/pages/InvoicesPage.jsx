import { useState, useEffect } from 'react';
import { invoices } from '../lib/api';
import { formatDate } from '../lib/dateUtils';

export default function InvoicesPage() {
  const handleDownloadNdiaCsv = async () => {
    try {
      await invoices.downloadNdiaManagedCsv();
    } catch (err) {
      alert(err.message);
    }
  };
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const l = await invoices.list();
      setList(l);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (selected) {
      invoices.get(selected.id).then(setSelected).catch(() => setSelected(null));
    }
  }, [selected?.id]);

  const handleDownloadPdf = (id) => {
    window.open(invoices.pdfUrl(id), '_blank');
  };

  const handleMarkSent = async (id) => {
    try {
      await invoices.updateStatus(id, 'sent');
      load();
      if (selected?.id === id) setSelected({ ...selected, status: 'sent' });
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <div style={{ flex: 1 }}>
        <div className="page-header">
          <h2>Invoices</h2>
          <button className="btn btn-secondary" onClick={handleDownloadNdiaCsv}>Download NDIA Managed CSV</button>
        </div>
        <div className="card">
          {loading ? (
            <p>Loading...</p>
          ) : list.length === 0 ? (
            <div className="empty-state">
              <p>No invoices yet. Invoices are created when shifts are marked complete.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice #</th>
                    <th>Participant</th>
                    <th>Shift Date</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((inv) => (
                    <tr key={inv.id}>
                      <td>{inv.invoice_number}</td>
                      <td>{inv.participant_name}</td>
                      <td>{inv.start_time ? formatDate(inv.start_time) : '-'}</td>
                      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
                      <td>
                        <button className="btn btn-secondary" style={{ fontSize: '0.8rem', marginRight: '0.25rem' }} onClick={() => setSelected(inv)}>View</button>
                        <button className="btn btn-primary" style={{ fontSize: '0.8rem' }} onClick={() => handleDownloadPdf(inv.id)}>PDF</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="card" style={{ width: 400 }}>
          <h3>Invoice {selected.invoice_number}</h3>
          <p><strong>Participant:</strong> {selected.participant_name}</p>
          <p><strong>NDIS Number:</strong> {selected.ndis_number || '-'}</p>
          <p><strong>Support Date:</strong> {selected.support_date || '-'}</p>
          <p><strong>Status:</strong> <span className={`badge badge-${selected.status}`}>{selected.status}</span></p>
          {selected.line_items?.length > 0 && (
            <>
              <h4 style={{ marginTop: '1rem' }}>Line Items</h4>
              <table>
                <thead>
                  <tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>
                </thead>
                <tbody>
                  {selected.line_items.map((li, i) => (
                    <tr key={i}>
                      <td>{li.support_item_number}</td>
                      <td>{li.quantity}</td>
                      <td>${li.unit_price?.toFixed(2)}</td>
                      <td>${((li.quantity || 0) * (li.unit_price || 0)).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontWeight: 600, marginTop: '0.5rem' }}>Total: ${selected.total?.toFixed(2) || '0.00'}</p>
            </>
          )}
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-primary" onClick={() => handleDownloadPdf(selected.id)}>Download PDF</button>
            {selected.status === 'draft' && (
              <button className="btn btn-secondary" onClick={() => handleMarkSent(selected.id)}>Mark as Sent</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
