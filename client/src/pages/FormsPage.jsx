import { useState, useEffect, useCallback } from 'react';
import { forms, onboarding } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import ServiceAgreementTemplateEditor from '../components/ServiceAgreementTemplateEditor';
import OrgFormsCatalog from '../components/OrgFormsCatalog';
import CompanyDocumentsPanel from '../components/CompanyDocumentsPanel';

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
      .then((d) => {
        setDocPackData(d);
        setDefaultStaffPack(d.defaults?.default_staff_onboarding_pack_id || '');
        setDefaultParticipantPack(d.defaults?.default_participant_onboarding_pack_id || '');
      })
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
    if (!orgId || !isAdmin) {
      setSettingsState(null);
      return;
    }
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
  }, [loadContext, reloadDocPacks, reloadSettings]);

  const handleCreatePack = async (e) => {
    e.preventDefault();
    const name = newPackName.trim();
    if (!name) return;
    setPackWorking(true);
    setMessage('');
    try {
      await forms.createOnboardingDocumentPack({ display_name: name, workflow: newPackWorkflow });
      setNewPackName('');
      setMessage('Pack created. Select policy PDFs below.');
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

      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Company documents</h2>
        <CompanyDocumentsPanel onMessage={(msg, isError) => setMessage(msg)} />
      </section>

      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Your forms</h2>
        <OrgFormsCatalog onMessage={(msg, isError) => setMessage(msg)} />
      </section>

      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Services Agreement template</h2>
        <ServiceAgreementTemplateEditor
          onMessage={(msg, isError) => setMessage(msg)}
        />
      </section>

      {isAdmin && orgId && (
        <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
          <h2 className="forms-section-heading">Onboarding settings</h2>
          <p className="forms-lede">
            Toggle onboarding behaviour for this organisation. Pilot mode keeps the workflow available for testing without affecting live participants.
          </p>

          {settingsState?.readiness && !settingsState.readiness.ready && (
            <div
              className="forms-banner"
              style={{ background: '#fef2f2', color: '#991b1b', marginBottom: '1rem' }}
            >
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

      {message && (
        <div
          className="forms-banner"
          style={{ background: bannerIsError ? '#fef2f2' : '#f0fdf4', color: bannerIsError ? '#991b1b' : '#166534' }}
        >
          {message}
        </div>
      )}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <section className="card forms-section">
          <h2 className="forms-section-heading">Policies and packs — staff and participant onboarding</h2>
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
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ color: '#b91c1c' }}
                          disabled={packWorking}
                          onClick={() => handlePolicyDelete(f.id, f.display_name)}
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
                      Tick policy PDFs to include in this pack.
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
      )}
    </div>
  );
}
