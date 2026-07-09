import { useEffect, useMemo, useState } from 'react';
import { activityRiskAssessments } from '../lib/api';

const GROUP_ORDER = [
  'Document details',
  'Activity details',
  'Hazards',
  'Control measures',
  'Review questions',
  'Pre-activity sign-off',
  'Consent',
  'Post-activity sign-off',
  'Other'
];

function fieldGroup(name) {
  if (name.startsWith('hazard_')) return 'Hazards';
  if (name.startsWith('control_')) return 'Control measures';
  if (name.startsWith('review_q')) return 'Review questions';
  if (name.includes('pre_activity') || ['prepared_by', 'prepared_role', 'date_prepared', 'others_involved', 'reviewed_by', 'approval_date'].includes(name)) {
    return 'Pre-activity sign-off';
  }
  if (name.includes('post_activity') || ['completed_by', 'designation', 'signature', 'date'].includes(name)) {
    return 'Post-activity sign-off';
  }
  if (name.startsWith('consent')) return 'Consent';
  if (['approved_by', 'version', 'review_date', 'additional_notes', 'review_details'].includes(name)) {
    return 'Document details';
  }
  return 'Activity details';
}

function fieldLabel(name) {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ActivityRiskAssessmentEditor({ recordId, onClose, onSaved }) {
  const [title, setTitle] = useState('');
  const [values, setValues] = useState({});
  const [schema, setSchema] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([activityRiskAssessments.getRecord(recordId), activityRiskAssessments.fieldSchema()])
      .then(([record, schemaRes]) => {
        if (cancelled) return;
        setTitle(record?.title || '');
        setValues(record?.field_values && typeof record.field_values === 'object' ? record.field_values : {});
        setSchema(Array.isArray(schemaRes?.fields) ? schemaRes.fields : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Could not load risk assessment.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  const groupedFields = useMemo(() => {
    const groups = new Map(GROUP_ORDER.map((g) => [g, []]));
    for (const field of schema) {
      const group = fieldGroup(field.name);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(field);
    }
    return GROUP_ORDER.map((name) => ({ name, fields: groups.get(name) || [] })).filter((g) => g.fields.length > 0);
  }, [schema]);

  const setFieldValue = (name, value) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await activityRiskAssessments.updateRecord(recordId, { title: title.trim(), field_values: values });
      setSavedAt(new Date().toLocaleTimeString());
      if (onSaved) onSaved();
    } catch (e) {
      setError(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem'
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          width: 'min(920px, 100%)',
          maxHeight: '92vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          margin: 0
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>Edit risk assessment</h3>
            <p className="forms-muted" style={{ margin: '0.35rem 0 0', fontSize: '0.9rem' }}>
              Fill in the form below and click Save. Use Preview PDF to see the completed document.
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {loading ? (
          <p className="forms-muted">Loading…</p>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
              <div className="form-group" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
                <label>Title</label>
                <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <a
                href={activityRiskAssessments.recordFileUrl(recordId)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary btn-sm"
              >
                Preview PDF
              </a>
              <button type="button" className="btn btn-primary btn-sm" disabled={saving || !title.trim()} onClick={handleSave}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>

            {error ? <p style={{ color: '#991b1b', marginTop: 0 }}>{error}</p> : null}
            {savedAt ? <p style={{ color: '#166534', marginTop: 0, fontSize: '0.9rem' }}>Saved at {savedAt}.</p> : null}

            <div style={{ overflow: 'auto', flex: 1, paddingRight: '0.25rem' }}>
              {groupedFields.map((group) => (
                <section key={group.name} style={{ marginBottom: '1.25rem' }}>
                  <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', color: '#334155' }}>{group.name}</h4>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                      gap: '0.65rem 0.85rem'
                    }}
                  >
                    {group.fields.map((field) => {
                      const value = values[field.name];
                      if (field.type === 'checkbox') {
                        return (
                          <label
                            key={field.name}
                            style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem', fontSize: '0.88rem' }}
                          >
                            <input
                              type="checkbox"
                              checked={Boolean(value)}
                              onChange={(e) => setFieldValue(field.name, e.target.checked)}
                              style={{ marginTop: '0.15rem' }}
                            />
                            <span>{fieldLabel(field.name)}</span>
                          </label>
                        );
                      }
                      const isTextarea = field.type === 'textarea';
                      return (
                        <div key={field.name} className="form-group" style={{ marginBottom: 0 }}>
                          <label style={{ fontSize: '0.82rem' }}>{fieldLabel(field.name)}</label>
                          {isTextarea ? (
                            <textarea
                              className="form-input"
                              rows={3}
                              value={value ?? ''}
                              onChange={(e) => setFieldValue(field.name, e.target.value)}
                            />
                          ) : (
                            <input
                              className="form-input"
                              value={value ?? ''}
                              onChange={(e) => setFieldValue(field.name, e.target.value)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
