import { useState, useEffect, useCallback, useRef } from 'react';
import { companyDocuments } from '../lib/api';

const CATEGORY_LABELS = {
  policy: 'Policy',
  procedure: 'Procedure',
  register: 'Register',
  contract: 'Contract',
  form: 'Form',
  guide: 'Guide'
};

function sourceLabel(source) {
  if (source === 'library_master') return 'Master library';
  if (source === 'onedrive') return 'OneDrive';
  return 'Upload';
}

export default function CompanyDocumentsPanel({ onMessage }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    auto_sync_policies_to_onboarding: true,
    default_sync_to_onboarding: true
  });
  const fileInputRef = useRef(null);
  const zipInputRef = useRef(null);

  const notify = (msg, isError) => {
    if (onMessage) onMessage(msg, isError);
  };

  const reload = useCallback(() => {
    setLoading(true);
    companyDocuments
      .list()
      .then((d) => {
        setData(d);
        if (d?.settings) {
          setSettingsForm({
            auto_sync_policies_to_onboarding: d.settings.auto_sync_policies_to_onboarding !== false,
            default_sync_to_onboarding: d.settings.default_sync_to_onboarding !== false
          });
        }
      })
      .catch((e) => notify(e.message || 'Could not load company documents', true))
      .finally(() => setLoading(false));
  }, [onMessage]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleBulkUpload = async (fileList) => {
    if (!fileList?.length) return;
    setBusy(true);
    try {
      const result = await companyDocuments.bulkUpload(Array.from(fileList));
      const msg = `Imported ${result.imported?.length || 0} document(s)${
        result.errors?.length ? `; ${result.errors.length} failed` : ''
      }.`;
      notify(msg, result.errors?.length > 0);
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
      const result = await companyDocuments.bulkUploadZip(file);
      notify(`Imported ${result.imported?.length || 0} document(s) from ZIP.`);
      reload();
    } catch (e) {
      notify(e.message || 'ZIP upload failed', true);
    } finally {
      setBusy(false);
      if (zipInputRef.current) zipInputRef.current.value = '';
    }
  };

  const handleSaveSettings = async () => {
    setBusy(true);
    try {
      await companyDocuments.updateSettings(settingsForm);
      notify('Company document settings saved.');
      reload();
    } catch (e) {
      notify(e.message || 'Save failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleSyncOnboarding = async () => {
    setBusy(true);
    try {
      const result = await companyDocuments.syncOnboarding();
      notify(
        `Synced ${result.synced_count || 0} policy document(s) to onboarding packs${
          result.pack_id ? ' (Company policies pack updated)' : ''
        }.`
      );
      reload();
    } catch (e) {
      notify(e.message || 'Onboarding sync failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleMirrorLibrary = async () => {
    setBusy(true);
    try {
      const result = await companyDocuments.mirrorLibrary();
      notify(`Linked ${result.created || 0} new master library document(s) (${result.total || 0} total).`);
      reload();
    } catch (e) {
      notify(e.message || 'Mirror failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleToggleSync = async (doc, checked) => {
    setBusy(true);
    try {
      await companyDocuments.update(doc.id, { sync_to_onboarding: checked });
      reload();
    } catch (e) {
      notify(e.message || 'Update failed', true);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (doc) => {
    if (!window.confirm(`Remove “${doc.display_name}” from your company documents?`)) return;
    setBusy(true);
    try {
      await companyDocuments.delete(doc.id);
      notify('Document removed.');
      reload();
    } catch (e) {
      notify(e.message || 'Delete failed', true);
    } finally {
      setBusy(false);
    }
  };

  const docs = data?.documents || [];

  return (
    <div className="company-documents-panel">
      <p className="forms-lede">
        Upload your organisation&apos;s policies, procedures, and templates in bulk. Documents marked for onboarding sync
        are copied into staff and participant onboarding email packs automatically. New organisations inherit the platform
        master library on setup, then you can add your own files here.
      </p>

      <div className="forms-add-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label className="btn btn-primary btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Working…' : 'Upload files'}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.html"
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
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={handleMirrorLibrary}>
          Link master library
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={handleSyncOnboarding}>
          Sync to onboarding packs
        </button>
      </div>

      <div className="card" style={{ padding: '0.75rem 1rem', marginBottom: '1rem' }}>
        <h3 className="forms-subheading" style={{ marginTop: 0 }}>Defaults</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <input
            type="checkbox"
            checked={settingsForm.default_sync_to_onboarding}
            onChange={(e) => setSettingsForm((s) => ({ ...s, default_sync_to_onboarding: e.target.checked }))}
          />
          New uploads default to onboarding sync (policies &amp; procedures)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input
            type="checkbox"
            checked={settingsForm.auto_sync_policies_to_onboarding}
            onChange={(e) => setSettingsForm((s) => ({ ...s, auto_sync_policies_to_onboarding: e.target.checked }))}
          />
          Auto-sync policies when a new organisation finishes setup
        </label>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={handleSaveSettings}>
          Save defaults
        </button>
      </div>

      {loading ? (
        <p className="forms-muted">Loading company documents…</p>
      ) : docs.length === 0 ? (
        <p className="forms-muted">
          No company documents yet. Upload PDF or Word files, import from OneDrive under Settings, or link the master
          library.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table-condensed forms-data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Category</th>
                <th>Source</th>
                <th>Onboarding</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id}>
                  <td>
                    <strong>{doc.display_name}</strong>
                    <span className="forms-muted" style={{ display: 'block', fontSize: '0.8rem' }}>
                      {doc.slug}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.85rem' }}>{CATEGORY_LABELS[doc.category] || doc.category}</td>
                  <td className="forms-muted" style={{ fontSize: '0.85rem' }}>
                    {sourceLabel(doc.source)}
                  </td>
                  <td>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(doc.sync_to_onboarding)}
                        disabled={busy}
                        onChange={(e) => handleToggleSync(doc, e.target.checked)}
                      />
                      {doc.company_policy_file_id ? 'Synced' : 'Include'}
                    </label>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <a
                        href={companyDocuments.fileUrl(doc.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary btn-sm"
                      >
                        View
                      </a>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ color: '#b91c1c' }}
                        disabled={busy}
                        onClick={() => handleDelete(doc)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
