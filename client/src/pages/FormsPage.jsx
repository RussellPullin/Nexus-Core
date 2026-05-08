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
  const [analyzeByTemplateId, setAnalyzeByTemplateId] = useState({});
  const [docPackData, setDocPackData] = useState(null);
  const [packWorking, setPackWorking] = useState(false);
  const [newPackName, setNewPackName] = useState('');
  const [newPackWorkflow, setNewPackWorkflow] = useState('both');
  const [expandedPackId, setExpandedPackId] = useState(null);
  const [packItemDraft, setPackItemDraft] = useState([]);
  const [defaultStaffPack, setDefaultStaffPack] = useState('');
  const [defaultParticipantPack, setDefaultParticipantPack] = useState('');

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

  useEffect(() => {
    if (tab !== 'development') return;
    forms
      .onboardingDocumentPacks()
      .then((d) => {
        setDocPackData(d);
        setDefaultStaffPack(d.defaults?.default_staff_onboarding_pack_id || '');
        setDefaultParticipantPack(d.defaults?.default_participant_onboarding_pack_id || '');
      })
      .catch(() => setDocPackData(null));
  }, [tab]);

  const reloadDocPacks = () =>
    forms
      .onboardingDocumentPacks()
      .then((d) => {
        setDocPackData(d);
        setDefaultStaffPack(d.defaults?.default_staff_onboarding_pack_id || '');
        setDefaultParticipantPack(d.defaults?.default_participant_onboarding_pack_id || '');
      })
      .catch(() => {});

  const workflowLabel = (w) =>
    w === 'staff_onboarding' ? 'Staff' : w === 'participant_onboarding' ? 'Participant' : 'Staff & participant';

  const handleCreatePack = async (e) => {
    e.preventDefault();
    const name = newPackName.trim();
    if (!name) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.createOnboardingDocumentPack({ display_name: name, workflow: newPackWorkflow });
      setNewPackName('');
      setMessage('Pack created. Add PDFs from your policy library below.');
      await reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Failed to create pack');
    } finally {
      setPackWorking(false);
    }
  };

  const handleSavePackDefaults = async () => {
    setPackWorking(true);
    setMessage('');
    try {
      await forms.patchOnboardingDocumentPackDefaults({
        default_staff_onboarding_pack_id: defaultStaffPack || null,
        default_participant_onboarding_pack_id: defaultParticipantPack || null
      });
      setMessage('Default packs saved.');
      await reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Failed to save defaults');
    } finally {
      setPackWorking(false);
    }
  };

  const handleDeletePack = async (packId) => {
    if (!confirm('Delete this pack? Onboarding emails may attach all policy PDFs until you choose another default.')) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.deleteOnboardingDocumentPack(packId);
      if (expandedPackId === packId) {
        setExpandedPackId(null);
        setPackItemDraft([]);
      }
      setMessage('Pack deleted.');
      await reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Delete failed');
    } finally {
      setPackWorking(false);
    }
  };

  const openPackEditor = (pack) => {
    setExpandedPackId(pack.id);
    setPackItemDraft((pack.items || []).map((i) => i.policy_file_id));
  };

  const toggleDraftPolicy = (policyFileId) => {
    setPackItemDraft((prev) => (prev.includes(policyFileId) ? prev.filter((x) => x !== policyFileId) : [...prev, policyFileId]));
  };

  const handleSavePackItems = async () => {
    if (!expandedPackId) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.setOnboardingDocumentPackItems(expandedPackId, packItemDraft);
      setMessage('Pack PDFs updated.');
      await reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Save failed');
    } finally {
      setPackWorking(false);
    }
  };

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

  const mappingFieldCount = (t) => {
    if (!t?.mapping_json) return 0;
    try {
      const m = typeof t.mapping_json === 'object' ? t.mapping_json : JSON.parse(t.mapping_json);
      return Object.keys(m.contract_field_map || {}).length;
    } catch {
      return 0;
    }
  };

  const handleContractAnalyze = async (templateId) => {
    const key = `${templateId}_contract`;
    const file = uploadFile[key];
    if (!file) {
      setMessage('Choose a contract file for analysis (DOCX, PDF, or a scan image).');
      return;
    }
    setUploading(key);
    setMessage('');
    try {
      const data = await forms.contractUploadAnalyze(templateId, file);
      setAnalyzeByTemplateId((prev) => ({ ...prev, [templateId]: data }));
      const n = data.all_placeholders?.length ?? 0;
      let msg = `Contract analyzed: ${n} field reference(s) detected; merge mapping saved.`;
      if (data.image_only) msg = data.message || `Saved ${n} detected label(s) from the scan.`;
      else if (data.analysis_only) msg = data.message || `Word mapping saved (${n} placeholders). Upload a fillable PDF as the template file.`;
      setMessage(msg);
      setUploadFile((prev) => ({ ...prev, [key]: null }));
      load(tab === 'client' ? 'participant_onboarding' : tab === 'staff' ? 'staff_onboarding' : null);
    } catch (err) {
      setMessage(err.message || 'Analysis failed');
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

          <div style={{ marginBottom: '1.5rem', padding: '1rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
            <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>Structured templates (Service Agreement)</h4>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#475569' }}>
              Legacy PDF/DOCX uploads for built-in participant forms have been removed in favour of the Nexus Core template system.
              Org admins configure branding and variables under <strong>Settings → Form templates</strong>; coordinators generate agreements from each participant profile (<strong>Agreements</strong> tab).
            </p>
          </div>

          <div style={{ marginBottom: '1.5rem', padding: '1rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fffbeb' }}>
            <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>Onboarding document packs</h4>
            <p style={{ margin: '0 0 1rem 0', fontSize: '0.9rem', color: '#78350f' }}>
              Upload policy PDFs under <strong>Staff → profile → Company policy PDFs</strong>, then group them into packs. Packs can be emailed during{' '}
              <strong>staff onboarding</strong> (welcome email) and <strong>participant onboarding</strong> (coordinator button on the onboarding page). If no pack applies, Nexus attaches{' '}
              <strong>all</strong> policy PDFs for your organisation (legacy behaviour).
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>Default staff pack</label>
                <select
                  value={defaultStaffPack}
                  onChange={(e) => setDefaultStaffPack(e.target.value)}
                  style={{ minWidth: 220, padding: '0.35rem' }}
                  disabled={packWorking}
                >
                  <option value="">None — attach all policy PDFs</option>
                  {(docPackData?.packs || [])
                    .filter((p) => p.workflow === 'staff_onboarding' || p.workflow === 'both')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name} ({p.item_count ?? 0})
                      </option>
                    ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>Default participant pack</label>
                <select
                  value={defaultParticipantPack}
                  onChange={(e) => setDefaultParticipantPack(e.target.value)}
                  style={{ minWidth: 220, padding: '0.35rem' }}
                  disabled={packWorking}
                >
                  <option value="">None — attach all policy PDFs</option>
                  {(docPackData?.packs || [])
                    .filter((p) => p.workflow === 'participant_onboarding' || p.workflow === 'both')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name} ({p.item_count ?? 0})
                      </option>
                    ))}
                </select>
              </div>
              <button type="button" className="btn btn-secondary" disabled={packWorking} onClick={handleSavePackDefaults}>
                Save defaults
              </button>
            </div>

            <form onSubmit={handleCreatePack} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>New pack name</label>
                <input value={newPackName} onChange={(e) => setNewPackName(e.target.value)} placeholder="e.g. Clinical policies" style={{ padding: '0.35rem', minWidth: 200 }} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>Used for</label>
                <select value={newPackWorkflow} onChange={(e) => setNewPackWorkflow(e.target.value)} style={{ padding: '0.35rem' }}>
                  <option value="both">Staff &amp; participant</option>
                  <option value="staff_onboarding">Staff only</option>
                  <option value="participant_onboarding">Participant only</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary" disabled={packWorking || !newPackName.trim()}>
                Create pack
              </button>
            </form>

            {!docPackData?.policy_files?.length ? (
              <p style={{ color: '#92400e', fontSize: '0.9rem' }}>No policy PDFs uploaded yet. Add files from a staff profile (Company policy PDFs) first.</p>
            ) : null}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {(docPackData?.packs || []).map((p) => (
                <div key={p.id} style={{ border: '1px solid #fde68a', borderRadius: 8, padding: '0.75rem', background: '#fff' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center' }}>
                    <div>
                      <strong>{p.display_name}</strong>
                      <span style={{ marginLeft: 8, fontSize: '0.85rem', color: '#64748b' }}>
                        {workflowLabel(p.workflow)} · {p.item_count ?? 0} PDF(s)
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => openPackEditor(p)} disabled={packWorking}>
                        {expandedPackId === p.id ? 'Editing…' : 'Edit PDFs'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ color: '#b91c1c' }} onClick={() => handleDeletePack(p.id)} disabled={packWorking}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {expandedPackId === p.id && (
                    <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid #fef3c7' }}>
                      <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.85rem', color: '#64748b' }}>Toggle PDFs to include. Order follows the list below (add files in the order you want them attached).</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', maxHeight: 220, overflow: 'auto', marginBottom: '0.5rem' }}>
                        {(docPackData?.policy_files || []).map((f) => (
                          <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.9rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={packItemDraft.includes(f.id)} onChange={() => toggleDraftPolicy(f.id)} />
                            {f.display_name}
                          </label>
                        ))}
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" disabled={packWorking} onClick={handleSavePackItems}>
                        Save pack PDFs
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
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
                        {mappingFieldCount(t) > 0 && (
                          <span style={{ marginLeft: 8, color: '#64748b' }}>
                            · {mappingFieldCount(t)} placeholder(s) mapped to profile/intake fields
                          </span>
                        )}
                      </p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <input
                          type="file"
                          accept=".pdf"
                          onChange={(e) => setUploadFile((prev) => ({ ...prev, [t.id]: e.target.files?.[0] || null }))}
                        />
                        <button type="button" className="btn btn-primary" disabled={uploading === t.id || !uploadFile[t.id]} onClick={() => handleUpload(t.id, { templateId: t.id })}>
                          {uploading === t.id ? 'Uploading…' : 'Upload PDF'}
                        </button>
                      </div>
                      <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid #e2e8f0' }}>
                        <p style={{ margin: '0 0 0.35rem 0', fontSize: '0.85rem', fontWeight: 500 }}>Upload contract &amp; auto-detect fields</p>
                        <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.8rem', color: '#64748b' }}>
                          Templates are <strong>PDF</strong> with AcroForm fields (fillable). Nexus reads field names and scanned text (OCR) to map values from staff or participant profiles and intake data. Word <code>{'{tags}'}</code> are still detected if you analyze a .docx export.
                        </p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <input
                            type="file"
                            accept=".pdf,.docx,.png,.jpg,.jpeg,.webp"
                            onChange={(e) => setUploadFile((prev) => ({ ...prev, [`${t.id}_contract`]: e.target.files?.[0] || null }))}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={uploading === `${t.id}_contract` || !uploadFile[`${t.id}_contract`]}
                            onClick={() => handleContractAnalyze(t.id)}
                          >
                            {uploading === `${t.id}_contract` ? 'Analyzing…' : 'Analyze & save mapping'}
                          </button>
                        </div>
                        {analyzeByTemplateId[t.id] && (
                          <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#475569' }}>
                            Last run: {analyzeByTemplateId[t.id].docx_placeholders?.length ?? 0} Word placeholders,{' '}
                            {analyzeByTemplateId[t.id].pdf_form_fields?.length ?? 0} PDF fields,{' '}
                            {analyzeByTemplateId[t.id].ocr_labels?.length ?? 0} text/OCR labels.
                            {analyzeByTemplateId[t.id].ocr_used ? ' OCR was used.' : ''}
                          </p>
                        )}
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
