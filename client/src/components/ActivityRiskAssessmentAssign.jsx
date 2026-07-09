import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { activityRiskAssessments } from '../lib/api';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';

export default function ActivityRiskAssessmentAssign({ participantId, onAssigned }) {
  const pathPrefix = useProductPathPrefix();
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    activityRiskAssessments
      .listRecords()
      .then((res) => {
        const list = (res?.records || []).filter((r) => r.is_complete && r.is_admin_signed);
        setRecords(list);
        setSelectedId((prev) => (prev && list.some((r) => r.id === prev) ? prev : list[0]?.id || ''));
      })
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const selectedRecord = records.find((r) => r.id === selectedId);
  const alreadyAssigned = (selectedRecord?.assignments || []).some((a) => a.participant_id === participantId);

  const handleAssign = async () => {
    if (!selectedId) {
      setMessage('Choose a completed activity risk assessment.');
      return;
    }
    if (alreadyAssigned) {
      setMessage('This participant already has that assessment.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await activityRiskAssessments.assignRecordToParticipant(selectedId, participantId);
      setMessage(`Added “${result.filename}” to this participant’s documents.`);
      reload();
      if (onAssigned) onAssigned();
    } catch (err) {
      setMessage(err.message || 'Could not add risk assessment.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="forms-muted" style={{ fontSize: '0.9rem' }}>Loading activity risk assessments…</p>;
  if (!records.length) {
    return (
      <p className="forms-muted" style={{ fontSize: '0.9rem' }}>
        No signed activity risk assessments yet. Complete one under{' '}
        <Link to={`${pathPrefix}/forms`}>Forms → Activity risk assessments</Link>, have an admin sign it with
        Nexus Core, then return here to add it to this participant.
      </p>
    );
  }

  const isError =
    message &&
    (message.includes('Could not') || message.includes('Choose') || message.includes('already'));

  return (
    <div
      style={{
        marginTop: '1.25rem',
        padding: '1rem',
        borderRadius: 8,
        border: '1px solid #e2e8f0',
        background: '#f8fafc'
      }}
    >
      <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Activity risk assessment</h4>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.88rem', color: '#64748b' }}>
        Pick a <strong>signed</strong> activity assessment from Forms. The same assessment can be assigned to many
        participants — each gets their own copy in their file.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <select
          className="form-input"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={busy}
          style={{ maxWidth: 360, minWidth: 180 }}
        >
          {records.map((r) => (
            <option key={r.id} value={r.id}>
              {r.template_activity_name || r.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || alreadyAssigned}
          onClick={handleAssign}
        >
          {busy ? 'Adding…' : alreadyAssigned ? 'Already assigned' : 'Add to participant file'}
        </button>
      </div>
      {message ? (
        <p style={{ margin: '0.75rem 0 0', fontSize: '0.88rem', color: isError ? '#991b1b' : '#166534' }}>{message}</p>
      ) : null}
    </div>
  );
}
