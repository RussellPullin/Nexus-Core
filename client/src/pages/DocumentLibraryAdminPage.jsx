import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { documentLibrary } from '../lib/api';
import DocumentPreviewModal from '../components/DocumentPreviewModal';

/**
 * Phase 1: Master document library admin page (system-admin only).
 *
 * Lists every template registered from `data/forms/templates/library/<slug>/`,
 * lets admins re-sync from disk and clone any/all masters into the current org.
 */
export default function DocumentLibraryAdminPage() {
  const { user } = useAuth();
  const isSystemAdmin = user?.role === 'super_admin' || user?.role === 'admin';
  const [masters, setMasters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState({ open: false, src: null, title: '' });

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await documentLibrary.listMasters();
      setMasters(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e.message || 'Could not load masters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleSync = async () => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const res = await documentLibrary.sync();
      setMessage(`Sync complete — scanned ${res.scanned}, registered ${res.registered}, skipped ${res.skipped?.length || 0}, warnings ${res.warnings?.length || 0}.`);
      await reload();
    } catch (e) {
      setError(e.message || 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCloneAll = async () => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const res = await documentLibrary.cloneAllToOrg();
      setMessage(`Cloned ${res.cloned} masters into your org.`);
      await reload();
    } catch (e) {
      setError(e.message || 'Clone failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCloneOne = async (masterId) => {
    setBusy(true);
    setError('');
    try {
      await documentLibrary.cloneMaster(masterId);
      await reload();
    } catch (e) {
      setError(e.message || 'Clone failed');
    } finally {
      setBusy(false);
    }
  };

  if (!isSystemAdmin) {
    return (
      <div style={{ padding: '1.5rem' }}>
        <h2>Master document library</h2>
        <p style={{ color: '#64748b' }}>This page is for system administrators only.</p>
      </div>
    );
  }

  const grouped = groupBy(masters, 'category');

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>Master document library</h2>
          <p style={{ color: '#64748b', margin: '.25rem 0 0', fontSize: '.9rem' }}>
            Drop folders into <code>server/data/forms/templates/library/&lt;slug&gt;/</code> with a <code>manifest.json</code> and template file. Each
            master gets cloned into every org so policies, registers and forms are pre-branded automatically.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button className="btn btn-secondary" onClick={handleSync} disabled={busy}>{busy ? 'Working…' : 'Re-sync from disk'}</button>
          <button className="btn btn-primary" onClick={handleCloneAll} disabled={busy}>Clone all to my org</button>
        </div>
      </div>

      {error && <div className="settings-error">{error}</div>}
      {message && <div className="settings-success">{message}</div>}

      {loading && <p>Loading…</p>}

      {!loading && masters.length === 0 && (
        <div style={{ padding: '1rem', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 8 }}>
          <p style={{ margin: 0, color: '#334155' }}>
            No masters registered yet. Drop a folder into the library directory and hit <strong>Re-sync from disk</strong>.
          </p>
        </div>
      )}

      {!loading && Object.entries(grouped).map(([category, items]) => (
        <div key={category} style={{ marginTop: '1.25rem' }}>
          <h3 style={{ textTransform: 'capitalize', margin: '0 0 .5rem' }}>{category || 'uncategorised'}</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.88rem' }}>
            <thead>
              <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                <th style={{ padding: '.4rem' }}>Slug</th>
                <th style={{ padding: '.4rem' }}>Display name</th>
                <th style={{ padding: '.4rem' }}>Engine</th>
                <th style={{ padding: '.4rem' }}>Version</th>
                <th style={{ padding: '.4rem' }}>Last synced</th>
                <th style={{ padding: '.4rem' }}>This org</th>
                <th style={{ padding: '.4rem' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '.4rem', color: '#475569' }}><code>{m.slug}</code></td>
                  <td style={{ padding: '.4rem' }}>{m.display_name}</td>
                  <td style={{ padding: '.4rem' }}>{m.engine}</td>
                  <td style={{ padding: '.4rem' }}>{m.version}</td>
                  <td style={{ padding: '.4rem', color: '#64748b' }}>{m.last_synced_at}</td>
                  <td style={{ padding: '.4rem' }}>
                    {m.clone_id ? (
                      <span style={{ color: '#16a34a' }}>Cloned</span>
                    ) : (
                      <span style={{ color: '#b91c1c' }}>Not yet</span>
                    )}
                  </td>
                  <td style={{ padding: '.4rem', display: 'flex', gap: '.35rem', flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() =>
                        setPreview({
                          open: true,
                          src: documentLibrary.previewMasterUrl(m.id),
                          title: `${m.display_name} — preview`
                        })
                      }
                    >
                      Preview
                    </button>
                    {!m.clone_id && (
                      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => handleCloneOne(m.id)}>
                        Clone to my org
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <DocumentPreviewModal
        open={preview.open}
        src={preview.src}
        title={preview.title}
        onClose={() => setPreview({ open: false, src: null, title: '' })}
      />
    </div>
  );
}

function groupBy(arr, key) {
  return (arr || []).reduce((acc, item) => {
    const k = item?.[key] || 'other';
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}
