import { useEffect, useMemo, useState } from 'react';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import { registers, documentLibrary, participants as participantsApi, staff as staffApi } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import '../App.css';

const EMPTY_INCIDENT_FORM = {
  incident_date: '',
  participant_id: '',
  staff_id: '',
  location: '',
  description: '',
  immediate_actions: '',
  follow_up: '',
  reported_by: '',
  reported_to: '',
  outcome: ''
};

const STATUS_STYLES = {
  Current: { background: '#dcfce7', color: '#166534', borderColor: '#86efac' },
  'Expiring Soon': { background: '#fef3c7', color: '#92400e', borderColor: '#fcd34d' },
  Expired: { background: '#fee2e2', color: '#991b1b', borderColor: '#fecaca' },
  Missing: { background: '#fee2e2', color: '#991b1b', borderColor: '#fecaca' },
  Manual: { background: '#e0f2fe', color: '#075985', borderColor: '#7dd3fc' },
  Shifter: { background: '#f1f5f9', color: '#334155', borderColor: '#cbd5e1' },
  Audit: { background: '#ede9fe', color: '#5b21b6', borderColor: '#c4b5fd' }
};

function statusBadge(value) {
  const style = STATUS_STYLES[value];
  if (!style) return value;
  return (
    <span style={{ ...style, border: `1px solid ${style.borderColor}`, borderRadius: 999, padding: '0.15rem 0.5rem', fontSize: '0.75rem', fontWeight: 700 }}>
      {value}
    </span>
  );
}

function getColumnIndex(view, name) {
  return view?.columns?.indexOf(name) ?? -1;
}

function rowDateInRange(row, view, from, to) {
  if (!view?.date_column || (!from && !to)) return true;
  const idx = getColumnIndex(view, view.date_column);
  if (idx < 0) return true;
  const time = new Date(row[idx]).getTime();
  if (Number.isNaN(time)) return false;
  if (from && time < new Date(from).getTime()) return false;
  if (to && time > new Date(to).getTime()) return false;
  return true;
}

function sortRows(rows, sort) {
  if (!sort) return rows;
  const { index, dir } = sort;
  return [...rows].sort((a, b) => {
    const av = a[index] ?? '';
    const bv = b[index] ?? '';
    const ad = new Date(av).getTime();
    const bd = new Date(bv).getTime();
    const cmp = !Number.isNaN(ad) && !Number.isNaN(bd)
      ? ad - bd
      : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return dir === 'desc' ? -cmp : cmp;
  });
}

export default function RegistersPage() {
  const pathPrefix = useProductPathPrefix();
  const { isAdmin, canAccessCaseTasks } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(null);
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState(null);
  const [libraryRegisters, setLibraryRegisters] = useState([]);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryMessage, setLibraryMessage] = useState('');
  const [preview, setPreview] = useState({ open: false, src: null, title: '' });
  const [incidentEntries, setIncidentEntries] = useState([]);
  const [participantsList, setParticipantsList] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [incidentPanelOpen, setIncidentPanelOpen] = useState(false);
  const [incidentForm, setIncidentForm] = useState(EMPTY_INCIDENT_FORM);
  const [editingIncidentId, setEditingIncidentId] = useState(null);
  const [savingIncident, setSavingIncident] = useState(false);
  const canManageIncidents = isAdmin || canAccessCaseTasks;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      registers.snapshot(),
      documentLibrary.listMasters().catch(() => []),
      registers.incidents().catch(() => ({ entries: [] })),
      participantsApi.list('', false).catch(() => []),
      staffApi.list(false).catch(() => [])
    ])
      .then(([snapshot, masters, incidents, participantRows, staffRows]) => {
        if (cancelled) return;
        setData(snapshot);
        const first = snapshot?.views?.[0]?.id;
        if (first) setActiveId(first);
        setLibraryRegisters((masters || []).filter((m) => m.category === 'register'));
        setIncidentEntries(incidents?.entries || []);
        setParticipantsList(participantRows || []);
        setStaffList(staffRows || []);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Could not load registers');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadRegisters = async () => {
    const [snapshot, incidents] = await Promise.all([registers.snapshot(), registers.incidents().catch(() => ({ entries: [] }))]);
    setData(snapshot);
    setIncidentEntries(incidents?.entries || []);
  };

  const active = data?.views?.find((v) => v.id === activeId) || data?.views?.[0];
  const activeFilter = filters[active?.id] || {};
  const manualById = useMemo(() => new Map(incidentEntries.map((e) => [String(e.id), e])), [incidentEntries]);
  const visibleColumnIndexes = useMemo(() => {
    if (!active) return [];
    return active.columns
      .map((col, index) => ({ col, index }))
      .filter(({ col }) => !['Manual ID', 'Shift ID'].includes(col));
  }, [active]);

  const filteredRows = useMemo(() => {
    if (!active) return [];
    const search = String(activeFilter.search || '').trim().toLowerCase();
    const statusIdx = active.status_column ? getColumnIndex(active, active.status_column) : -1;
    const rows = (active.rows || []).filter((row) => {
      if (activeFilter.status && statusIdx >= 0 && row[statusIdx] !== activeFilter.status) return false;
      if (!rowDateInRange(row, active, activeFilter.from, activeFilter.to)) return false;
      if (!search) return true;
      return visibleColumnIndexes.some(({ index }) => String(row[index] ?? '').toLowerCase().includes(search));
    });
    return sortRows(rows, sort?.viewId === active.id ? sort : null);
  }, [active, activeFilter, sort, visibleColumnIndexes]);

  const setActiveFilter = (patch) => {
    if (!active?.id) return;
    setFilters((prev) => ({ ...prev, [active.id]: { ...(prev[active.id] || {}), ...patch } }));
  };

  const handleSort = (index) => {
    if (!active) return;
    setSort((prev) => ({
      viewId: active.id,
      index,
      dir: prev?.viewId === active.id && prev.index === index && prev.dir === 'asc' ? 'desc' : 'asc'
    }));
  };

  const openNewIncident = () => {
    setEditingIncidentId(null);
    setIncidentForm(EMPTY_INCIDENT_FORM);
    setIncidentPanelOpen(true);
  };

  const openEditIncident = (manualId) => {
    const entry = manualById.get(String(manualId));
    if (!entry) return;
    setEditingIncidentId(entry.id);
    setIncidentForm({
      incident_date: entry.incident_date || '',
      participant_id: entry.participant_id || '',
      staff_id: entry.staff_id || '',
      location: entry.location || '',
      description: entry.description || '',
      immediate_actions: entry.immediate_actions || '',
      follow_up: entry.follow_up || '',
      reported_by: entry.reported_by || '',
      reported_to: entry.reported_to || '',
      outcome: entry.outcome || ''
    });
    setIncidentPanelOpen(true);
  };

  const saveIncident = async (e) => {
    e.preventDefault();
    setSavingIncident(true);
    try {
      if (editingIncidentId) await registers.updateIncident(editingIncidentId, incidentForm);
      else await registers.createIncident(incidentForm);
      setIncidentPanelOpen(false);
      setEditingIncidentId(null);
      setIncidentForm(EMPTY_INCIDENT_FORM);
      await reloadRegisters();
    } catch (err) {
      setError(err.message || 'Could not save incident');
    } finally {
      setSavingIncident(false);
    }
  };

  const deleteIncident = async (manualId) => {
    if (!manualId) return;
    if (!window.confirm('Delete this manual incident entry?')) return;
    await registers.deleteIncident(manualId);
    await reloadRegisters();
  };

  const handleExport = () => {
    if (!active) return;
    const url = registers.exportUrl({
      view: active.id,
      format: 'csv',
      from: activeFilter.from,
      to: activeFilter.to
    });
    window.location.href = url;
  };

  const handlePreviewRegister = (master) => {
    setPreview({
      open: true,
      src: documentLibrary.previewMasterUrl(master.id),
      title: `${master.display_name} - preview`
    });
  };

  const handleCloneAll = async () => {
    setLibraryBusy(true);
    setLibraryMessage('');
    try {
      const res = await documentLibrary.cloneAllToOrg();
      setLibraryMessage(`Cloned ${res.cloned || 0} master templates into your org.`);
      const list = await documentLibrary.listMasters();
      setLibraryRegisters((list || []).filter((m) => m.category === 'register'));
    } catch (e) {
      setLibraryMessage(e.message || 'Clone failed');
    } finally {
      setLibraryBusy(false);
    }
  };

  const jumpTo = (viewId, status) => {
    setActiveId(viewId);
    if (status) setFilters((prev) => ({ ...prev, [viewId]: { ...(prev[viewId] || {}), status } }));
  };

  if (loading) {
    return (
      <div className="content">
        <p>Loading registers...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="content">
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <p style={{ color: '#64748b', marginTop: '0.5rem' }}>Registers are available to organisation admins and coordinators.</p>
      </div>
    );
  }

  return (
    <div className="content">
      <div className="page-header" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Registers</h1>
        <p style={{ margin: '0.35rem 0 0', color: '#64748b', maxWidth: '52rem' }}>
          Live view of the same data Nexus pushes to <strong>Nexus Core / Register</strong> in OneDrive (when connected).
          Extending a Nexus feature with new compliance data should update rows here and in the next register sync.
        </p>
        {data?.generated_at && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#94a3b8' }}>
            Generated {new Date(data.generated_at).toLocaleString()}
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
        <button type="button" className="card" onClick={() => jumpTo('staff_compliance_register', 'Expiring Soon')} style={{ textAlign: 'left', padding: '1rem', border: '1px solid #e2e8f0', cursor: 'pointer' }}>
          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Staff with expiring certs</div>
          <strong style={{ fontSize: '1.5rem' }}>{data?.summary?.staff_expiring_certs_60_days ?? 0}</strong>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Next 60 days</div>
        </button>
        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Incidents this month</div>
          <strong style={{ fontSize: '1.5rem' }}>{data?.summary?.incidents_this_month ?? 0}</strong>
        </div>
        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Participants missing risk assessment</div>
          <strong style={{ fontSize: '1.5rem' }}>{data?.summary?.participants_missing_risk_assessment ?? 0}</strong>
        </div>
        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Plans expiring soon</div>
          <strong style={{ fontSize: '1.5rem' }}>{data?.summary?.participants_plan_expiring_60_days ?? 0}</strong>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Next 60 days</div>
        </div>
      </div>

      <div className="card" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.75rem' }}>
          {(data?.views || []).map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setActiveId(v.id);
                setSort(null);
              }}
              className={v.id === active?.id ? 'btn btn-primary' : 'btn btn-secondary'}
            >
              {v.title} <span style={{ opacity: 0.75 }}>({v.row_count})</span>
            </button>
          ))}
        </div>

        {active && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{active.title}</h2>
                {active.data_source && <p style={{ margin: '0.2rem 0 0', color: '#64748b', fontSize: '0.85rem' }}>Source: <code>{active.data_source}</code></p>}
              </div>
              {active.id === 'incident_register' && canManageIncidents && (
                <button type="button" className="btn btn-primary" onClick={openNewIncident}>Log Incident</button>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'end', marginTop: '1rem' }}>
              <label style={{ flex: '1 1 260px' }}>
                <span style={{ display: 'block', fontSize: '0.8rem', color: '#64748b' }}>Search</span>
                <input className="form-input" value={activeFilter.search || ''} onChange={(e) => setActiveFilter({ search: e.target.value })} placeholder="Search visible columns" />
              </label>
              {active.date_column && (
                <>
                  <label>
                    <span style={{ display: 'block', fontSize: '0.8rem', color: '#64748b' }}>From</span>
                    <input type="date" className="form-input" value={activeFilter.from || ''} onChange={(e) => setActiveFilter({ from: e.target.value })} />
                  </label>
                  <label>
                    <span style={{ display: 'block', fontSize: '0.8rem', color: '#64748b' }}>To</span>
                    <input type="date" className="form-input" value={activeFilter.to || ''} onChange={(e) => setActiveFilter({ to: e.target.value })} />
                  </label>
                </>
              )}
              {activeFilter.status && (
                <button type="button" className="btn btn-secondary" onClick={() => setActiveFilter({ status: '' })}>
                  Clear {activeFilter.status}
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={handleExport}>Export CSV</button>
            </div>

            <div style={{ overflowX: 'auto', maxHeight: 'min(64vh, 620px)', overflowY: 'auto', marginTop: '1rem' }}>
              <table className="table-condensed registers-data-table" style={{ fontSize: '0.82rem', whiteSpace: 'nowrap', width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr>
                    {visibleColumnIndexes.map(({ col, index }) => (
                      <th key={col} onClick={() => handleSort(index)} style={{ position: 'sticky', top: 0, background: '#f8fafc', cursor: 'pointer', zIndex: 1 }}>
                        {col}{sort?.viewId === active.id && sort.index === index ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </th>
                    ))}
                    {active.id === 'incident_register' && <th style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 1 }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr><td colSpan={visibleColumnIndexes.length + 1} style={{ color: '#64748b', padding: '1rem' }}>No rows match the current filters.</td></tr>
                  ) : (
                    filteredRows.map((row, ri) => {
                      const sourceIdx = getColumnIndex(active, 'Source');
                      const manualIdIdx = getColumnIndex(active, 'Manual ID');
                      const source = sourceIdx >= 0 ? row[sourceIdx] : '';
                      const manualId = manualIdIdx >= 0 ? row[manualIdIdx] : '';
                      return (
                        <tr key={`${ri}-${row.join('|')}`} style={{ background: ri % 2 ? '#f8fafc' : '#fff' }}>
                          {visibleColumnIndexes.map(({ index }) => (
                            <td key={index}>{statusBadge(row[index] ?? '')}</td>
                          ))}
                          {active.id === 'incident_register' && (
                            <td>
                              {source === 'Manual' && canManageIncidents ? (
                                <div style={{ display: 'flex', gap: '0.35rem' }}>
                                  <button type="button" className="btn btn-secondary" onClick={() => openEditIncident(manualId)}>Edit</button>
                                  <button type="button" className="btn btn-secondary" onClick={() => deleteIncident(manualId)}>Delete</button>
                                </div>
                              ) : (
                                <span style={{ color: '#94a3b8' }}>Read-only</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <p style={{ marginTop: '1.25rem', fontSize: '0.85rem', color: '#64748b' }}>
        To refresh Excel files in OneDrive, use <a href={`${pathPrefix}/admin`}>Admin - Refresh Registers Now</a>.
      </p>

      <div className="card" style={{ marginTop: '1.5rem', padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Register templates (document library)</h2>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
              Re-render any compliance register from the master library with your branding.
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={handleCloneAll} disabled={libraryBusy}>
            {libraryBusy ? 'Working...' : 'Clone all masters to my org'}
          </button>
        </div>
        {libraryMessage && <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#334155' }}>{libraryMessage}</div>}
        {libraryRegisters.length > 0 && (
          <table style={{ width: '100%', marginTop: '0.5rem', fontSize: '0.85rem' }}>
            <tbody>
              {libraryRegisters.map((m) => (
                <tr key={m.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '.35rem' }}>{m.display_name}</td>
                  <td style={{ padding: '.35rem', color: '#64748b' }}>{m.version}</td>
                  <td style={{ padding: '.35rem' }}>
                    <button type="button" className="btn btn-secondary" onClick={() => handlePreviewRegister(m)} disabled={libraryBusy}>Preview</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {incidentPanelOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
          <form onSubmit={saveIncident} className="card" style={{ width: 'min(520px, 100%)', height: '100%', overflowY: 'auto', padding: '1rem', borderRadius: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>{editingIncidentId ? 'Edit Incident' : 'Log Incident'}</h2>
              <button type="button" className="btn btn-secondary" onClick={() => setIncidentPanelOpen(false)}>Close</button>
            </div>
            <label className="form-group"><span>Date</span><input type="date" className="form-input" value={incidentForm.incident_date} onChange={(e) => setIncidentForm({ ...incidentForm, incident_date: e.target.value })} /></label>
            <label className="form-group"><span>Participant</span><select className="form-input" value={incidentForm.participant_id} onChange={(e) => setIncidentForm({ ...incidentForm, participant_id: e.target.value })}><option value="">Select participant</option>{participantsList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="form-group"><span>Staff</span><select className="form-input" value={incidentForm.staff_id} onChange={(e) => setIncidentForm({ ...incidentForm, staff_id: e.target.value })}><option value="">Select staff</option>{staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label className="form-group"><span>Location</span><input className="form-input" value={incidentForm.location} onChange={(e) => setIncidentForm({ ...incidentForm, location: e.target.value })} /></label>
            <label className="form-group"><span>Description</span><textarea className="form-input" rows={4} value={incidentForm.description} onChange={(e) => setIncidentForm({ ...incidentForm, description: e.target.value })} /></label>
            <label className="form-group"><span>Immediate actions</span><textarea className="form-input" rows={3} value={incidentForm.immediate_actions} onChange={(e) => setIncidentForm({ ...incidentForm, immediate_actions: e.target.value })} /></label>
            <label className="form-group"><span>Follow-up</span><textarea className="form-input" rows={3} value={incidentForm.follow_up} onChange={(e) => setIncidentForm({ ...incidentForm, follow_up: e.target.value })} /></label>
            <label className="form-group"><span>Reported by</span><input className="form-input" value={incidentForm.reported_by} onChange={(e) => setIncidentForm({ ...incidentForm, reported_by: e.target.value })} /></label>
            <label className="form-group"><span>Reported to</span><input className="form-input" value={incidentForm.reported_to} onChange={(e) => setIncidentForm({ ...incidentForm, reported_to: e.target.value })} /></label>
            <label className="form-group"><span>Outcome</span><textarea className="form-input" rows={3} value={incidentForm.outcome} onChange={(e) => setIncidentForm({ ...incidentForm, outcome: e.target.value })} /></label>
            <button type="submit" className="btn btn-primary" disabled={savingIncident}>{savingIncident ? 'Saving...' : 'Save incident'}</button>
          </form>
        </div>
      )}

      <DocumentPreviewModal
        open={preview.open}
        src={preview.src}
        title={preview.title}
        onClose={() => setPreview({ open: false, src: null, title: '' })}
      />
    </div>
  );
}
