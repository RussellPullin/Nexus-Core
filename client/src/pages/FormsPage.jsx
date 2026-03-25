import { useState, useEffect } from 'react';
import { forms } from '../lib/api';

const FORM_TYPE_LABELS = {
  service_agreement: 'Service Agreement',
  intake_form: 'Participant Intake Form',
  support_plan: 'Support Plan',
  privacy_consent: 'Privacy Consent Form',
  custom: 'Custom form'
};

const WORKFLOW_LABELS = {
  participant_onboarding: 'Client (participant onboarding)',
  staff_onboarding: 'Staff onboarding'
};

const BUILTIN_FORM_TYPES = ['privacy_consent', 'service_agreement', 'support_plan'];

export default function FormsPage() {
  const [tab, setTab] = useState('client'); // 'client' | 'staff' | 'development'
  const [context, setContext] = useState(null);
  const [templatesAll, setTemplatesAll] = useState([]);
  const [templateFiles, setTemplateFiles] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(null);
  const [uploadFile, setUploadFile] = useState({});
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [addFormLabel, setAddFormLabel] = useState('');
  const [addFormWorkflow, setAddFormWorkflow] = useState('participant_onboarding');
  const [adding, setAdding] = useState(false);

  const load = (workflowFilter = null) => {
    setLoading(true);
    Promise.all([
      forms.context(),
      workflowFilter ? forms.templates(workflowFilter) : forms.templates()
    ])
      .then(([ctx, data]) => {
        setContext(ctx);
        setTemplatesAll(data.templates || []);
        setTemplateFiles(data.template_files || {});
      })
      .catch(() => {
        setTemplatesAll([]);
        setTemplateFiles({});
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (tab === 'client') load('participant_onboarding');
    else if (tab === 'staff') load('staff_onboarding');
    else load();
  }, [tab]);

  const templates = templatesAll;
  const clientTemplates = templates.filter((t) => (t.workflow || 'participant_onboarding') === 'participant_onboarding');
  const staffTemplates = templates.filter((t) => t.workflow === 'staff_onboarding');
  const customTemplates = templates.filter((t) => t.form_type === 'custom');

  const handleSaveLabel = async () => {
    if (!editingId || editLabel.trim() === '') return;
    setSaving(true);
    setMessage('');
    try {
      await forms.updateTemplate(editingId, { display_name: editLabel.trim() });
      setEditingId(null);
      setEditLabel('');
      setMessage('Label saved.');
      load(tab === 'client' ? 'participant_onboarding' : tab === 'staff' ? 'staff_onboarding' : null);
    } catch (err) {
      setMessage(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleUpload = async (formTypeOrId, options = {}) => {
    const file = uploadFile[formTypeOrId];
    if (!file) {
      setMessage('Choose a file first.');
      return;
    }
    setUploading(formTypeOrId);
    setMessage('');
    try {
      if (options.templateId) {
        await forms.uploadTemplate(formTypeOrId, file, { templateId: options.templateId });
        setMessage('Custom form template uploaded.');
      } else {
        await forms.uploadTemplate(formTypeOrId, file);
        setMessage('Template uploaded.');
      }
      setUploadFile((prev) => ({ ...prev, [formTypeOrId]: null }));
      load(tab === 'client' ? 'participant_onboarding' : tab === 'staff' ? 'staff_onboarding' : null);
    } catch (err) {
      setMessage(err.message || 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const handleAddForm = async (e) => {
    e.preventDefault();
    const name = addFormLabel.trim();
    if (!name) return;
    setAdding(true);
    setMessage('');
    try {
      await forms.createTemplate({ display_name: name, workflow: addFormWorkflow });
      setAddFormOpen(false);
      setAddFormLabel('');
      setAddFormWorkflow('participant_onboarding');
      setMessage('Form added. Upload a template file below.');
      load();
    } catch (err) {
      setMessage(err.message || 'Failed to add form');
    } finally {
      setAdding(false);
    }
  };

  const renderFormsTable = (list, workflowLabel) => (
    <div>
      <p style={{ color: '#64748b', marginBottom: '1rem' }}>
        {workflowLabel}. Edit labels below or upload template files in Form development settings.
      </p>
      <div className="table-wrap">
        <table className="table-condensed" style={{ width: '100%', maxWidth: 720 }}>
          <thead>
            <tr>
              <th>Label</th>
              <th>Type</th>
              <th>Required</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id}>
                <td>
                  {editingId === t.id ? (
                    <input
                      type="text"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      style={{ width: '100%', maxWidth: 220 }}
                      placeholder="Display name"
                    />
                  ) : (
                    <span>{t.display_name || FORM_TYPE_LABELS[t.form_type] || t.form_type}</span>
                  )}
                </td>
                <td>{FORM_TYPE_LABELS[t.form_type] || t.form_type}</td>
                <td>{t.is_required ? 'Yes' : 'No'}</td>
                <td>{t.is_active ? 'Yes' : 'No'}</td>
                <td>
                  {editingId === t.id ? (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveLabel} disabled={saving}>Save</button>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 4 }} onClick={() => { setEditingId(null); setEditLabel(''); }}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditingId(t.id); setEditLabel(t.display_name || ''); }}>Edit label</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p style={{ color: '#64748b' }}>No forms in this workflow. Add forms in Form development settings.</p>}
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <h2>Forms & form development</h2>
      </div>
      {context?.organisation_name && (
        <p style={{ color: '#64748b', marginBottom: '1rem' }}>
          Organisation: <strong>{context.organisation_name}</strong>
          {!context.organisation_id && ' (default)'}
        </p>
      )}
      {context?.message && (
        <p style={{ color: '#94a3b8', marginBottom: '1rem', fontSize: '0.9rem' }}>{context.message}</p>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', borderBottom: '1px solid #e2e8f0' }}>
        <button
          type="button"
          className={`btn ${tab === 'client' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('client')}
        >
          Client forms
        </button>
        <button
          type="button"
          className={`btn ${tab === 'staff' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('staff')}
        >
          Staff forms
        </button>
        <button
          type="button"
          className={`btn ${tab === 'development' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('development')}
        >
          Form development settings
        </button>
      </div>

      {message && (
        <div style={{ padding: '0.5rem 1rem', marginBottom: '1rem', background: message.includes('Failed') ? '#fef2f2' : '#f0fdf4', color: message.includes('Failed') ? '#991b1b' : '#166534', borderRadius: 6 }}>
          {message}
        </div>
      )}

      {loading ? (
        <p>Loading...</p>
      ) : tab === 'client' ? (
        renderFormsTable(clientTemplates, 'Forms used in participant (client) onboarding.')
      ) : tab === 'staff' ? (
        renderFormsTable(staffTemplates, 'Forms used in staff onboarding.')
      ) : (
        <div>
          <p style={{ color: '#64748b', marginBottom: '1rem' }}>
            Upload or replace template files and add new forms. New forms can be linked to Client or Staff workflows.
          </p>

          <div style={{ marginBottom: '1.5rem' }}>
            <button type="button" className="btn btn-primary" onClick={() => setAddFormOpen(true)}>
              Add form
            </button>
            {addFormOpen && (
              <form onSubmit={handleAddForm} style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #e2e8f0', borderRadius: 8, maxWidth: 400, background: '#fafafa' }}>
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Label</label>
                  <input
                    type="text"
                    value={addFormLabel}
                    onChange={(e) => setAddFormLabel(e.target.value)}
                    placeholder="e.g. Staff Code of Conduct"
                    style={{ width: '100%', padding: '0.5rem' }}
                  />
                </div>
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>Workflow</label>
                  <select
                    value={addFormWorkflow}
                    onChange={(e) => setAddFormWorkflow(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem' }}
                  >
                    <option value="participant_onboarding">Client (participant onboarding)</option>
                    <option value="staff_onboarding">Staff onboarding</option>
                  </select>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="submit" className="btn btn-primary" disabled={adding || !addFormLabel.trim()}>
                    {adding ? 'Adding…' : 'Add form'}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => { setAddFormOpen(false); setAddFormLabel(''); }}>Cancel</button>
                </div>
              </form>
            )}
          </div>

          <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>Built-in forms (participant onboarding)</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
            {BUILTIN_FORM_TYPES.map((formType) => {
              const fileInfo = templateFiles[formType];
              const hasFile = fileInfo?.has_file;
              const name = FORM_TYPE_LABELS[formType] || formType;
              return (
                <div key={formType} style={{ padding: '1rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fafafa' }}>
                  <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>{name}</h4>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>
                    {formType === 'privacy_consent' ? '.docx only. Use placeholders like {name}, {date}.' : '.pdf or .docx.'}
                  </p>
                  <p style={{ margin: '0.25rem 0 0.5rem 0', fontSize: '0.85rem' }}>
                    Current: {hasFile ? <strong>{fileInfo.filename}</strong> : <span style={{ color: '#94a3b8' }}>No file</span>}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <input
                      type="file"
                      accept={formType === 'privacy_consent' ? '.docx' : '.pdf,.docx'}
                      onChange={(e) => setUploadFile((prev) => ({ ...prev, [formType]: e.target.files?.[0] || null }))}
                    />
                    <button type="button" className="btn btn-primary" disabled={uploading === formType || !uploadFile[formType]} onClick={() => handleUpload(formType)}>
                      {uploading === formType ? 'Uploading…' : 'Upload'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {customTemplates.length > 0 && (
            <>
              <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>Custom forms</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {customTemplates.map((t) => {
                  const fileInfo = templateFiles[t.id];
                  const hasFile = fileInfo?.has_file;
                  return (
                    <div key={t.id} style={{ padding: '1rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fafafa' }}>
                      <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>{t.display_name}</h4>
                      <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>{WORKFLOW_LABELS[t.workflow] || t.workflow}</p>
                      <p style={{ margin: '0.25rem 0 0.5rem 0', fontSize: '0.85rem' }}>
                        Current: {hasFile ? <strong>{fileInfo.filename}</strong> : <span style={{ color: '#94a3b8' }}>No file</span>}
                      </p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <input
                          type="file"
                          accept=".pdf,.docx"
                          onChange={(e) => setUploadFile((prev) => ({ ...prev, [t.id]: e.target.files?.[0] || null }))}
                        />
                        <button type="button" className="btn btn-primary" disabled={uploading === t.id || !uploadFile[t.id]} onClick={() => handleUpload(t.id, { templateId: t.id })}>
                          {uploading === t.id ? 'Uploading…' : 'Upload'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
