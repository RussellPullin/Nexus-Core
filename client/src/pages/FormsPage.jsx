import { useState, useEffect, useCallback, Fragment } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  participantContractMergeKeyOptions,
  staffContractMergeKeyOptions,
  isValidCustomMergeTargetKey
} from '@nexus-shared/contractFormMergeKeys';
import { forms } from '../lib/api';

const WF_PARTICIPANT = 'participant_onboarding';
const WF_STAFF = 'staff_onboarding';

function workflowLabel(w) {
  if (w === 'staff_onboarding') return 'Staff only';
  if (w === 'participant_onboarding') return 'Participant only';
  return 'Staff and participant';
}

function parseMappingJson(raw) {
  if (!raw) return {};
  try {
    return typeof raw === 'object' ? raw : JSON.parse(raw);
  } catch {
    return {};
  }
}

function mappingFieldCount(t) {
  const m = parseMappingJson(t?.mapping_json);
  const map = m.contract_field_map || {};
  return Object.keys(map).length;
}

function placeholdersFromTemplate(t) {
  const m = parseMappingJson(t?.mapping_json);
  const fromAnalysis = m.contract_analysis?.all_placeholders;
  if (Array.isArray(fromAnalysis) && fromAnalysis.length) return fromAnalysis;
  const keys = Object.keys(m.contract_field_map || {});
  return keys;
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
  const [mappingEditorId, setMappingEditorId] = useState(null);
  const [mappingDraft, setMappingDraft] = useState({});
  const [mappingSaving, setMappingSaving] = useState(false);
  const [extraMappingKeys, setExtraMappingKeys] = useState([]);
  const [newMappingKeyInput, setNewMappingKeyInput] = useState('');
  const [verifiedDraft, setVerifiedDraft] = useState({});

  const [docPackData, setDocPackData] = useState(null);
  const [packWorking, setPackWorking] = useState(false);
  const [newPackName, setNewPackName] = useState('');
  const [newPackWorkflow, setNewPackWorkflow] = useState('both');
  const [expandedPackId, setExpandedPackId] = useState(null);
  const [packItemDraft, setPackItemDraft] = useState([]);
  const [packFormDraft, setPackFormDraft] = useState([]);
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
      setMessage('Document added. Upload a PDF or Word file once — Nexus saves it and links fields to intake data automatically (same idea as the service agreement template).');
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Could not add document');
    } finally {
      setAddingWf(null);
    }
  };

  const handleDeleteTemplate = async (templateId) => {
    if (!confirm('Delete this document template? This cannot be undone.')) return;
    setMessage('');
    try {
      await forms.deleteTemplate(templateId);
      setAnalyzeByTemplateId((prev) => {
        const next = { ...prev };
        delete next[templateId];
        return next;
      });
      setMessage('Template deleted.');
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Delete failed');
    }
  };

  const handleUploadPdf = async (templateId) => {
    const file = uploadFile[templateId];
    if (!file) {
      setMessage('Choose a PDF or Word file first.');
      return;
    }
    setUploading(templateId);
    setMessage('');
    try {
      const data = await forms.uploadTemplate(templateId, file, { templateId });
      setUploadFile((prev) => ({ ...prev, [templateId]: null }));
      const mapped = data?.mapped_field_count ?? 0;
      const found = data?.placeholders_found ?? 0;
      setMessage(
        `Template saved. Linked ${mapped} field(s) to profile/intake data from ${found} detected reference(s). When you generate the onboarding pack, this document will merge like the service agreement.`
      );
      if (data && typeof data === 'object') {
        setAnalyzeByTemplateId((prev) => ({ ...prev, [templateId]: data }));
      }
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const handleContractAnalyze = async (templateId) => {
    const key = `${templateId}_adv`;
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

  const openFieldLinkEditor = (t) => {
    if (mappingEditorId === t.id) {
      setMappingEditorId(null);
      return;
    }
    const m = parseMappingJson(t.mapping_json);
    const map = { ...(m.contract_field_map || {}) };
    const ph = [...new Set([...placeholdersFromTemplate(t), ...Object.keys(map)])];
    for (const p of ph) {
      if (map[p] === undefined) map[p] = '';
    }
    setMappingDraft(map);
    const meta = m.contract_field_meta || {};
    const ver = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v && v.verified) ver[k] = true;
    }
    setVerifiedDraft(ver);
    setExtraMappingKeys([]);
    setNewMappingKeyInput('');
    setMappingEditorId(t.id);
  };

  const addMappingPlaceholderRow = () => {
    const raw = (newMappingKeyInput || '').trim();
    if (!raw) return;
    const key = raw.replace(/\s+/g, '_');
    if (!key) return;
    setExtraMappingKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setMappingDraft((prev) => ({ ...prev, [key]: prev[key] ?? '' }));
    setNewMappingKeyInput('');
  };

  const removeMappingPlaceholderRow = (key) => {
    setExtraMappingKeys((prev) => prev.filter((k) => k !== key));
    setMappingDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setVerifiedDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const saveFieldLinks = async (t) => {
    setMappingSaving(true);
    setMessage('');
    try {
      const existing = parseMappingJson(t.mapping_json);
      const preset = t.workflow === WF_STAFF ? staffContractMergeKeyOptions() : participantContractMergeKeyOptions();
      const next = {};
      for (const [k, v] of Object.entries(mappingDraft)) {
        const val = String(v || '').trim();
        if (!val) continue;
        if (!preset.includes(val) && !isValidCustomMergeTargetKey(val)) continue;
        next[k] = val;
      }
      const nextMeta = { ...(existing.contract_field_meta || {}) };
      for (const ph of Object.keys(next)) {
        if (verifiedDraft[ph]) nextMeta[ph] = { ...(nextMeta[ph] || {}), verified: true };
      }
      const mapping_json = {
        ...existing,
        contract_field_map: next,
        contract_field_meta: nextMeta,
        manual_field_map_saved_at: new Date().toISOString()
      };
      await forms.updateTemplate(t.id, { mapping_json });
      setMessage('Field links saved.');
      setMappingEditorId(null);
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Save failed');
    } finally {
      setMappingSaving(false);
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
      setMessage('Pack created. Select policy PDFs and optional custom documents below.');
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
        setPackFormDraft([]);
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
    setPackFormDraft((pack.form_template_items || []).map((i) => i.form_template_id));
  };

  const toggleDraftPolicy = (policyFileId) => {
    setPackItemDraft((prev) => (prev.includes(policyFileId) ? prev.filter((x) => x !== policyFileId) : [...prev, policyFileId]));
  };

  const toggleDraftFormTemplate = (formTemplateId) => {
    setPackFormDraft((prev) => (prev.includes(formTemplateId) ? prev.filter((x) => x !== formTemplateId) : [...prev, formTemplateId]));
  };

  const handleSavePackItems = async () => {
    if (!expandedPackId) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.setOnboardingDocumentPackItems(expandedPackId, { policy_file_ids: packItemDraft, form_template_ids: packFormDraft });
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

  const handlePolicyDelete = async (policyId, label) => {
    if (!confirm(`Remove policy “${label}” from the library? Packs that include it will be updated when you save packs again.`)) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.policyFilesDelete(policyId);
      setMessage('Policy removed.');
      reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Delete failed');
    } finally {
      setPackWorking(false);
    }
  };

  const renderCustomTable = (wf) => {
    const list = customForWorkflow(wf);
    if (list.length === 0) {
      return <p className="forms-muted">No documents yet. Use “Add document” above.</p>;
    }
    return (
      <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
        <table className="table-condensed forms-data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>File</th>
              <th>Mapped fields</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const fileInfo = templateFiles[t.id];
              const hasFile = fileInfo?.has_file;
              const advKey = `${t.id}_adv`;
              const m = parseMappingJson(t.mapping_json);
              const analyzedAt = m.contract_analysis?.analyzed_at;
              const mergeOptions = wf === WF_STAFF ? staffContractMergeKeyOptions() : participantContractMergeKeyOptions();
              const detected = m.contract_analysis?.detected_fields;
              const fromDetected = (Array.isArray(detected) ? detected : []).map((d) => d.key).filter(Boolean);
              const phRows = [
                ...new Set([...placeholdersFromTemplate(t), ...Object.keys(m.contract_field_map || {}), ...extraMappingKeys, ...fromDetected])
              ];
              const fieldSourceLabel = (ph) => {
                const a = m.contract_analysis;
                if (!a) return extraMappingKeys.includes(ph) ? 'Manual' : '—';
                if ((a.pdf_form_fields || []).includes(ph)) return 'PDF field';
                if ((a.docx_placeholders || []).includes(ph)) return 'Word';
                const d = (a.detected_fields || []).find((x) => x.key === ph);
                if (d) return `OCR (${d.method || 'heuristic'})`;
                return extraMappingKeys.includes(ph) ? 'Manual' : '—';
              };
              const datalistId = `merge-keys-${t.id}`;
              return (
                <Fragment key={t.id}>
                  <tr>
                    <td>{t.display_name || 'Untitled'}</td>
                    <td>{hasFile ? <span className="forms-ok">{fileInfo.filename}</span> : <span className="forms-muted">None</span>}</td>
                    <td>
                      {mappingFieldCount(t)}
                      {analyzedAt ? <span className="forms-muted" style={{ display: 'block', fontSize: '0.8rem' }}>Analyzed {analyzedAt.slice(0, 10)}</span> : null}
                    </td>
                    <td>
                      <div className="forms-actions-cell">
                        <input
                          type="file"
                          accept=".pdf,.docx,.jpg,.jpeg,.png,.webp"
                          className="forms-file-inline"
                          onChange={(e) => setUploadFile((prev) => ({ ...prev, [t.id]: e.target.files?.[0] || null }))}
                        />
                        <button type="button" className="btn btn-primary btn-sm" disabled={uploading === t.id || !uploadFile[t.id]} onClick={() => handleUploadPdf(t.id)}>
                          {uploading === t.id ? '…' : 'Upload & map from intake'}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => openFieldLinkEditor(t)}>
                          {mappingEditorId === t.id ? 'Close field links' : 'Edit field links'}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" style={{ color: '#b91c1c' }} onClick={() => handleDeleteTemplate(t.id)}>
                          Delete
                        </button>
                      </div>
                    <details className="forms-advanced" style={{ marginTop: '0.5rem' }}>
                      <summary className="forms-muted" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
                        Advanced — re-run field detection on another file
                      </summary>
                      <div className="forms-actions-cell" style={{ marginTop: '0.35rem' }}>
                        <input
                          type="file"
                          accept=".pdf,.docx,.png,.jpg,.jpeg,.webp"
                          className="forms-file-inline"
                          onChange={(e) => setUploadFile((prev) => ({ ...prev, [advKey]: e.target.files?.[0] || null }))}
                        />
                        <button type="button" className="btn btn-secondary btn-sm" disabled={uploading === advKey || !uploadFile[advKey]} onClick={() => handleContractAnalyze(t.id)}>
                          {uploading === advKey ? '…' : 'Detect only'}
                        </button>
                      </div>
                    </details>
                      {analyzeByTemplateId[t.id] && (
                        <p className="forms-muted" style={{ fontSize: '0.78rem', margin: '0.35rem 0 0' }}>
                          Last run: {analyzeByTemplateId[t.id].pdf_form_fields?.length ?? 0} PDF fields ·{' '}
                          {analyzeByTemplateId[t.id].docx_placeholders?.length ?? 0} Word · {analyzeByTemplateId[t.id].ocr_labels?.length ?? 0} OCR labels ·{' '}
                          {(analyzeByTemplateId[t.id].detected_fields || []).length} detected
                        </p>
                      )}
                    </td>
                  </tr>
                  {mappingEditorId === t.id ? (
                    <tr className="forms-map-editor-row">
                      <td colSpan={4} style={{ background: 'var(--surface-muted, #f8fafc)', padding: '0.75rem 1rem' }}>
                        <p className="forms-muted" style={{ margin: '0 0 0.5rem 0', fontSize: '0.88rem' }}>
                          Link each placeholder to an intake/profile merge key (pick a suggestion or type a snake_case intake key). Tick{' '}
                          <strong>Verified</strong> for rows you have checked so future re-detection keeps your merge target. Empty merge values are omitted on save.
                        </p>
                        {phRows.length === 0 ? (
                          <p className="forms-muted">Upload or run Detect first, or add a placeholder name below if OCR missed a field.</p>
                        ) : null}
                        <div className="table-wrap" style={{ marginBottom: phRows.length ? '0.5rem' : 0 }}>
                          <table className="table-condensed forms-data-table" style={{ background: '#fff' }}>
                            <thead>
                              <tr>
                                <th>Source</th>
                                <th>Form field / placeholder</th>
                                <th>Merge key</th>
                                <th>Verified</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {phRows.map((ph) => (
                                <tr key={ph}>
                                  <td className="forms-muted" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                                    {fieldSourceLabel(ph)}
                                  </td>
                                  <td style={{ fontSize: '0.85rem', wordBreak: 'break-word' }}>{ph}</td>
                                  <td>
                                    <input
                                      type="text"
                                      className="form-input"
                                      style={{ minWidth: 220 }}
                                      list={datalistId}
                                      value={mappingDraft[ph] ?? ''}
                                      onChange={(e) => setMappingDraft((prev) => ({ ...prev, [ph]: e.target.value }))}
                                      placeholder="e.g. first_name"
                                    />
                                  </td>
                                  <td style={{ textAlign: 'center' }}>
                                    <input
                                      type="checkbox"
                                      checked={!!verifiedDraft[ph]}
                                      onChange={(e) => setVerifiedDraft((prev) => ({ ...prev, [ph]: e.target.checked }))}
                                      title="Mark when this link is reviewed"
                                    />
                                  </td>
                                  <td>
                                    {extraMappingKeys.includes(ph) ? (
                                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeMappingPlaceholderRow(ph)}>
                                        Remove
                                      </button>
                                    ) : null}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <datalist id={datalistId}>
                            {mergeOptions.map((k) => (
                              <option key={k} value={k} />
                            ))}
                          </datalist>
                        </div>
                        <div className="forms-add-row" style={{ marginBottom: '0.65rem', flexWrap: 'wrap' }}>
                          <input
                            type="text"
                            className="form-input"
                            placeholder="Add placeholder name OCR missed"
                            value={newMappingKeyInput}
                            onChange={(e) => setNewMappingKeyInput(e.target.value)}
                            style={{ flex: 1, minWidth: 180 }}
                          />
                          <button type="button" className="btn btn-secondary btn-sm" onClick={addMappingPlaceholderRow}>
                            Add field row
                          </button>
                        </div>
                        <div style={{ marginTop: '0.65rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <button type="button" className="btn btn-primary btn-sm" disabled={mappingSaving} onClick={() => saveFieldLinks(t)}>
                            {mappingSaving ? 'Saving…' : 'Save field links'}
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMappingEditorId(null)}>
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderWorkflowSection = (workflow, heading, lede, staffNote) => (
    <section className="card forms-section" key={workflow}>
      <h2 className="forms-section-heading">{heading}</h2>
      <p className="forms-lede">{lede}</p>
      {staffNote ? <p className="forms-muted forms-callout">{staffNote}</p> : null}
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
      {renderCustomTable(workflow)}
    </section>
  );

  const bannerIsError = (message || '').toLowerCase().includes('fail') || (message || '').toLowerCase().includes('could not');

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
        The <strong>service agreement</strong> you configure under{' '}
        <Link to={settingsFormTemplatesHref}>Settings → Form templates</Link> uses a structured template: variables are filled from the participant profile and intake when packs are generated. On this page, a{' '}
        <strong>custom participant or staff PDF, Word, or image</strong> works the same way in one step: choose <strong>Upload &amp; map from intake</strong> and Nexus saves the file, runs deterministic field detection (PDF names, Word tags, on-device OCR), and links fields to intake/profile data. Use <strong>Edit field links</strong> to adjust any mapping, or <strong>Detect only</strong> under Advanced to refresh placeholders from another file.
      </p>

      {message && (
        <div className="forms-banner" style={{ background: bannerIsError ? '#fef2f2' : '#f0fdf4', color: bannerIsError ? '#991b1b' : '#166534' }}>
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
            'Add a document, then use Upload & map from intake once. That runs the same kind of merge preparation as the service agreement: your file is stored and field names are matched to participant intake and profile data for onboarding pack generation.',
            null
          )}
          {renderWorkflowSection(
            WF_STAFF,
            'Staff onboarding — upload form',
            'Upload employment or compliance PDFs for staff onboarding.',
            'When multiple staff documents exist, the employment merge uses the one most recently updated (PDF or Word on file).'
          )}

          <section className="card forms-section">
            <h2 className="forms-section-heading">Policies and packs — staff and participant onboarding</h2>
            <p className="forms-lede">
              Policy PDFs and optional <strong>custom form documents</strong> can be grouped into packs and attached to staff welcome mail and participant onboarding mail. Choose whether each pack applies to staff onboarding, participant onboarding, or both.
            </p>

            <form onSubmit={handlePolicyUpload} className="forms-add-row" style={{ marginBottom: '1rem' }}>
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

            <h3 className="forms-subheading">Policy library</h3>
            {(docPackData?.policy_files || []).length === 0 ? (
              <p className="forms-muted">No policy PDFs yet. Upload one above.</p>
            ) : (
              <div className="table-wrap">
                <table className="table-condensed forms-data-table">
                  <thead>
                    <tr>
                      <th>Display name</th>
                      <th>Id</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(docPackData?.policy_files || []).map((f) => (
                      <tr key={f.id}>
                        <td>{f.display_name}</td>
                        <td className="forms-muted" style={{ fontSize: '0.85rem' }}>
                          {f.id.slice(0, 8)}…
                        </td>
                        <td>
                          <button type="button" className="btn btn-secondary btn-sm" style={{ color: '#b91c1c' }} disabled={packWorking} onClick={() => handlePolicyDelete(f.id, f.display_name)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="forms-pack-defaults" style={{ marginTop: '1.25rem' }}>
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

            <div className="forms-pack-list">
              {(docPackData?.packs || []).map((p) => (
                <div key={p.id} className="forms-pack-card">
                  <div className="forms-pack-head">
                    <div>
                      <strong>{p.display_name}</strong>
                      <span className="forms-muted" style={{ marginLeft: 8, fontSize: '0.9rem' }}>
                        {workflowLabel(p.workflow)} · {p.item_count ?? 0} item(s)
                      </span>
                    </div>
                    <div className="forms-pack-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => openPackEditor(p)} disabled={packWorking}>
                        {expandedPackId === p.id ? 'Editing…' : 'Edit pack'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ color: '#b91c1c' }} onClick={() => handleDeletePack(p.id)} disabled={packWorking}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {expandedPackId === p.id && (
                    <div className="forms-pack-body">
                      <p className="forms-muted" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                        Tick policy PDFs and custom onboarding documents to include. Policies are attached as PDFs; custom documents use the file stored on the Forms tab (PDF, Word, or image).
                      </p>
                      <p className="forms-muted" style={{ fontSize: '0.82rem', marginBottom: '0.35rem' }}>
                        <strong>Policy PDFs</strong>
                      </p>
                      <div className="forms-policy-checks">
                        {(docPackData?.policy_files || []).map((f) => (
                          <label key={f.id} className="forms-policy-check">
                            <input type="checkbox" checked={packItemDraft.includes(f.id)} onChange={() => toggleDraftPolicy(f.id)} />
                            {f.display_name}
                          </label>
                        ))}
                      </div>
                      <p className="forms-muted" style={{ fontSize: '0.82rem', margin: '0.75rem 0 0.35rem' }}>
                        <strong>Custom form documents</strong> (from Participant / Staff sections above)
                      </p>
                      <div className="forms-policy-checks">
                        {(docPackData?.custom_form_templates || []).length === 0 ? (
                          <span className="forms-muted">No custom documents yet.</span>
                        ) : (
                          (docPackData?.custom_form_templates || []).map((f) => (
                            <label key={f.id} className="forms-policy-check">
                              <input type="checkbox" checked={packFormDraft.includes(f.id)} onChange={() => toggleDraftFormTemplate(f.id)} />
                              {f.display_name}
                              <span className="forms-muted" style={{ marginLeft: 6, fontSize: '0.78rem' }}>
                                ({f.workflow === 'staff_onboarding' ? 'Staff' : 'Participant'})
                              </span>
                            </label>
                          ))
                        )}
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
