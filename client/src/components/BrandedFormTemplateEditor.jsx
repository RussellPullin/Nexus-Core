import { useCallback, useEffect, useMemo, useState } from 'react';
import { formTemplates, organisations } from '../lib/api';

const BRANDING_FIELDS = [
  { key: 'org_trading_name', label: 'Organisation name', placeholder: 'Defaults from organisation profile' },
  { key: 'org_abn', label: 'ABN', placeholder: 'Defaults from organisation profile' },
  { key: 'org_address', label: 'Address', placeholder: 'Defaults from organisation profile' },
  { key: 'org_phone', label: 'Phone', placeholder: 'Defaults from organisation profile' },
  { key: 'org_email', label: 'Email', placeholder: 'Defaults from organisation profile' }
];

function stripHtml(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function participantAutoFillLabel(key) {
  const k = String(key || '').toLowerCase();
  if (k.includes('participant') || k.includes('client')) return 'Participant profile';
  if (k.includes('plan_')) return 'Participant NDIS plan';
  if (k.includes('staff')) return 'Staff profile';
  if (k.includes('org_') || k.includes('abn') || k.includes('complaints')) return 'Organisation settings';
  return 'Template default';
}

export default function BrandedFormTemplateEditor({ templateId, onClose, onMessage, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('branding');
  const [template, setTemplate] = useState(null);
  const [branding, setBranding] = useState({});
  const [variables, setVariables] = useState({});
  const [variableSlots, setVariableSlots] = useState([]);
  const [sections, setSections] = useState([]);
  const [previewUrl, setPreviewUrl] = useState('');
  const [lastSaved, setLastSaved] = useState('');
  const [orgProfile, setOrgProfile] = useState(null);

  const notify = useCallback((msg, isError) => onMessage?.(msg, isError), [onMessage]);

  const load = useCallback(async () => {
    if (!templateId) return;
    setLoading(true);
    try {
      const [res, profile] = await Promise.all([
        formTemplates.orgTemplate(templateId),
        organisations.getMyProfile().catch(() => null)
      ]);
      const data = res.data || res;
      setTemplate(data);
      setBranding(data.branding || {});
      setVariables(data.variable_values || {});

      // If the master has no variable_slots defined, derive editable slots from placeholders
      // so every template always shows something meaningful in the Variables tab.
      const rawSlots = data.variable_slots || [];
      const derivedSlots =
        rawSlots.length > 0
          ? rawSlots
          : (data.placeholders || data.metadata?.placeholders || [])
              .filter((p) => !String(p).startsWith('org.branding'))
              .map((p) => ({
                key: p,
                label: p
                  .replace(/^org\./, 'Organisation ')
                  .replace(/^participant\./, 'Participant ')
                  .replace(/^staff\./, 'Staff ')
                  .replace(/_/g, ' ')
                  .replace(/\./g, ' → '),
                default_value: '',
                auto_fill: true
              }));
      setVariableSlots(derivedSlots);
      setSections(data.sections || []);
      setLastSaved(data.updated_at || '');
      setOrgProfile(profile?.org || null);
    } catch (e) {
      notify(e.message || 'Could not load template', true);
    } finally {
      setLoading(false);
    }
  }, [templateId, notify]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const refreshPreview = useCallback(async () => {
    if (!templateId) return;
    setPreviewLoading(true);
    try {
      const blob = await formTemplates.previewOrgTemplateBlob(templateId);
      const nextUrl = URL.createObjectURL(blob);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return nextUrl;
      });
    } catch (e) {
      notify(e.message || 'Preview failed', true);
    } finally {
      setPreviewLoading(false);
    }
  }, [templateId, notify]);

  useEffect(() => {
    refreshPreview();
  }, [refreshPreview]);

  const saveTemplate = useCallback(
    async (payload, options = {}) => {
      if (!templateId) return null;
      setSaving(true);
      try {
        const res = await formTemplates.updateOrgTemplate(templateId, payload);
        const data = res.data || res;
        setTemplate(data);
        setLastSaved(data.updated_at || new Date().toISOString());
        onSaved?.(data);
        if (!options.silent) notify('Template saved.');
        return data;
      } catch (e) {
        notify(e.message || 'Save failed', true);
        return null;
      } finally {
        setSaving(false);
      }
    },
    [templateId, notify, onSaved]
  );

  const saveBrandingAndVariables = useCallback(() => {
    return saveTemplate(
      {
        branding,
        variable_values: variables,
        variable_slots: variableSlots
      },
      { silent: true }
    );
  }, [branding, variables, variableSlots, saveTemplate]);

  const saveContent = async () => {
    const saved = await saveTemplate({ sections });
    if (saved) refreshPreview();
  };

  const uploadLogo = async (file) => {
    if (!file) return;
    setSaving(true);
    try {
      await organisations.uploadMyLogo(file);
      const profile = await organisations.getMyProfile();
      setOrgProfile(profile?.org || null);
      notify('Logo uploaded.');
      await refreshPreview();
    } catch (e) {
      notify(e.message || 'Logo upload failed', true);
    } finally {
      setSaving(false);
    }
  };

  const sectionText = useMemo(
    () => Object.fromEntries((sections || []).map((section) => [section.id, stripHtml(section.body_html)])),
    [sections]
  );

  if (loading) return <p className="forms-muted">Loading template editor...</p>;
  if (!template) return <p className="forms-muted">Template not available.</p>;

  return (
    <div className="branded-template-editor">
      <div className="branded-template-left">
        <div className="forms-row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div>
            <h3 className="forms-subheading" style={{ margin: 0 }}>{template.name}</h3>
            <p className="forms-muted" style={{ margin: '0.25rem 0 0' }}>{template.description}</p>
          </div>
          {onClose ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          ) : null}
        </div>

        <div className="branded-template-tabs">
          {['branding', 'variables', 'content'].map((tab) => (
            <button
              key={tab}
              type="button"
              className={`btn btn-sm ${activeTab === tab ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {activeTab === 'branding' && (
          <div className="branded-template-panel">
            <div className="form-group">
              <label className="forms-label">Logo</label>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => uploadLogo(e.target.files?.[0] || null)} />
              <p className="forms-muted" style={{ marginTop: '0.35rem' }}>
                {orgProfile?.hasLogo || orgProfile?.logoPath ? 'Org logo on file.' : 'No org logo on file.'}
              </p>
            </div>
            <div className="forms-field-grid">
              <label className="forms-label">
                Primary colour
                <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', marginTop: 4 }}>
                  <input
                    type="color"
                    value={branding.primary_color || '#1e3a5f'}
                    onChange={(e) => setBranding((b) => ({ ...b, primary_color: e.target.value }))}
                    onBlur={saveBrandingAndVariables}
                  />
                  <input
                    className="form-input"
                    value={branding.primary_color || ''}
                    placeholder="#1e3a5f"
                    onChange={(e) => setBranding((b) => ({ ...b, primary_color: e.target.value }))}
                    onBlur={saveBrandingAndVariables}
                  />
                </div>
              </label>
              <label className="forms-label">
                Accent colour
                <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', marginTop: 4 }}>
                  <input
                    type="color"
                    value={branding.accent_color || '#2563eb'}
                    onChange={(e) => setBranding((b) => ({ ...b, accent_color: e.target.value }))}
                    onBlur={saveBrandingAndVariables}
                  />
                  <input
                    className="form-input"
                    value={branding.accent_color || ''}
                    placeholder="#2563eb"
                    onChange={(e) => setBranding((b) => ({ ...b, accent_color: e.target.value }))}
                    onBlur={saveBrandingAndVariables}
                  />
                </div>
              </label>
              {BRANDING_FIELDS.map((field) => (
                <label key={field.key} className="forms-label">
                  {field.label}
                  <input
                    className="form-input"
                    value={variables[field.key] || ''}
                    placeholder={field.placeholder}
                    onChange={(e) => setVariables((v) => ({ ...v, [field.key]: e.target.value }))}
                    onBlur={saveBrandingAndVariables}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'variables' && (
          <div className="branded-template-panel">
            {(variableSlots || []).length === 0 ? (
              <p className="forms-muted">No variable fields for this template.</p>
            ) : (
              <>
                <p className="forms-muted" style={{ marginBottom: '0.75rem', fontSize: '0.85rem' }}>
                  Fields marked <em>auto-fills</em> are populated from your organisation profile — leave blank to use those values, or override here.
                </p>
                <div className="forms-field-grid">
                  {variableSlots.map((slot, idx) => {
                    const value = slot.value ?? variables[slot.key] ?? '';
                    const isAutoFill = slot.auto_fill || participantAutoFillLabel(slot.key) !== 'Template default';
                    return (
                      <label key={`${slot.key}-${idx}`} className="forms-label">
                        {slot.label || slot.key}
                        {isAutoFill && (
                          <span className="forms-muted" style={{ fontSize: '0.75rem', marginLeft: 6 }}>
                            — auto-fills from {participantAutoFillLabel(slot.key)}
                          </span>
                        )}
                        <input
                          className="form-input"
                          value={value}
                          placeholder={isAutoFill ? 'Leave blank to use organisation profile' : String(slot.default_value ?? '')}
                          onChange={(e) => {
                            const next = e.target.value;
                            setVariableSlots((slots) => slots.map((s, i) => (i === idx ? { ...s, value: next } : s)));
                            setVariables((v) => ({ ...v, [slot.key]: next }));
                          }}
                          onBlur={saveBrandingAndVariables}
                        />
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'content' && (
          <div className="branded-template-panel">
            {(sections || []).map((section) => (
              <section key={section.id} className={`branded-section-edit ${section.locked ? 'is-locked' : ''}`}>
                <div className="forms-row" style={{ justifyContent: 'space-between' }}>
                  <strong>{section.title}</strong>
                  {section.locked ? <span className="forms-muted">Locked</span> : <span className="forms-muted">Editable</span>}
                </div>
                {section.locked ? (
                  <p className="forms-muted" style={{ whiteSpace: 'pre-wrap' }}>{sectionText[section.id]}</p>
                ) : (
                  <textarea
                    className="form-input"
                    rows={8}
                    value={sectionText[section.id] || ''}
                    onChange={(e) => {
                      const body_html = textToHtml(e.target.value);
                      setSections((list) => list.map((s) => (s.id === section.id ? { ...s, body_html } : s)));
                    }}
                  />
                )}
              </section>
            ))}
            <button type="button" className="btn btn-primary" disabled={saving} onClick={saveContent}>
              {saving ? 'Saving...' : 'Save content'}
            </button>
          </div>
        )}
      </div>

      <div className="branded-template-preview">
        <div className="forms-row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div>
            <strong>Live preview</strong>
            <p className="forms-muted" style={{ margin: '0.2rem 0 0' }}>
              Last saved: {lastSaved ? new Date(lastSaved).toLocaleString() : 'Not saved yet'}
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" disabled={previewLoading} onClick={refreshPreview}>
            {previewLoading ? 'Rendering...' : 'Refresh Preview'}
          </button>
        </div>
        {previewUrl ? (
          <iframe title="Form template preview" src={previewUrl} className="branded-template-iframe" />
        ) : (
          <div className="branded-template-preview-empty">
            {previewLoading ? 'Rendering preview...' : 'No preview yet.'}
          </div>
        )}
      </div>
    </div>
  );
}
