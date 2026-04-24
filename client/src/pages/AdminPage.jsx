import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { users, admin, participants, staff, billing, auth } from '../lib/api';
import SearchableSelect from '../components/SearchableSelect';
import { formatDate } from '../lib/dateUtils';
import { effectivePayRates, computeSubcontractorLaborDollars } from '../lib/payrollRates.js';

const ROLE_LABELS = { admin: 'Admin', support_coordinator: 'Support Coordinator', delegate: 'Delegate' };

function payRowKey(r) {
  return `${r.staffName}|${r.periodStart}|${r.periodEnd}`;
}

function escapeCsvCell(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseNum(v, fallback) {
  if (v === '' || v === undefined || v === null) return fallback;
  const n = parseFloat(String(v).replace(/[,$]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/** CSV hour values to 2 decimal places (avoids long floats from aggregations). */
function csvHours2dp(val) {
  const n = parseNum(val, NaN);
  if (!Number.isFinite(n)) return '';
  return (Math.round(n * 100) / 100).toFixed(2);
}

export default function AdminPage() {
  const { canManageUsers } = useAuth();
  const [tab, setTab] = useState('users');
  const [usersList, setUsersList] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [participantsList, setParticipantsList] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [coordinatorActivity, setCoordinatorActivity] = useState(null);
  const [billableSummary, setBillableSummary] = useState(null);
  const [financialOverview, setFinancialOverview] = useState(null);
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState('month');
  const [assignUserId, setAssignUserId] = useState('');
  const [assignParticipantId, setAssignParticipantId] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [paySummary, setPaySummary] = useState(null);
  const [paySummaryLoading, setPaySummaryLoading] = useState(false);
  const [paySummaryErr, setPaySummaryErr] = useState('');
  const [registerSyncLoading, setRegisterSyncLoading] = useState(false);
  const [caseNotesResult, setCaseNotesResult] = useState(null);
  const [caseNotesDefaultPid, setCaseNotesDefaultPid] = useState('');
  const [caseNotesDryRun, setCaseNotesDryRun] = useState(true);
  const [caseNotesLoading, setCaseNotesLoading] = useState(false);
  const [payPeriodFilter, setPayPeriodFilter] = useState('');
  const [payAdjustMode, setPayAdjustMode] = useState(false);
  const [payEdits, setPayEdits] = useState({});

  useEffect(() => {
    if (!canManageUsers) return;
    users.list().then(setUsersList).catch(() => setUsersList([]));
    users.listAssignments().then(setAssignments).catch(() => setAssignments([]));
    participants.list().then(setParticipantsList).catch(() => setParticipantsList([]));
    staff.list().then(setStaffList).catch(() => setStaffList([]));
  }, [canManageUsers]);

  useEffect(() => {
    if (!canManageUsers || tab !== 'activity') return;
    setLoading(true);
    admin.coordinatorActivity({ from_date: fromDate, to_date: toDate })
      .then(setCoordinatorActivity)
      .catch(() => setCoordinatorActivity(null))
      .finally(() => setLoading(false));
  }, [canManageUsers, tab, fromDate, toDate]);

  useEffect(() => {
    if (!canManageUsers || tab !== 'billable') return;
    setLoading(true);
    admin.billableSummary({ from_date: fromDate, to_date: toDate })
      .then(setBillableSummary)
      .catch(() => setBillableSummary(null))
      .finally(() => setLoading(false));
  }, [canManageUsers, tab, fromDate, toDate]);

  useEffect(() => {
    if (!canManageUsers || tab !== 'financial') return;
    setLoading(true);
    admin.financialOverview({ from_date: fromDate, to_date: toDate, group_by: groupBy })
      .then(setFinancialOverview)
      .catch(() => setFinancialOverview(null))
      .finally(() => setLoading(false));
  }, [canManageUsers, tab, fromDate, toDate, groupBy]);

  const loadPaySummary = useCallback(() => {
    setPaySummaryLoading(true);
    setPaySummaryErr('');
    admin
      .paySummary()
      .then((data) => {
        setPaySummary(data);
        setPayEdits({});
        setPayPeriodFilter('');
      })
      .catch((e) => {
        setPaySummary(null);
        setPaySummaryErr(e.message || 'Failed to load pay summary');
      })
      .finally(() => setPaySummaryLoading(false));
  }, []);

  useEffect(() => {
    if (!canManageUsers || tab !== 'pay_summary') return;
    loadPaySummary();
  }, [canManageUsers, tab, loadPaySummary]);

  const payPeriodOptions = useMemo(() => {
    const rows = paySummary?.summaryRows || [];
    const map = new Map();
    rows.forEach((r) => {
      const k = `${r.periodStart}|||${r.periodEnd}`;
      if (!map.has(k)) map.set(k, { periodStart: r.periodStart, periodEnd: r.periodEnd });
    });
    return Array.from(map.values()).sort((a, b) => String(b.periodEnd || '').localeCompare(String(a.periodEnd || '')));
  }, [paySummary]);

  const payFilteredRows = useMemo(() => {
    const rows = paySummary?.summaryRows || [];
    if (!payPeriodFilter) return rows;
    const [ps, pe] = payPeriodFilter.split('|||');
    return rows.filter((r) => r.periodStart === ps && r.periodEnd === pe);
  }, [paySummary, payPeriodFilter]);

  const getPayCell = (row, field) => {
    const k = payRowKey(row);
    const raw = payEdits[k]?.[field];
    if (raw !== undefined && raw !== '') return parseNum(raw, row[field]);
    return row[field];
  };

  const setPayCell = (row, field, value) => {
    const k = payRowKey(row);
    setPayEdits((prev) => ({
      ...prev,
      [k]: { ...prev[k], [field]: value },
    }));
  };

  const payTotals = useMemo(() => {
    const fields = ['totalHours', 'weekdayHours', 'saturdayHours', 'sundayHours', 'holidayHours', 'eveningHours', 'totalExpenses', 'totalKm'];
    const t = Object.fromEntries(fields.map((f) => [f, 0]));
    payFilteredRows.forEach((r) => {
      const k = payRowKey(r);
      fields.forEach((f) => {
        const raw = payEdits[k]?.[f];
        const val = raw !== undefined && raw !== '' ? parseNum(raw, r[f]) : r[f];
        t[f] += parseNum(val, 0);
      });
    });
    return t;
  }, [payFilteredRows, payEdits]);

  const subcontractorPayRows = useMemo(() => {
    return payFilteredRows.filter((r) => {
      const s = staffList.find((x) => String(x.id) === String(r.staff_id));
      return s?.employment_type === 'subcontractor';
    });
  }, [payFilteredRows, staffList]);

  const employeePayRows = useMemo(() => {
    return payFilteredRows.filter((r) => {
      const s = staffList.find((x) => String(x.id) === String(r.staff_id));
      return s?.employment_type === 'employee';
    });
  }, [payFilteredRows, staffList]);

  const downloadPayCsv = () => {
    const headers = [
      'Staff Name',
      'Nexus staff ID',
      'Pay period start',
      'Pay period end',
      'Total hours',
      'Weekday hours',
      'Saturday hours',
      'Sunday hours',
      'Public holiday hours',
      'Evening hours',
      'Total expenses',
      'Total km',
    ];
    const lines = [headers.map(escapeCsvCell).join(',')];
    payFilteredRows.forEach((r) => {
      const vals = [
        r.staffName,
        r.staff_id ?? '',
        r.periodStart,
        r.periodEnd,
        getPayCell(r, 'totalHours'),
        getPayCell(r, 'weekdayHours'),
        getPayCell(r, 'saturdayHours'),
        getPayCell(r, 'sundayHours'),
        getPayCell(r, 'holidayHours'),
        getPayCell(r, 'eveningHours'),
        getPayCell(r, 'totalExpenses'),
        getPayCell(r, 'totalKm'),
      ];
      lines.push(vals.map(escapeCsvCell).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pay-summary-xero-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Labor = sum of hours per bucket × matching pay rate from the staff profile (default weekday + optional overrides). */
  const downloadLaborPayCsv = (payRows, filenamePrefix) => {
    const headers = [
      'Staff Name',
      'Nexus staff ID',
      'Pay period start',
      'Pay period end',
      'Total hours',
      'Weekday hours',
      'Saturday hours',
      'Sunday hours',
      'Public holiday hours',
      'Evening hours',
      'Base hourly ($)',
      'Labor ($)',
      'Expenses ($)',
      'Total pay ($)',
      'Total km',
    ];
    const lines = [headers.map(escapeCsvCell).join(',')];
    payRows.forEach((r) => {
      const st = staffList.find((x) => String(x.id) === String(r.staff_id));
      const baseRate = st?.hourly_rate;
      const rateNum = baseRate != null && baseRate !== '' ? Number(baseRate) : NaN;
      const hours = {
        weekdayHours: parseNum(getPayCell(r, 'weekdayHours'), 0),
        eveningHours: parseNum(getPayCell(r, 'eveningHours'), 0),
        saturdayHours: parseNum(getPayCell(r, 'saturdayHours'), 0),
        sundayHours: parseNum(getPayCell(r, 'sundayHours'), 0),
        holidayHours: parseNum(getPayCell(r, 'holidayHours'), 0),
      };
      const rates = st ? effectivePayRates(st) : null;
      const labor = st ? computeSubcontractorLaborDollars(hours, rates) : 0;
      const expVal = getPayCell(r, 'totalExpenses');
      const expNum = Number.isFinite(expVal) ? expVal : 0;
      const totalPay = Math.round((labor + expNum) * 100) / 100;
      const vals = [
        r.staffName,
        r.staff_id ?? '',
        r.periodStart,
        r.periodEnd,
        csvHours2dp(getPayCell(r, 'totalHours')),
        csvHours2dp(getPayCell(r, 'weekdayHours')),
        csvHours2dp(getPayCell(r, 'saturdayHours')),
        csvHours2dp(getPayCell(r, 'sundayHours')),
        csvHours2dp(getPayCell(r, 'holidayHours')),
        csvHours2dp(getPayCell(r, 'eveningHours')),
        Number.isFinite(rateNum) ? rateNum : '',
        labor,
        expNum,
        totalPay,
        getPayCell(r, 'totalKm'),
      ];
      lines.push(vals.map(escapeCsvCell).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadSubcontractorPayCsv = () => downloadLaborPayCsv(subcontractorPayRows, 'subcontractor-pay');
  const downloadEmployeePayCsv = () => downloadLaborPayCsv(employeePayRows, 'employee-pay');

  const handleSetRole = async (userId, role) => {
    try {
      await users.setRole(userId, role);
      setMsg('Role updated');
      users.list().then(setUsersList);
    } catch (e) {
      setMsg(e.message || 'Failed');
    }
  };

  const handleAssign = async () => {
    if (!assignUserId || !assignParticipantId) { setMsg('Select user and participant'); return; }
    try {
      await users.assignParticipant(assignUserId, assignParticipantId);
      setMsg('Assigned');
      setAssignUserId(''); setAssignParticipantId('');
      users.listAssignments().then(setAssignments);
    } catch (e) {
      setMsg(e.message || 'Failed');
    }
  };

  const handleRemoveAssignment = async (id) => {
    try {
      await users.removeAssignment(id);
      setMsg('Removed');
      users.listAssignments().then(setAssignments);
    } catch (e) {
      setMsg(e.message || 'Failed');
    }
  };

  const handleGrantDelegate = async (userId) => {
    try {
      await users.grantDelegate(userId);
      setMsg('Granted');
      users.list().then(setUsersList);
    } catch (e) {
      setMsg(e.message || 'Failed');
    }
  };

  const handleRevokeDelegate = async (userId) => {
    try {
      await users.revokeDelegate(userId);
      setMsg('Revoked');
      users.list().then(setUsersList);
    } catch (e) {
      setMsg(e.message || 'Failed');
    }
  };

  const handleSupabaseInvite = async () => {
    if (!inviteEmail.trim()) {
      setMsg('Enter an email for the invite');
      return;
    }
    try {
      await auth.supabaseInviteStaff(inviteEmail.trim(), inviteName.trim() || undefined);
      setMsg('Invite email sent. They will join your organisation when they accept.');
      setInviteEmail('');
      setInviteName('');
    } catch (e) {
      setMsg(e.message || 'Invite failed');
    }
  };

  const handleRefreshRegisters = async () => {
    try {
      setRegisterSyncLoading(true);
      const out = await admin.refreshRegisters();
      const separateCount = out?.separate_registers?.created_or_updated ?? 0;
      setMsg(`Registers refreshed in OneDrive. Separate register files updated: ${separateCount}.`);
    } catch (e) {
      setMsg(e.message || 'Failed to refresh registers');
    } finally {
      setRegisterSyncLoading(false);
    }
  };

  const handleCaseNotesImport = async () => {
    const el = document.getElementById('case-notes-csv-input');
    const file = el?.files?.[0];
    if (!file) {
      setMsg('Choose a CSV file first');
      return;
    }
    setCaseNotesLoading(true);
    setCaseNotesResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (caseNotesDefaultPid) fd.append('default_participant_id', caseNotesDefaultPid);
      if (caseNotesDryRun) fd.append('dry_run', '1');
      const out = await admin.importCaseNotesCsv(fd);
      setCaseNotesResult(out);
      setMsg(
        out.dry_run
          ? `Preview: ${out.imported} row(s) would be imported. Turn off “Preview only” to save.`
          : `Imported ${out.imported} case note(s).`
      );
    } catch (e) {
      setCaseNotesResult(null);
      setMsg(e.message || 'Import failed');
    } finally {
      setCaseNotesLoading(false);
    }
  };

  if (!canManageUsers) {
    return (
      <div className="content">
        <h2>Admin</h2>
        <p>You do not have permission to access this page.</p>
      </div>
    );
  }

  const tabs = [
    { id: 'users', label: 'Users & Roles' },
    { id: 'case_notes_import', label: 'Case notes import' },
    { id: 'activity', label: 'Coordinator Activity' },
    { id: 'billable', label: 'Billing & Billable Hours' },
    { id: 'financial', label: 'Financial Overview' },
    { id: 'pay_summary', label: 'Pay summary (Xero)' }
  ];

  return (
    <div className="admin-page">
      <h2>Admin</h2>
      <div className="admin-tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {(tab === 'activity' || tab === 'billable' || tab === 'financial') && (
        <div className="admin-date-range" style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label>From <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
          <label>To <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
          {tab === 'financial' && (
            <label>Group by
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                <option value="month">Month</option>
                <option value="participant">Participant</option>
                <option value="coordinator">Coordinator</option>
              </select>
            </label>
          )}
        </div>
      )}

      {msg && <div className={msg.includes('Failed') ? 'settings-error' : 'settings-success'} style={{ marginBottom: '1rem' }}>{msg}</div>}

      {tab === 'users' && (
        <div className="card">
          <h3>Users</h3>
          <div style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <strong>OneDrive Register Sync</strong>
                <div style={{ fontSize: '0.9rem', color: '#64748b' }}>
                  Rebuilds `Document Register.xlsx` and all separate register files in `Nexus Core/Register`.
                </div>
              </div>
              <button type="button" className="btn btn-primary" onClick={handleRefreshRegisters} disabled={registerSyncLoading}>
                {registerSyncLoading ? 'Refreshing…' : 'Refresh Registers Now'}
              </button>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr><th>Email</th><th>Name</th><th>Role</th><th>Staff</th><th>Assigned</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {usersList.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name || '—'}</td>
                  <td>
                    <select value={u.role} onChange={(e) => handleSetRole(u.id, e.target.value)}>
                      {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td>{u.staff_name || '—'}</td>
                  <td>{u.assigned_participant_count ?? 0}</td>
                  <td>
                    {u.role === 'delegate' && (
                      u.delegate_grant?.id
                        ? <button type="button" className="btn btn-secondary" onClick={() => handleRevokeDelegate(u.id)}>Revoke</button>
                        : <button type="button" className="btn btn-primary" onClick={() => handleGrantDelegate(u.id)}>Grant</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 style={{ marginTop: '1.5rem' }}>Invite staff</h4>
          <p style={{ fontSize: '0.9rem', color: '#64748b', maxWidth: '42rem' }}>
            Sends an email invite. The person is added to the same organisation as you and can sign in after they set a password.
            Enable Shifter separately from the Staff page if needed.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <input
              type="email"
              placeholder="Email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="form-input"
              style={{ maxWidth: 220 }}
            />
            <input
              type="text"
              placeholder="Name (optional)"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              className="form-input"
              style={{ maxWidth: 180 }}
            />
            <button type="button" className="btn btn-secondary" onClick={handleSupabaseInvite}>
              Send invite
            </button>
          </div>

          <h4 style={{ marginTop: '1.5rem' }}>Assign participant to coordinator</h4>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <SearchableSelect
              options={usersList.filter((u) => u.role === 'support_coordinator').map((u) => ({ id: u.id, label: u.email }))}
              value={assignUserId}
              onChange={setAssignUserId}
              placeholder="Select coordinator"
            />
            <SearchableSelect
              options={participantsList.map((p) => ({ id: p.id, label: p.name + (p.ndis_number ? ' (' + p.ndis_number + ')' : '') }))}
              value={assignParticipantId}
              onChange={setAssignParticipantId}
              placeholder="Select participant"
            />
            <button type="button" className="btn btn-primary" onClick={handleAssign}>Assign</button>
          </div>

          <h4 style={{ marginTop: '1rem' }}>Current assignments</h4>
          <table className="table">
            <thead><tr><th>Coordinator</th><th>Participant</th><th></th></tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td>{a.user_email}</td>
                  <td>{a.participant_name} {a.ndis_number ? `(${a.ndis_number})` : ''}</td>
                  <td><button type="button" className="btn btn-secondary" onClick={() => handleRemoveAssignment(a.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'case_notes_import' && (
        <div className="card">
          <h3>Import case notes (CSV)</h3>
          <p style={{ fontSize: '0.9rem', color: '#64748b', maxWidth: '48rem', marginBottom: '1rem' }}>
            Upload a CSV export from your previous system. The importer looks for columns for <strong>date</strong> (e.g. contact_date, date, created_at),{' '}
            <strong>notes</strong> (notes, text, description), and <strong>participant</strong> (participant_id, client_id, or ndis_number). If every row is for
            the same person, you can pick a <strong>default participant</strong> and omit the participant column. Use comma- or semicolon-separated UTF-8 CSV.
            Run a preview first, then import without preview to write into Nexus.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '32rem' }}>
            <label style={{ display: 'block' }}>
              CSV file
              <input id="case-notes-csv-input" type="file" accept=".csv,.txt" style={{ display: 'block', marginTop: '0.35rem' }} />
            </label>
            <div>
              <div style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.25rem' }}>Default participant (optional)</div>
              <SearchableSelect
                options={participantsList.map((p) => ({ id: p.id, label: p.name + (p.ndis_number ? ' (' + p.ndis_number + ')' : '') }))}
                value={caseNotesDefaultPid}
                onChange={setCaseNotesDefaultPid}
                placeholder="None — use CSV participant column"
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <input type="checkbox" checked={caseNotesDryRun} onChange={(e) => setCaseNotesDryRun(e.target.checked)} />
              Preview only (no changes to the database)
            </label>
            <button type="button" className="btn btn-primary" onClick={handleCaseNotesImport} disabled={caseNotesLoading}>
              {caseNotesLoading ? 'Processing…' : caseNotesDryRun ? 'Run preview' : 'Import into Nexus'}
            </button>
          </div>
          {caseNotesResult && (
            <div style={{ marginTop: '1.25rem' }}>
              {caseNotesResult.column_map && (
                <p style={{ fontSize: '0.9rem' }}>
                  <strong>Detected columns:</strong>{' '}
                  {caseNotesResult.column_map.participant
                    ? `${caseNotesResult.column_map.participant.kind} → ${caseNotesResult.column_map.participant.name || '—'}`
                    : 'participant from default only'}
                  {', '}
                  date → {caseNotesResult.column_map.contact_date || '—'}
                  {', '}
                  notes → {caseNotesResult.column_map.notes || '—'}
                  {caseNotesResult.column_map.contact_type ? `, type → ${caseNotesResult.column_map.contact_type}` : ''}
                </p>
              )}
              {Number(caseNotesResult.skipped) > 0 && (
                <p style={{ fontSize: '0.9rem', color: '#64748b' }}>Blank rows skipped: {caseNotesResult.skipped}</p>
              )}
              {Array.isArray(caseNotesResult.errors) && caseNotesResult.errors.length > 0 && (
                <div style={{ marginTop: '0.5rem' }}>
                  <strong>Row issues ({caseNotesResult.errors.length})</strong>
                  <ul style={{ maxHeight: '12rem', overflow: 'auto', fontSize: '0.85rem', marginTop: '0.35rem' }}>
                    {caseNotesResult.errors.map((e, i) => (
                      <li key={i}>
                        Line {e.line}: {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {Array.isArray(caseNotesResult.preview) && caseNotesResult.preview.length > 0 && (
                <div style={{ marginTop: '0.75rem' }}>
                  <strong>Sample (first rows)</strong>
                  <ul style={{ fontSize: '0.85rem', marginTop: '0.35rem' }}>
                    {caseNotesResult.preview.map((p, i) => (
                      <li key={i} style={{ marginBottom: '0.5rem' }}>
                        {p.contact_date} · {p.contact_type}
                        <div style={{ whiteSpace: 'pre-wrap', color: '#475569' }}>{p.notes}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'activity' && (
        <div className="card">
          <h3>Coordinator Activity</h3>
          {loading && <p>Loading...</p>}
          {coordinatorActivity?.aggregates?.length > 0 ? (
            <table className="table">
              <thead><tr><th>Coordinator</th><th>Tasks</th><th>Hours</th><th>Value</th></tr></thead>
              <tbody>
                {coordinatorActivity.aggregates.map((a) => (
                  <tr key={a.staff_id}>
                    <td>{a.staff_name}</td>
                    <td>{a.task_count}</td>
                    <td>{a.total_hours}</td>
                    <td>${a.total_value?.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : !loading && <p>No coordinator tasks in date range.</p>}
        </div>
      )}

      {tab === 'billable' && (
        <div className="card">
          <h3>Billing & Billable Hours</h3>
          {loading && <p>Loading...</p>}
          {billableSummary && (
            <div>
              <h4>Coordinator tasks</h4>
              <p>Unbilled: {billableSummary.coordinator_tasks?.unbilled?.count ?? 0} tasks, {billableSummary.coordinator_tasks?.unbilled?.hours ?? 0} hrs, ${billableSummary.coordinator_tasks?.unbilled?.value?.toFixed(2) ?? '0.00'}</p>
              <p>Billed: {billableSummary.coordinator_tasks?.billed?.count ?? 0} tasks, {billableSummary.coordinator_tasks?.billed?.hours ?? 0} hrs, ${billableSummary.coordinator_tasks?.billed?.value?.toFixed(2) ?? '0.00'}</p>
              <h4>Shifts</h4>
              <p>Unbilled: {billableSummary.shifts?.unbilled?.count ?? 0} shifts, {billableSummary.shifts?.unbilled?.hours ?? 0} hrs</p>
              <p>Billed: {billableSummary.shifts?.billed?.count ?? 0} shifts</p>
              <a href="/financial" className="btn btn-primary" style={{ marginTop: '1rem' }}>Go to Financial</a>
            </div>
          )}
        </div>
      )}

      {tab === 'pay_summary' && (
        <div className="card">
          <h3>Staff pay summary (Xero)</h3>
          <p style={{ color: '#64748b', marginBottom: '0.75rem', maxWidth: '48rem' }}>
            Pay periods and hour breakdowns use only <strong>completed</strong> shifts (including those marked completed by admin)—same rules as each staff profile&apos;s Hours Summary. Travel time from linked progress notes is included in the day-type hour buckets (and in total hours); km and expenses are shown separately. Use this to check a pay run before entering or importing figures into Xero.
          </p>
          <p style={{ color: '#64748b', marginBottom: '1rem', fontSize: '0.9rem', maxWidth: '48rem' }}>
            Download CSV for a spreadsheet-friendly file you can adjust and then use in Xero (manual timesheets or your payroll import).{' '}
            <strong>Subcontractor CSV</strong> and <strong>Employee CSV</strong> include only staff with that employment type; hour columns are exported to two decimal places. <strong>Labor ($)</strong> is hourly rate from their
            profile × hours by bucket, and <strong>Total pay ($)</strong> adds expenses (reimbursements) on top.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
            <label>
              Pay period{' '}
              <select
                value={payPeriodFilter}
                onChange={(e) => setPayPeriodFilter(e.target.value)}
                style={{ marginLeft: '0.25rem' }}
              >
                <option value="">All periods</option>
                {payPeriodOptions.map((p) => {
                  const v = `${p.periodStart}|||${p.periodEnd}`;
                  return (
                    <option key={v} value={v}>
                      {(p.periodStart && formatDate(p.periodStart)) || p.periodStart} – {(p.periodEnd && formatDate(p.periodEnd)) || p.periodEnd}
                    </option>
                  );
                })}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <input type="checkbox" checked={payAdjustMode} onChange={(e) => setPayAdjustMode(e.target.checked)} />
              Adjust numbers before export
            </label>
            <button type="button" className="btn btn-secondary" onClick={loadPaySummary} disabled={paySummaryLoading}>
              Refresh
            </button>
            <button type="button" className="btn btn-primary" onClick={downloadPayCsv} disabled={paySummaryLoading || !payFilteredRows.length}>
              Download CSV
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={downloadSubcontractorPayCsv}
              disabled={paySummaryLoading || !subcontractorPayRows.length}
              title={
                !subcontractorPayRows.length
                  ? 'No subcontractor rows in the current filter (set staff to Subcontractor and ensure they have shifts).'
                  : undefined
              }
            >
              Download subcontractor CSV ($)
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={downloadEmployeePayCsv}
              disabled={paySummaryLoading || !employeePayRows.length}
              title={
                !employeePayRows.length
                  ? 'No employee rows in the current filter (set staff to Employee and ensure they have shifts).'
                  : undefined
              }
            >
              Download employee CSV ($)
            </button>
            {payAdjustMode && Object.keys(payEdits).length > 0 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPayEdits({})}
              >
                Clear adjustments
              </button>
            )}
          </div>
          {paySummaryErr && <div className="settings-error" style={{ marginBottom: '1rem' }}>{paySummaryErr}</div>}
          {paySummaryLoading && <p>Loading…</p>}
          {!paySummaryLoading && paySummary?.unmatchedStaffNames?.length > 0 && (
            <div className="settings-error" style={{ marginBottom: '1rem', fontSize: '0.9rem' }}>
              <strong>No matching Nexus staff</strong> (check spelling matches Staff name): {paySummary.unmatchedStaffNames.join('; ')}
            </div>
          )}
          {!paySummaryLoading && payFilteredRows.length > 0 && (
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th>Period</th>
                    <th>Total</th>
                    <th>Weekday</th>
                    <th>Sat</th>
                    <th>Sun</th>
                    <th>PH</th>
                    <th>Evening</th>
                    <th>Expenses</th>
                    <th>Km</th>
                  </tr>
                </thead>
                <tbody>
                  {payFilteredRows.map((r) => {
                    const k = payRowKey(r);
                    const exDisplay = parseNum(getPayCell(r, 'totalExpenses'), NaN);
                    const kmDisplay = parseNum(getPayCell(r, 'totalKm'), NaN);
                    const hourFields = ['totalHours', 'weekdayHours', 'saturdayHours', 'sundayHours', 'holidayHours', 'eveningHours'];
                    const renderHour = (f) => {
                      const n = parseNum(getPayCell(r, f), NaN);
                      if (!payAdjustMode) return <td key={f}>{Number.isFinite(n) ? n.toFixed(1) : '—'}</td>;
                      return (
                        <td key={f}>
                          <input
                            type="number"
                            step="0.1"
                            className="form-input"
                            style={{ width: '4.5rem', padding: '0.2rem 0.35rem' }}
                            value={payEdits[k]?.[f] !== undefined ? payEdits[k][f] : (Number.isFinite(parseNum(r[f], NaN)) ? String(r[f]) : '')}
                            onChange={(e) => setPayCell(r, f, e.target.value)}
                          />
                        </td>
                      );
                    };
                    return (
                      <tr key={k}>
                        <td>
                          {r.staff_id ? (
                            <Link to={`/staff/${r.staff_id}`} className="participant-name-link">{r.staffName}</Link>
                          ) : (
                            <span>{r.staffName}</span>
                          )}
                        </td>
                        <td>
                          {(r.periodStart && formatDate(r.periodStart)) || r.periodStart} – {(r.periodEnd && formatDate(r.periodEnd)) || r.periodEnd}
                        </td>
                        {hourFields.map((f) => renderHour(f))}
                        <td>
                          {!payAdjustMode ? (
                            Number.isFinite(exDisplay) && exDisplay !== 0
                              ? `$${exDisplay.toFixed(2)}`
                              : '—'
                          ) : (
                            <input
                              type="number"
                              step="0.01"
                              className="form-input"
                              style={{ width: '5rem', padding: '0.2rem 0.35rem' }}
                              value={payEdits[k]?.totalExpenses !== undefined ? payEdits[k].totalExpenses : String(r.totalExpenses ?? '')}
                              onChange={(e) => setPayCell(r, 'totalExpenses', e.target.value)}
                            />
                          )}
                        </td>
                        <td>
                          {!payAdjustMode ? (
                            Number.isFinite(kmDisplay) && kmDisplay !== 0
                              ? kmDisplay.toFixed(1)
                              : '—'
                          ) : (
                            <input
                              type="number"
                              step="0.1"
                              className="form-input"
                              style={{ width: '4.5rem', padding: '0.2rem 0.35rem' }}
                              value={payEdits[k]?.totalKm !== undefined ? payEdits[k].totalKm : String(r.totalKm ?? '')}
                              onChange={(e) => setPayCell(r, 'totalKm', e.target.value)}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 600 }}>
                    <td colSpan={2}>Totals (visible rows)</td>
                    <td>{payTotals.totalHours.toFixed(1)}</td>
                    <td>{payTotals.weekdayHours.toFixed(1)}</td>
                    <td>{payTotals.saturdayHours.toFixed(1)}</td>
                    <td>{payTotals.sundayHours.toFixed(1)}</td>
                    <td>{payTotals.holidayHours.toFixed(1)}</td>
                    <td>{payTotals.eveningHours.toFixed(1)}</td>
                    <td>${payTotals.totalExpenses.toFixed(2)}</td>
                    <td>{payTotals.totalKm.toFixed(1)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {!paySummaryLoading && paySummary && payFilteredRows.length === 0 && (
            <p>No summary rows{payPeriodFilter ? ' for this pay period' : ''}. Staff only appear when they have completed shifts with valid start and end times in Nexus.</p>
          )}
        </div>
      )}

      {tab === 'financial' && (
        <div className="card">
          <h3>Financial Overview</h3>
          {loading && <p>Loading...</p>}
          {financialOverview && (
            <div>
              <h4>By status</h4>
              <table className="table">
                <thead><tr><th>Status</th><th>Count</th><th>Total</th></tr></thead>
                <tbody>
                  {Object.entries(financialOverview.by_status || {}).map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td>{v?.count ?? 0}</td><td>${(v?.total ?? 0).toFixed(2)}</td></tr>
                  ))}
                </tbody>
              </table>
              <h4>Grouped</h4>
              <table className="table">
                <thead>
                  <tr>
                    <th>{groupBy === 'month' ? 'Period' : groupBy === 'participant' ? 'Participant' : 'Coordinator'}</th>
                    <th>Count</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(financialOverview.grouped || []).map((g, i) => (
                    <tr key={i}>
                      <td>{g.period ?? g.participant_name ?? g.staff_name ?? g.participant_id ?? g.staff_id ?? '—'}</td>
                      <td>{g.count ?? 0}</td>
                      <td>${(g.total ?? 0).toFixed(2)}</td>
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
