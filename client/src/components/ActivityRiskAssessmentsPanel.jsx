import { useState, useEffect, useCallback } from 'react';
import { activityRiskAssessments } from '../lib/api';

export default function ActivityRiskAssessmentsPanel({ onMessage }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newActivityName, setNewActivityName] = useState('');

  const notify = (msg, isError) => {
    if (onMessage) onMessage(msg, isError);
  };

  const reload = useCallback(() => {
    setLoading(true);
    activityRiskAssessments
      .list()
      .then((res) => setTemplates(res?.templates || []))
      .catch((e) => notify(e.message || 'Could not load risk assessments', true))
      .finally(() => setLoading(false));
  }, [onMessage]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleCreate = async (e) => {
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
      notify(`Added activity risk assessment template “${name}”.`);
      reload();
    } catch (err) {
      notify(err.message || 'Create failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (t) => {
    if (t.is_default_blank) return;
    if (!window.confirm(`Remove “${t.activity_name}” from the catalogue? Existing participant copies are not deleted.`)) {
      return;
    }
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

  return (
    <div className="activity-risk-assessments-panel">
      <p className="forms-lede">
        Generic health &amp; safety risk assessment (fillable PDF, no organisation branding). Add one entry per activity
        (e.g. Rock climbing, Kayaking). From a participant profile, assign a blank copy to their documents — entries
        also append to the <strong>Risk register</strong> in Registers (OneDrive) and sync to the participant&apos;s{' '}
        <strong>Risk assessments</strong> folder when connected. For your own branded PDFs, use{' '}
        <strong>Form templates (workflows)</strong> below and Dropbox Sign.
      </p>

      <form onSubmit={handleCreate} className="forms-add-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
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
        <div className="table-wrap">
          <table className="table-condensed forms-data-table">
            <thead>
              <tr>
                <th>Activity</th>
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
                    <a
                      href={activityRiskAssessments.fileUrl(t.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary btn-sm"
                      style={{ marginRight: '0.35rem' }}
                    >
                      Preview PDF
                    </a>
                    {!t.is_default_blank ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() => handleDelete(t)}
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
    </div>
  );
}
