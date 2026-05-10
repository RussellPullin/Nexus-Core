import { useEffect, useState } from 'react';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import { registers } from '../lib/api.js';
import '../App.css';

export default function RegistersPage() {
  const pathPrefix = useProductPathPrefix();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    registers
      .snapshot()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          const first = d?.views?.[0]?.id;
          if (first) setActiveId(first);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Could not load registers');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = data?.views?.find((v) => v.id === activeId) || data?.views?.[0];

  if (loading) {
    return (
      <div className="content">
        <p>Loading registers…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="content">
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <p style={{ color: '#64748b', marginTop: '0.5rem' }}>Registers are available to organisation admins.</p>
      </div>
    );
  }

  return (
    <div className="content">
      <div className="page-header" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Registers</h1>
        <p style={{ margin: '0.35rem 0 0', color: '#64748b', maxWidth: '52rem' }}>
          Live view of the same data Nexus pushes to <strong>Nexus Core / Register</strong> in OneDrive (when connected).
          Extending a Nexus feature with new compliance data should update rows here and in the next register sync — see{' '}
          <code style={{ fontSize: '0.85em' }}>server/src/services/registerSnapshots.service.js</code>.
        </p>
        {data?.generated_at && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#94a3b8' }}>
            Generated {new Date(data.generated_at).toLocaleString()}
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'stretch', flexWrap: 'wrap' }}>
        <nav className="card" style={{ flex: '0 0 220px', maxHeight: '70vh', overflowY: 'auto', padding: '0.75rem' }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {(data?.views || []).map((v) => (
              <li key={v.id} style={{ marginBottom: 4 }}>
                <button
                  type="button"
                  onClick={() => setActiveId(v.id)}
                  className={v.id === active?.id ? 'registers-nav-link registers-nav-link-active' : 'registers-nav-link'}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: v.id === active?.id ? 'rgba(59,130,246,0.12)' : 'transparent',
                    cursor: 'pointer',
                    borderRadius: 6,
                    padding: '0.45rem 0.5rem',
                    fontSize: '0.9rem'
                  }}
                >
                  {v.title}
                  <span style={{ display: 'block', fontSize: '0.75rem', color: '#64748b', marginTop: 2 }}>
                    {v.populated_from_nexus ? `${v.row_count} row${v.row_count === 1 ? '' : 's'}` : 'Pending data source'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="card" style={{ flex: '1 1 480px', minWidth: 0, padding: '1rem' }}>
          {active && (
            <>
              <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>{active.title}</h2>
              {active.data_source && (
                <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '-0.25rem' }}>
                  Source: <code>{active.data_source}</code>
                </p>
              )}
              {active.roadmap_note && (
                <div
                  style={{
                    marginBottom: '1rem',
                    padding: '0.65rem 0.85rem',
                    background: '#fffbeb',
                    border: '1px solid #fcd34d',
                    borderRadius: 8,
                    fontSize: '0.9rem'
                  }}
                >
                  {active.roadmap_note}
                </div>
              )}
              {!active.row_count && active.populated_from_nexus && (
                <p style={{ color: '#64748b' }}>No rows yet.</p>
              )}
              {active.row_count > 0 && (
                <div style={{ overflowX: 'auto', maxHeight: 'min(60vh, 520px)', overflowY: 'auto' }}>
                  <table
                    className="table-condensed registers-data-table"
                    style={{ fontSize: '0.82rem', whiteSpace: 'nowrap', width: '100%' }}
                  >
                    <thead>
                      <tr>
                        {active.columns.map((col, i) => (
                          <th key={i}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {active.rows.map((row, ri) => (
                        <tr key={ri}>
                          {active.columns.map((_, ci) => (
                            <td key={ci}>{row[ci] ?? ''}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <p style={{ marginTop: '1.25rem', fontSize: '0.85rem', color: '#64748b' }}>
        To refresh Excel files in OneDrive, use{' '}
        <a href={`${pathPrefix}/admin`}>Admin → Refresh Registers Now</a>.
      </p>
    </div>
  );
}
