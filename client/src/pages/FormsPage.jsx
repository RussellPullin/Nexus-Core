import { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PARTICIPANT_CONTRACT_MERGE_KEYS, STAFF_CONTRACT_MERGE_KEYS } from '@nexus-shared/contractFormMergeKeys';
import { forms } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { resolveLocalOllamaBaseUrl, pickFirstLocalModelName, generateLocalOllamaJson } from '../lib/localOllama.js';

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

/** Normalize Ollama JSON: merge_map object with allowed values only. */
function normalizeOllamaMergeMap(parsed, allowed) {
  const raw =
    parsed && typeof parsed.merge_map === 'object' && parsed.merge_map != null
      ? parsed.merge_map
      : parsed && typeof parsed === 'object'
        ? parsed
        : null;
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const skip = new Set(['merge_map', 'fields', 'notes', 'field_labels']);
  for (const [k, v] of Object.entries(raw)) {
    if (skip.has(k)) continue;
    const key = String(k || '').trim();
    const val = String(v || '').trim();
    if (!key || key.length > 220 || !allowed.includes(val)) continue;
    out[key] = val;
  }
  return out;
}

export default function FormsPage() {
  const { user } = useAuth();
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
  /** `map:${templateId}` | `read:${templateId}` */
  const [ollamaKey, setOllamaKey] = useState(null);

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
      setMessage('Document added. Upload a PDF in the table below, then use Detect (heuristics), Read form (Ollama), or Ollama map.');
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

  const handleOllamaReadDocument = async (t, workflow) => {
    const contractKey = `${t.id}_contract`;
    const file = uploadFile[contractKey];
    if (!file) {
      setMessage(
        'Choose a file in the second file picker (same as Detect). Nexus extracts text on the server; Ollama on this computer reads that text like a person to find fields.'
      );
      return;
    }
    const allowed = workflow === WF_STAFF ? STAFF_CONTRACT_MERGE_KEYS : PARTICIPANT_CONTRACT_MERGE_KEYS;
    const baseUrl = resolveLocalOllamaBaseUrl(user);
    const kind = workflow === WF_STAFF ? 'staff employment / HR' : 'NDIS participant onboarding';
    setOllamaKey(`read:${t.id}`);
    setMessage('');
    try {
      const data = await forms.contractAnalyzePreview(t.id, file);
      const excerpt = String(data.text_excerpt || data.text_preview || '').trim();
      const pdfFields = data.pdf_form_fields || [];
      if (!excerpt && pdfFields.length === 0) {
        setMessage('No text could be extracted from this file. Try a text-based PDF, Word document, or a clearer scan.');
        return;
      }
      const model = await pickFirstLocalModelName(baseUrl);
      if (!model) {
        setMessage('Could not list Ollama models. Is Ollama running? For HTTPS sites set OLLAMA_ORIGINS to this site URL (see Settings → Ollama).');
        return;
      }
      const excerptForModel = excerpt.slice(0, 26000);
      const prompt = `You are reading a ${kind} form as a human would: headings, labels, blanks, tables, and any fill-in areas.

Known PDF AcroForm field names (keys must match these EXACTLY when filling PDFs — use identical spelling/case): ${JSON.stringify(pdfFields)}

Heuristic placeholder list (hints only; you may add more keys you find in the text): ${JSON.stringify(data.all_placeholders || [])}

Document text (may be truncated):
---
${excerptForModel}
---

Task: infer every distinct merge target: PDF field names from the list above, plus Word-style {Placeholders} or line labels that need data.

Return ONLY valid JSON of this exact shape:
{"merge_map":{"ExactPdfOrPlaceholderKey":"one_of_allowed_keys",...},"notes":"optional brief note"}

Rules:
- Each VALUE must be exactly one string from this allowed list: ${JSON.stringify(allowed)}
- Each KEY should be the exact PDF field name when it appears in the PDF field list; otherwise use the placeholder or the shortest stable label as it should appear for merge (often same as PDF field name).
- Include every PDF field name from the list that is a real fill-in, mapped to the best allowed value.
- Do not invent allowed keys; values must be from the list only.`;

      const parsed = await generateLocalOllamaJson(baseUrl, model, prompt, 5000);
      const ollamaMap = normalizeOllamaMergeMap(parsed, allowed);
      if (!Object.keys(ollamaMap).length) {
        setMessage(
          'Ollama did not return a usable merge_map. Try a larger model, shorten the document, or run Detect then Ollama map. Ensure the JSON uses the merge_map key.'
        );
        return;
      }

      const existing = parseMappingJson(t.mapping_json);
      const prevMap = existing.contract_field_map || {};
      const mergedMap = { ...prevMap, ...ollamaMap };
      const prevPh = Array.isArray(existing.contract_analysis?.all_placeholders) ? existing.contract_analysis.all_placeholders : [];
      const mergedPh = [...new Set([...prevPh, ...(data.all_placeholders || []), ...Object.keys(ollamaMap)])];
      const mapping_json = {
        ...existing,
        contract_field_map: mergedMap,
        contract_analysis: {
          ...(existing.contract_analysis || {}),
          docx_placeholders: data.docx_placeholders,
          pdf_form_fields: data.pdf_form_fields,
          ocr_labels: data.ocr_labels,
          ocr_used: data.ocr_used,
          text_preview: data.text_preview,
          file_kind: data.file_kind,
          all_placeholders: mergedPh,
          analyzed_at: new Date().toISOString(),
          text_excerpt_length: excerpt.length
        },
        ollama_document_read: { at: new Date().toISOString(), model, keys: Object.keys(ollamaMap) }
      };
      await forms.updateTemplate(t.id, { mapping_json });
      setAnalyzeByTemplateId((prev) => ({ ...prev, [t.id]: { ...data, all_placeholders: mergedPh, contract_field_map: mergedMap } }));
      setMessage(
        `Ollama read the document and saved ${Object.keys(ollamaMap).length} field mapping(s). Use “Detect” to persist server heuristics too, or “Ollama map” to tweak keys.`
      );
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Ollama read failed');
    } finally {
      setOllamaKey(null);
    }
  };

  const handleOllamaRefineMapping = async (t, workflow) => {
    const placeholders =
      (analyzeByTemplateId[t.id]?.all_placeholders?.length && analyzeByTemplateId[t.id].all_placeholders) ||
      placeholdersFromTemplate(t);
    if (!placeholders.length) {
      setMessage('Run “Read form (Ollama)” or “Detect fields” first so there are field names to map.');
      return;
    }
    const allowed = workflow === WF_STAFF ? STAFF_CONTRACT_MERGE_KEYS : PARTICIPANT_CONTRACT_MERGE_KEYS;
    const baseUrl = resolveLocalOllamaBaseUrl(user);
    setOllamaKey(`map:${t.id}`);
    setMessage('');
    try {
      const model = await pickFirstLocalModelName(baseUrl);
      if (!model) {
        setMessage('Could not list Ollama models. Is Ollama running? For HTTPS sites set OLLAMA_ORIGINS to this site URL (see Settings → Ollama).');
        return;
      }
      const prompt = `You map PDF or Word form field names to data keys for mail merge.
Respond with ONLY a single JSON object (no markdown, no explanation). Use this exact shape: {"merge_map":{...}}

Keys are form field names or placeholders exactly as listed. Values must be one of the allowed merge keys.

Allowed merge keys (use only these as values): ${JSON.stringify(allowed)}

Form field names and labels to map: ${JSON.stringify(placeholders)}

Example: {"merge_map":{"EmployeeName":"employee_name","NDIS_Number":"ndis_number"}}`;
      const parsed = await generateLocalOllamaJson(baseUrl, model, prompt, 2200);
      const ollamaMap = normalizeOllamaMergeMap(parsed, allowed);
      if (!Object.keys(ollamaMap).length) {
        setMessage('Ollama did not return a usable merge_map object.');
        return;
      }
      const existing = parseMappingJson(t.mapping_json);
      const prevMap = existing.contract_field_map || {};
      const merged = { ...prevMap, ...ollamaMap };
      const mapping_json = {
        ...existing,
        contract_field_map: merged,
        ollama_refine: { at: new Date().toISOString(), model }
      };
      await forms.updateTemplate(t.id, { mapping_json });
      setMessage(`Ollama saved ${Object.keys(merged).length} mapping entr${Object.keys(merged).length === 1 ? 'y' : 'ies'}.`);
      loadTemplates();
    } catch (err) {
      setMessage(err.message || 'Ollama mapping failed');
    } finally {
      setOllamaKey(null);
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
              <th>PDF</th>
              <th>Mapped fields</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const fileInfo = templateFiles[t.id];
              const hasFile = fileInfo?.has_file;
              const contractKey = `${t.id}_contract`;
              const m = parseMappingJson(t.mapping_json);
              const analyzedAt = m.contract_analysis?.analyzed_at;
              return (
                <tr key={t.id}>
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
                        accept=".pdf"
                        className="forms-file-inline"
                        onChange={(e) => setUploadFile((prev) => ({ ...prev, [t.id]: e.target.files?.[0] || null }))}
                      />
                      <button type="button" className="btn btn-primary btn-sm" disabled={uploading === t.id || !uploadFile[t.id]} onClick={() => handleUploadPdf(t.id)}>
                        {uploading === t.id ? '…' : 'Upload'}
                      </button>
                      <input
                        type="file"
                        accept=".pdf,.docx,.png,.jpg,.jpeg,.webp"
                        className="forms-file-inline"
                        onChange={(e) => setUploadFile((prev) => ({ ...prev, [contractKey]: e.target.files?.[0] || null }))}
                      />
                      <button type="button" className="btn btn-secondary btn-sm" disabled={uploading === contractKey || !uploadFile[contractKey]} onClick={() => handleContractAnalyze(t.id)}>
                        {uploading === contractKey ? '…' : 'Detect'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={uploading === contractKey || !uploadFile[contractKey] || ollamaKey === `read:${t.id}`}
                        onClick={() => handleOllamaReadDocument(t, wf)}
                        title="Server extracts text; Ollama on this PC reads the document to find fields (HTTPS: set OLLAMA_ORIGINS)"
                      >
                        {ollamaKey === `read:${t.id}` ? 'Reading…' : 'Read form'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={ollamaKey === `map:${t.id}`}
                        onClick={() => handleOllamaRefineMapping(t, wf)}
                        title="Map known field names to profile keys using Ollama in this browser"
                      >
                        {ollamaKey === `map:${t.id}` ? 'Ollama…' : 'Ollama map'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ color: '#b91c1c' }} onClick={() => handleDeleteTemplate(t.id)}>
                        Delete
                      </button>
                    </div>
                    {analyzeByTemplateId[t.id] && (
                      <p className="forms-muted" style={{ fontSize: '0.78rem', margin: '0.35rem 0 0' }}>
                        Last detect: {analyzeByTemplateId[t.id].pdf_form_fields?.length ?? 0} PDF fields ·{' '}
                        {analyzeByTemplateId[t.id].docx_placeholders?.length ?? 0} Word · {analyzeByTemplateId[t.id].ocr_labels?.length ?? 0} OCR labels
                      </p>
                    )}
                  </td>
                </tr>
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
        Structured service agreements and branding live under{' '}
        <Link to={settingsFormTemplatesHref}>Settings → Form templates</Link>. This page is for PDFs you merge during onboarding and for policy bundles.
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
            'Add each PDF you want included when onboarding packs are generated. Detect uses OCR and patterns only. Read form sends document text to Ollama on this computer so it can infer fields the way a person would; then use Ollama map to adjust mappings.',
            null
          )}
          {renderWorkflowSection(
            WF_STAFF,
            'Staff onboarding — upload form',
            'Upload employment or compliance PDFs for staff onboarding.',
            'When multiple staff documents exist, the employment merge uses the one most recently updated (PDF or Word on file).'
          )}

          <section className="card forms-section">
            <h2 className="forms-section-heading">Policies — staff and participant onboarding</h2>
            <p className="forms-lede">
              Policy PDFs can be grouped into packs and attached to staff welcome mail and participant onboarding mail. Choose whether each pack applies to staff onboarding, participant onboarding, or both.
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
