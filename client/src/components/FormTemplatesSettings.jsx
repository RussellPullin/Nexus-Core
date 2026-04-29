import { useState, useEffect, useMemo, useCallback } from 'react';
import { formTemplates } from '../lib/api';

function interpolatePreview(template, map) {
  if (!template) return '';
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => (map[k] != null ? String(map[k]) : ''));
}

export default function FormTemplatesSettings() {
  const [masters, setMasters] = useState([]);
  const [instances, setInstances] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [preview, setPreview] = useState(null);
  const [draftValues, setDraftValues] = useState({});
  const [branding, setBranding] = useState({ primary_color: '#1e3a5f', accent_color: '#0f766e', body_font: 'Helvetica' });
  const [metadata, setMetadata] = useState({ document_date_approved: '', document_review_date: '', document_next_review_date: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [logoUploading, setLogoUploading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [m, i] = await Promise.all([formTemplates.masters(), formTemplates.instances()]);
      setMasters(m.masters || []);
      setInstances(i.instances || []);
    } catch (e) {
      setMessage(e.message || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedId) {
      setPreview(null);
      setDraftValues({});
      return;
    }
    let cancel = false;
    formTemplates
      .previewModel(selectedId)
      .then((data) => {
        if (cancel) return;
        setPreview(data);
        setDraftValues(data.variable_values || {});
        setBranding({ primary_color: '#1e3a5f', accent_color: '#0f766e', body_font: 'Helvetica', ...(data.branding || {}) });
        let md = {};
        try {
          md = data.instance?.metadata_json ? JSON.parse(data.instance.metadata_json) : {};
        } catch {
          md = {};
        }
        setMetadata({
          document_date_approved: md.document_date_approved || '',
          document_review_date: md.document_review_date || '',
          document_next_review_date: md.document_next_review_date || ''
        });
      })
      .catch((e) => setMessage(e.message || 'Preview failed'));
    return () => {
      cancel = true;
    };
  }, [selectedId]);

  const serviceAgreementMaster = useMemo(
    () => (masters || []).find((m) => m.template_key === 'service_agreement_spring2_v3'),
    [masters]
  );

  const setupClone = async () => {
    if (!serviceAgreementMaster) return;
    setSaving(true);
    setMessage('');
    try {
      const r = await formTemplates.cloneInstance({
        master_id: serviceAgreementMaster.id,
        label: 'Service Agreement'
      });
      await loadAll();
      if (r.instance?.id) setSelectedId(r.instance.id);
      setMessage('Template ready. Adjust variables and branding below.');
    } catch (e) {
      setMessage(e.message || 'Could not clone template');
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!selectedId) return;
    setSaving(true);
    setMessage('');
    try {
      await formTemplates.updateInstance(selectedId, {
        variable_values: draftValues,
        branding,
        metadata: {
          document_date_approved: metadata.document_date_approved,
          document_review_date: metadata.document_review_date,
          document_next_review_date: metadata.document_next_review_date
        }
      });
      setMessage('Saved.');
      const data = await formTemplates.previewModel(selectedId);
      setPreview(data);
    } catch (e) {
      setMessage(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const resetKey = (key, defaultVal) => {
    setDraftValues((prev) => ({ ...prev, [key]: defaultVal }));
  };

  const clause6Preview = useMemo(() => {
    const def = preview?.definition_json;
    const clauses = def?.clauses || [];
    const c6 = clauses.find((c) => c.number === 6);
    if (!c6) return '';
    return interpolatePreview(c6.body, draftValues);
  }, [preview, draftValues]);

  const onLogo = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !selectedId) return;
    setLogoUploading(true);
    setMessage('');
    try {
      await formTemplates.uploadInstanceLogo(selectedId, file);
      setMessage('Logo uploaded.');
      const data = await formTemplates.previewModel(selectedId);
      setPreview(data);
    } catch (err) {
      setMessage(err.message || 'Logo upload failed');
    } finally {
      setLogoUploading(false);
      e.target.value = '';
    }
  };

  if (loading) return <p style={{ color: '#64748b' }}>Loading form templates…</p>;

  return (
    <div>
      <p className="settings-desc">
        System templates use fixed legal wording; your organisation customises variables, branding, and contact details.
        Connect Microsoft OneDrive under Integrations so generated PDFs archive to each participant’s folder.
      </p>
      {message && (
        <div
          className={message.includes('failed') || message.includes('Could not') ? 'settings-error' : 'settings-success'}
          style={{ marginBottom: '0.75rem' }}
        >
          {message}
        </div>
      )}

      {!instances.some((i) => i.template_key === 'service_agreement_spring2_v3') && (
        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
          <h4 style={{ margin: '0 0 0.5rem 0' }}>Service Agreement</h4>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.9rem', color: '#475569' }}>
            Clone the Spring 2 Health Services Agreement (Version 3 structure) for your organisation.
          </p>
          <button type="button" className="btn btn-primary" disabled={saving || !serviceAgreementMaster} onClick={setupClone}>
            {saving ? 'Working…' : 'Set up Service Agreement'}
          </button>
        </div>
      )}

      <div className="form-group">
        <label>Organisation template</label>
        <select
          className="form-input"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{ maxWidth: 420 }}
        >
          <option value="">— Select —</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label || i.master_title} ({i.template_key})
            </option>
          ))}
        </select>
      </div>

      {selectedId && preview?.variable_groups && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', alignItems: 'start' }}>
          <div>
            <h4 style={{ marginTop: 0 }}>Variables</h4>
            {preview.variable_groups.map((g) => (
              <div key={g.id} style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fafafa' }}>
                <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.9rem' }}>{g.label}</div>
                {g.keys.map((key) => (
                  <div key={key} className="form-group" style={{ marginBottom: '0.5rem' }}>
                    <label style={{ fontSize: '0.85rem' }}>{key.replace(/_/g, ' ')}</label>
                    <input
                      className="form-input"
                      value={draftValues[key] ?? ''}
                      onChange={(e) => setDraftValues((prev) => ({ ...prev, [key]: e.target.value }))}
                      style={{ width: '100%' }}
                    />
                    <small className="form-hint" style={{ display: 'block', marginTop: 2 }}>
                      {g.descriptions?.[key] || ''}{' '}
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                        onClick={() => resetKey(key, preview.variable_defaults?.[key])}
                      >
                        Reset to default
                      </button>
                    </small>
                  </div>
                ))}
              </div>
            ))}

            <h4>Branding</h4>
            <div className="form-group">
              <label>Primary colour (hex)</label>
              <input className="form-input" value={branding.primary_color || ''} onChange={(e) => setBranding((b) => ({ ...b, primary_color: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Accent colour (hex)</label>
              <input className="form-input" value={branding.accent_color || ''} onChange={(e) => setBranding((b) => ({ ...b, accent_color: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Body font (PDF)</label>
              <select className="form-input" value={branding.body_font || 'Helvetica'} onChange={(e) => setBranding((b) => ({ ...b, body_font: e.target.value }))}>
                <option value="Helvetica">Helvetica</option>
                <option value="Times-Roman">Times Roman</option>
                <option value="Courier">Courier</option>
              </select>
            </div>
            <div className="form-group">
              <label>Logo (PNG/JPEG)</label>
              <input type="file" accept="image/png,image/jpeg" disabled={logoUploading} onChange={onLogo} />
            </div>

            <h4>Footer metadata</h4>
            <div className="form-group">
              <label>Date approved</label>
              <input className="form-input" value={metadata.document_date_approved} onChange={(e) => setMetadata((m) => ({ ...m, document_date_approved: e.target.value }))} placeholder="YYYY-MM-DD" />
            </div>
            <div className="form-group">
              <label>Review date</label>
              <input className="form-input" value={metadata.document_review_date} onChange={(e) => setMetadata((m) => ({ ...m, document_review_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Next review date</label>
              <input className="form-input" value={metadata.document_next_review_date} onChange={(e) => setMetadata((m) => ({ ...m, document_next_review_date: e.target.value }))} />
            </div>

            <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save template settings'}
            </button>
          </div>

          <div style={{ position: 'sticky', top: 12, padding: '1rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', maxHeight: '70vh', overflow: 'auto' }}>
            <h4 style={{ marginTop: 0 }}>Live preview (Clause 6 excerpt)</h4>
            <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 0 }}>
              Full PDF includes participant data at generation time. This panel resolves variables only for a sample clause.
            </p>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: '0.75rem',
                lineHeight: 1.45,
                margin: 0,
                padding: '0.75rem',
                background: '#f8fafc',
                borderRadius: 6
              }}
            >
              {clause6Preview || '…'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
