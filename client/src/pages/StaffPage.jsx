import { useState, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { staff } from '../lib/api';

/** Matches profiles.role enum-style values used in NexusCore. */
const ROLE_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'Support Worker', label: 'Support Worker' },
  { value: 'Team Leader', label: 'Team Leader' },
  { value: 'Coordinator', label: 'Coordinator' },
  { value: 'Admin', label: 'Admin' },
  { value: 'Manager', label: 'Manager' },
];

const SUPPORT_WORKER = 'Support Worker';

function staffMatchesSearch(s, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const name = (s.name || '').toLowerCase();
  const email = (s.email || '').toLowerCase();
  const phone = (s.phone || '').toLowerCase();
  return name.includes(needle) || email.includes(needle) || phone.includes(needle);
}

function staffMatchesRoleFilter(s, roleFilter) {
  if (!roleFilter) return true;
  return (s.role || '').trim() === roleFilter;
}

function ShifterStatusBadge({ status }) {
  const palette = {
    not_enabled: { bg: '#f1f5f9', color: '#64748b', label: 'Not enabled' },
    invited: { bg: '#fef3c7', color: '#92400e', label: 'Invited' },
    active: { bg: '#d1fae5', color: '#065f46', label: 'Active' },
  };
  const p = palette[status] || palette.not_enabled;
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: '0.7rem',
        fontWeight: 600,
        letterSpacing: '0.02em',
        padding: '0.15rem 0.45rem',
        borderRadius: '999px',
        background: p.bg,
        color: p.color,
        whiteSpace: 'nowrap',
      }}
    >
      {p.label}
    </span>
  );
}

export default function StaffPage() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notify_email: true, notify_sms: false, role: '', employment_type: 'employee', hourly_rate: '' });
  const [selectedStaffIds, setSelectedStaffIds] = useState([]);
  const [shifterSavingId, setShifterSavingId] = useState(null);
  const [inviteSending, setInviteSending] = useState(false);
  const selectAllRef = useRef(null);

  const displayList = useMemo(
    () => list.filter((s) => staffMatchesSearch(s, search) && staffMatchesRoleFilter(s, roleFilter)),
    [list, search, roleFilter]
  );

  const selectedSet = useMemo(() => new Set(selectedStaffIds), [selectedStaffIds]);
  const supportWorkerFilter = roleFilter === SUPPORT_WORKER;

  const allVisibleSelected =
    supportWorkerFilter && displayList.length > 0 && displayList.every((s) => selectedSet.has(s.id));
  const someVisibleSelected =
    supportWorkerFilter && displayList.some((s) => selectedSet.has(s.id)) && !allVisibleSelected;

  useEffect(() => {
    const el = selectAllRef.current;
    if (el) el.indeterminate = someVisibleSelected;
  }, [someVisibleSelected, displayList.length, allVisibleSelected]);

  useEffect(() => {
    if (!supportWorkerFilter) setSelectedStaffIds([]);
  }, [supportWorkerFilter]);

  const load = async () => {
    setLoading(true);
    try {
      const s = await staff.list(showArchived);
      setList(s);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [showArchived]);

  const toggleRowSelected = (id) => {
    setSelectedStaffIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSelectAllVisible = () => {
    if (allVisibleSelected) {
      const visibleIds = new Set(displayList.map((s) => s.id));
      setSelectedStaffIds((prev) => prev.filter((id) => !visibleIds.has(id)));
    } else {
      const visibleIds = displayList.map((s) => s.id);
      setSelectedStaffIds((prev) => [...new Set([...prev, ...visibleIds])]);
    }
  };

  const handleShifterToggle = async (s, nextEnabled) => {
    if (!s.email?.trim()) {
      alert('Add an email address for this staff member so they can be linked to a Supabase profile for Shifter.');
      return;
    }
    setShifterSavingId(s.id);
    try {
      const data = await staff.setShifterEnabled(s.id, nextEnabled);
      setList((prev) =>
        prev.map((row) =>
          row.id === s.id
            ? {
                ...row,
                shifter_enabled: data.shifter_enabled,
                shifter_status: data.shifter_status,
                supabase_profile_id: data.supabase_profile_id ?? data.profile_id ?? row.supabase_profile_id,
                shifter_worker_profile_id: data.shifter_worker_profile_id ?? row.shifter_worker_profile_id,
              }
            : row
        )
      );
    } catch (err) {
      alert(err.message || 'Could not update Shifter access');
    } finally {
      setShifterSavingId(null);
    }
  };

  const handleSendShifterInvites = async () => {
    const selectedRows = list.filter((s) => selectedSet.has(s.id));
    const targets = selectedRows.filter((s) => !s.shifter_enabled);
    if (targets.length === 0) {
      alert('None of the selected staff need an invite (Shifter is already enabled for them).');
      return;
    }
    setInviteSending(true);
    try {
      const { results } = await staff.sendShifterInvites(targets.map((s) => s.id));
      console.log('[Send Shifter Invites]', results);
      await load();
      setSelectedStaffIds([]);
    } catch (err) {
      alert(err.message || 'Failed to send Shifter invites');
    } finally {
      setInviteSending(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await staff.create(form);
      setShowModal(false);
      setForm({ name: '', email: '', phone: '', notify_email: true, notify_sms: false, role: '', employment_type: 'employee', hourly_rate: '' });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleArchive = async (s) => {
    if (!confirm(`Archive ${s.name}? They will be hidden from staff lists but can be restored.`)) return;
    try {
      await staff.archive(s.id);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUnarchive = async (s) => {
    try {
      await staff.unarchive(s.id);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async (s) => {
    if (!confirm(`Permanently delete ${s.name}? This cannot be undone. All shifts and related data will be removed.`)) return;
    try {
      await staff.delete(s.id);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const selectedCount = selectedStaffIds.length;

  return (
    <div>
      <div className="page-header">
        <h2>Staff</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>Add Staff</button>
        </div>
      </div>
      <div className="search-bar" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search by name, email, or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search staff"
        />
        <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: '#64748b', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>Role</span>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filter by role"
            style={{ minWidth: '11rem' }}
          >
            {ROLE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-label" style={{ margin: 0 }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
      <div className="card">
        {loading ? (
          <p>Loading...</p>
        ) : list.length === 0 ? (
          <div className="empty-state">
            <p>No staff yet. Add staff to schedule shifts and assign participants.</p>
            <p style={{ marginTop: '0.5rem', color: '#64748b', fontSize: '0.9rem' }}>Click &quot;Add Staff&quot; below to create support workers. Then click a name to open their profile and assign participants.</p>
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>Add Staff</button>
          </div>
        ) : displayList.length === 0 ? (
          <div className="empty-state">
            <p>No staff match your search or role filter.</p>
            <p style={{ marginTop: '0.5rem', color: '#64748b', fontSize: '0.9rem' }}>
              Try clearing the search box, setting Role to All, or including archived staff if they are hidden.
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setSearch('');
                setRoleFilter('');
              }}
            >
              Clear search and role
            </button>
          </div>
        ) : (
          <>
            {supportWorkerFilter && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '0.75rem 1rem',
                  marginBottom: '0.75rem',
                  paddingBottom: '0.75rem',
                  borderBottom: '1px solid #e2e8f0',
                }}
              >
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' }}>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={handleSelectAllVisible}
                    aria-label="Select all visible support workers"
                  />
                  Select all
                </label>
                {selectedCount > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: '0.875rem' }}
                    disabled={inviteSending}
                    onClick={handleSendShifterInvites}
                  >
                    {inviteSending ? 'Sending…' : 'Send Shifter Invites'}
                  </button>
                )}
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {supportWorkerFilter && (
                      <th style={{ width: '2.5rem' }} aria-label="Select row" />
                    )}
                    <th>Name</th>
                    <th>Role</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Notifications</th>
                    <th>Shifter</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {displayList.map((s) => (
                    <tr key={s.id} style={s.archived_at ? { opacity: 0.7 } : undefined}>
                      {supportWorkerFilter && (
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedSet.has(s.id)}
                            onChange={() => toggleRowSelected(s.id)}
                            aria-label={`Select ${s.name}`}
                          />
                        </td>
                      )}
                      <td>
                        <Link to={`/staff/${s.id}`} className="participant-name-link">{s.name}</Link>
                        {s.archived_at && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#64748b' }}>(archived)</span>}
                      </td>
                      <td>{s.role || '-'}</td>
                      <td>{s.email || '-'}</td>
                      <td>{s.phone || '-'}</td>
                      <td>
                        {s.notify_email ? 'Email ' : ''}
                        {s.notify_sms ? 'SMS' : ''}
                        {!s.notify_email && !s.notify_sms ? '-' : ''}
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', alignItems: 'flex-start' }}>
                          <ShifterStatusBadge status={s.shifter_status || (s.shifter_enabled ? 'invited' : 'not_enabled')} />
                          <label
                            style={{
                              margin: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.35rem',
                              fontSize: '0.8rem',
                              color: '#475569',
                              cursor: s.email?.trim() ? 'pointer' : 'not-allowed',
                              opacity: s.email?.trim() ? 1 : 0.55,
                            }}
                            title={!s.email?.trim() ? 'Add an email to manage Shifter access in Supabase' : 'Toggle profiles.shifter_enabled (Supabase)'}
                          >
                            <input
                              type="checkbox"
                              checked={Boolean(s.shifter_enabled)}
                              disabled={!s.email?.trim() || shifterSavingId === s.id}
                              onChange={(e) => handleShifterToggle(s, e.target.checked)}
                            />
                            {shifterSavingId === s.id ? 'Saving…' : 'Enabled'}
                          </label>
                        </div>
                      </td>
                      <td style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                        <Link to={`/staff/${s.id}`} className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', textDecoration: 'none' }}>View</Link>
                        {s.archived_at ? (
                          <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }} onClick={() => handleUnarchive(s)}>Restore</button>
                        ) : (
                          <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }} onClick={() => handleArchive(s)} title="Hide from lists (can restore)">Archive</button>
                        )}
                        <button type="button" className="btn btn-danger" style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }} onClick={() => handleDelete(s)} title="Permanently delete">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Staff</h3>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Role / position</label>
                <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="e.g. Support Worker" />
              </div>
              <div className="form-group">
                <label>Employment type</label>
                <select value={form.employment_type} onChange={(e) => setForm({ ...form, employment_type: e.target.value })}>
                  <option value="employee">Employee</option>
                  <option value="subcontractor">Subcontractor</option>
                </select>
              </div>
              <div className="form-group">
                <label>Hourly rate</label>
                <input type="number" step="0.01" min="0" value={form.hourly_rate} onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })} placeholder="e.g. 35.00" />
              </div>
              <div className="form-group">
                <label>
                  <input type="checkbox" checked={form.notify_email} onChange={(e) => setForm({ ...form, notify_email: e.target.checked })} />
                  Notify by email when shift scheduled
                </label>
              </div>
              <div className="form-group">
                <label>
                  <input type="checkbox" checked={form.notify_sms} onChange={(e) => setForm({ ...form, notify_sms: e.target.checked })} />
                  Notify by SMS when shift scheduled
                </label>
              </div>
              <button type="submit" className="btn btn-primary">Create</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
