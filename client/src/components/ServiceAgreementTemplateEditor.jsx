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
  if (
    key.includes('hours') ||
    key.includes('days') ||
    key.includes('weeks') ||
    key.includes('months') ||
    key.includes('percent') ||
    key.includes('allowance')
  ) {
    return 'number';
  }
  if (key.includes('date')) return 'date';
  return 'text';
}

function orgTemplateLooksReady(values) {
  const v = values || {};
  return Boolean(String(v.org_legal_name || v.org_trading_name || '').trim());
}

/**
 * Convert body_html to plain editable text for the textarea.
 * Headings and paragraph tags become blank-line-separated blocks.
 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
    .replace(/<\s*\/?\s*h[1-6][^>]*>/gi, '\n\n')
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

/**
 * Convert edited plain text back to paragraph HTML for storage.
 * Double blank lines → separate <p> blocks; single newlines → <br>.
 */
function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p>${p
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>')}</p>`
    )
    .join('');
}

function sectionHasOrgFields(section) {
  return (section.blocks || []).some((b) =>
    (b.fields || []).some((f) => f.editableByOrg && ORG_FIELD_KEYS.has(f.key))
  );
}

export default function ServiceAgreementTemplateEditor({ onMessage }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [instanceId, setInstanceId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [values, setValues] = useState({});
  const [metadata, setMetadata] = useState({});
  const [expandedSection, setExpandedSection] = useState('s1');
  const [expandedBodySection, setExpandedBodySection] = useState(null);
  const [docSections, setDocSections] = useState([]);
  const [docSectionTexts, setDocSectionTexts] = useState({});

  const notify = (msg, isError) => {
    if (onMessage) onMessage(msg, isError);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ masters }, { instances }] = await Promise.all([
        formTemplates.masters(),
        formTemplates.instances()
      ]);
      const master =
        (masters || []).find((m) => m.template_type === 'service_agreement') || masters?.[0];
      if (!master) {
        notify(
          'No service agreement template master found. Restart the server to seed templates.',
          true
        );
        setLoading(false);
        return;
      }
      let inst = (instances || []).find((i) => i.master_id === master.id);
      if (!inst) {
        const created = await formTemplates.cloneInstance({
          master_id: master.id,
          label: 'Services Agreement'
        });
        inst = created.instance;
      }
      setInstanceId(inst.id);
      const model = await formTemplates.previewModel(inst.id);
      setPreview(model);
      setValues({ ...(model.variable_values || {}) });
      const meta =
        typeof model.instance?.metadata_json === 'string'
          ? (() => {
              try {
                return JSON.parse(model.instance.metadata_json);
              } catch {
                return {};
              }
            })()
          : model.instance?.metadata_json || {};
      setMetadata({
        document_date_approved:
          meta.document_date_approved ?? model.variable_values?.document_date_approved ?? '',
        document_review_date:
          meta.document_review_date ?? model.variable_values?.document_review_date ?? '',
        document_next_review_date:
          meta.document_next_review_date ??
          model.variable_values?.document_next_review_date ??
          ''
      });

      const bodySections = model.sections || [];
      setDocSections(bodySections);
      const texts = {};
      for (const s of bodySections) {
        texts[s.id] = stripHtml(s.body_html || '');
      }
      setDocSectionTexts(texts);
    } catch (e) {
      notify(e.message || 'Could not load template', true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const buildSectionsPayload = () =>
    docSections.map((s) => ({
      ...s,
      body_html: textToHtml(docSectionTexts[s.id] ?? stripHtml(s.body_html || ''))
    }));

  const syncOrgProfile = async (variable_values) => {
    try {
      const orgUpdate = {};
      if (variable_values.org_legal_name?.trim()) {
        orgUpdate.legal_name = variable_values.org_legal_name.trim();
        orgUpdate.trading_name = variable_values.org_legal_name.trim();
      }
      if (variable_values.org_abn?.trim()) orgUpdate.abn = variable_values.org_abn.trim();
      if (variable_values.org_address?.trim())
        orgUpdate.address = variable_values.org_address.trim();
      if (variable_values.org_email?.trim()) orgUpdate.email = variable_values.org_email.trim();
      if (variable_values.org_phone?.trim()) orgUpdate.phone = variable_values.org_phone.trim();
      if (Object.keys(orgUpdate).length > 0) {
        await organisations.updateMyProfile(orgUpdate);
      }
    } catch {
      // Non-blocking
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
        },
        sections: buildSectionsPayload()
      });
      await syncOrgProfile(variable_values);
      notify('Service agreement template saved.');
      await load();
    } catch (e) {
      notify(e.message || 'Save failed', true);
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadSample = async () => {
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
        },
        sections: buildSectionsPayload()
      });
      await syncOrgProfile(variable_values);
    } catch {
      // Save failed — still open the PDF with whatever is currently in DB
    } finally {
      setSaving(false);
    }
    window.open(formTemplates.previewPdfUrl(instanceId), '_blank', 'noopener,noreferrer');
  };

  const setValue = (key, val) => setValues((prev) => ({ ...prev, [key]: val }));

  const updateDocSectionText = (id, text) => {
    setDocSectionTexts((prev) => ({ ...prev, [id]: text }));
  };

  const editableSections = (preview?.editable_sections || []).filter(sectionHasOrgFields);
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
        Set your organisation details here once. Brand colours and logo are managed under{' '}
        <strong>Settings → Organisation profile &amp; branding</strong>. Participant fields stay blank on the sample
        preview and are filled from each participant&apos;s profile and intake when you generate an agreement.
      </p>

      {editableSections.map((section) => {
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
              <p className="forms-muted" style={{ fontSize: '0.88rem', margin: '0.5rem 0 0.75rem' }}>
                {section.description}
              </p>
            ) : null}
            {isOpen && (
              <div style={{ marginTop: '0.75rem' }}>
                {(section.blocks || []).map((block) => {
                  const orgFields = (block.fields || []).filter(
                    (f) => f.editableByOrg && ORG_FIELD_KEYS.has(f.key)
                  );
                  if (!orgFields.length) return null;
                  return (
                    <div key={block.id} style={{ marginBottom: '1rem' }}>
                      <h3 className="forms-subheading">{block.label}</h3>
                      <div className="forms-field-grid">
                        {orgFields.map((f) => {
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
                              {desc ? (
                                <p
                                  className="forms-muted"
                                  style={{ fontSize: '0.78rem', margin: '0.2rem 0 0' }}
                                >
                                  {desc}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      {docSections.length > 0 && (
        <div className="card" style={{ padding: '1rem', marginBottom: '1rem' }}>
          <h3 className="forms-subheading" style={{ marginTop: 0 }}>Document sections</h3>
          <p className="forms-muted" style={{ fontSize: '0.85rem', margin: '0 0 0.75rem' }}>
            Edit the body text of each section. Use{' '}
            <code style={{ fontSize: '0.8rem', background: '#f1f5f9', padding: '1px 4px', borderRadius: 3 }}>
              {'{{variable_name}}'}
            </code>{' '}
            for dynamic values (e.g.{' '}
            <code style={{ fontSize: '0.8rem', background: '#f1f5f9', padding: '1px 4px', borderRadius: 3 }}>
              {'{{org_trading_name}}'}
            </code>
            ). Separate paragraphs with a blank line. Changes are saved when you click Save below.
          </p>
          {docSections.map((section) => {
            const isOpen = expandedBodySection === section.id;
            const rowCount = section.id === 'terms' ? 60 : 14;
            return (
              <div
                key={section.id}
                style={{
                  marginBottom: '0.5rem',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  overflow: 'hidden'
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpandedBodySection(isOpen ? null : section.id)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: isOpen ? '#f8fafc' : '#fff',
                    border: 'none',
                    borderBottom: isOpen ? '1px solid #e2e8f0' : 'none',
                    padding: '0.65rem 0.85rem',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontWeight: 500,
                    fontSize: '0.92rem',
                    color: '#1e293b'
                  }}
                >
                  <span>{section.title}</span>
                  <span className="forms-muted" style={{ fontSize: '0.8rem' }}>
                    {isOpen ? '▼' : '▶'}
                  </span>
                </button>
                {isOpen && (
                  <div style={{ padding: '0.75rem', background: '#fafafa' }}>
                    <textarea
                      className="form-input"
                      value={docSectionTexts[section.id] ?? ''}
                      onChange={(e) => updateDocSectionText(section.id, e.target.value)}
                      rows={rowCount}
                      spellCheck={false}
                      style={{
                        fontFamily: 'monospace',
                        fontSize: '0.8rem',
                        resize: 'vertical',
                        width: '100%',
                        boxSizing: 'border-box',
                        lineHeight: 1.55
                      }}
                    />
                    <p
                      className="forms-muted"
                      style={{ fontSize: '0.75rem', margin: '0.3rem 0 0' }}
                    >
                      Tip: blank line = new paragraph · single line break = line break within a
                      paragraph.{' '}
                      <code style={{ fontSize: '0.75rem' }}>{'{{org_legal_name}}'}</code>,{' '}
                      <code style={{ fontSize: '0.75rem' }}>{'{{org_abn}}'}</code>,{' '}
                      <code style={{ fontSize: '0.75rem' }}>{'{{org_trading_name}}'}</code>{' '}
                      and all other template variables are substituted at generation time.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div
        style={{
          marginTop: '1rem',
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          alignItems: 'center'
        }}
      >
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!templateReady || saving}
          onClick={handleDownloadSample}
          title={
            templateReady
              ? 'Saves your details then downloads a sample PDF (participant fields blank)'
              : 'Add your organisation name first'
          }
        >
          {saving ? 'Saving…' : 'Save & download sample'}
        </button>
        {!templateReady ? (
          <span className="forms-muted" style={{ fontSize: '0.85rem' }}>
            Add organisation name to enable download.
          </span>
        ) : null}
      </div>
    </div>
  );
}
