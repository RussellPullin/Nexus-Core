import { useState, useEffect, useCallback } from 'react';
import { formTemplates, organisations } from '../lib/api';

const ORG_FIELD_KEYS = new Set([
  'org_legal_name',
  'org_trading_name',
  'org_abn',
  'org_address',
  'org_email',
  'org_phone',
  'org_contact_person',
  'principal_names',
  'board_approval_label',
  'establishment_fee_min_hours',
  'group_centre_allowance_per_hour',
  'shadow_shift_max_hours_per_year',
  'invoice_payment_terms_days',
  'cancellation_charge_percent',
  'cancellation_notice_days',
  'complaints_email',
  'complaints_postal_address',
  'complaints_phone',
  'termination_notice_weeks',
  'no_contact_termination_months',
  'governing_law_jurisdiction',
  'monitoring_worker_frequency_default',
  'other_provider_consultation_frequency_default',
  'document_date_approved',
  'document_review_date',
  'document_next_review_date'
]);

function fieldInputType(key) {
  if (key.includes('email')) return 'email';
  if (key.includes('phone')) return 'tel';
  if (key.includes('hours') || key.includes('days') || key.includes('weeks') || key.includes('months') || key.includes('percent') || key.includes('allowance')) {
    return 'number';
  }
  if (key.includes('date')) return 'date';
  return 'text';
}

function orgTemplateLooksReady(values) {
  const v = values || {};
  return Boolean(String(v.org_legal_name || v.org_trading_name || '').trim());
}

export default function ServiceAgreementTemplateEditor({ onMessage }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [instanceId, setInstanceId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [values, setValues] = useState({});
  const [metadata, setMetadata] = useState({});
  const [expandedSection, setExpandedSection] = useState('s1');
  const [logoFile, setLogoFile] = useState(null);
  const [orgProfile, setOrgProfile] = useState(null);
  const [brandPrimary, setBrandPrimary] = useState('#1e3a5f');
  const [brandAccent, setBrandAccent] = useState('#2563eb');
  const [savingBrand, setSavingBrand] = useState(false);

  const notify = (msg, isError) => {
    if (onMessage) onMessage(msg, isError);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ masters }, { instances }] = await Promise.all([formTemplates.masters(), formTemplates.instances()]);
      const master = (masters || []).find((m) => m.template_type === 'service_agreement') || masters?.[0];
      if (!master) {
        notify('No service agreement template master found. Restart the server to seed templates.', true);
        setLoading(false);
        return;
      }
      let inst = (instances || []).find((i) => i.master_id === master.id);
      if (!inst) {
        const created = await formTemplates.cloneInstance({ master_id: master.id, label: 'Services Agreement' });
        inst = created.instance;
      }
      setInstanceId(inst.id);
      const model = await formTemplates.previewModel(inst.id);
      setPreview(model);
      setValues({ ...(model.variable_values || {}) });
      const meta = typeof model.instance?.metadata_json === 'string'
        ? (() => { try { return JSON.parse(model.instance.metadata_json); } catch { return {}; } })()
        : model.instance?.metadata_json || {};
      setMetadata({
        document_date_approved: meta.document_date_approved ?? model.variable_values?.document_date_approved ?? '',
        document_review_date: meta.document_review_date ?? model.variable_values?.document_review_date ?? '',
        document_next_review_date: meta.document_next_review_date ?? model.variable_values?.document_next_review_date ?? ''
      });
    } catch (e) {
      notify(e.message || 'Could not load template', true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    organisations
      .getMyProfile()
      .then((p) => {
        setOrgProfile(p?.org || null);
        if (p?.branding?.primaryColor) setBrandPrimary(p.branding.primaryColor);
        if (p?.branding?.accentColor) setBrandAccent(p.branding.accentColor);
      })
      .catch(() => {});
  }, []);

  const handleSaveBranding = async () => {
    setSavingBrand(true);
    try {
      await organisations.updateMyProfile({
        brand_primary_color: brandPrimary || null,
        brand_accent_color: brandAccent || null
      });
      notify('Brand colours saved. Download a sample to see them applied.');
    } catch (e) {
      notify(e.message || 'Save failed', true);
    } finally {
      setSavingBrand(false);
    }
  };

  const handleUploadOrgLogo = async (file) => {
    if (!file) return;
    setSavingBrand(true);
    try {
      await organisations.uploadMyLogo(file);
      const refreshed = await organisations.getMyProfile();
      setOrgProfile(refreshed?.org || null);
      notify('Logo uploaded — download a sample to see it in the header.');
    } catch (e) {
      notify(e.message || 'Upload failed', true);
    } finally {
      setSavingBrand(false);
    }
  };

  const handleSave = async () => {
    if (!instanceId) return;
    setSaving(true);
    try {
      const variable_values = { ...values };
      variable_values.document_date_approved = metadata.document_date_approved || '';
      variable_values.document_review_date = metadata.document_review_date || '';
      variable_values.document_next_review_date = metadata.document_next_review_date || '';
      await formTemplates.updateInstance(instanceId, {
        variable_values,
        metadata: {
          document_date_approved: metadata.document_date_approved || null,
          document_review_date: metadata.document_review_date || null,
          document_next_review_date: metadata.document_next_review_date || null
        }
      });
      if (logoFile) {
        await formTemplates.uploadInstanceLogo(instanceId, logoFile);
        setLogoFile(null);
      }
      notify('Service agreement template saved.');
      await load();
    } catch (e) {
      notify(e.message || 'Save failed', true);
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadSample = () => {
    if (!instanceId) return;
    window.open(formTemplates.previewPdfUrl(instanceId), '_blank', 'noopener,noreferrer');
  };

  const setValue = (key, val) => setValues((prev) => ({ ...prev, [key]: val }));

  const logoPath = preview?.branding?.logo_relative_path;
  const sections = preview?.editable_sections || [];
  const templateReady = orgTemplateLooksReady(values);

  if (loading) {
    return <p className="forms-muted">Loading service agreement template…</p>;
  }

  if (!instanceId || !preview) {
    return <p className="forms-muted">Template not available.</p>;
  }

  return (
    <div className="sa-template-editor">
      <p className="forms-lede">
        Standard NDIS <strong>Services Agreement (Version 3)</strong>. Set your organisation details here. Participant fields stay blank on the
        template preview and are filled from each participant’s profile and onboarding intake when you generate an agreement.
      </p>

      <div className="card" style={{ padding: '1rem', marginBottom: '1rem' }}>
        <h3 className="forms-subheading" style={{ marginTop: 0 }}>Organisation branding</h3>
        <p className="forms-muted" style={{ fontSize: '0.85rem', margin: '0 0 0.75rem' }}>
          Colours and logo applied to every generated document (Service Agreement, policies, registers). Saved to your organisation profile.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.8rem', color: '#475569' }}>Primary colour (header band)</span>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input
                type="color"
                value={brandPrimary || '#1e3a5f'}
                onChange={(e) => setBrandPrimary(e.target.value)}
                style={{ width: 40, height: 32, padding: 0, border: '1px solid #cbd5e1', borderRadius: 4 }}
              />
              <input
                type="text"
                className="form-input"
                value={brandPrimary || ''}
                onChange={(e) => setBrandPrimary(e.target.value)}
                placeholder="#1e3a5f"
                style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
              />
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.8rem', color: '#475569' }}>Accent colour (section bars)</span>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input
                type="color"
                value={brandAccent || '#2563eb'}
                onChange={(e) => setBrandAccent(e.target.value)}
                style={{ width: 40, height: 32, padding: 0, border: '1px solid #cbd5e1', borderRadius: 4 }}
              />
              <input
                type="text"
                className="form-input"
                value={brandAccent || ''}
                onChange={(e) => setBrandAccent(e.target.value)}
                placeholder="#2563eb"
                style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
              />
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.8rem', color: '#475569' }}>Replace org logo</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              onChange={(e) => handleUploadOrgLogo(e.target.files?.[0] || null)}
            />
            {orgProfile?.hasLogo || orgProfile?.logoPath ? (
              <span style={{ fontSize: '0.75rem', color: '#16a34a' }}>Org logo on file ✓</span>
            ) : (
              <span style={{ fontSize: '0.75rem', color: '#b91c1c' }}>No org logo on file</span>
            )}
          </label>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveBranding} disabled={savingBrand}>
            {savingBrand ? 'Saving…' : 'Save brand colours'}
          </button>
        </div>
      </div>

      <div className="forms-logo-row card" style={{ padding: '1rem', marginBottom: '1rem' }}>
        <div>
          <h3 className="forms-subheading" style={{ marginTop: 0 }}>Template-only logo override (optional)</h3>
          <p className="forms-muted" style={{ fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
            Use this only if you want a logo different from your org logo for the Service Agreement specifically.
            Most users should leave this empty and rely on the org logo above.
          </p>
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => setLogoFile(e.target.files?.[0] || null)} />
        </div>
        <div className="forms-logo-preview-slot" aria-hidden>
          {logoPath ? (
            <img src={formTemplates.instanceLogoUrl(instanceId)} alt="" style={{ maxHeight: 48, maxWidth: 120, objectFit: 'contain' }} />
          ) : (
            <div
              className="forms-logo-placeholder"
              style={{
                width: 88,
                height: 40,
                border: '1px dashed #cbd5e1',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94a3b8',
                fontSize: '0.75rem'
              }}
            >
              Logo
            </div>
          )}
        </div>
      </div>

      {(sections || []).map((section) => {
        const showOrgInputs = (section.blocks || []).some((b) =>
          (b.fields || []).some((f) => f.editableByOrg && ORG_FIELD_KEYS.has(f.key))
        );
        const isOpen = expandedSection === section.id;

        return (
          <section key={section.id} className="card forms-section" style={{ marginBottom: '0.75rem' }}>
            <button
              type="button"
              className="forms-section-toggle"
              onClick={() => setExpandedSection(isOpen ? null : section.id)}
              style={{
                width: '100%',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}
            >
              <h2 className="forms-section-heading" style={{ margin: 0, fontSize: '1.05rem' }}>
                {section.title}
              </h2>
              <span className="forms-muted">{isOpen ? '▼' : '▶'}</span>
            </button>
            {section.description && isOpen ? (
              <p className="forms-muted" style={{ fontSize: '0.88rem', margin: '0.5rem 0 0.75rem' }}>{section.description}</p>
            ) : null}
            {isOpen && (
              <div style={{ marginTop: '0.75rem' }}>
                {(section.blocks || []).map((block) => (
                  <div key={block.id} style={{ marginBottom: '1rem' }}>
                    <h3 className="forms-subheading">{block.label}</h3>
                    {showOrgInputs && (block.fields || []).some((f) => f.editableByOrg && ORG_FIELD_KEYS.has(f.key)) ? (
                      <div className="forms-field-grid">
                        {(block.fields || [])
                          .filter((f) => f.editableByOrg && ORG_FIELD_KEYS.has(f.key))
                          .map((f) => {
                            const desc = (preview.variable_groups || [])
                              .flatMap((g) => Object.entries(g.descriptions || {}))
                              .find(([k]) => k === f.key)?.[1];
                            const val = values[f.key];
                            const displayVal = val === undefined || val === null ? '' : String(val);
                            return (
                              <div key={f.key} className="form-group">
                                <label className="forms-label">{f.label}</label>
                                <input
                                  type={fieldInputType(f.key)}
                                  className="form-input"
                                  value={displayVal}
                                  onChange={(e) => setValue(f.key, e.target.value)}
                                />
                                {desc ? <p className="forms-muted" style={{ fontSize: '0.78rem', margin: '0.2rem 0 0' }}>{desc}</p> : null}
                              </div>
                            );
                          })}
                      </div>
                    ) : null}
                    {!showOrgInputs || !(block.fields || []).some((f) => f.editableByOrg && ORG_FIELD_KEYS.has(f.key)) ? (
                      <ul className="forms-field-list" style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.88rem' }}>
                        {(block.fields || []).map((f) => (
                          <li key={f.key} style={{ marginBottom: '0.25rem' }}>
                            <strong>{f.label}</strong>
                            {f.hint ? <span className="forms-muted"> — {f.hint}</span> : null}
                            {f.format ? <span className="forms-muted"> ({f.format})</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save template'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!templateReady}
          onClick={handleDownloadSample}
          title={templateReady ? 'Download a sample PDF with your organisation details (participant fields blank)' : 'Add your organisation name first'}
        >
          Sample
        </button>
        {!templateReady ? (
          <span className="forms-muted" style={{ fontSize: '0.85rem' }}>Add organisation name to enable download.</span>
        ) : null}
      </div>
    </div>
  );
}
