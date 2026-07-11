import { useState, useEffect, useCallback, useRef } from 'react';
import { forms } from '../lib/api';
import FormTemplateFieldEditor from './FormTemplateFieldEditor';

function workflowLabel(w) {
  if (w === 'staff_onboarding') return 'Staff onboarding';
  return 'Participant onboarding';
}

export default function CustomFormTemplatesPanel({ onMessage }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [workflow, setWorkflow] = useState('participant_onboarding');
  const [editingTemplate, setEditingTemplate] = useState(null);
  const fileInputRef = useRef(null);

  const notify = useCallback(
    (msg, isError) => {
      if (onMessage) onMessage(msg, isError);
    },
    [onMessage]
  );

  const reload = useCallback(() => {
    setLoading(true);
    forms
      .templates()
      .then((res) => {
        const custom = (res?.templates || []).filter((t) => t.form_type === 'custom');
        setTemplates(custom);
      })
      .catch((e) => notify(e.message || 'Could not load form templates', true))
      .finally(() => setLoading(false));
  }, [notify]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleCreateAndUpload = async (fileList) => {
    const file = fileList?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const displayName = file.name.replace(/\.[^.]+$/, '');
      const created = await forms.createTemplate({ display_name: displayName, workflow });
      await forms.uploadTemplate(null, file, { templateId: created.id });
      notify(`Created "${displayName}". Use Edit fields to place signing boxes.`);
      reload();
    } catch (e) {
      notify(e.message || 'Could not create form template', true);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (t) => {
    if (!window.confirm(`Delete form template "${t.display_name}"?`)) return;
    setBusy(true);
    try {
      await forms.deleteTemplate(t.id);
      notify('Form template deleted.');
      reload();
    } catch (e) {
      notify(e.message || 'Delete failed', true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="forms-lede">
        Upload your organisation&apos;s own PDF forms. Use <strong>Edit fields</strong> to place signing boxes and
        tag each one Participant, Staff, or Organisation. Adding an Organisation field automatically makes the
        organisation sign first — the other signer only gets access once that&apos;s done.
      </p>

      <div className="forms-add-row" style={{ marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="forms-label" style={{ marginBottom: 0 }}>
          Workflow
          <select
            className="form-input"
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            disabled={busy}
            style={{ marginLeft: '0.5rem', maxWidth: 220 }}
          >
            <option value="participant_onboarding">Participant onboarding</option>
            <option value="staff_onboarding">Staff onboarding</option>
          </select>
        </label>
        <label className="btn btn-primary btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Working…' : 'New custom form (upload PDF)'}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => handleCreateAndUpload(e.target.files)}
          />
        </label>
      </div>

      {loading ? (
        <p className="forms-muted">Loading form templates…</p>
      ) : templates.length === 0 ? (
        <p className="forms-muted">No custom form templates yet. Upload a PDF above to get started.</p>
      ) : (
        <div className="table-wrap">
          <table className="table-condensed forms-data-table">
            <thead>
              <tr>
                <th>Form</th>
                <th>Workflow</th>
                <th>Fields</th>
                <th></th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.display_name}</strong>
                  </td>
                  <td style={{ fontSize: '0.85rem' }}>{workflowLabel(t.workflow)}</td>
                  <td className="forms-muted" style={{ fontSize: '0.85rem' }}>
                    {t.file_missing_on_disk ? (
                      <span style={{ color: '#b45309' }}>File missing — re-upload</span>
                    ) : t.has_template_file ? (
                      t.signing_layout_field_count > 0 ? (
                        `${t.signing_layout_field_count} signing field${t.signing_layout_field_count === 1 ? '' : 's'} configured`
                      ) : (
                        <span style={{ color: '#b45309' }}>Open Edit fields to configure signing layout</span>
                      )
                    ) : (
                      'No file'
                    )}
                  </td>
                  <td>
                    {t.has_template_file ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() => setEditingTemplate(t)}
                      >
                        Edit fields
                      </button>
                    ) : (
                      <span className="forms-muted" style={{ fontSize: '0.8rem' }}>—</span>
                    )}
                  </td>
                  <td>
                    {t.has_template_file ? (
                      <a
                        href={forms.signerPreviewPdfUrl(t.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary btn-sm"
                        title="Signer view — highlighted fields with mapping labels"
                      >
                        Preview
                      </a>
                    ) : (
                      <span className="forms-muted" style={{ fontSize: '0.8rem' }}>—</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ color: '#b91c1c' }}
                      disabled={busy}
                      onClick={() => handleDelete(t)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingTemplate ? (
        <FormTemplateFieldEditor
          templateId={editingTemplate.id}
          displayName={editingTemplate.display_name}
          onClose={() => setEditingTemplate(null)}
          onSaved={() => {
            notify('Signing field layout saved.');
            reload();
          }}
          onError={(msg) => notify(msg, true)}
        />
      ) : null}
    </>
  );
}
