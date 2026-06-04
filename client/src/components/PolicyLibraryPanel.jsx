import { useState, useEffect, useCallback, useRef } from 'react';
import { companyDocuments } from '../lib/api';

const POLICY_CATEGORIES = new Set(['policy', 'procedure', 'register']);

function sourceLabel(source) {
  if (source === 'library_master') return 'Master library';
  if (source === 'onedrive') return 'OneDrive';
  return 'Upload';
}

export default function PolicyLibraryPanel({ onMessage }) {
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
      .catch((e) => notify(e.message || 'Could not load policies', true))
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
      const msg = `Imported ${result.imported?.length || 0} policy PDF(s)${
        result.onboarding?.synced_count != null ? `; ${result.onboarding.synced_count} synced to onboarding` : ''
      }${result.errors?.length ? `; ${result.errors.length} failed` : ''}.`;
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
      notify(
        `Imported ${result.imported?.length || 0} policy PDF(s) from ZIP${
          result.onboarding?.synced_count != null ? `; ${result.onboarding.synced_count} synced` : ''
        }.`
      );
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
      notify('Policy settings saved.');
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
        `Synced ${result.synced_count || 0} policy PDF(s) to onboarding packs${
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
    if (!window.confirm(`Remove “${doc.display_name}” from the policy library?`)) return;
    setBusy(true);
    try {
      await companyDocuments.delete(doc.id);
      notify('Policy removed.');
      reload();
    } catch (e) {
      notify(e.message || 'Delete failed', true);
    } finally {
      setBusy(false);
    }
  };

  const docs = (data?.documents || []).filter((d) => POLICY_CATEGORIES.has(d.category));

  return (
    <div className="policy-library-panel">
      <p className="forms-lede">
        Upload finished policy PDFs that already include your logo and branding. Nexus stores them as-is and can attach
        them to staff and participant onboarding emails. Import more from OneDrive under Settings → Document archive.
      </p>

      <div className="forms-add-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label className="btn btn-primary btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Working…' : 'Upload policy PDFs'}
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
          New policy uploads default to onboarding email packs
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
        <p className="forms-muted">Loading policies…</p>
      ) : docs.length === 0 ? (
        <p className="forms-muted">No policies yet. Upload pre-branded PDFs above.</p>
      ) : (
        <div className="table-wrap">
          <table className="table-condensed forms-data-table">
            <thead>
              <tr>
                <th>Policy</th>
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
                  </td>
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
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
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
