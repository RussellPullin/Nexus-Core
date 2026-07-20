import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { activityRiskAssessments, participants } from '../lib/api';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import ActivityRiskAssessmentEditor from './ActivityRiskAssessmentEditor';

const SIGN_OFF_FIELD_PREFIXES = ['pre_activity_', 'post_activity_'];
const SIGN_OFF_EXTRA_FIELDS = new Set(['consent_yes', 'consent_na']);

function isSignOffField(name) {
  const key = String(name || '');
  if (SIGN_OFF_EXTRA_FIELDS.has(key)) return true;
  return SIGN_OFF_FIELD_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export default function ActivityRiskAssessmentsPanel({ onMessage }) {
  const prefix = useProductPathPrefix();
  const [templates, setTemplates] = useState([]);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newActivityName, setNewActivityName] = useState('');
  const [editingRecordId, setEditingRecordId] = useState(null);
  const [assignRecordId, setAssignRecordId] = useState(null);
  const [participantSearch, setParticipantSearch] = useState('');
  const [participantOptions, setParticipantOptions] = useState([]);
  const [selectedParticipantId, setSelectedParticipantId] = useState('');
  const [assignMessage, setAssignMessage] = useState('');

  const notify = (msg, isError) => {
    if (onMessage) onMessage(msg, isError);
  };

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([activityRiskAssessments.list(), activityRiskAssessments.listRecords()])
      .then(([templatesRes, recordsRes]) => {
        setTemplates(templatesRes?.templates || []);
        setRecords(recordsRes?.records || []);
      })
      .catch((e) => notify(e.message || 'Could not load risk assessments', true))
      .finally(() => setLoading(false));
  }, [onMessage]);

  useEffect(() => {
    reload();
  }, [reload]);

  // After signing in a new tab, refresh status when the user returns to this page.
  useEffect(() => {
    const awaiting = records.some((r) => r.is_awaiting_signature && !r.is_admin_signed);
    if (!awaiting) return undefined;
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [records, reload]);

  const recordsByTemplateId = useMemo(() => {
    const map = new Map();
    for (const record of records) {
      if (!map.has(record.template_id)) map.set(record.template_id, record);
    }
    return map;
  }, [records]);

  const activities = useMemo(
    () =>
      templates
        .filter((t) => !t.is_default_blank)
        .map((t) => ({
          template: t,
          record: recordsByTemplateId.get(t.id) || null
        })),
    [templates, recordsByTemplateId]
  );

  const assignRecord = useMemo(
    () => (assignRecordId ? records.find((r) => r.id === assignRecordId) : null),
    [assignRecordId, records]
  );

  const assignedParticipantIds = useMemo(
    () => new Set((assignRecord?.assignments || []).map((a) => a.participant_id)),
    [assignRecord]
  );

  useEffect(() => {
    if (!assignRecordId) return;
    const q = participantSearch.trim();
    const timer = window.setTimeout(() => {
      participants
        .list(q, false, false)
        .then((rows) => setParticipantOptions(Array.isArray(rows) ? rows : []))
        .catch(() => setParticipantOptions([]));
    }, q ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [assignRecordId, participantSearch]);

  const handleCreateTemplate = async (e) => {
    e.preventDefault();
    const name = newActivityName.trim();
    if (!name) {
      notify('Enter an activity name (e.g. Rock climbing).', true);
      return;
    }
    setBusy(true);
    try {
      await activityRiskAssessments.create(name);
      setNewActivityName('');
      notify(`Added activity “${name}”.`);
      reload();
    } catch (err) {
      notify(err.message || 'Create failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleStartOrEdit = async (template) => {
    const existing = recordsByTemplateId.get(template.id);
    if (existing) {
      setEditingRecordId(existing.id);
      return;
    }
    setBusy(true);
    try {
      const created = await activityRiskAssessments.createRecord(template.id);
      notify(`Started risk assessment for “${template.activity_name}”.`);
      setEditingRecordId(created.id);
      reload();
    } catch (err) {
      notify(err.message || 'Could not start risk assessment', true);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTemplate = async (t) => {
    if (!window.confirm(`Remove activity “${t.activity_name}”? Completed assessments for it are kept.`)) return;
    setBusy(true);
    try {
      await activityRiskAssessments.delete(t.id);
      notify('Activity removed.');
      reload();
    } catch (err) {
      notify(err.message || 'Delete failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteRecord = async (record) => {
    if (
      !window.confirm(
        `Delete the completed assessment for “${record.template_activity_name}”? Participants who already received a copy keep their document.`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await activityRiskAssessments.deleteRecord(record.id);
      notify('Risk assessment deleted.');
      reload();
    } catch (err) {
      notify(err.message || 'Delete failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleSignAsAdmin = async (record) => {
    setBusy(true);
    try {
      const result = await activityRiskAssessments.signRecordAsAdmin(record.id);
      const path = result?.signing_path || (result?.signing_url ? new URL(result.signing_url).pathname : null);
      if (path) {
        window.open(path, '_blank', 'noopener,noreferrer');
        notify(`Signing opened for “${record.template_activity_name || record.title}”. Complete the signature, then return here.`);
      } else {
        notify('Signing session created, but no signing link was returned.', true);
      }
      reload();
    } catch (err) {
      notify(err.message || 'Could not start signing', true);
    } finally {
      setBusy(false);
    }
  };

  const openAssignModal = (recordId) => {
    setEditingRecordId(null);
    setAssignRecordId(recordId);
    setSelectedParticipantId('');
    setParticipantSearch('');
    setAssignMessage('');
    participants
      .list('', false, false)
      .then((rows) => setParticipantOptions(Array.isArray(rows) ? rows : []))
      .catch(() => setParticipantOptions([]));
  };

  const closeAssignModal = () => {
    setAssignRecordId(null);
    setSelectedParticipantId('');
    setParticipantSearch('');
    setAssignMessage('');
  };

  const handleAssign = async () => {
    if (!assignRecordId || !selectedParticipantId) {
      setAssignMessage('Choose a participant.');
      return;
    }
    if (assignedParticipantIds.has(selectedParticipantId)) {
      setAssignMessage('This participant already has this assessment.');
      return;
    }
    setBusy(true);
    setAssignMessage('');
    try {
      const result = await activityRiskAssessments.assignRecordToParticipant(assignRecordId, selectedParticipantId);
      const participantName =
        participantOptions.find((p) => p.id === selectedParticipantId)?.name || 'participant';
      setAssignMessage(`Added to ${participantName}. Choose another participant to assign the same assessment again.`);
      setSelectedParticipantId('');
      setParticipantSearch('');
      reload();
      notify(`Added “${result.filename}” to ${participantName}.`);
    } catch (err) {
      setAssignMessage(err.message || 'Could not assign to participant');
    } finally {
      setBusy(false);
    }
  };

  const formatAssignedNames = (record) => {
    const names = (record?.assignments || []).map((a) => a.participant_name).filter(Boolean);
    if (!names.length) return '—';
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
  };

  const renderStatus = (record) => {
    if (!record) return <span className="forms-muted">Not started</span>;
    if (record.is_admin_signed) return <span style={{ color: '#166534' }}>Signed — ready to assign</span>;
    if (record.is_awaiting_signature) return <span style={{ color: '#b45309' }}>Signature in progress</span>;
    if (record.is_complete) return <span style={{ color: '#b45309' }}>Awaiting admin signature</span>;
    return <span style={{ color: '#b45309' }}>In progress</span>;
  };

  return (
    <div className="activity-risk-assessments-panel">
      <p className="forms-lede">
        Complete a risk assessment <strong>once per activity</strong>, then click{' '}
        <strong>Sign with Nexus Core</strong> to open the built-in signing page (default signatory from{' '}
        <Link to={`${prefix}/settings`}>Settings → Business</Link>). After you sign and submit, assign the
        assessment to as many participants as you need. Each participant gets their own copy in their file.
      </p>

      <form onSubmit={handleCreateTemplate} className="forms-add-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          className="form-input"
          placeholder="New activity (e.g. Rock climbing)"
          value={newActivityName}
          onChange={(e) => setNewActivityName(e.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Working…' : 'Add activity'}
        </button>
      </form>

      {loading ? (
        <p className="forms-muted">Loading…</p>
      ) : activities.length === 0 ? (
        <p className="forms-muted">No activities yet. Add one above to get started.</p>
      ) : (
        <div className="table-wrap">
          <table className="table-condensed forms-data-table">
            <thead>
              <tr>
                <th>Activity</th>
                <th>Status</th>
                <th>Assigned to</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activities.map(({ template, record }) => (
                <tr key={template.id}>
                  <td>{template.activity_name}</td>
                  <td>{renderStatus(record)}</td>
                  <td>
                    {record ? (
                      <span title={(record.assignments || []).map((a) => a.participant_name).join(', ')}>
                        {formatAssignedNames(record)}
                        {record.assignment_count > 0 ? (
                          <span className="forms-muted" style={{ marginLeft: '0.35rem', fontSize: '0.8rem' }}>
                            ({record.assignment_count})
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ marginRight: '0.35rem' }}
                      disabled={busy}
                      onClick={() => handleStartOrEdit(template)}
                    >
                      {record ? 'Edit' : 'Complete assessment'}
                    </button>
                    {record ? (
                      <>
                        <a
                          href={activityRiskAssessments.recordFileUrl(record.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-secondary btn-sm"
                          style={{ marginRight: '0.35rem' }}
                        >
                          PDF
                        </a>
                        {!record.is_admin_signed ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ marginRight: '0.35rem' }}
                            disabled={busy || !record.is_complete}
                            title={
                              record.is_complete
                                ? 'Open Nexus Core signing to complete pre-activity sign-off'
                                : 'Save the assessment before signing'
                            }
                            onClick={() => handleSignAsAdmin(record)}
                          >
                            {record.is_awaiting_signature ? 'Open signing again' : 'Sign with Nexus Core'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ marginRight: '0.35rem' }}
                          disabled={busy || !record.is_admin_signed}
                          title={
                            record.is_admin_signed
                              ? undefined
                              : 'An admin must sign with Nexus Core before assigning'
                          }
                          onClick={() => openAssignModal(record.id)}
                        >
                          Assign to participant
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ marginRight: '0.35rem' }}
                          disabled={busy}
                          onClick={() => handleDeleteRecord(record)}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => handleDeleteTemplate(template)}
                    >
                      Remove activity
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingRecordId ? (
        <ActivityRiskAssessmentEditor
          recordId={editingRecordId}
          onClose={() => setEditingRecordId(null)}
          onSaved={reload}
        />
      ) : null}

      {assignRecordId ? (
        <div
          className="modal-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            zIndex: 1300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem'
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAssignModal();
          }}
        >
          <div className="card" style={{ width: 'min(520px, 100%)', margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>Assign to participant</h3>
            <p className="forms-muted" style={{ marginTop: 0 }}>
              Add <strong>{assignRecord?.template_activity_name || assignRecord?.title}</strong> to a participant&apos;s
              file. You can assign the same signed assessment to many participants — keep this window open and pick
              another name after each one.
            </p>
            {(assignRecord?.assignments || []).length > 0 ? (
              <p className="forms-muted" style={{ marginTop: 0, fontSize: '0.88rem' }}>
                Already assigned to:{' '}
                {(assignRecord.assignments || []).map((a) => a.participant_name).join(', ')}
              </p>
            ) : null}
            <div className="form-group">
              <label>Search participant</label>
              <input
                className="form-input"
                value={participantSearch}
                onChange={(e) => setParticipantSearch(e.target.value)}
                placeholder="Type a name…"
              />
            </div>
            <div className="form-group">
              <label>Participant</label>
              <select
                className="form-input"
                value={selectedParticipantId}
                onChange={(e) => setSelectedParticipantId(e.target.value)}
              >
                <option value="">Select…</option>
                {participantOptions.map((p) => (
                  <option key={p.id} value={p.id} disabled={assignedParticipantIds.has(p.id)}>
                    {p.name}
                    {assignedParticipantIds.has(p.id) ? ' (already assigned)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {assignMessage ? (
              <p
                style={{
                  margin: '0 0 0.75rem',
                  fontSize: '0.88rem',
                  color:
                    assignMessage.includes('Could not') ||
                    assignMessage.includes('Choose') ||
                    assignMessage.includes('already') ||
                    assignMessage.includes('must sign')
                      ? '#991b1b'
                      : '#166534'
                }}
              >
                {assignMessage}
              </p>
            ) : null}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={closeAssignModal}>
                Done
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !selectedParticipantId}
                onClick={handleAssign}
              >
                {busy ? 'Assigning…' : 'Assign to participant'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
