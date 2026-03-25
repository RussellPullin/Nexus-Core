import { useState, useEffect } from 'react';
import { appShifts } from '../lib/api';
import SearchableSelect from './SearchableSelect';
import { formatDate } from '../lib/dateUtils';

export default function ResolveShiftModal({ shift, staffList, participantsList, onClose, onResolved, onRefreshLists }) {
  const [staffMode, setStaffMode] = useState('existing');
  const [participantMode, setParticipantMode] = useState('existing');
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [selectedParticipantId, setSelectedParticipantId] = useState('');
  const [newStaffName, setNewStaffName] = useState(shift.staff_name || '');
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffPhone, setNewStaffPhone] = useState('');
  const [newParticipantName, setNewParticipantName] = useState(shift.client_name || '');
  const [newParticipantNdis, setNewParticipantNdis] = useState('');
  const [newParticipantEmail, setNewParticipantEmail] = useState('');
  const [newParticipantPhone, setNewParticipantPhone] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');

  const staffMatched = staffList.some(
    (s) => s.name.toLowerCase().trim() === (shift.staff_name || '').toLowerCase().trim()
  );
  const participantMatched = participantsList.some(
    (p) => p.name.toLowerCase().trim() === (shift.client_name || '').toLowerCase().trim()
  );

  useEffect(() => {
    if (staffMatched) {
      const match = staffList.find((s) => s.name.toLowerCase().trim() === (shift.staff_name || '').toLowerCase().trim());
      if (match) setSelectedStaffId(match.id);
    }
    if (participantMatched) {
      const match = participantsList.find((p) => p.name.toLowerCase().trim() === (shift.client_name || '').toLowerCase().trim());
      if (match) setSelectedParticipantId(match.id);
    }
  }, []);

  const handleResolve = async () => {
    setError('');
    setResolving(true);
    try {
      const payload = {};
      if (staffMode === 'existing') {
        if (!selectedStaffId) { setError('Select a staff member'); setResolving(false); return; }
        payload.staff_id = selectedStaffId;
      } else {
        if (!newStaffName.trim()) { setError('Enter a name for the new staff member'); setResolving(false); return; }
        payload.new_staff = { name: newStaffName.trim(), email: newStaffEmail || undefined, phone: newStaffPhone || undefined };
      }
      if (participantMode === 'existing') {
        if (!selectedParticipantId) { setError('Select a participant'); setResolving(false); return; }
        payload.participant_id = selectedParticipantId;
      } else {
        if (!newParticipantName.trim()) { setError('Enter a name for the new participant'); setResolving(false); return; }
        payload.new_participant = { name: newParticipantName.trim(), ndis_number: newParticipantNdis || undefined, email: newParticipantEmail || undefined, phone: newParticipantPhone || undefined };
      }
      await appShifts.resolve(shift.shift_id, payload);
      onRefreshLists();
      onResolved();
    } catch (err) {
      setError(err.message || 'Resolve failed');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ minWidth: 420, maxWidth: 540, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 0.5rem' }}>Link Shift</h3>
        <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#64748b' }}>
          {shift.date ? formatDate(shift.date) : ''} &middot; {shift.start_time}–{shift.finish_time} &middot; Staff: <strong>{shift.staff_name || '—'}</strong> &middot; Client: <strong>{shift.client_name || '—'}</strong>
        </p>

        {error && <div style={{ background: '#fef2f2', color: '#dc2626', padding: '0.5rem 0.75rem', borderRadius: 6, marginBottom: '0.75rem', fontSize: '0.85rem' }}>{error}</div>}

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ fontWeight: 600 }}>Staff {staffMatched && <span style={{ color: '#16a34a', fontWeight: 400, fontSize: '0.8rem' }}>(auto-matched)</span>}</label>
          <div style={{ display: 'flex', gap: '0.5rem', margin: '0.35rem 0' }}>
            <button type="button" className={`btn ${staffMode === 'existing' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }} onClick={() => setStaffMode('existing')}>Select existing</button>
            <button type="button" className={`btn ${staffMode === 'new' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }} onClick={() => setStaffMode('new')}>Create new</button>
          </div>
          {staffMode === 'existing' ? (
            <SearchableSelect options={staffList} value={selectedStaffId} onChange={setSelectedStaffId} placeholder="Select staff..." />
          ) : (
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              <input type="text" className="form-input" placeholder="Name *" value={newStaffName} onChange={(e) => setNewStaffName(e.target.value)} />
              <input type="email" className="form-input" placeholder="Email (optional)" value={newStaffEmail} onChange={(e) => setNewStaffEmail(e.target.value)} />
              <input type="text" className="form-input" placeholder="Phone (optional)" value={newStaffPhone} onChange={(e) => setNewStaffPhone(e.target.value)} />
            </div>
          )}
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ fontWeight: 600 }}>Participant {participantMatched && <span style={{ color: '#16a34a', fontWeight: 400, fontSize: '0.8rem' }}>(auto-matched)</span>}</label>
          <div style={{ display: 'flex', gap: '0.5rem', margin: '0.35rem 0' }}>
            <button type="button" className={`btn ${participantMode === 'existing' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }} onClick={() => setParticipantMode('existing')}>Select existing</button>
            <button type="button" className={`btn ${participantMode === 'new' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }} onClick={() => setParticipantMode('new')}>Create new</button>
          </div>
          {participantMode === 'existing' ? (
            <SearchableSelect options={participantsList} value={selectedParticipantId} onChange={setSelectedParticipantId} placeholder="Select participant..." />
          ) : (
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              <input type="text" className="form-input" placeholder="Name *" value={newParticipantName} onChange={(e) => setNewParticipantName(e.target.value)} />
              <input type="text" className="form-input" placeholder="NDIS number (optional)" value={newParticipantNdis} onChange={(e) => setNewParticipantNdis(e.target.value)} />
              <input type="email" className="form-input" placeholder="Email (optional)" value={newParticipantEmail} onChange={(e) => setNewParticipantEmail(e.target.value)} />
              <input type="text" className="form-input" placeholder="Phone (optional)" value={newParticipantPhone} onChange={(e) => setNewParticipantPhone(e.target.value)} />
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={resolving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleResolve} disabled={resolving}>
            {resolving ? 'Linking…' : 'Link & Process Shift'}
          </button>
        </div>
      </div>
    </div>
  );
}
