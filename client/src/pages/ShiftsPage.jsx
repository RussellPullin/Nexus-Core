import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate, formatDateLocal } from '../lib/dateUtils';
import { useSearchParams } from 'react-router-dom';
import { shifts, participants, staff, appShifts, syncFromExcel, syncFromShifter } from '../lib/api';
import WeekPlanner from '../components/WeekPlanner';
import SearchableSelect from '../components/SearchableSelect';
import SuggestionPanel from '../components/SuggestionPanel';
import ResolveShiftModal from '../components/ResolveShiftModal';

function getWeekStart(d) {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function toDatetimeLocal(dt) {
  if (!dt) return '';
  const s = String(dt).slice(0, 19).replace(' ', 'T');
  return s.slice(0, 16);
}

export default function ShiftsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [shiftList, setShiftList] = useState([]);
  const [participantsList, setParticipantsList] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('planner');
  const [weekStart, setWeekStart] = useState(getWeekStart(new Date()));
  const [showModal, setShowModal] = useState(false);
  const [editingShift, setEditingShift] = useState(null);
  const [form, setForm] = useState({
    participant_id: '',
    staff_id: '',
    start_time: '',
    end_time: '',
    notes: ''
  });
  const [recurring, setRecurring] = useState({
    frequency: 'weekly',
    end: 'ongoing',
    untilDate: ''
  });
  const [planEndDate, setPlanEndDate] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [moveConfirm, setMoveConfirm] = useState(null);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [duplicatesData, setDuplicatesData] = useState(null);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicatesStaffId, setDuplicatesStaffId] = useState('');
  const [appShiftsList, setAppShiftsList] = useState([]);
  const [showAppShifts, setShowAppShifts] = useState(true);
  const [syncingExcel, setSyncingExcel] = useState(false);
  const [syncingShifter, setSyncingShifter] = useState(false);
  const [resolvingShift, setResolvingShift] = useState(null);
  const sendAfterRef = useRef(false);
  const formRef = useRef(null);

  const handleDeleteDuplicateShift = async (s) => {
    if (!confirm(`Delete this shift (${s.participant_name} · ${s.staff_name} · ${s.start_time?.slice(0, 16)})? This cannot be undone.`)) return;
    try {
      await shifts.delete(s.id);
      load({ silent: true });
      const params = duplicatesStaffId ? { staff_id: duplicatesStaffId } : {};
      const data = await shifts.duplicates(params);
      setDuplicatesData(data);
    } catch (e) {
      console.error(e);
      alert(e.message || 'Failed to delete shift');
    }
  };

  const load = async (opts = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const start = formatDateLocal(weekStart);
      const end = new Date(weekStart);
      end.setDate(end.getDate() + 6);
      const endStr = formatDateLocal(end);
      const [s, p, st] = await Promise.all([
        shifts.list({ start: `${start}T00:00:00`, end: `${endStr}T23:59:59` }),
        participants.list(),
        staff.list()
      ]);
      setShiftList(s);
      setParticipantsList(p);
      setStaffList(st);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [weekStart]);

  const loadAppShifts = () => {
    const from = formatDateLocal(weekStart);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const to = formatDateLocal(weekEnd);
    appShifts.list({ from_date: from, to_date: to }).then(setAppShiftsList).catch(() => setAppShiftsList([]));
  };

  useEffect(() => {
    loadAppShifts();
  }, [weekStart]);

  const alertSyncResult = (result, label) => {
    const newCount = (result?.matched ?? 0) + (result?.unmatched ?? 0);
    const message = newCount === 0
      ? `No new shifts from ${label}.`
      : newCount === 1
        ? `1 new shift from ${label}.`
        : `${newCount} new shifts from ${label}.`;
    if (result?.source === 'shifter_supabase_fallback') {
      alert(`${message} (OneDrive file was missing; used Shifter database instead.)`);
    } else {
      alert(message);
    }
  };

  const handleSyncFromExcel = async () => {
    setSyncingExcel(true);
    try {
      const result = await syncFromExcel.run();
      loadAppShifts();
      load();
      alertSyncResult(result, 'Excel / OneDrive');
    } catch (err) {
      alert(err.message || 'Sync from Excel failed');
    } finally {
      setSyncingExcel(false);
    }
  };

  const handleSyncFromShifter = async () => {
    setSyncingShifter(true);
    try {
      const result = await syncFromShifter.run();
      loadAppShifts();
      load();
      alertSyncResult(result, 'Shifter');
    } catch (err) {
      alert(err.message || 'Sync from Shifter failed');
    } finally {
      setSyncingShifter(false);
    }
  };

  const handleDeleteAppShift = async (shiftId) => {
    if (!confirm('Dismiss this unmatched shift?')) return;
    try {
      await appShifts.delete(shiftId);
      loadAppShifts();
    } catch (err) {
      alert(err.message || 'Delete failed');
    }
  };

  const refreshListsForModal = () => {
    participants.list().then((p) => setParticipantsList(Array.isArray(p) ? p : [])).catch(() => []);
    staff.list().then((s) => setStaffList(Array.isArray(s) ? s : [])).catch(() => []);
  };

  const shiftId = searchParams.get('shift');
  const openDuplicates = searchParams.get('duplicates') === '1';
  const duplicatesStaffFromUrl = searchParams.get('staff_id') || '';
  useEffect(() => {
    if (openDuplicates) {
      setDuplicatesOpen(true);
      setDuplicatesStaffId(duplicatesStaffFromUrl);
      setDuplicatesData(null);
    }
  }, [openDuplicates, duplicatesStaffFromUrl]);
  // When opened from Staff profile with staff_id, run the check once
  const didRunDuplicatesFromUrl = useRef(false);
  useEffect(() => {
    if (!duplicatesOpen || !duplicatesStaffFromUrl || didRunDuplicatesFromUrl.current) return;
    didRunDuplicatesFromUrl.current = true;
    setDuplicatesLoading(true);
    shifts.duplicates({ staff_id: duplicatesStaffFromUrl })
      .then(setDuplicatesData)
      .catch((e) => setDuplicatesData({ error: e.message }))
      .finally(() => setDuplicatesLoading(false));
  }, [duplicatesOpen, duplicatesStaffFromUrl]);
  useEffect(() => {
    if (!duplicatesOpen) didRunDuplicatesFromUrl.current = false;
  }, [duplicatesOpen]);
  useEffect(() => {
    if (shiftId) {
      shifts.get(shiftId).then((s) => {
        setEditingShift(s);
        setForm({
          participant_id: s.participant_id,
          staff_id: s.staff_id,
          start_time: toDatetimeLocal(s.start_time),
          end_time: toDatetimeLocal(s.end_time),
          notes: s.notes || ''
        });
        setRecurring({ frequency: 'weekly', end: 'ongoing', untilDate: '' });
        setShowModal(true);
      }).catch(() => {});
    }
  }, [shiftId]);

  useEffect(() => {
    if (!editingShift?.participant_id || recurring.end !== 'plan') {
      setPlanEndDate(null);
      return;
    }
    participants.listPlans(editingShift.participant_id).then((plans) => {
      const shiftDate = new Date(editingShift.start_time);
      const plan = plans.find((p) => {
        const start = new Date(p.start_date);
        const end = new Date(p.end_date);
        return shiftDate >= start && shiftDate <= end;
      }) || plans[0];
      setPlanEndDate(plan ? plan.end_date : null);
    }).catch(() => setPlanEndDate(null));
  }, [editingShift?.id, editingShift?.participant_id, recurring.end]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const sendAfter = sendAfterRef.current;
    sendAfterRef.current = false;
    try {
      const payload = { ...form };
      let shiftId;
      if (editingShift) {
        await shifts.update(editingShift.id, { ...payload, status: editingShift.status });
        shiftId = editingShift.id;
      } else {
        const created = await shifts.create(payload);
        shiftId = created.id;
      }
      if (sendAfter && shiftId) {
        await shifts.sendIcs(shiftId);
        alert('Shift saved and sent to staff.');
      }
      setShowModal(false);
      setEditingShift(null);
      setForm({ participant_id: '', staff_id: '', start_time: '', end_time: '', notes: '' });
      load();
      window.history.replaceState({}, '', '/shifts');
    } catch (err) {
      alert(err.message);
    }
  };

  const formatForApi = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}:00`;
  };

  const getDaysPerRepeat = () => {
    switch (recurring.frequency) {
      case 'weekly': return 7;
      case 'fortnightly': return 14;
      case '3weeks': return 21;
      case '4weeks': return 28;
      default: return 7;
    }
  };

  const handleApplyRecurring = async () => {
    if (!editingShift || !editingShift.start_time || !editingShift.end_time) return;
    // Use editingShift dates (not form) so we never move the original shift when applying recurring
    const baseStart = new Date(String(editingShift.start_time).replace(' ', 'T'));
    const baseEnd = new Date(String(editingShift.end_time).replace(' ', 'T'));
    const durationMs = baseEnd.getTime() - baseStart.getTime();
    if (isNaN(baseStart.getTime()) || isNaN(baseEnd.getTime())) {
      alert('Invalid shift dates.');
      return;
    }
    let endDate;
    if (recurring.end === 'plan') {
      if (!planEndDate) {
        alert('No plan found for this participant, or plan end date is unknown.');
        return;
      }
      endDate = new Date(planEndDate);
      endDate.setHours(23, 59, 59, 999); // include end day
    } else if (recurring.end === 'date') {
      if (!recurring.untilDate) {
        alert('Please select an end date.');
        return;
      }
      endDate = new Date(recurring.untilDate);
      endDate.setHours(23, 59, 59, 999); // include end day
    } else {
      const d = new Date(baseStart);
      d.setDate(d.getDate() + 52 * 7);
      endDate = d;
    }
    const daysToAdd = getDaysPerRepeat();
    const recurringGroupId = crypto.randomUUID();
    let created = 0;
    try {
      // Update existing shift: add recurring_group_id only; do NOT change start/end (prevents moving it)
      await shifts.update(editingShift.id, {
        participant_id: form.participant_id,
        staff_id: form.staff_id,
        start_time: formatForApi(baseStart),
        end_time: formatForApi(baseEnd),
        notes: form.notes || '',
        status: editingShift.status,
        recurring_group_id: recurringGroupId
      });
      for (let i = 1; ; i++) {
        const shiftStart = new Date(baseStart);
        shiftStart.setDate(shiftStart.getDate() + i * daysToAdd);
        if (shiftStart > endDate) break;
        const shiftEnd = new Date(shiftStart.getTime() + durationMs);
        await shifts.create({
          participant_id: form.participant_id,
          staff_id: form.staff_id,
          start_time: formatForApi(shiftStart),
          end_time: formatForApi(shiftEnd),
          notes: form.notes || '',
          recurring_group_id: recurringGroupId
        });
        created++;
      }
      load();
      if (created === 0) {
        alert('No additional shifts were created. The end date may be before the next occurrence. Try "Until date" or "Ongoing" and pick a future end date.');
      } else {
        alert(`Created ${created} additional recurring shift${created !== 1 ? 's' : ''}.`);
      }
    } catch (err) {
      alert(err.message || 'Failed to create recurring shifts');
    }
  };

  const handleDeleteOne = async () => {
    if (!deleteConfirm) return;
    try {
      await shifts.delete(deleteConfirm.shift.id);
      setShiftList((prev) => prev.filter((s) => s.id !== deleteConfirm.shift.id));
      setDeleteConfirm(null);
      load({ silent: true });
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteAllInSeries = async () => {
    if (!deleteConfirm) return;
    try {
      const groupShifts = await shifts.listByRecurringGroup(deleteConfirm.shift.recurring_group_id);
      for (const s of groupShifts) {
        await shifts.delete(s.id);
      }
      setShiftList((prev) => prev.filter((s) => s.recurring_group_id !== deleteConfirm.shift.recurring_group_id));
      setDeleteConfirm(null);
      load({ silent: true });
    } catch (err) {
      alert(err.message);
    }
  };

  const handleMoveOne = async () => {
    if (!moveConfirm) return;
    try {
      await shifts.update(moveConfirm.shift.id, moveConfirm.data);
      setMoveConfirm(null);
      load({ silent: true });
    } catch (err) {
      alert(err.message);
    }
  };

  const handleMoveAllInSeries = async () => {
    if (!moveConfirm) return;
    try {
      const groupShifts = await shifts.listByRecurringGroup(moveConfirm.shift.recurring_group_id);
      const oldStart = new Date(moveConfirm.shift.start_time).getTime();
      const newStart = new Date(String(moveConfirm.data.start_time).replace(' ', 'T')).getTime();
      const deltaMs = newStart - oldStart;
      const oldEnd = new Date(moveConfirm.shift.end_time).getTime();
      const newEnd = new Date(String(moveConfirm.data.end_time).replace(' ', 'T')).getTime();
      const deltaEndMs = newEnd - oldEnd;
      for (const s of groupShifts) {
        const sStart = new Date(s.start_time);
        const sEnd = new Date(s.end_time);
        const nStart = new Date(sStart.getTime() + deltaMs);
        const nEnd = new Date(sEnd.getTime() + deltaEndMs);
        await shifts.update(s.id, {
          start_time: formatForApi(nStart),
          end_time: formatForApi(nEnd)
        });
      }
      setMoveConfirm(null);
      load({ silent: true });
    } catch (err) {
      alert(err.message);
    }
  };

  const handleEditShift = (shift) => {
    setEditingShift(shift);
    setForm({
      participant_id: shift.participant_id,
      staff_id: shift.staff_id,
      start_time: toDatetimeLocal(shift.start_time),
      end_time: toDatetimeLocal(shift.end_time),
      notes: shift.notes || ''
    });
    setRecurring({ frequency: 'weekly', end: 'ongoing', untilDate: '' });
    setShowModal(true);
  };

  const [sendingRoster, setSendingRoster] = useState(false);
  const handleSendRoster = async () => {
    const start = formatDateLocal(weekStart);
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    const endStr = formatDateLocal(end);
    setSendingRoster(true);
    try {
      const r = await shifts.sendRoster(start, endStr);
      if (r.sent === 0 && r.errors?.length > 0) {
        alert(`Failed to send roster:\n\n${r.errors.join('\n')}`);
      } else if (r.sent === 0 && r.skipped > 0) {
        alert(`No staff with email addresses in this week. ${r.skipped} staff skipped.`);
      } else if (r.errors?.length > 0) {
        alert(`Sent to ${r.sent} staff. ${r.skipped} skipped. Some failed:\n\n${r.errors.join('\n')}`);
      } else {
        alert(`Roster sent to ${r.sent} staff.`);
      }
    } catch (err) {
      if (err.code === 'EMAIL_NOT_CONNECTED' || err.code === 'EMAIL_RECONNECT_REQUIRED') {
        alert(err.code === 'EMAIL_RECONNECT_REQUIRED'
          ? 'Your email connection expired. Open Settings and reconnect your email.'
          : 'Connect your email in Settings first, then try sending the roster again.');
      } else {
        alert(err.message || 'Failed to send roster');
      }
    } finally {
      setSendingRoster(false);
    }
  };

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  return (
    <div>
      <div className="page-header">
        <h2>Shifts</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '0.25rem', marginRight: '0.5rem' }}>
            <button className={`btn ${view === 'planner' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('planner')}>Week Planner</button>
            <button className={`btn ${view === 'table' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('table')}>Table</button>
          </div>
          <button className="btn btn-secondary" onClick={() => {
            const prev = new Date(weekStart);
            prev.setDate(prev.getDate() - 7);
            setWeekStart(prev);
          }}>Prev</button>
          <span style={{ minWidth: 140, textAlign: 'center' }}>
            {formatDate(weekStart)} – {formatDate(days[6])}
          </span>
          <button className="btn btn-secondary" onClick={() => {
            const next = new Date(weekStart);
            next.setDate(next.getDate() + 7);
            setWeekStart(next);
          }}>Next</button>
          <button className="btn btn-primary" onClick={() => { setEditingShift(null); setForm({ participant_id: '', staff_id: '', start_time: '', end_time: '', notes: '' }); setRecurring({ frequency: 'weekly', end: 'ongoing', untilDate: '' }); setShowModal(true); }}>New Shift</button>
          <button className="btn btn-secondary" onClick={handleSendRoster} disabled={sendingRoster || shiftList.length === 0} title="Email roster (ICS) to staff with unsent shifts this week. Sent shifts are highlighted; move or edit to send again.">
            {sendingRoster ? 'Sending…' : 'Send roster to all staff'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => { setDuplicatesOpen(true); setDuplicatesData(null); }} title="Find shifts that were imported twice or same staff+client+time">
            Find duplicate shifts
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setShowAppShifts(!showAppShifts)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem' }}>
            {showAppShifts ? '▼' : '▶'}
          </button>
          Shifts from App ({appShiftsList.length})
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleSyncFromExcel}
              disabled={syncingExcel || syncingShifter}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem', cursor: syncingExcel || syncingShifter ? 'wait' : 'pointer' }}
            >
              {syncingExcel ? 'Pulling Excel…' : 'Pull from OneDrive Excel'}
            </button>
            <button
              type="button"
              onClick={handleSyncFromShifter}
              disabled={syncingExcel || syncingShifter}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem', cursor: syncingExcel || syncingShifter ? 'wait' : 'pointer' }}
            >
              {syncingShifter ? 'Pulling Shifter…' : 'Pull from Shifter DB'}
            </button>
          </span>
        </h3>
        <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>
          Shifts can come from the Progress app (webhook), from an Excel workbook on OneDrive (connect Microsoft in Settings and set the path in
          Shifter), or from Shifter directly — use <strong>Pull from Shifter DB</strong> when shifts already live there. Matched names become
          shifts; unmatched rows stay here for linking.
        </p>
        {showAppShifts && (
          <div style={{ marginTop: '0.75rem', maxHeight: 300, overflowY: 'auto' }}>
            {appShiftsList.length === 0 ? (
              <div className="empty-state" style={{ padding: '1rem', fontSize: '0.9rem', color: '#64748b' }}>
                No shifts yet. Use Pull from OneDrive Excel or Pull from Shifter DB, or ensure the Progress app can reach your Nexus webhook (see
                Settings → Shifter).
                <div style={{ marginTop: '0.6rem' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => navigate('/settings')}>
                    Open Settings
                  </button>
                </div>
              </div>
            ) : (
              <table className="table" style={{ fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Staff</th>
                    <th>Client</th>
                    <th>Time</th>
                    <th>Mood</th>
                    <th style={{ width: 90 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {appShiftsList.map((s) => (
                    <tr key={s.shift_id}>
                      <td>{s.date ? formatDate(s.date) : ''}</td>
                      <td>{s.staff_name || '—'}</td>
                      <td>{s.client_name || '—'}</td>
                      <td>{s.start_time && s.finish_time ? `${s.start_time}–${s.finish_time}` : '—'}</td>
                      <td>{s.mood || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-primary" style={{ fontSize: '0.75rem', padding: '0.2rem 0.45rem', marginRight: '0.25rem' }} onClick={() => setResolvingShift(s)} title="Link to staff & participant">Link</button>
                        <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.2rem 0.45rem' }} onClick={() => handleDeleteAppShift(s.shift_id)} title="Dismiss">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {duplicatesOpen && (
        <div className="modal-overlay" onClick={() => setDuplicatesOpen(false)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <h3>Find duplicate shifts</h3>
            <p style={{ color: '#64748b', marginBottom: '1rem', fontSize: '0.9rem' }}>
              Finds duplicates by <strong>participant name + staff name + date + time</strong>. Also shows groups that share the same import ID (Progress Notes App).
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <label>
                <span style={{ marginRight: '0.5rem' }}>Staff (optional):</span>
                <select
                  value={duplicatesStaffId}
                  onChange={(e) => setDuplicatesStaffId(e.target.value)}
                  style={{ minWidth: 160 }}
                >
                  <option value="">All staff</option>
                  {(staffList || []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-primary"
                disabled={duplicatesLoading}
                onClick={async () => {
                  setDuplicatesLoading(true);
                  try {
                    const params = duplicatesStaffId ? { staff_id: duplicatesStaffId } : {};
                    const data = await shifts.duplicates(params);
                    setDuplicatesData(data);
                  } catch (e) {
                    console.error(e);
                    setDuplicatesData({ error: e.message });
                  } finally {
                    setDuplicatesLoading(false);
                  }
                }}
              >
                {duplicatesLoading ? 'Checking…' : 'Run check'}
              </button>
            </div>
            {duplicatesData && !duplicatesData.error && (
              <div style={{ maxHeight: 420, overflow: 'auto' }}>
                {(duplicatesData.summary?.duplicateGroupsBySameSlot ?? 0) === 0 && (duplicatesData.summary?.duplicateGroupsByShifterId ?? 0) === 0 && (
                  <p style={{ color: '#64748b' }}>No duplicate groups found.</p>
                )}
                {(duplicatesData.bySameSlot ?? []).length > 0 && (
                  <div style={{ marginBottom: '1.5rem' }}>
                    <h4 style={{ marginBottom: '0.5rem' }}>Same participant, staff, date and time</h4>
                    <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.5rem' }}>Shifts that match on participant name, staff name, date and start time (likely double-ups).</p>
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {(duplicatesData.bySameSlot ?? []).map((grp, i) => (
                        <li key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.5rem 0.75rem', marginBottom: '0.5rem' }}>
                          <strong>{grp[0]?.participant_name} · {grp[0]?.staff_name} · {grp[0]?.start_time?.slice(0, 10)} {grp[0]?.start_time?.slice(11, 16)}</strong>
                          <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                            {(Array.isArray(grp) ? grp : []).map((s) => (
                              <li key={s.id} style={{ marginBottom: '0.25rem' }}>
                                {s.start_time?.slice(0, 16)} – {s.end_time?.slice(11, 16)} —{' '}
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDuplicatesOpen(false); navigate(`/shifts/${s.id}`); }}>View</button>
                                <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: '0.25rem' }} onClick={() => { setDuplicatesOpen(false); handleEditShift(s); }}>Edit</button>
                                <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: '0.25rem', color: '#b91c1c' }} onClick={() => handleDeleteDuplicateShift(s)} title="Delete this duplicate">Delete</button>
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(duplicatesData.byShifterId ?? []).length > 0 && (
                  <div>
                    <h4 style={{ marginBottom: '0.5rem' }}>Same import ID (Progress Notes App)</h4>
                    <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.5rem' }}>Shifts that share the same import ID from the app.</p>
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {(duplicatesData.byShifterId ?? []).map((grp, i) => (
                        <li key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.5rem 0.75rem', marginBottom: '0.5rem' }}>
                          <strong>ID: {grp.shifter_shift_id}</strong>
                          <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                            {(grp.shifts ?? []).map((s) => (
                              <li key={s.id} style={{ marginBottom: '0.25rem' }}>
                                {s.participant_name} · {s.staff_name} · {s.start_time?.slice(0, 16)} —{' '}
                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDuplicatesOpen(false); navigate(`/shifts/${s.id}`); }}>View</button>
                                <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: '0.25rem' }} onClick={() => { setDuplicatesOpen(false); handleEditShift(s); }}>Edit</button>
                                <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: '0.25rem', color: '#b91c1c' }} onClick={() => handleDeleteDuplicateShift(s)} title="Delete this duplicate">Delete</button>
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {duplicatesData.summary && (duplicatesData.summary.duplicateGroupsBySameSlot > 0 || duplicatesData.summary.duplicateGroupsByShifterId > 0) && (
                  <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#64748b' }}>
                    {duplicatesData.summary.duplicateGroupsBySameSlot} group(s) by participant+staff+date+time, {duplicatesData.summary.duplicateGroupsByShifterId} group(s) by import ID · {duplicatesData.summary.totalDuplicateShifts} shift(s) in total
                  </p>
                )}
              </div>
            )}
            {duplicatesData?.error && <p style={{ color: '#dc2626' }}>{duplicatesData.error}</p>}
            <div style={{ marginTop: '1rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setDuplicatesOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {view === 'planner' && (
        <div className="card">
          {loading ? <p>Loading...</p> : (
            <WeekPlanner
              weekStart={weekStart}
              shiftList={shiftList}
              participantsList={participantsList}
              staffList={staffList}
              onCreateShift={async (data) => {
                try {
                  const created = await shifts.create(data);
                  setShiftList((prev) => [...prev, { ...created, participant_name: participantsList.find((p) => p.id === data.participant_id)?.name ?? '', staff_name: staffList.find((s) => s.id === data.staff_id)?.name ?? '' }]);
                  load({ silent: true });
                } catch (err) {
                  alert(err.message);
                }
              }}
              onUpdateShift={async (id, data) => {
                try {
                  const shift = shiftList.find((s) => s.id === id);
                  if (shift?.recurring_group_id) {
                    const groupShifts = await shifts.listByRecurringGroup(shift.recurring_group_id);
                    setMoveConfirm({ shift, count: groupShifts.length, data });
                    return;
                  }
                  await shifts.update(id, data);
                  load({ silent: true });
                } catch (err) {
                  alert(err.message);
                }
              }}
              onDeleteShift={async (shift) => {
                if (shift.recurring_group_id) {
                  const groupShifts = await shifts.listByRecurringGroup(shift.recurring_group_id);
                  setDeleteConfirm({ shift, count: groupShifts.length });
                  return;
                }
                try {
                  await shifts.delete(shift.id);
                  setShiftList((prev) => prev.filter((s) => s.id !== shift.id));
                  load({ silent: true });
                } catch (err) {
                  alert(err.message);
                }
              }}
              onEditShift={handleEditShift}
            />
          )}
        </div>
      )}

      {view === 'table' && (
        <div className="card">
          {loading ? <p>Loading...</p> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Participant</th>
                    <th>Staff</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {shiftList.map((s) => (
                    <tr key={s.id}>
                      <td>{formatDate(s.start_time)}</td>
                      <td>{new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {new Date(s.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                      <td>{s.participant_name}</td>
                      <td>{s.staff_name}</td>
                      <td><span className={`badge badge-${s.status}`}>{s.status}</span></td>
                      <td>
                        {s.roster_sent_at && <span className="badge badge-completed" style={{ marginRight: '0.25rem' }} title="Roster sent">Sent</span>}
                        <button className="btn btn-primary" style={{ fontSize: '0.75rem', marginRight: '0.25rem' }} onClick={() => navigate(`/shifts/${s.id}`)}>View / Charges</button>
                        <a href={shifts.icsUrl(s.id)} download className="btn btn-secondary" style={{ fontSize: '0.75rem', marginRight: '0.25rem' }} title="Download ICS">ICS</a>
                        <button className="btn btn-secondary" style={{ fontSize: '0.75rem' }} onClick={() => handleEditShift(s)}>Edit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && shiftList.length === 0 && (
            <div className="empty-state">
              <p>No shifts this week. Drag a worker and client onto the planner to create a shift.</p>
            </div>
          )}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => {
          if (window.getSelection?.()?.toString?.()) return;
          setShowModal(false);
          setEditingShift(null);
          window.history.replaceState({}, '', '/shifts');
        }}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <h3>{editingShift ? 'Edit Shift' : 'New Shift'}</h3>
            <form ref={formRef} onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Participant *</label>
                <SearchableSelect
                  options={participantsList.map((p) => ({ id: p.id, name: p.name }))}
                  value={form.participant_id}
                  onChange={(id) => setForm({ ...form, participant_id: id })}
                  placeholder="Search participants..."
                  required
                />
              </div>
              <div className="form-group">
                <label>Staff *</label>
                <SearchableSelect
                  options={staffList.map((s) => ({ id: s.id, name: s.name }))}
                  value={form.staff_id}
                  onChange={(id) => setForm({ ...form, staff_id: id })}
                  placeholder="Search workers..."
                  required
                />
              </div>
              <SuggestionPanel
                participantId={form.participant_id}
                staffId={form.staff_id}
                date={form.start_time ? form.start_time.slice(0, 10) : undefined}
                onApplySuggestion={(field, value) => {
                  if (field === 'start_time' && value && form.start_time) {
                    const datePrefix = form.start_time.slice(0, 11) || new Date().toISOString().slice(0, 11);
                    setForm(f => ({ ...f, start_time: datePrefix + value }));
                  } else if (field === 'end_time' && value && form.end_time) {
                    const datePrefix = (form.end_time || form.start_time || '').slice(0, 11) || new Date().toISOString().slice(0, 11);
                    setForm(f => ({ ...f, end_time: datePrefix + value }));
                  }
                }}
              />
              <div className="form-group">
                <label>Start *</label>
                <input type="datetime-local" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} required step="1800" />
              </div>
              <div className="form-group">
                <label>End *</label>
                <input type="datetime-local" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} required step="1800" />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="Notes are sent to the worker when roster is sent" />
              </div>
              {editingShift && (
                <div className="form-group" style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #eee' }}>
                  <label style={{ fontWeight: 600 }}>Make recurring</label>
                  <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem' }}>Create additional shifts from the next occurrence onwards. The current shift stays in place. Save first if you need to change its times.</p>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                    <div>
                      <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.25rem' }}>Frequency</label>
                      <select value={recurring.frequency} onChange={(e) => setRecurring({ ...recurring, frequency: e.target.value })}>
                        <option value="weekly">Weekly</option>
                        <option value="fortnightly">Fortnightly</option>
                        <option value="3weeks">Every 3 weeks</option>
                        <option value="4weeks">Every 4 weeks</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.25rem' }}>Until</label>
                      <select value={recurring.end} onChange={(e) => setRecurring({ ...recurring, end: e.target.value })}>
                        <option value="plan">End of plan</option>
                        <option value="ongoing">Ongoing (1 year)</option>
                        <option value="date">Until date</option>
                      </select>
                    </div>
                    {recurring.end === 'date' && (
                      <div>
                        <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.25rem' }}>End date</label>
                        <input type="date" value={recurring.untilDate} onChange={(e) => setRecurring({ ...recurring, untilDate: e.target.value })} />
                      </div>
                    )}
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={handleApplyRecurring} style={{ marginTop: '0.25rem' }}>
                    Apply recurring
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                <button type="submit" className="btn btn-primary">{editingShift ? 'Save' : 'Create'}</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    sendAfterRef.current = true;
                    formRef.current?.requestSubmit();
                  }}
                  title="Save shift and email it to the assigned staff member"
                >
                  {editingShift ? 'Save & send to staff' : 'Create & send to staff'}
                </button>
                {editingShift && (
                  <button type="button" className="btn btn-primary" onClick={() => { setShowModal(false); setEditingShift(null); navigate(`/shifts/${editingShift.id}`); }}>
                    View / Charges
                  </button>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => { setShowModal(false); setEditingShift(null); window.history.replaceState({}, '', '/shifts'); }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3>Delete recurring shift</h3>
            <p>
              This shift is part of a recurring series ({deleteConfirm.count} shift{deleteConfirm.count !== 1 ? 's' : ''}). Do you want to delete only this shift or all shifts in this series?
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={handleDeleteOne}>
                Delete this shift only
              </button>
              <button type="button" className="btn btn-danger" onClick={handleDeleteAllInSeries}>
                Delete all in series
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {moveConfirm && (
        <div className="modal-overlay" onClick={() => setMoveConfirm(null)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3>Move recurring shift</h3>
            <p>
              This shift is part of a recurring series ({moveConfirm.count} shift{moveConfirm.count !== 1 ? 's' : ''}). Do you want to move only this shift or all shifts in this series?
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={handleMoveOne}>
                Move this shift only
              </button>
              <button type="button" className="btn btn-primary" onClick={handleMoveAllInSeries}>
                Move all in series
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setMoveConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {resolvingShift && (
        <ResolveShiftModal
          shift={resolvingShift}
          staffList={staffList?.map((s) => ({ id: s.id, name: s.name })) || []}
          participantsList={participantsList?.map((p) => ({ id: p.id, name: p.name })) || []}
          onClose={() => setResolvingShift(null)}
          onResolved={() => { setResolvingShift(null); loadAppShifts(); load(); }}
          onRefreshLists={refreshListsForModal}
        />
      )}
    </div>
  );
}
