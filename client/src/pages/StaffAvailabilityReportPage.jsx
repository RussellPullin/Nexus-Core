import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import { formatDate } from '../lib/dateUtils';
import { reports, admin } from '../lib/api';

function getDefaultRange() {
  const start = new Date();
  const day = start.getDay();
  const diff = start.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(start);
  monday.setDate(diff);
  const end = new Date(monday);
  end.setDate(end.getDate() + 6);
  const toY = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dayStr = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dayStr}`;
  };
  return { start: toY(monday), end: toY(end) };
}

function conflictTable(data) {
  const columns = ['Staff', 'Participant', 'Start', 'End', 'Message'];
  const rows = (data.conflicts || []).map((c) => [
    c.staff_name || '',
    c.participant_name || '',
    c.start_time || '',
    c.end_time || '',
    c.message || ''
  ]);
  return { columns, rows };
}

function downloadCsv(data) {
  const { columns, rows } = conflictTable(data);
  const esc = (s) => {
    if (s == null) return '';
    const t = String(s);
    if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const lines = [columns.map(esc).join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `staff-availability-${data.start}-to-${data.end}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadReadable(data, format) {
  const { columns, rows } = conflictTable(data);
  await admin.exportTable({
    title: 'Staff availability conflicts',
    subtitle: `${data.start} to ${data.end}`,
    columns,
    rows,
    format,
    filename: `staff-availability-${data.start}-to-${data.end}`
  });
}

export default function StaffAvailabilityReportPage() {
  const pathPrefix = useProductPathPrefix();
  const def = getDefaultRange();
  const [start, setStart] = useState(def.start);
  const [end, setEnd] = useState(def.end);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await reports.staffAvailability(start, end);
      setData(r);
    } catch (e) {
      setError(e?.message || 'Failed to load report');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="page-header">
        <h2>Staff availability (rostering)</h2>
        <Link to="/shifts" className="btn btn-secondary">Back to Shifts</Link>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', color: '#64748b' }}>
          Compares scheduled shifts to each staff member&apos;s weekly availability. Shifts with no availability on file are not flagged.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <label>
            <span style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem' }}>From</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            <span style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem' }}>To</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <button type="button" className="btn btn-primary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Run report'}
          </button>
          {data?.conflicts?.length > 0 && (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => downloadReadable(data, 'xlsx').catch((e) => alert(e.message))}>
                Download Excel
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => downloadReadable(data, 'pdf').catch((e) => alert(e.message))}>
                Download PDF
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => downloadCsv(data)}>
                Download CSV
              </button>
            </>
          )}
        </div>
        {error && <p style={{ color: '#b91c1c', marginTop: '0.75rem' }}>{error}</p>}
      </div>

      {data && (
        <div className="card">
          <p style={{ margin: '0 0 0.75rem', fontSize: '0.9rem' }}>
            <strong>{data.summary?.total_shifts ?? 0}</strong> shift(s) in range ·{' '}
            <strong style={{ color: data.summary?.outside_availability > 0 ? '#b45309' : 'inherit' }}>
              {data.summary?.outside_availability ?? 0}
            </strong>{' '}
            outside weekly availability
          </p>
          {(!data.conflicts || data.conflicts.length === 0) ? (
            <p style={{ color: '#64748b', margin: 0 }}>No shifts fall outside set availability in this range.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th>Participant</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Issue</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.conflicts.map((c) => (
                    <tr key={c.shift_id}>
                      <td>
                        <Link to={`${pathPrefix}/staff/${c.staff_id}`}>{c.staff_name}</Link>
                      </td>
                      <td>{c.participant_name}</td>
                      <td>{c.start_time ? formatDate(c.start_time) : '—'}</td>
                      <td>{c.end_time ? formatDate(c.end_time) : '—'}</td>
                      <td style={{ color: '#b45309' }}>{c.message || 'Outside availability'}</td>
                      <td>
                        <Link to={`${pathPrefix}/shifts/${c.shift_id}`} className="btn btn-secondary" style={{ fontSize: '0.8rem' }}>
                          Open shift
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
