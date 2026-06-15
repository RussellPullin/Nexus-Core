import { useState, useEffect, useCallback } from 'react';
import { forms, formTemplates, onboarding } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import BrandedFormTemplateEditor from '../components/BrandedFormTemplateEditor';
import ActivityRiskAssessmentsPanel from '../components/ActivityRiskAssessmentsPanel';

function workflowLabel(w) {
  if (w === 'staff_onboarding') return 'Staff only';
  if (w === 'participant_onboarding') return 'Participant only';
  return 'Staff and participant';
}

export default function FormsPage() {
  const { user, isAdmin } = useAuth();
  const orgId = user?.org_id || null;
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  // Nexus template library
  const [masterTemplates, setMasterTemplates] = useState([]);
  const [orgTemplates, setOrgTemplates] = useState([]);
  const [templateCategoryFilter, setTemplateCategoryFilter] = useState('');
  const [selectedOrgTemplateId, setSelectedOrgTemplateId] = useState(null);
  const [templateLibraryBusy, setTemplateLibraryBusy] = useState(false);

  // Policy packs
  const [docPackData, setDocPackData] = useState(null);
  const [packWorking, setPackWorking] = useState(false);
  const [newPackName, setNewPackName] = useState('');
  const [newPackWorkflow, setNewPackWorkflow] = useState('both');
  const [expandedPackId, setExpandedPackId] = useState(null);
  const [packItemDraft, setPackItemDraft] = useState([]);
  const [policyDisplayName, setPolicyDisplayName] = useState('');
  const [policyFile, setPolicyFile] = useState(null);

  // Onboarding settings
  const [settingsState, setSettingsState] = useState(null);
  const [settingsForm, setSettingsForm] = useState({
    onboarding_enabled: false,
    onboarding_pilot: false,
    signature_mode: 'hybrid',
    default_renewal_days: 365,
    dropbox_sign_enabled: false
  });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');

  const reloadDocPacks = useCallback(() => {
    forms
      .onboardingDocumentPacks()
      .then((d) => setDocPackData(d))
      .catch(() => {});
  }, []);

  const loadContext = useCallback(() => {
    setLoading(true);
    forms
      .context()
      .then(setContext)
      .catch(() => setContext(null))
      .finally(() => setLoading(false));
  }, []);

  const reloadSettings = useCallback(() => {
    if (!orgId || !isAdmin) { setSettingsState(null); return; }
    onboarding
      .getProviderSettings(orgId)
      .then((data) => {
        setSettingsState(data);
        const profile = data?.provider_profile || {};
        setSettingsForm({
          onboarding_enabled: Boolean(profile.onboarding_enabled),
          onboarding_pilot: Boolean(profile.onboarding_pilot),
          signature_mode: profile.signature_mode || 'hybrid',
          default_renewal_days: Number(profile.default_renewal_days || 365),
          dropbox_sign_enabled: Boolean(data?.config?.dropbox_sign_enabled)
        });
      })
      .catch(() => setSettingsState(null));
  }, [orgId, isAdmin]);

  const reloadBrandedTemplates = useCallback(() => {
    Promise.all([formTemplates.masters(), formTemplates.orgTemplates()])
      .then(([mastersRes, orgRes]) => {
        const masters = mastersRes.data || mastersRes.masters || [];
        const orgItems = orgRes.data || [];
        setMasterTemplates(masters);
        setOrgTemplates(orgItems);
        setSelectedOrgTemplateId((current) => current || orgItems[0]?.id || null);
      })
      .catch((err) => setMessage(err.message || 'Could not load templates'));
  }, []);

  const handleSaveSettings = async (e) => {
    e?.preventDefault?.();
    if (!orgId) return;
    setSettingsBusy(true);
    setSettingsMessage('');
    try {
      const existingConfig = settingsState?.config || {};
      const nextConfig = { ...existingConfig, dropbox_sign_enabled: Boolean(settingsForm.dropbox_sign_enabled) };
      await onboarding.providerSettings(orgId, {
        onboarding_enabled: settingsForm.onboarding_enabled,
        onboarding_pilot: settingsForm.onboarding_pilot,
        signature_mode: settingsForm.signature_mode,
        default_renewal_days: Number(settingsForm.default_renewal_days) || 365,
        config: nextConfig
      });
      setSettingsMessage('Onboarding settings saved.');
      reloadSettings();
    } catch (err) {
      setSettingsMessage(err.message || 'Failed to save settings.');
    } finally {
      setSettingsBusy(false);
    }
  };

  useEffect(() => {
    loadContext();
    reloadDocPacks();
    reloadSettings();
    reloadBrandedTemplates();
  }, [loadContext, reloadDocPacks, reloadSettings, reloadBrandedTemplates]);

  const handleCloneMasterTemplate = async (masterId) => {
    setTemplateLibraryBusy(true);
    setMessage('');
    try {
      const res = await formTemplates.cloneMasterToOrg(masterId);
      const id = res.data?.org_template_id || res.data?.id;
      setMessage(res.data?.already_added ? 'Template already added.' : 'Template added to your forms.');
      await reloadBrandedTemplates();
      if (id) setSelectedOrgTemplateId(id);
    } catch (err) {
      setMessage(err.message || 'Could not add template');
    } finally {
      setTemplateLibraryBusy(false);
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
      setMessage('Pack created.');
      reloadDocPacks();
    } catch (err) {
      setMessage(err.message || 'Failed to create pack');
    } finally {
      setPackWorking(false);
    }
  };

  const handleDeletePack = async (packId) => {
    if (!confirm('Delete this pack?')) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.deleteOnboardingDocumentPack(packId);
      if (expandedPackId === packId) { setExpandedPackId(null); setPackItemDraft([]); }
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
    setPackItemDraft((prev) =>
      prev.includes(policyFileId) ? prev.filter((x) => x !== policyFileId) : [...prev, policyFileId]
    );
  };

  const handleSavePackItems = async () => {
    if (!expandedPackId) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.setOnboardingDocumentPackItems(expandedPackId, { policy_file_ids: packItemDraft, form_template_ids: [] });
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
    if (!policyFile) { setMessage('Choose a policy PDF.'); return; }
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
    if (!confirm(`Remove policy "${label}"?`)) return;
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

  const bannerIsError = (message || '').toLowerCase().includes('fail') || (message || '').toLowerCase().includes('could not');
  const templateCategories = Array.from(new Set((masterTemplates || []).map((m) => m.category).filter(Boolean))).sort();
  const filteredMasterTemplates = templateCategoryFilter
    ? (masterTemplates || []).filter((m) => m.category === templateCategoryFilter)
    : masterTemplates;

  return (
    <div className="forms-page">
      <div className="page-header">
        <h2>Forms &amp; Documents</h2>
      </div>

      {context?.organisation_name && (
        <p className="forms-muted" style={{ marginBottom: '1rem' }}>
          Organisation: <strong>{context.organisation_name}</strong>
          {!context.organisation_id && ' (default)'}
        </p>
      )}

      {message && (
        <div
          className="forms-banner"
          style={{
            background: bannerIsError ? '#fef2f2' : '#f0fdf4',
            color: bannerIsError ? '#991b1b' : '#166534',
            marginBottom: '1rem'
          }}
        >
          {message}
        </div>
      )}

      {/* 1. Activity Risk Assessments */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Activity risk assessments</h2>
        <ActivityRiskAssessmentsPanel onMessage={(msg) => setMessage(msg)} />
      </section>

      {/* 2. Nexus Template Library */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <div className="forms-row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div>
            <h2 className="forms-section-heading" style={{ marginBottom: 0 }}>Nexus Template Library</h2>
            <p className="forms-lede" style={{ marginBottom: 0 }}>
              Add compliance documents, forms, and agreements to your organisation. Once added, apply your branding in the section below.
            </p>
          </div>
          <select
            className="form-input"
            style={{ maxWidth: 220 }}
            value={templateCategoryFilter}
            onChange={(e) => setTemplateCategoryFilter(e.target.value)}
          >
            <option value="">All categories</option>
            {templateCategories.map((cat) => (
              <option key={cat} value={cat}>{cat.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
        <div className="template-library-grid">
          {(filteredMasterTemplates || []).length === 0 ? (
            <p className="forms-muted">No templates available.</p>
          ) : (
            (filteredMasterTemplates || []).map((master) => (
              <article key={master.id} className="template-library-card">
                <div className="template-library-icon" aria-hidden>
                  {(master.category || 'F').slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <span className="template-library-badge">{(master.category || 'custom').replace(/_/g, ' ')}</span>
                  <h3>{master.name || master.title}</h3>
                  <p className="forms-muted">{master.description}</p>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={templateLibraryBusy || master.already_added}
                    onClick={() => handleCloneMasterTemplate(master.id)}
                  >
                    {master.already_added ? 'Already added' : 'Add to my forms'}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      {/* 3. Your Branded Templates */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Your branded templates</h2>
        <p className="forms-lede">
          Apply your branding, fill in variables, and customise editable sections. Your logo, colours, ABN, and contact details auto-fill from your organisation profile.
        </p>
        <div className="branded-template-shell">
          <aside className="branded-template-list">
            {(orgTemplates || []).length === 0 ? (
              <p className="forms-muted">No templates yet — add one from the library above.</p>
            ) : (
              (orgTemplates || []).map((template) => (
                <button
                  type="button"
                  key={template.id}
                  className={`branded-template-list-item${selectedOrgTemplateId === template.id ? ' is-selected' : ''}`}
                  onClick={() => setSelectedOrgTemplateId(template.id)}
                >
                  <strong>{template.name}</strong>
                  <span>{(template.category || 'custom').replace(/_/g, ' ')}</span>
                </button>
              ))
            )}
          </aside>
          <main className="branded-template-editor-wrap">
            {selectedOrgTemplateId ? (
              <BrandedFormTemplateEditor
                key={selectedOrgTemplateId}
                templateId={selectedOrgTemplateId}
                onMessage={(msg) => setMessage(msg)}
                onSaved={reloadBrandedTemplates}
              />
            ) : (
              <p className="forms-muted">Choose a template to edit.</p>
            )}
          </main>
        </div>
      </section>

      {/* 4. Policy packs */}
      {!loading && (
        <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
          <h2 className="forms-section-heading">Policy packs — onboarding</h2>
          <p className="forms-lede">
            Upload your policy PDFs and group them into packs that attach to staff or participant onboarding emails.
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

          {(docPackData?.policy_files || []).length > 0 && (
            <>
              <h3 className="forms-subheading">Uploaded policies</h3>
              <div className="table-wrap">
                <table className="table-condensed forms-data-table">
                  <thead>
                    <tr><th>Name</th><th></th></tr>
                  </thead>
                  <tbody>
                    {(docPackData?.policy_files || []).map((f) => (
                      <tr key={f.id}>
                        <td>{f.display_name}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ color: '#b91c1c' }}
                            disabled={packWorking}
                            onClick={() => handlePolicyDelete(f.id, f.display_name)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <form onSubmit={handleCreatePack} className="forms-add-row" style={{ marginTop: '1.25rem' }}>
            <input
              className="form-input"
              value={newPackName}
              onChange={(e) => setNewPackName(e.target.value)}
              placeholder="New pack name"
              style={{ flex: 1, minWidth: 160 }}
            />
            <select
              className="form-input"
              value={newPackWorkflow}
              onChange={(e) => setNewPackWorkflow(e.target.value)}
              style={{ maxWidth: 220 }}
            >
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
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => openPackEditor(p)}
                      disabled={packWorking}
                    >
                      {expandedPackId === p.id ? 'Editing…' : 'Edit pack'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ color: '#b91c1c' }}
                      onClick={() => handleDeletePack(p.id)}
                      disabled={packWorking}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {expandedPackId === p.id && (
                  <div className="forms-pack-body">
                    <p className="forms-muted" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                      Tick policies to include in this pack.
                    </p>
                    <div className="forms-policy-checks">
                      {(docPackData?.policy_files || []).map((f) => (
                        <label key={f.id} className="forms-policy-check">
                          <input
                            type="checkbox"
                            checked={packItemDraft.includes(f.id)}
                            onChange={() => toggleDraftPolicy(f.id)}
                          />
                          {f.display_name}
                        </label>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={packWorking}
                      onClick={handleSavePackItems}
                    >
                      Save pack
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5. Onboarding settings */}
      {isAdmin && orgId && (
        <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
          <h2 className="forms-section-heading">Onboarding settings</h2>
          <p className="forms-lede">
            Toggle onboarding behaviour for this organisation. Pilot mode keeps the workflow available for testing without affecting live participants.
          </p>

          {settingsState?.readiness && !settingsState.readiness.ready && (
            <div className="forms-banner" style={{ background: '#fef2f2', color: '#991b1b', marginBottom: '1rem' }}>
              Not ready to send onboarding yet: {settingsState.readiness.reason}
            </div>
          )}

          <form onSubmit={handleSaveSettings} style={{ display: 'grid', gap: '0.75rem', maxWidth: 560 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={settingsForm.onboarding_enabled}
                onChange={(e) => setSettingsForm((s) => ({ ...s, onboarding_enabled: e.target.checked }))}
              />
              Enable onboarding workflow for this organisation
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={settingsForm.onboarding_pilot}
                onChange={(e) => setSettingsForm((s) => ({ ...s, onboarding_pilot: e.target.checked }))}
              />
              Pilot mode (testing — no live notifications)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={settingsForm.dropbox_sign_enabled}
                onChange={(e) => setSettingsForm((s) => ({ ...s, dropbox_sign_enabled: e.target.checked }))}
              />
              Enable Sign with Nexus Core (Dropbox Sign)
              <span className="forms-muted" style={{ fontSize: '0.8rem' }}>
                Requires Dropbox Sign connected in Settings → Integrations.
              </span>
            </label>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="forms-label" htmlFor="signature_mode">Signature packet mode</label>
              <select
                id="signature_mode"
                className="form-input"
                value={settingsForm.signature_mode}
                onChange={(e) => setSettingsForm((s) => ({ ...s, signature_mode: e.target.value }))}
              >
                <option value="hybrid">Hybrid — bundle related forms, separate consent</option>
                <option value="packet">Packet — all forms in a single envelope</option>
                <option value="separate">Separate — one envelope per form</option>
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="forms-label" htmlFor="default_renewal_days">Default renewal period (days)</label>
              <input
                id="default_renewal_days"
                type="number"
                min="30"
                max="3650"
                className="form-input"
                value={settingsForm.default_renewal_days}
                onChange={(e) => setSettingsForm((s) => ({ ...s, default_renewal_days: e.target.value }))}
                style={{ maxWidth: 160 }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <button type="submit" className="btn btn-primary" disabled={settingsBusy}>
                {settingsBusy ? 'Saving…' : 'Save settings'}
              </button>
              {settingsMessage && (
                <span style={{ color: settingsMessage.toLowerCase().includes('fail') ? '#991b1b' : '#166534', fontSize: '0.9rem' }}>
                  {settingsMessage}
                </span>
              )}
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
