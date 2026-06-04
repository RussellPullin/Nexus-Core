import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { activityRiskAssessments } from '../lib/api';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';

export default function ActivityRiskAssessmentAssign({ participantId, onAssigned }) {
  const pathPrefix = useProductPathPrefix();
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    activityRiskAssessments
      .list()
      .then((res) => {
        const list = (res?.templates || []).filter((t) => !t.is_default_blank);
        const withDefault = (res?.templates || []).filter((t) => t.is_default_blank);
        const combined = [...withDefault, ...list];
        setTemplates(combined);
        if (!selectedId && combined.length) setSelectedId(combined[0].id);
      })
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleAssign = async () => {
    if (!selectedId) {
      setMessage('Choose an activity template.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await activityRiskAssessments.assignToParticipant(selectedId, participantId);
      setMessage(`Added “${result.filename}” to this participant’s documents.`);
      if (onAssigned) onAssigned();
    } catch (err) {
      setMessage(err.message || 'Could not add risk assessment.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="forms-muted" style={{ fontSize: '0.9rem' }}>Loading activity templates…</p>;
  if (!templates.length) {
    return (
      <p className="forms-muted" style={{ fontSize: '0.9rem' }}>
        No activity risk assessment templates yet. Add them under{' '}
        <Link to={`${pathPrefix}/forms`}>Forms → Activity risk assessments</Link>.
      </p>
    );
  }

  const isError = message && (message.includes('Could not') || message.includes('Choose'));

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
        Add a blank health &amp; safety risk assessment PDF to this participant&apos;s file (category: Risk assessment).
        The assignment is listed under Registers → Risk register — activity assessments and in OneDrive when connected.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <select
          className="form-input"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={busy}
          style={{ maxWidth: 320, minWidth: 180 }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.activity_name}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={handleAssign}>
          {busy ? 'Adding…' : 'Add to participant file'}
        </button>
      </div>
      {message ? (
        <p style={{ margin: '0.75rem 0 0', fontSize: '0.88rem', color: isError ? '#991b1b' : '#166534' }}>{message}</p>
      ) : null}
    </div>
  );
}
