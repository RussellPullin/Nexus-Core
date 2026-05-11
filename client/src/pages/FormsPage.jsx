import { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { forms } from '../lib/api';

const WF_PARTICIPANT = 'participant_onboarding';
const WF_STAFF = 'staff_onboarding';

function workflowLabel(w) {
  if (w === 'staff_onboarding') return 'Staff only';
  if (w === 'participant_onboarding') return 'Participant only';
  return 'Staff and participant';
}

export default function FormsPage() {
  const { productSurface } = useParams();
  const settingsFormTemplatesHref = productSurface ? `/${productSurface}/settings?expand=form-templates` : '/settings?expand=form-templates';

  const [context, setContext] = useState(null);
  const [templatesAll, setTemplatesAll] = useState([]);
  const [templateFiles, setTemplateFiles] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const [newLabelByWf, setNewLabelByWf] = useState({ [WF_PARTICIPANT]: '', [WF_STAFF]: '' });
  const [addingWf, setAddingWf] = useState(null);
  const [uploadFile, setUploadFile] = useState({});
  const [uploading, setUploading] = useState(null);
  const [analyzeByTemplateId, setAnalyzeByTemplateId] = useState({});

  const [docPackData, setDocPackData] = useState(null);
  const [packWorking, setPackWorking] = useState(false);
  const [newPackName, setNewPackName] = useState('');
  const [newPackWorkflow, setNewPackWorkflow] = useState('both');
  const [expandedPackId, setExpandedPackId] = useState(null);
  const [packItemDraft, setPackItemDraft] = useState([]);
  const [defaultStaffPack, setDefaultStaffPack] = useState('');
  const [defaultParticipantPack, setDefaultParticipantPack] = useState('');

  const [policyDisplayName, setPolicyDisplayName] = useState('');
  const [policyFile, setPolicyFile] = useState(null);

  const loadTemplates = useCallback(() => {
    setLoading(true);
    Promise.all([forms.context(), forms.templates()])
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
  }, []);

  const reloadDocPacks = useCallback(() => {
    forms
      .onboardingDocumentPacks()
      .then((d) => {
        setDocPackData(d);
        setDefaultStaffPack(d.defaults?.default_staff_onboarding_pack_id || '');
        setDefaultParticipantPack(d.defaults?.default_participant_onboarding_pack_id || '');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    reloadDocPacks();
  }, [reloadDocPacks]);

  const customForWorkflow = (wf) =>
    (templatesAll || []).filter((t) => t.form_type === 'custom' && (t.workflow || WF_PARTICIPANT) === wf);

  const handleAddForm = async (e, workflow) => {
    e.preventDefault();
    const name = (newLabelByWf[workflow] || '').trim();
    if (!name) return;
    setAddingWf(workflow);
    setMessage('');
    try {
      await forms.createTemplate({ display_name: name, workflow });
      setNewLabelByWf((prev) => ({ ...prev, [workflow]: '' }));
      setMessage('Document added. Upload a PDF below, then run field detection if needed.');
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Could not add document');
    } finally {
      setAddingWf(null);
    }
  };

  const handleUploadPdf = async (templateId) => {
    const file = uploadFile[templateId];
    if (!file) {
      setMessage('Choose a PDF first.');
      return;
    }
    setUploading(templateId);
    setMessage('');
    try {
      await forms.uploadTemplate(templateId, file, { templateId });
      setUploadFile((prev) => ({ ...prev, [templateId]: null }));
      setMessage('PDF saved.');
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const handleContractAnalyze = async (templateId) => {
    const key = `${templateId}_contract`;
    const file = uploadFile[key];
    if (!file) {
      setMessage('Choose a file for field detection (PDF, Word, or a scan).');
      return;
    }
    setUploading(key);
    setMessage('');
    try {
      const data = await forms.contractUploadAnalyze(templateId, file);
      setAnalyzeByTemplateId((prev) => ({ ...prev, [templateId]: data }));
      const n = data.all_placeholders?.length ?? 0;
      let msg = `Field detection finished (${n} reference(s)). Mapping saved.`;
      if (data.image_only) msg = data.message || msg;
      else if (data.analysis_only) msg = data.message || msg;
      setMessage(msg);
      setUploadFile((prev) => ({ ...prev, [key]: null }));
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Detection failed');
    } finally {
      setUploading(null);
    }
  };

  const handleCreatePack = async (e) => {
    e.preventDefault();
    const name = newPackName.trim();
    if (!name) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.createOnboardingDocumentPack({ display_name: name, workflow: newPackWorkflow });
      setNewPackName('');
      setMessage('Pack created. Tick the policy PDFs to include below.');
      reloadDocPacks();
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
      reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Failed to save defaults');
    } finally {
      setPackWorking(false);
    }
  };

  const handleDeletePack = async (packId) => {
    if (!confirm('Delete this pack? Onboarding emails may attach all policy PDFs until you pick another default.')) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.deleteOnboardingDocumentPack(packId);
      if (expandedPackId === packId) {
        setExpandedPackId(null);
        setPackItemDraft([]);
      }
      setMessage('Pack deleted.');
      reloadDocPacks();
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
      setMessage('Pack updated.');
      reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Save failed');
    } finally {
      setPackWorking(false);
    }
  };

  const handlePolicyUpload = async (e) => {
    e.preventDefault();
    if (!policyFile) {
      setMessage('Choose a policy PDF.');
      return;
    }
    setPackWorking(true);
    setMessage('');
    try {
      await forms.policyFilesUpload(policyFile, policyDisplayName.trim() || undefined);
      setPolicyFile(null);
      setPolicyDisplayName('');
      setMessage('Policy PDF uploaded.');
      reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Policy upload failed');
    } finally {
      setPackWorking(false);
    }
  };

  const renderCustomRows = (wf) => {
    const list = customForWorkflow(wf);
    if (list.length === 0) {
      return <p className="forms-muted">No uploaded documents yet. Add one with the form above.</p>;
    }
    return (
      <ul className="forms-doc-list">
        {list.map((t) => {
          const fileInfo = templateFiles[t.id];
          const hasFile = fileInfo?.has_file;
          const contractKey = `${t.id}_contract`;
          return (
            <li key={t.id} className="forms-doc-card">
              <div className="forms-doc-title">{t.display_name || 'Untitled'}</div>
              <p className="forms-muted" style={{ margin: '0.25rem 0 0.75rem' }}>
                Template file: {hasFile ? <strong>{fileInfo.filename}</strong> : <span>No PDF yet</span>}
              </p>
              <div className="forms-row">
                <input
                  type="file"
                  accept=".pdf"
                  onChange={(e) => setUploadFile((prev) => ({ ...prev, [t.id]: e.target.files?.[0] || null }))}
                />
                <button type="button" className="btn btn-primary btn-sm" disabled={uploading === t.id || !uploadFile[t.id]} onClick={() => handleUploadPdf(t.id)}>
                  {uploading === t.id ? 'Uploading…' : 'Upload PDF'}
                </button>
              </div>
              <div className="forms-detect">
                <span className="forms-detect-label">Read the form and save field mapping</span>
                <p className="forms-muted forms-detect-hint">
                  Detects PDF form field names, Word <code>{'{placeholders}'}</code>, and labels in scanned pages (OCR). For richer AI-assisted workflows elsewhere in Nexus, use{' '}
                  <strong>Settings → Form templates</strong> (branding, variables) and keep <strong>Ollama</strong> running on this computer when your organisation uses local AI.
                </p>
                <div className="forms-row">
                  <input
                    type="file"
                    accept=".pdf,.docx,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => setUploadFile((prev) => ({ ...prev, [contractKey]: e.target.files?.[0] || null }))}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={uploading === contractKey || !uploadFile[contractKey]}
                    onClick={() => handleContractAnalyze(t.id)}
                  >
                    {uploading === contractKey ? 'Working…' : 'Detect fields'}
                  </button>
                </div>
                {analyzeByTemplateId[t.id] && (
                  <p className="forms-muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                    Last run: {analyzeByTemplateId[t.id].pdf_form_fields?.length ?? 0} PDF fields,{' '}
                    {analyzeByTemplateId[t.id].docx_placeholders?.length ?? 0} Word tags,{' '}
                    {analyzeByTemplateId[t.id].ocr_labels?.length ?? 0} text labels.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  };

  const renderWorkflowSection = (workflow, heading, lede) => (
    <section className="card forms-section" key={workflow}>
      <h2 className="forms-section-heading">{heading}</h2>
      <p className="forms-lede">{lede}</p>
      <form className="forms-add-row" onSubmit={(e) => handleAddForm(e, workflow)}>
        <input
          type="text"
          className="form-input"
          placeholder="Document name (e.g. Participant agreement)"
          value={newLabelByWf[workflow]}
          onChange={(e) => setNewLabelByWf((prev) => ({ ...prev, [workflow]: e.target.value }))}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button type="submit" className="btn btn-primary" disabled={addingWf === workflow || !newLabelByWf[workflow]?.trim()}>
          {addingWf === workflow ? 'Adding…' : 'Add document'}
        </button>
      </form>
      {renderCustomRows(workflow)}
    </section>
  );

  return (
    <div className="forms-page">
      <div className="page-header">
        <h2>Forms</h2>
      </div>

      {context?.organisation_name && (
        <p className="forms-muted" style={{ marginBottom: '1rem' }}>
          Organisation: <strong>{context.organisation_name}</strong>
          {!context.organisation_id && ' (default)'}
        </p>
      )}
      {context?.message && <p className="forms-muted">{context.message}</p>}

      <p className="forms-lede" style={{ marginBottom: '1.25rem' }}>
        Structured service agreements and branding live under{' '}
        <Link to={settingsFormTemplatesHref}>Settings → Form templates</Link>. This page is for PDFs you merge during onboarding and for policy bundles.
      </p>

      {message && (
        <div
          className="forms-banner"
          style={{
            background: message.toLowerCase().includes('fail') ? '#fef2f2' : '#f0fdf4',
            color: message.toLowerCase().includes('fail') ? '#991b1b' : '#166534'
          }}
        >
          {message}
        </div>
      )}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          {renderWorkflowSection(
            WF_PARTICIPANT,
            'Participant onboarding — upload form',
            'Add one row per PDF you want participants to complete or sign during onboarding. Upload a fillable PDF, then run field detection so Nexus can merge profile and intake data.'
          )}
          {renderWorkflowSection(
            WF_STAFF,
            'Staff onboarding — upload form',
            'Same flow for employment or compliance PDFs used in staff onboarding.'
          )}

          <section className="card forms-section">
            <h2 className="forms-section-heading">Policies — staff and participant onboarding</h2>
            <p className="forms-lede">
              Policy PDFs can be grouped into packs and attached to staff welcome mail and participant onboarding mail. Choose whether each pack applies to staff onboarding, participant onboarding, or both.
            </p>

            <form onSubmit={handlePolicyUpload} className="forms-add-row" style={{ marginBottom: '1.25rem' }}>
              <input
                type="text"
                className="form-input"
                placeholder="Display name (optional)"
                value={policyDisplayName}
                onChange={(e) => setPolicyDisplayName(e.target.value)}
                style={{ flex: 1, minWidth: 160 }}
              />
              <input type="file" accept=".pdf" onChange={(e) => setPolicyFile(e.target.files?.[0] || null)} />
              <button type="submit" className="btn btn-primary" disabled={packWorking || !policyFile}>
                {packWorking ? 'Uploading…' : 'Upload policy PDF'}
              </button>
            </form>

            <div className="forms-pack-defaults">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="forms-label">Default pack — staff onboarding email</label>
                <select
                  className="form-input"
                  value={defaultStaffPack}
                  onChange={(e) => setDefaultStaffPack(e.target.value)}
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
                <label className="forms-label">Default pack — participant onboarding email</label>
                <select
                  className="form-input"
                  value={defaultParticipantPack}
                  onChange={(e) => setDefaultParticipantPack(e.target.value)}
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

            <form onSubmit={handleCreatePack} className="forms-add-row" style={{ marginTop: '1.25rem' }}>
              <input
                className="form-input"
                value={newPackName}
                onChange={(e) => setNewPackName(e.target.value)}
                placeholder="New pack name"
                style={{ flex: 1, minWidth: 160 }}
              />
              <select className="form-input" value={newPackWorkflow} onChange={(e) => setNewPackWorkflow(e.target.value)} style={{ maxWidth: 220 }}>
                <option value="both">Staff and participant</option>
                <option value="staff_onboarding">Staff only</option>
                <option value="participant_onboarding">Participant only</option>
              </select>
              <button type="submit" className="btn btn-primary" disabled={packWorking || !newPackName.trim()}>
                Create pack
              </button>
            </form>

            {!docPackData?.policy_files?.length ? (
              <p className="forms-muted" style={{ marginTop: '1rem' }}>
                No policy PDFs yet. Upload one above (or from a staff profile under company policy PDFs).
              </p>
            ) : null}

            <div className="forms-pack-list">
              {(docPackData?.packs || []).map((p) => (
                <div key={p.id} className="forms-pack-card">
                  <div className="forms-pack-head">
                    <div>
                      <strong>{p.display_name}</strong>
                      <span className="forms-muted" style={{ marginLeft: 8, fontSize: '0.9rem' }}>
                        {workflowLabel(p.workflow)} · {p.item_count ?? 0} PDF(s)
                      </span>
                    </div>
                    <div className="forms-pack-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => openPackEditor(p)} disabled={packWorking}>
                        {expandedPackId === p.id ? 'Editing…' : 'Edit PDFs'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ color: '#b91c1c' }} onClick={() => handleDeletePack(p.id)} disabled={packWorking}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {expandedPackId === p.id && (
                    <div className="forms-pack-body">
                      <p className="forms-muted" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                        Tick which policy PDFs belong in this pack.
                      </p>
                      <div className="forms-policy-checks">
                        {(docPackData?.policy_files || []).map((f) => (
                          <label key={f.id} className="forms-policy-check">
                            <input type="checkbox" checked={packItemDraft.includes(f.id)} onChange={() => toggleDraftPolicy(f.id)} />
                            {f.display_name}
                          </label>
                        ))}
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" disabled={packWorking} onClick={handleSavePackItems}>
                        Save pack
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
