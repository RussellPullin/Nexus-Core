import { useState, useEffect, useCallback, useRef } from 'react';
import { forms } from '../lib/api';
import FormTemplateFieldEditor from './FormTemplateFieldEditor';

function workflowLabel(w) {
  if (w === 'staff_onboarding') return 'Staff onboarding';
  return 'Participant onboarding';
}

export default function FormTemplatesBulkPanel({ onMessage }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [workflow, setWorkflow] = useState('participant_onboarding');
  const [editingTemplate, setEditingTemplate] = useState(null);
  const fileInputRef = useRef(null);
  const zipInputRef = useRef(null);

  const notify = (msg, isError) => {
    if (onMessage) onMessage(msg, isError);
  };

  const reload = useCallback(() => {
    setLoading(true);
    forms
      .templates()
      .then((res) => {
        const custom = (res?.templates || []).filter((t) => t.form_type === 'custom');
        setTemplates(custom);
      })
      .catch((e) => notify(e.message || 'Could not load form templates', true))
      .finally(() => setLoading(false));
  }, [onMessage]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleBulkUpload = async (fileList) => {
    if (!fileList?.length) return;
    setBusy(true);
    try {
      const result = await forms.bulkUploadTemplates(Array.from(fileList), { workflow });
      const mapped = (result.imported || []).reduce((n, r) => n + (r.mapped_field_count || 0), 0);
      notify(
        `Registered ${result.imported?.length || 0} form template(s) with ${mapped} mapped field(s)${
          result.errors?.length ? `; ${result.errors.length} failed` : ''
        }. Open Preview on each row to check field placement before sending for signature.`
      );
      reload();
    } catch (e) {
      notify(e.message || 'Upload failed', true);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleZipUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await forms.bulkUploadTemplatesZip(file, { workflow });
      notify(`Registered ${result.imported?.length || 0} form template(s) from ZIP.`);
      reload();
    } catch (e) {
      notify(e.message || 'ZIP upload failed', true);
    } finally {
      setBusy(false);
      if (zipInputRef.current) zipInputRef.current.value = '';
    }
  };

  const handleDelete = async (t) => {
    if (!window.confirm(`Delete form template “${t.display_name}”?`)) return;
    setBusy(true);
    try {
      await forms.deleteTemplate(t.id);
      notify('Form template deleted.');
      reload();
    } catch (e) {
      notify(e.message || 'Delete failed', true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-templates-bulk-panel">
      <p className="forms-lede">
        Upload your organisation&apos;s own PDF forms (your branding). Nexus auto-suggests field boxes on upload — use{' '}
        <strong>Edit fields</strong> to adjust placement, then <strong>Preview</strong> to see what signers see in
        Dropbox Sign. Text fields pre-fill from intake; signature and date fields are collected at signing.
      </p>

      <div className="forms-add-row" style={{ marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="forms-label" style={{ marginBottom: 0 }}>
          Workflow
          <select
            className="form-input"
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            disabled={busy}
            style={{ marginLeft: '0.5rem', maxWidth: 220 }}
          >
            <option value="participant_onboarding">Participant onboarding</option>
            <option value="staff_onboarding">Staff onboarding</option>
          </select>
        </label>
        <label className="btn btn-primary btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Working…' : 'Upload PDF forms'}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,application/pdf"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => handleBulkUpload(e.target.files)}
          />
        </label>
        <label className="btn btn-secondary btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          Upload ZIP
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => handleZipUpload(e.target.files?.[0])}
          />
        </label>
      </div>

      {loading ? (
        <p className="forms-muted">Loading form templates…</p>
      ) : templates.length === 0 ? (
        <p className="forms-muted">No workflow form templates yet. Bulk-upload PDFs with AcroForm fields above.</p>
      ) : (
        <>
          {templates.some((t) => t.file_missing_on_disk) ? (
            <div
              className="forms-banner"
              style={{ background: '#fffbeb', color: '#92400e', marginBottom: '1rem' }}
            >
              Some templates are registered in the database but their PDF files are missing from server storage
              (this can happen after a deploy). Re-upload those forms so Preview works again.
            </div>
          ) : null}
          <div className="table-wrap">
            <table className="table-condensed forms-data-table">
              <thead>
                <tr>
                  <th>Form</th>
                  <th>Workflow</th>
                  <th>Fields</th>
                  <th></th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.display_name}</strong>
                      <span className="forms-muted" style={{ display: 'block', fontSize: '0.8rem' }}>
                        {t.version}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.85rem' }}>{workflowLabel(t.workflow)}</td>
                    <td className="forms-muted" style={{ fontSize: '0.85rem' }}>
                      {t.file_missing_on_disk ? (
                        <span style={{ color: '#b45309' }}>File missing — re-upload</span>
                      ) : t.has_template_file ? (
                        t.signing_layout_field_count > 0 ? (
                          <>
                            {t.signing_layout_field_count} signing field
                            {t.signing_layout_field_count === 1 ? '' : 's'} configured
                            {t.acro_field_count > 0 ? (
                              <span style={{ display: 'block', fontSize: '0.75rem' }}>
                                {t.mapped_field_count ?? 0} of {t.acro_field_count} AcroForm field
                                {t.acro_field_count === 1 ? '' : 's'} mapped
                              </span>
                            ) : null}
                          </>
                        ) : t.acro_field_count > 0 ? (
                          <>
                            {t.mapped_field_count ?? 0} of {t.acro_field_count} PDF field
                            {t.acro_field_count === 1 ? '' : 's'} mapped
                            <span style={{ display: 'block', color: '#b45309', fontSize: '0.75rem' }}>
                              Open Edit fields to configure signing layout
                            </span>
                          </>
                        ) : (
                          <>
                            {t.mapped_field_count ?? 0} label{t.mapped_field_count === 1 ? '' : 's'} detected
                            <span style={{ display: 'block', color: '#b45309', fontSize: '0.75rem' }}>
                              Open Edit fields to place boxes on flat PDFs
                            </span>
                          </>
                        )
                      ) : (
                        'No file'
                      )}
                    </td>
                    <td>
                      {t.has_template_file ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={busy}
                          onClick={() => setEditingTemplate(t)}
                        >
                          Edit fields
                        </button>
                      ) : (
                        <span className="forms-muted" style={{ fontSize: '0.8rem' }}>—</span>
                      )}
                    </td>
                    <td>
                      {t.has_template_file ? (
                        <a
                          href={forms.signerPreviewPdfUrl(t.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-secondary btn-sm"
                          title="Signer view — highlighted fields with mapping labels"
                        >
                          Preview
                        </a>
                      ) : (
                        <span className="forms-muted" style={{ fontSize: '0.8rem' }}>—</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ color: '#b91c1c' }}
                        disabled={busy}
                        onClick={() => handleDelete(t)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editingTemplate ? (
        <FormTemplateFieldEditor
          templateId={editingTemplate.id}
          displayName={editingTemplate.display_name}
          onClose={() => setEditingTemplate(null)}
          onSaved={() => {
            notify('Signing field layout saved.');
            reload();
          }}
          onError={(msg) => notify(msg, true)}
        />
      ) : null}
    </div>
  );
}
