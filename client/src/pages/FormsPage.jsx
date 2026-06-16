import { useState, useEffect, useCallback } from 'react';
import { forms, onboarding, documentLibrary } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import ServiceAgreementTemplateEditor from '../components/ServiceAgreementTemplateEditor';
import ActivityRiskAssessmentsPanel from '../components/ActivityRiskAssessmentsPanel';

const CATEGORY_LABELS = {
  policy:    'Policy',
  procedure: 'Procedure',
  register:  'Register',
  contract:  'Contract',
  form:      'Form',
  guide:     'Guide',
};

const CATEGORY_ICONS = {
  policy:    '📋',
  procedure: '🔧',
  register:  '📊',
  contract:  '📄',
  form:      '✏️',
  guide:     '📖',
};

function workflowLabel(w) {
  if (w === 'staff_onboarding') return 'Staff only';
  if (w === 'participant_onboarding') return 'Participant only';
  return 'Staff and participant';
}

export default function FormsPage() {
  const { user, isAdmin } = useAuth();
  const orgId = user?.org_id || null;

  const [message, setMessage] = useState('');

  // Document Library (104 NDIS templates)
  const [libraryTemplates, setLibraryTemplates] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryCategoryFilter, setLibraryCategoryFilter] = useState('');

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

  // ── Load ────────────────────────────────────────────────────────────────

  const reloadDocPacks = useCallback(() => {
    forms.onboardingDocumentPacks().then(setDocPackData).catch(() => {});
  }, []);

  const reloadLibrary = useCallback(() => {
    setLibraryLoading(true);
    documentLibrary
      .listMasters()
      .then((res) => {
        const items = Array.isArray(res) ? res : (res?.templates || res?.masters || []);
        setLibraryTemplates(items);
      })
      .catch(() => setLibraryTemplates([]))
      .finally(() => setLibraryLoading(false));
  }, []);

  const reloadSettings = useCallback(() => {
    if (!orgId || !isAdmin) { setSettingsState(null); return; }
    onboarding.getProviderSettings(orgId)
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

  useEffect(() => {
    reloadDocPacks();
    reloadLibrary();
    reloadSettings();
  }, [reloadDocPacks, reloadLibrary, reloadSettings]);

  // ── Policy pack handlers ─────────────────────────────────────────────────

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

  // ── Settings handler ─────────────────────────────────────────────────────

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

  // ── Derived ──────────────────────────────────────────────────────────────

  const bannerIsError = (message || '').toLowerCase().includes('fail') || (message || '').toLowerCase().includes('could not');
  const libraryCategories = Array.from(new Set((libraryTemplates || []).map((t) => t.category).filter(Boolean))).sort();
  const filteredLibrary = libraryCategoryFilter
    ? (libraryTemplates || []).filter((t) => t.category === libraryCategoryFilter)
    : libraryTemplates;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="forms-page">
      <div className="page-header">
        <h2>Forms &amp; Documents</h2>
      </div>

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
          <button
            type="button"
            style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.7 }}
            onClick={() => setMessage('')}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── 1. Service Agreement ─────────────────────────────────────────── */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <div style={{ marginBottom: '1rem' }}>
          <h2 className="forms-section-heading" style={{ marginBottom: '0.25rem' }}>Service Agreement</h2>
          <p className="forms-lede" style={{ marginBottom: 0 }}>
            Set up your organisation's standard services agreement once. Your details auto-fill from your profile.
            When you generate an agreement for a participant, their information merges in automatically.
          </p>
        </div>
        <ServiceAgreementTemplateEditor onMessage={(msg, isError) => setMessage(isError ? `Error: ${msg}` : msg)} />
      </section>

      {/* ── 2. Participant Intake ─────────────────────────────────────────── */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Participant intake form</h2>
        <p className="forms-lede">
          Send participants (or their guardian/family) a secure self-service link to complete their details before onboarding.
          Their answers feed directly into their profile and service agreement.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', marginTop: '0.75rem' }}>
          <div style={{ padding: '1rem', background: '#f0f9ff', borderRadius: 8, border: '1px solid #bae6fd' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.35rem' }}>📋</div>
            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>4-step intake wizard</strong>
            <p className="forms-muted" style={{ margin: 0, fontSize: '0.85rem' }}>About you · Contact details · NDIS plan · Representative &amp; consent</p>
          </div>
          <div style={{ padding: '1rem', background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.35rem' }}>✉️</div>
            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Flexible delivery</strong>
            <p className="forms-muted" style={{ margin: 0, fontSize: '0.85rem' }}>Send to the participant, a parent, guardian, or any email. Autosaves as they type.</p>
          </div>
          <div style={{ padding: '1rem', background: '#faf5ff', borderRadius: 8, border: '1px solid #e9d5ff' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.35rem' }}>🔗</div>
            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Send from participant profile</strong>
            <p className="forms-muted" style={{ margin: 0, fontSize: '0.85rem' }}>Go to any participant → click <strong>Send self-intake link</strong> to choose who receives it.</p>
          </div>
        </div>
      </section>

      {/* ── 3. Activity Risk Assessments ─────────────────────────────────── */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Activity risk assessments</h2>
        <ActivityRiskAssessmentsPanel onMessage={(msg) => setMessage(msg)} />
      </section>

      {/* ── 4. NDIS Document Library ─────────────────────────────────────── */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <div className="forms-row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem', alignItems: 'flex-start' }}>
          <div>
            <h2 className="forms-section-heading" style={{ marginBottom: '0.25rem' }}>NDIS document library</h2>
            <p className="forms-lede" style={{ marginBottom: 0 }}>
              {libraryTemplates.length} compliance documents — policies, procedures, registers, contracts, and guides.
              Generic and ready to customise with your organisation's branding.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
            <select
              className="form-input"
              style={{ maxWidth: 180 }}
              value={libraryCategoryFilter}
              onChange={(e) => setLibraryCategoryFilter(e.target.value)}
            >
              <option value="">All types</option>
              {libraryCategories.map((cat) => (
                <option key={cat} value={cat}>{CATEGORY_LABELS[cat] || cat}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={reloadLibrary}
              disabled={libraryLoading}
            >
              {libraryLoading ? 'Loading…' : '↻'}
            </button>
          </div>
        </div>

        {libraryLoading ? (
          <p className="forms-muted">Loading document library…</p>
        ) : filteredLibrary.length === 0 ? (
          <p className="forms-muted">No documents found. {libraryTemplates.length === 0 ? 'Check the server has synced templates.' : 'Try a different category filter.'}</p>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '0.65rem'
          }}>
            {filteredLibrary.map((doc) => (
              <div
                key={doc.id || doc.slug}
                style={{
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  padding: '0.75rem',
                  background: '#fff',
                  display: 'flex',
                  gap: '0.65rem',
                  alignItems: 'flex-start'
                }}
              >
                <span style={{ fontSize: '1.2rem', flexShrink: 0, marginTop: 1 }}>
                  {CATEGORY_ICONS[doc.category] || '📄'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: '0.2rem' }}>
                    <span style={{
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: '#64748b',
                      background: '#f1f5f9',
                      borderRadius: 4,
                      padding: '0.1rem 0.35rem'
                    }}>
                      {CATEGORY_LABELS[doc.category] || doc.category}
                    </span>
                    {doc.signature_count > 0 && (
                      <span style={{ fontSize: '0.7rem', color: '#7c3aed' }}>✍️ Signature</span>
                    )}
                  </div>
                  <strong style={{ display: 'block', fontSize: '0.88rem', color: '#1e293b', lineHeight: 1.3 }}>
                    {doc.display_name || doc.name}
                  </strong>
                </div>
              </div>
            ))}
          </div>
        )}

        {!libraryLoading && filteredLibrary.length > 0 && (
          <p className="forms-muted" style={{ marginTop: '0.75rem', fontSize: '0.82rem' }}>
            Showing {filteredLibrary.length} of {libraryTemplates.length} documents.
            {libraryCategoryFilter && (
              <button
                type="button"
                style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '0.82rem', padding: '0 0.25rem' }}
                onClick={() => setLibraryCategoryFilter('')}
              >
                Clear filter
              </button>
            )}
          </p>
        )}
      </section>

      {/* ── 5. Policy packs ──────────────────────────────────────────────── */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Policy packs — onboarding</h2>
        <p className="forms-lede">
          Upload your own policy PDFs and group them into packs that attach to staff or participant onboarding emails.
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

      {/* ── 6. Onboarding settings ───────────────────────────────────────── */}
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
