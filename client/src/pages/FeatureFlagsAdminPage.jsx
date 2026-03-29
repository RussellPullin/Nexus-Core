import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { orgFeatures } from '../lib/api';

export default function FeatureFlagsAdminPage() {
  const { user } = useAuth();
  const [matrixPayload, setMatrixPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [pending, setPending] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const data = await orgFeatures.superAdminMatrix();
      setMatrixPayload(data);
    } catch (e) {
      setMatrixPayload(null);
      setMsg(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user?.is_super_admin) return;
    load();
  }, [user?.is_super_admin, load]);

  const toggle = async (orgId, featureKey, nextEnabled) => {
    const key = `${orgId}:${featureKey}`;
    setPending((s) => new Set(s).add(key));
    setMsg('');
    try {
      await orgFeatures.superAdminSet(orgId, featureKey, nextEnabled);
      setMatrixPayload((prev) => {
        if (!prev?.matrix?.[orgId]) return prev;
        return {
          ...prev,
          matrix: {
            ...prev.matrix,
            [orgId]: { ...prev.matrix[orgId], [featureKey]: nextEnabled }
          }
        };
      });
    } catch (e) {
      setMsg(e.message || 'Update failed');
    } finally {
      setPending((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  if (!user?.is_super_admin) {
    return (
      <div className="content">
        <h2>Feature flags</h2>
        <p>You do not have access to this page.</p>
      </div>
    );
  }

  const { orgs = [], feature_defs = [], matrix = {}, supabase_configured } = matrixPayload || {};

  return (
    <div className="admin-page">
      <h2>Organisation feature flags</h2>
      <p style={{ color: '#64748b', maxWidth: 720 }}>
        Turn features on or off per organisation. Access to this page is limited to super-admin accounts configured by your host.
      </p>

      {!supabase_configured && (
        <div className="settings-error" style={{ marginBottom: '1rem' }}>
          Organisation features are not available until your administrator finishes server setup.
        </div>
      )}

      {msg && (
        <div className={msg.includes('Failed') || msg.includes('403') ? 'settings-error' : 'settings-success'} style={{ marginBottom: '1rem' }}>
          {msg}
        </div>
      )}

      {loading && <p>Loading…</p>}

      {!loading && orgs.length === 0 && <p>No organisations in Nexus yet. Create one under Directory / org setup first.</p>}

      {!loading && orgs.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>Organisation</th>
                {feature_defs.map((fd) => (
                  <th key={fd.key} title={fd.key}>
                    {fd.label || fd.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td style={{ position: 'sticky', left: 0, background: '#fff', fontWeight: 500 }}>{o.name}</td>
                  {feature_defs.map((fd) => {
                    const on = Boolean(matrix[o.id]?.[fd.key]);
                    const busy = pending.has(`${o.id}:${fd.key}`);
                    return (
                      <td key={fd.key} style={{ textAlign: 'center' }}>
                        <label style={{ cursor: busy ? 'wait' : 'pointer', userSelect: 'none' }}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={busy || !supabase_configured}
                            onChange={(e) => toggle(o.id, fd.key, e.target.checked)}
                            aria-label={`${o.name}: ${fd.label || fd.key}`}
                          />
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: '1rem' }}>
        <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
          Refresh
        </button>
      </p>
    </div>
  );
}
