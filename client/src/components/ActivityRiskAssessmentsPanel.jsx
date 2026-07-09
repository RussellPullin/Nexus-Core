import { useState, useEffect, useCallback } from 'react';
import { activityRiskAssessments, participants } from '../lib/api';
import ActivityRiskAssessmentEditor from './ActivityRiskAssessmentEditor';

export default function ActivityRiskAssessmentsPanel({ onMessage }) {
  const [templates, setTemplates] = useState([]);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newActivityName, setNewActivityName] = useState('');
  const [newRecordTemplateId, setNewRecordTemplateId] = useState('');
  const [newRecordTitle, setNewRecordTitle] = useState('');
  const [editingRecordId, setEditingRecordId] = useState(null);
  const [assignRecordId, setAssignRecordId] = useState(null);
  const [participantSearch, setParticipantSearch] = useState('');
  const [participantOptions, setParticipantOptions] = useState([]);
  const [selectedParticipantId, setSelectedParticipantId] = useState('');

  const notify = (msg, isError) => {
    if (onMessage) onMessage(msg, isError);
  };

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([activityRiskAssessments.list(), activityRiskAssessments.listRecords()])
      .then(([templatesRes, recordsRes]) => {
        const list = templatesRes?.templates || [];
        setTemplates(list);
        setRecords(recordsRes?.records || []);
        setNewRecordTemplateId((prev) => {
          if (prev) return prev;
          const firstNamed = list.find((t) => !t.is_default_blank) || list[0];
          return firstNamed?.id || '';
        });
      })
      .catch((e) => notify(e.message || 'Could not load risk assessments', true))
      .finally(() => setLoading(false));
  }, [onMessage]);

  useEffect(() => {
    reload();
  }, [reload]);

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
      notify(`Added activity template “${name}”.`);
      reload();
    } catch (err) {
      notify(err.message || 'Create failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRecord = async (e) => {
    e.preventDefault();
    if (!newRecordTemplateId) {
      notify('Choose an activity template first.', true);
      return;
    }
    setBusy(true);
    try {
      const created = await activityRiskAssessments.createRecord(
        newRecordTemplateId,
        newRecordTitle.trim() || undefined
      );
      setNewRecordTitle('');
      notify(`Created risk assessment “${created.title}”.`);
      setEditingRecordId(created.id);
      reload();
    } catch (err) {
      notify(err.message || 'Could not create risk assessment', true);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTemplate = async (t) => {
    if (t.is_default_blank) return;
    if (!window.confirm(`Remove template “${t.activity_name}”? Saved assessments using it are kept.`)) return;
    setBusy(true);
    try {
      await activityRiskAssessments.delete(t.id);
      notify('Activity template removed.');
      reload();
    } catch (err) {
      notify(err.message || 'Delete failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteRecord = async (record) => {
    if (!window.confirm(`Delete saved risk assessment “${record.title}”?`)) return;
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

  const handleAssign = async () => {
    if (!assignRecordId || !selectedParticipantId) {
      notify('Choose a participant.', true);
      return;
    }
    setBusy(true);
    try {
      const result = await activityRiskAssessments.assignRecordToParticipant(assignRecordId, selectedParticipantId);
      notify(`Added “${result.filename}” to participant documents.`);
      setAssignRecordId(null);
      setSelectedParticipantId('');
      setParticipantSearch('');
    } catch (err) {
      notify(err.message || 'Could not assign to participant', true);
    } finally {
      setBusy(false);
    }
  };

  const creatableTemplates = templates.filter((t) => !t.is_default_blank);
  const templateChoices = creatableTemplates.length ? creatableTemplates : templates;

  return (
    <div className="activity-risk-assessments-panel">
      <p className="forms-lede">
        Create activity templates, fill in and <strong>save</strong> risk assessments here in Nexus Core, then add a
        saved copy to a participant&apos;s file. Assignments also appear in Registers → Risk register and sync to
        OneDrive when connected.
      </p>

      <h3 className="forms-subheading" style={{ marginTop: '1.25rem' }}>Activity templates</h3>
      <p className="forms-muted" style={{ marginTop: 0 }}>
        One template per activity type (e.g. Rock climbing, Kayaking).
      </p>

      <form onSubmit={handleCreateTemplate} className="forms-add-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          className="form-input"
          placeholder="New activity name (e.g. Rock climbing)"
          value={newActivityName}
          onChange={(e) => setNewActivityName(e.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Working…' : 'Add activity template'}
        </button>
      </form>

      {loading ? (
        <p className="forms-muted">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="forms-muted">No templates yet.</p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: '1.5rem' }}>
          <table className="table-condensed forms-data-table">
            <thead>
              <tr>
                <th>Activity template</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.activity_name}
                    {t.is_default_blank ? (
                      <span className="forms-muted" style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}>
                        (master blank)
                      </span>
                    ) : null}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!t.is_default_blank ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() => handleDeleteTemplate(t)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="forms-subheading">Saved risk assessments</h3>
      <p className="forms-muted" style={{ marginTop: 0 }}>
        Fill these in, save here, then assign to a participant when ready.
      </p>

      <form onSubmit={handleCreateRecord} className="forms-add-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select
          className="form-input"
          value={newRecordTemplateId}
          onChange={(e) => setNewRecordTemplateId(e.target.value)}
          disabled={busy || !templateChoices.length}
          style={{ minWidth: 200 }}
        >
          {templateChoices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.activity_name}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="form-input"
          placeholder="Title (optional — defaults to activity name)"
          value={newRecordTitle}
          onChange={(e) => setNewRecordTitle(e.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !templateChoices.length}>
          {busy ? 'Working…' : 'New risk assessment'}
        </button>
      </form>

      {!loading && records.length === 0 ? (
        <p className="forms-muted">No saved risk assessments yet. Click “New risk assessment” to start one.</p>
      ) : null}

      {!loading && records.length > 0 ? (
        <div className="table-wrap">
          <table className="table-condensed forms-data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Activity</th>
                <th>Last updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td>{r.template_activity_name}</td>
                  <td>{r.updated_at ? String(r.updated_at).replace('T', ' ').slice(0, 16) : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ marginRight: '0.35rem' }}
                      disabled={busy}
                      onClick={() => setEditingRecordId(r.id)}
                    >
                      Edit / Save
                    </button>
                    <a
                      href={activityRiskAssessments.recordFileUrl(r.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary btn-sm"
                      style={{ marginRight: '0.35rem' }}
                    >
                      PDF
                    </a>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ marginRight: '0.35rem' }}
                      disabled={busy}
                      onClick={() => {
                        setAssignRecordId(r.id);
                        setSelectedParticipantId('');
                        setParticipantSearch('');
                      }}
                    >
                      Add to participant
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => handleDeleteRecord(r)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

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
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem'
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setAssignRecordId(null);
          }}
        >
          <div className="card" style={{ width: 'min(480px, 100%)', margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>Add to participant</h3>
            <p className="forms-muted" style={{ marginTop: 0 }}>
              The saved risk assessment (with your entered details) will be added to the participant&apos;s documents.
            </p>
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
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setAssignRecordId(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !selectedParticipantId} onClick={handleAssign}>
                {busy ? 'Adding…' : 'Add to participant file'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
