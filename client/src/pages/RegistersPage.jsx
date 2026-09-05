import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import { registers, documentLibrary, participants as participantsApi, staff as staffApi, organisations, onboarding } from '../lib/api.js';
import { PARTICIPANT_INTAKE_FIELD_DEFS } from '@nexus-shared/onboardingFieldRegistry.js';
import { useAuth } from '../context/AuthContext.jsx';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import '../App.css';

const RISK_ASSESSMENT_FIELDS = PARTICIPANT_INTAKE_FIELD_DEFS.filter((d) => d.section === 'clinical');
const EMPTY_RISK_FORM = Object.fromEntries(RISK_ASSESSMENT_FIELDS.map((d) => [d.key, '']));
const RISK_FIELD_HELP = {
  risks_at_home: 'Risks at home (access, safety, hazards)',
  triggers_stressors: 'Known triggers or stressors',
  current_supports_strategies: 'Current supports or strategies',
  functional_assistance_needs: 'Functional assistance needs (daily living areas)',
  living_arrangements: 'Living arrangements (who do you live with)',
  mental_health_summary: 'Mental health summary'
};

function emptyRiskForm() {
  return { ...EMPTY_RISK_FORM };
}

function riskAssessmentIsEmpty(fields) {
  return RISK_ASSESSMENT_FIELDS.every((d) => !String(fields?.[d.key] ?? '').trim());
}

function riskRowIsEmpty(row) {
  return (row || []).slice(1).every((v) => !String(v ?? '').trim() || String(v).trim() === 'Not recorded');
}

function truncateCell(value, max = 72) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

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
  const [branding, setBranding] = useState({ primaryColor: '#1d4ed8', accentColor: '#0ea5e9' });
  const [editCell, setEditCell] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [savingCell, setSavingCell] = useState(false);
  const [addingRow, setAddingRow] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [catalogDraft, setCatalogDraft] = useState([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [organisationId, setOrganisationId] = useState(null);
  const [riskPanel, setRiskPanel] = useState({
    open: false,
    participantId: '',
    participantName: '',
    fields: emptyRiskForm(),
    isEmpty: true,
    loading: false,
    error: ''
  });
  const [savingRisk, setSavingRisk] = useState(false);
  const canManageIncidents = isAdmin || canAccessCaseTasks;
  const canEditRegisters = isAdmin || canAccessCaseTasks;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      registers.snapshot(),
      documentLibrary.listMasters().catch(() => []),
      registers.incidents().catch(() => ({ entries: [] })),
      participantsApi.list('', false).catch(() => []),
      staffApi.list(false).catch(() => []),
      organisations.getMyProfile().catch(() => null)
    ])
      .then(([snapshot, masters, incidents, participantRows, staffRows, profile]) => {
        if (cancelled) return;
        setData(snapshot);
        const first = snapshot?.views?.[0]?.id;
        if (first) setActiveId(first);
        setCatalogDraft(snapshot?.register_catalog || []);
        setLibraryRegisters((masters || []).filter((m) => m.category === 'register'));
        setIncidentEntries(incidents?.entries || []);
        setParticipantsList(participantRows || []);
        setStaffList(staffRows || []);
        if (profile?.organisation_id) setOrganisationId(profile.organisation_id);
        if (profile?.branding) {
          setBranding({
            primaryColor: profile.branding.primaryColor || '#1d4ed8',
            accentColor: profile.branding.accentColor || '#0ea5e9'
          });
        }
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
    setCatalogDraft(snapshot?.register_catalog || []);
    setIncidentEntries(incidents?.entries || []);
    if (activeId && !(snapshot?.views || []).some((v) => v.id === activeId)) {
      const next = snapshot?.views?.[0]?.id;
      if (next) setActiveId(next);
    }
  };

  const updateCatalogItem = (viewId, patch) => {
    setCatalogDraft((prev) =>
      prev.map((item) => {
        if (item.id !== viewId) return item;
        const next = { ...item, ...patch };
        if (patch.visible === false) next.editable = false;
        if (patch.visible === true && item.supports_inline_edit) next.editable = true;
        return next;
      })
    );
  };

  const saveRegisterSettings = async () => {
    setSavingSettings(true);
    setSettingsMessage('');
    try {
      const payload = catalogDraft.map(({ id, visible, editable }) => ({ view_id: id, visible, editable }));
      const snapshot = await registers.updateSettings(payload);
      setData(snapshot);
      setCatalogDraft(snapshot?.register_catalog || []);
      if (activeId && !(snapshot?.views || []).some((v) => v.id === activeId)) {
        const next = snapshot?.views?.[0]?.id;
        if (next) setActiveId(next);
      }
      setSettingsMessage('Register layout saved.');
    } catch (err) {
      setSettingsMessage(err.message || 'Could not save register settings');
    } finally {
      setSavingSettings(false);
    }
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

  const isRiskAssessmentView = active?.id === 'risk_assessment_register' || active?.row_mode === 'risk_assessment';
  const isEditableView = !isRiskAssessmentView && canEditRegisters && (active?.supports_inline_edit !== false) && !!active?.editable;
  const keyColIndex = active?.key_column_index ?? 0;

  const filteredRowEntries = useMemo(() => {
    if (!active) return [];
    const search = String(activeFilter.search || '').trim().toLowerCase();
    const statusIdx = active.status_column ? getColumnIndex(active, active.status_column) : -1;
    const entries = (active.rows || []).map((row, index) => ({
      row,
      rowKey: String(active.row_keys?.[index] ?? row[keyColIndex] ?? '').trim(),
      rowRef: active.row_refs?.[index] || null
    }));
    const filtered = entries.filter(({ row }) => {
      if (activeFilter.status && statusIdx >= 0 && row[statusIdx] !== activeFilter.status) return false;
      if (!rowDateInRange(row, active, activeFilter.from, activeFilter.to)) return false;
      if (!search) return true;
      return visibleColumnIndexes.some(({ index }) => String(row[index] ?? '').toLowerCase().includes(search));
    });
    const sorted = [...filtered].sort((a, b) => {
      if (!sort || sort.viewId !== active.id) return 0;
      const { index, dir } = sort;
      const av = a.row[index] ?? '';
      const bv = b.row[index] ?? '';
      const ad = new Date(av).getTime();
      const bd = new Date(bv).getTime();
      const cmp = !Number.isNaN(ad) && !Number.isNaN(bd)
        ? ad - bd
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return dir === 'desc' ? -cmp : cmp;
    });
    return sorted;
  }, [active, activeFilter, sort, visibleColumnIndexes, keyColIndex]);

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

  const addRegisterRow = async () => {
    if (!active?.id || !isEditableView) return;
    setAddingRow(true);
    try {
      const snapshot = await registers.addRow(active.id);
      if (snapshot?.views) {
        setData(snapshot);
        const updated = snapshot.views.find((v) => v.id === active.id);
        const newIndex = (updated?.rows?.length || 1) - 1;
        const newRowKey = updated?.row_keys?.[newIndex] || '';
        if (newRowKey) {
          setEditCell({ rowKey: newRowKey, colIndex: keyColIndex });
          setEditValue(String(updated?.rows?.[newIndex]?.[keyColIndex] ?? ''));
        }
      }
    } catch (err) {
      setError(err.message || 'Could not add row');
    } finally {
      setAddingRow(false);
    }
  };

  const removeRegisterRow = async (rowKey) => {
    if (!active?.id || !rowKey?.startsWith('@manual:')) return;
    if (!window.confirm('Delete this row?')) return;
    try {
      const snapshot = await registers.deleteRow(active.id, rowKey);
      if (snapshot?.views) setData(snapshot);
      cancelEditCell();
    } catch (err) {
      setError(err.message || 'Could not delete row');
    }
  };

  const beginEditCell = (rowKey, colIndex, currentValue) => {
    if (!isEditableView) return;
    setEditCell({ rowKey, colIndex });
    setEditValue(String(currentValue ?? ''));
  };

  const cancelEditCell = () => {
    setEditCell(null);
    setEditValue('');
  };

  const commitEditCell = async () => {
    if (!editCell || !active?.id) return cancelEditCell();
    setSavingCell(true);
    try {
      const snapshot = await registers.setCell(active.id, {
        rowKey: editCell.rowKey,
        colIndex: editCell.colIndex,
        value: editValue
      });
      if (snapshot?.views) setData(snapshot);
      cancelEditCell();
    } catch (err) {
      setError(err.message || 'Could not save edit');
    } finally {
      setSavingCell(false);
    }
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

  const resolveRiskParticipantId = (row, rowRef) => {
    if (rowRef?.participant_id) return String(rowRef.participant_id);
    const name = String(row?.[0] ?? '').trim().toLowerCase();
    if (!name) return '';
    const match = participantsList.find((p) => String(p.name || '').trim().toLowerCase() === name);
    return match?.id || '';
  };

  const closeRiskPanel = () => {
    setRiskPanel({
      open: false,
      participantId: '',
      participantName: '',
      fields: emptyRiskForm(),
      isEmpty: true,
      loading: false,
      error: ''
    });
  };

  const openRiskAssessment = async (row, rowRef) => {
    const participantId = resolveRiskParticipantId(row, rowRef);
    const participantName = String(row?.[0] ?? '').trim() || 'Participant';
    if (!participantId) {
      setRiskPanel({
        open: true,
        participantId: '',
        participantName,
        fields: emptyRiskForm(),
        isEmpty: true,
        loading: false,
        error: 'Could not find this participant. Open them from Participants and try again.'
      });
      return;
    }
    setRiskPanel({
      open: true,
      participantId,
      participantName,
      fields: emptyRiskForm(),
      isEmpty: true,
      loading: true,
      error: ''
    });
    try {
      let data = await onboarding.get(participantId).catch(() => null);
      if (!data) {
        data = await onboarding.initialize(participantId, organisationId);
      }
      const fields = emptyRiskForm();
      for (const def of RISK_ASSESSMENT_FIELDS) {
        fields[def.key] = String(data?.intake_fields?.[def.key] ?? '');
      }
      setRiskPanel({
        open: true,
        participantId,
        participantName,
        fields,
        isEmpty: riskAssessmentIsEmpty(fields),
        loading: false,
        error: ''
      });
    } catch (err) {
      setRiskPanel({
        open: true,
        participantId,
        participantName,
        fields: emptyRiskForm(),
        isEmpty: true,
        loading: false,
        error: err.message || 'Could not load risk assessment'
      });
    }
  };

  const saveRiskAssessment = async (e) => {
    e.preventDefault();
    if (!riskPanel.participantId) return;
    setSavingRisk(true);
    try {
      const existing = await onboarding.get(riskPanel.participantId).catch(() => null);
      if (!existing) {
        await onboarding.initialize(riskPanel.participantId, organisationId);
      }
      await onboarding.updateIntakeFields(riskPanel.participantId, riskPanel.fields);
      await reloadRegisters();
      closeRiskPanel();
    } catch (err) {
      setRiskPanel((prev) => ({ ...prev, error: err.message || 'Could not save risk assessment' }));
    } finally {
      setSavingRisk(false);
    }
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
        <h1 style={{ margin: 0, color: branding.primaryColor }}>Registers</h1>
        <p style={{ margin: '0.35rem 0 0', color: '#64748b', maxWidth: '52rem' }}>
          Live view of the same data Nexus pushes to <strong>Nexus Core / Register</strong> in OneDrive (when connected).
          Compliance registers maintained in Excel (conflict of interest, medication storage, continuous improvement, emergency tests, waste removal) are imported from your Register folder.
        </p>
        {data?.generated_at && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#94a3b8' }}>
            Generated {new Date(data.generated_at).toLocaleString()}
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
        <button type="button" className="card" onClick={() => jumpTo('staff_compliance_register', 'Expiring Soon')} style={{ textAlign: 'left', padding: '1rem', border: '1px solid #e2e8f0', borderLeft: `4px solid ${branding.accentColor}`, cursor: 'pointer' }}>
          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Staff with expiring certs</div>
          <strong style={{ fontSize: '1.5rem' }}>{data?.summary?.staff_expiring_certs_60_days ?? 0}</strong>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Next 60 days</div>
        </button>
        <div className="card" style={{ padding: '1rem', borderLeft: `4px solid ${branding.accentColor}` }}>
          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Incidents this month</div>
          <strong style={{ fontSize: '1.5rem' }}>{data?.summary?.incidents_this_month ?? 0}</strong>
        </div>
        <button type="button" className="card" onClick={() => jumpTo('risk_assessment_register')} style={{ textAlign: 'left', padding: '1rem', border: '1px solid #e2e8f0', borderLeft: `4px solid ${branding.accentColor}`, cursor: 'pointer' }}>
          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Participants missing risk assessment</div>
          <strong style={{ fontSize: '1.5rem' }}>{data?.summary?.participants_missing_risk_assessment ?? 0}</strong>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Click to open Risk Assessments</div>
        </button>
        <div className="card" style={{ padding: '1rem', borderLeft: `4px solid ${branding.accentColor}` }}>
          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Plans expiring soon</div>
          <strong style={{ fontSize: '1.5rem' }}>{data?.summary?.participants_plan_expiring_60_days ?? 0}</strong>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Next 60 days</div>
        </div>
      </div>

      {canEditRegisters && catalogDraft.length > 0 && (
        <div className="card" style={{ marginBottom: '1rem', padding: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Register layout</h2>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
                Choose which registers appear in the live view. Visible registers can be edited cell-by-cell. Incidents and Risk Assessments use a form.
              </p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setSettingsOpen((v) => !v)}>
              {settingsOpen ? 'Hide options' : 'Configure registers'}
            </button>
          </div>
          {settingsOpen && (
            <>
              <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
                <table className="table-condensed" style={{ width: '100%', fontSize: '0.85rem' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Register</th>
                      <th style={{ textAlign: 'center', width: '7rem' }}>Live view</th>
                      <th style={{ textAlign: 'center', width: '7rem' }}>Editable</th>
                      <th style={{ textAlign: 'left' }}>Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalogDraft.map((item) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '0.4rem 0.35rem' }}>
                          <strong>{item.title}</strong>
                          {item.roadmap_note && (
                            <div style={{ color: '#94a3b8', fontSize: '0.78rem', marginTop: '0.15rem' }}>Coming soon — no Nexus data yet</div>
                          )}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={!!item.visible}
                            onChange={(e) => updateCatalogItem(item.id, { visible: e.target.checked })}
                            aria-label={`Show ${item.title} in live view`}
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {item.supports_inline_edit ? (
                            <input
                              type="checkbox"
                              checked={!!item.editable}
                              disabled={!item.visible}
                              onChange={(e) => updateCatalogItem(item.id, { editable: e.target.checked })}
                              aria-label={`Allow inline editing for ${item.title}`}
                            />
                          ) : (
                            <span style={{ color: '#94a3b8', fontSize: '0.78rem' }} title="Uses a dedicated form (Incidents, Risk Assessments)">Form</span>
                          )}
                        </td>
                        <td style={{ color: '#64748b' }}>{item.row_count ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" onClick={saveRegisterSettings} disabled={savingSettings}>
                  {savingSettings ? 'Saving...' : 'Save register layout'}
                </button>
                {settingsMessage && <span style={{ fontSize: '0.85rem', color: '#334155' }}>{settingsMessage}</span>}
              </div>
            </>
          )}
        </div>
      )}

      <div className="card" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.75rem' }}>
          {(data?.views || []).length === 0 ? (
            <p style={{ margin: 0, color: '#64748b', fontSize: '0.9rem' }}>
              No registers selected for the live view. Use <strong>Configure registers</strong> to add them.
            </p>
          ) : (
            (data?.views || []).map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setActiveId(v.id);
                setSort(null);
                cancelEditCell();
              }}
              className={v.id === active?.id ? 'btn btn-primary' : 'btn btn-secondary'}
              style={v.id === active?.id ? { background: branding.primaryColor, borderColor: branding.primaryColor } : undefined}
            >
              {v.title} <span style={{ opacity: 0.75 }}>({v.row_count})</span>
            </button>
            ))
          )}
        </div>

        {active && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{active.title}</h2>
                {active.data_source && (
                  <p style={{ margin: '0.2rem 0 0', color: '#64748b', fontSize: '0.85rem' }}>Source: <code>{active.data_source}</code></p>
                )}
                {active.roadmap_note && (
                  <p style={{ margin: '0.35rem 0 0', color: '#b45309', fontSize: '0.85rem' }}>{active.roadmap_note}</p>
                )}
                {isEditableView && (
                  <p style={{ margin: '0.2rem 0 0', color: branding.accentColor, fontSize: '0.8rem' }}>
                    Click any cell to edit, or use Add row when the register is empty. Manual edits sync to the register files.
                  </p>
                )}
                {isRiskAssessmentView && (
                  <p style={{ margin: '0.2rem 0 0', color: branding.accentColor, fontSize: '0.8rem' }}>
                    Click a participant to view their risk assessment, or complete it if it is empty.
                  </p>
                )}
              </div>
              {active.id === 'incident_register' && canManageIncidents && (
                <button type="button" className="btn btn-primary" onClick={openNewIncident}>Log Incident</button>
              )}
              {isEditableView && active.id !== 'incident_register' && (
                <button type="button" className="btn btn-primary" onClick={addRegisterRow} disabled={addingRow}>
                  {addingRow ? 'Adding...' : 'Add row'}
                </button>
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
                      <th key={col} onClick={() => handleSort(index)} style={{ position: 'sticky', top: 0, background: branding.primaryColor, color: '#fff', cursor: 'pointer', zIndex: 1 }}>
                        {col}{sort?.viewId === active.id && sort.index === index ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </th>
                    ))}
                    {(isRiskAssessmentView || active.id === 'incident_register' || (isEditableView && active.id !== 'incident_register')) && (
                      <th style={{ position: 'sticky', top: 0, background: branding.primaryColor, color: '#fff', zIndex: 1 }}>Actions</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filteredRowEntries.length === 0 ? (
                    <tr>
                      <td colSpan={visibleColumnIndexes.length + (isEditableView || isRiskAssessmentView || active.id === 'incident_register' ? 1 : 0)} style={{ color: '#64748b', padding: '1rem' }}>
                        {isEditableView && active.id !== 'incident_register' && !(activeFilter.search || activeFilter.from || activeFilter.to || activeFilter.status) ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <span>No rows yet.</span>
                            <button type="button" className="btn btn-secondary" onClick={addRegisterRow} disabled={addingRow}>
                              {addingRow ? 'Adding...' : 'Add first row'}
                            </button>
                          </div>
                        ) : (
                          'No rows match the current filters.'
                        )}
                      </td>
                    </tr>
                  ) : (
                    filteredRowEntries.map(({ row, rowKey, rowRef }, ri) => {
                      const sourceIdx = getColumnIndex(active, 'Source');
                      const manualIdIdx = getColumnIndex(active, 'Manual ID');
                      const source = sourceIdx >= 0 ? row[sourceIdx] : '';
                      const manualId = manualIdIdx >= 0 ? row[manualIdIdx] : '';
                      const canEditRow = isEditableView && !!rowKey;
                      const emptyRisk = isRiskAssessmentView && riskRowIsEmpty(row);
                      return (
                        <tr
                          key={`${rowKey || ri}-${row.join('|')}`}
                          onClick={isRiskAssessmentView ? () => openRiskAssessment(row, rowRef) : undefined}
                          style={{
                            background: ri % 2 ? '#f8fafc' : '#fff',
                            cursor: isRiskAssessmentView ? 'pointer' : undefined
                          }}
                          title={isRiskAssessmentView ? (emptyRisk ? 'Click to complete risk assessment' : 'Click to view risk assessment') : undefined}
                        >
                          {visibleColumnIndexes.map(({ index }) => {
                            const editing = isEditableView && editCell && editCell.rowKey === rowKey && editCell.colIndex === index;
                            if (editing) {
                              return (
                                <td key={index} style={{ padding: '0.15rem' }}>
                                  <input
                                    autoFocus
                                    className="form-input"
                                    value={editValue}
                                    disabled={savingCell}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onBlur={commitEditCell}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') { e.preventDefault(); commitEditCell(); }
                                      else if (e.key === 'Escape') { e.preventDefault(); cancelEditCell(); }
                                    }}
                                    style={{ minWidth: '8rem', fontSize: '0.82rem', padding: '0.2rem 0.35rem' }}
                                  />
                                </td>
                              );
                            }
                            const display = statusBadge(row[index] ?? '');
                            return (
                              <td
                                key={index}
                                onClick={() => canEditRow && beginEditCell(rowKey, index, row[index])}
                                title={canEditRow ? 'Click to edit' : (isRiskAssessmentView ? String(row[index] ?? '') : undefined)}
                                style={{ cursor: canEditRow ? 'text' : (isRiskAssessmentView ? 'pointer' : 'default') }}
                              >
                                {isRiskAssessmentView && index > 0 && typeof display === 'string' ? truncateCell(display) : display}
                              </td>
                            );
                          })}
                          {isRiskAssessmentView && (
                            <td>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openRiskAssessment(row, rowRef);
                                }}
                              >
                                {emptyRisk ? 'Complete' : 'View'}
                              </button>
                            </td>
                          )}
                          {isEditableView && active.id !== 'incident_register' && (
                            <td>
                              {rowKey.startsWith('@manual:') ? (
                                <button type="button" className="btn btn-secondary" onClick={() => removeRegisterRow(rowKey)}>Delete</button>
                              ) : (
                                <span style={{ color: '#94a3b8' }}>—</span>
                              )}
                            </td>
                          )}
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

      {riskPanel.open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
          <form onSubmit={saveRiskAssessment} className="card" style={{ width: 'min(560px, 100%)', height: '100%', overflowY: 'auto', padding: '1rem', borderRadius: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>{riskPanel.isEmpty ? 'Complete risk assessment' : 'Risk assessment'}</h2>
              <button type="button" className="btn btn-secondary" onClick={closeRiskPanel}>Close</button>
            </div>
            <p style={{ margin: '0.5rem 0 1rem', color: '#64748b' }}>
              {riskPanel.participantName}
              {riskPanel.isEmpty
                ? ' — no risk assessment recorded yet. Complete the fields below.'
                : ' — review the full assessment and update it if needed.'}
            </p>
            {riskPanel.error && <p style={{ color: '#b91c1c' }}>{riskPanel.error}</p>}
            {riskPanel.loading ? (
              <p>Loading risk assessment...</p>
            ) : (
              <>
                {RISK_ASSESSMENT_FIELDS.map((def) => (
                  <label key={def.key} className="form-group">
                    <span>{RISK_FIELD_HELP[def.key] || def.label}</span>
                    {def.key === 'living_arrangements' ? (
                      <input
                        className="form-input"
                        value={riskPanel.fields[def.key] || ''}
                        disabled={!canEditRegisters}
                        onChange={(e) => setRiskPanel((prev) => ({
                          ...prev,
                          fields: { ...prev.fields, [def.key]: e.target.value }
                        }))}
                      />
                    ) : (
                      <textarea
                        className="form-input"
                        rows={3}
                        value={riskPanel.fields[def.key] || ''}
                        disabled={!canEditRegisters}
                        onChange={(e) => setRiskPanel((prev) => ({
                          ...prev,
                          fields: { ...prev.fields, [def.key]: e.target.value }
                        }))}
                      />
                    )}
                  </label>
                ))}
                {canEditRegisters && riskPanel.participantId && (
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <button type="submit" className="btn btn-primary" disabled={savingRisk}>
                      {savingRisk ? 'Saving...' : (riskPanel.isEmpty ? 'Save risk assessment' : 'Update risk assessment')}
                    </button>
                    <Link to={`${pathPrefix}/onboarding/${riskPanel.participantId}`} style={{ fontSize: '0.85rem' }}>
                      Open full intake
                    </Link>
                  </div>
                )}
              </>
            )}
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
