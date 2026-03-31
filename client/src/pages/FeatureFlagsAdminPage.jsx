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

  const {
    orgs = [],
    feature_defs = [],
    matrix = {},
    supabase_configured,
    scoped_to_own_org: scopedToOwnOrg
  } = matrixPayload || {};

  const singleOrg = orgs.length === 1 ? orgs[0] : null;

  return (
    <div className="admin-page">
      <h2>Organisation feature flags</h2>
      <p style={{ color: '#64748b', maxWidth: 720 }}>
        {scopedToOwnOrg || singleOrg
          ? 'Turn features on or off for your organisation only.'
          : 'Turn features on or off per organisation. Access to this page is limited to super-admin accounts configured by your host.'}
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

      {!loading && orgs.length === 0 && (
        <p>No organisation found for your account. Create one under Directory / org setup first, or ask your host to assign you to an organisation.</p>
      )}

      {!loading && singleOrg && (
        <div
          style={{
            maxWidth: 560,
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            padding: '1.25rem',
            background: '#fafafa'
          }}
        >
          <h3 style={{ margin: '0 0 1rem 0', fontSize: '1.15rem' }}>{singleOrg.name}</h3>
          <p className="form-hint" style={{ marginTop: 0, marginBottom: '1rem' }}>
            Toggle features for this organisation only.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {feature_defs.map((fd) => {
              const on = Boolean(matrix[singleOrg.id]?.[fd.key]);
              const busy = pending.has(`${singleOrg.id}:${fd.key}`);
              return (
                <li
                  key={fd.key}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '0.6rem 0',
                    borderBottom: '1px solid #f1f5f9'
                  }}
                >
                  <label style={{ cursor: busy ? 'wait' : 'pointer', userSelect: 'none', display: 'flex', gap: '0.75rem', flex: 1 }}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy || !supabase_configured}
                      onChange={(e) => toggle(singleOrg.id, fd.key, e.target.checked)}
                      aria-label={fd.label || fd.key}
                    />
                    <span>
                      <span style={{ fontWeight: 500 }}>{fd.label || fd.key}</span>
                      <span className="form-hint" style={{ display: 'block', fontSize: '0.85rem' }}>
                        {fd.key}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!loading && !singleOrg && orgs.length > 0 && (
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
