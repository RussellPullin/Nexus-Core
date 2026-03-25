import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { ndis } from '../lib/api';
import { formatRate } from '../lib/format';

export default function NDISPage() {
  const { canManageUsers } = useAuth();
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [showDeleteSelectedConfirm, setShowDeleteSelectedConfirm] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [form, setForm] = useState({ support_item_number: '', description: '', rate: '', unit: 'hour', category: '' });
  const fileInputRef = useRef(null);
  const [importResult, setImportResult] = useState(null);
  const [lastImportedIds, setLastImportedIds] = useState([]);
  const [importMode, setImportMode] = useState('official'); // 'generic' | 'official'
  const [preview, setPreview] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [i, c] = await Promise.all([ndis.list(category, search), ndis.categories()]);
      setItems(i);
      setCategories(c);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [category, search]);

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await ndis.create({ ...form, rate: parseFloat(form.rate) });
      setShowModal(false);
      setForm({ support_item_number: '', description: '', rate: '', unit: 'hour', category: '' });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handlePreview = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      alert('Select a CSV file first');
      return;
    }
    try {
      const result = await ndis.importPreview(file);
      setPreview(result);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleImport = async (e) => {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      alert('Select a CSV file');
      return;
    }
    try {
      const result = await ndis.importCsv(file);
      setImportResult(result);
      setLastImportedIds(result.importedIds || []);
      setPreview(null);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUndoImport = async () => {
    if (lastImportedIds.length === 0) return;
    const count = lastImportedIds.length;
    try {
      await ndis.deleteSelected(lastImportedIds);
      setLastImportedIds([]);
      setImportResult(null);
      load();
      alert(`Undid import: removed ${count} line items.`);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this line item?')) return;
    try {
      await ndis.delete(id);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteAllClick = () => setShowDeleteAllConfirm(true);

  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const someSelected = selectedIds.size > 0;
  const toggleSelectAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(items.map(i => i.id)));
  };
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteSelectedClick = () => setShowDeleteSelectedConfirm(true);

  const handleDeleteSelectedConfirm = async () => {
    setShowDeleteSelectedConfirm(false);
    try {
      const result = await ndis.deleteSelected([...selectedIds]);
      setSelectedIds(new Set());
      await load();
      alert(`Deleted ${result.deleted} line items.`);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteAllConfirm = async () => {
    setShowDeleteAllConfirm(false);
    setSelectedIds(new Set());
    try {
      const result = await ndis.deleteAll();
      await load();
      alert(`Deleted ${result.deleted} line items.`);
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>NDIS Pricing Schedule</h2>
        {canManageUsers && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" onClick={() => setShowImportModal(true)}>Import CSV</button>
          {lastImportedIds.length > 0 && (
            <button type="button" className="btn btn-secondary" onClick={handleUndoImport}>
              Undo last import ({lastImportedIds.length} items)
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setShowModal(true)}>Add Line Item</button>
          {items.length > 0 && (
            <>
              <button type="button" className="btn btn-danger" onClick={handleDeleteSelectedClick} disabled={!someSelected}>
                Delete Selected ({selectedIds.size})
              </button>
              <button type="button" className="btn btn-danger" onClick={handleDeleteAllClick}>Delete All</button>
            </>
          )}
        </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
        <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
          <label>Search</label>
          <input placeholder="Support item or description..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0, width: 200 }}>
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="card">
        {loading ? (
          <p>Loading...</p>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <p>No NDIS line items.{canManageUsers ? ' Import from CSV, or add manually.' : ''}</p>
            {canManageUsers && (
              <>
                <button type="button" className="btn btn-primary" onClick={() => setShowImportModal(true)}>Import CSV</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(true)}>Add Manually</button>
              </>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {canManageUsers && (
                    <th style={{ width: 40 }}>
                      <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                        Select all
                      </label>
                    </th>
                  )}
                  <th>Support Item</th>
                  <th>Description</th>
                  <th>Rate</th>
                  <th>Unit</th>
                  <th>Category</th>
                  {canManageUsers && <th></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    {canManageUsers && (
                      <td>
                        <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                      </td>
                    )}
                    <td>{item.support_item_number}</td>
                    <td>{item.description}</td>
                    <td>{formatRate(item.rate)}</td>
                    <td>{item.unit || 'hour'}</td>
                    <td>{item.category || '-'}</td>
                    {canManageUsers && (
                      <td>
                        <button type="button" className="btn btn-danger" style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }} onClick={() => handleDelete(item.id)}>Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add NDIS Line Item</h3>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Support Item Number *</label>
                <input value={form.support_item_number} onChange={(e) => setForm({ ...form, support_item_number: e.target.value })} placeholder="e.g. 01_010_0105_1_1" required />
              </div>
              <div className="form-group">
                <label>Description *</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Rate ($) *</label>
                <input type="number" step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Unit</label>
                <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="hour" />
              </div>
              <div className="form-group">
                <label>Category</label>
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Daily Activities" />
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            </form>
          </div>
        </div>
      )}

      {showDeleteSelectedConfirm && (
        <div className="modal-overlay" onClick={() => setShowDeleteSelectedConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <h3>Delete Selected Items?</h3>
            <p style={{ margin: '0 0 1.5rem', color: '#64748b' }}>
              This will delete {selectedIds.size} line item{selectedIds.size !== 1 ? 's' : ''} and remove them from any shifts. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowDeleteSelectedConfirm(false)}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={handleDeleteSelectedConfirm}>Delete Selected</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteAllConfirm && (
        <div className="modal-overlay" onClick={() => setShowDeleteAllConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <h3>Delete All Pricing?</h3>
            <p style={{ margin: '0 0 1.5rem', color: '#64748b' }}>
              This will delete ALL NDIS pricing line items and remove line items from existing shifts. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowDeleteAllConfirm(false)}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={handleDeleteAllConfirm}>Delete All</button>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div className="modal-overlay" onClick={() => { setShowImportModal(false); setImportResult(null); setPreview(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Import NDIS Pricing (CSV)</h3>
            <div className="form-group">
              <label>Import format</label>
              <select value={importMode} onChange={(e) => setImportMode(e.target.value)}>
                <option value="generic">Generic CSV (support item, description, rate, unit, category)</option>
                <option value="official">Official NDIS Support Catalogue (Support Item Number, Remote, Very Remote)</option>
              </select>
            </div>
            <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '1rem' }}>
              {importMode === 'official'
                ? 'Use the official NDIS Support Catalogue exported as CSV. Includes standard, remote and very remote rates.'
                : 'File should have a header row. Columns: support item number (or code), description, rate, unit (optional), category (optional).'}
            </p>
            <form onSubmit={handleImport}>
              <div className="form-group">
                <label>Select CSV file</label>
                <input ref={fileInputRef} type="file" accept=".csv" onChange={() => setPreview(null)} />
              </div>
              {preview && (
                <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#f8fafc', borderRadius: 6, fontSize: '0.85rem', maxHeight: 200, overflow: 'auto' }}>
                  <strong>Preview</strong> (format: {preview.isOfficial ? 'Official NDIS' : 'Generic'})
                  <div style={{ marginTop: '0.5rem' }}>Headers: {preview.headers?.join(', ')}</div>
                  <div style={{ marginTop: '0.5rem' }}>Sample (first 5):</div>
                  <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                    {preview.sample?.map((s, i) => (
                      <li key={i}>{s.support_item_number} – {s.description} @ ${s.rate?.toFixed(2) ?? '-'}</li>
                    ))}
                  </ul>
                </div>
              )}
              {importResult && (
                <div style={{ marginBottom: '1rem' }}>
                  <p style={{ color: '#047857' }}>Imported {importResult.imported} of {importResult.total} rows.</p>
                  {lastImportedIds.length > 0 && (
                    <button type="button" className="btn btn-secondary" style={{ marginTop: '0.5rem' }} onClick={handleUndoImport}>
                      Undo import
                    </button>
                  )}
                </div>
              )}
              <button type="button" className="btn btn-secondary" onClick={handlePreview}>Preview</button>
              <button type="submit" className="btn btn-primary">Import</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowImportModal(false); setImportResult(null); setPreview(null); }}>Close</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
