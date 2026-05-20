import { useEffect, useState } from 'react';
import { compliance, bulkOps } from '../lib/api';

/**
 * Phase 7: Compliance dashboard.
 *
 * Surfaces every NDIS Practice Standard alongside the document library evidence the
 * org has cloned, and lets an admin record a per-standard review status.
 *
 * Also exposes a bulk one-click onboarding panel — operators can paste comma-separated
 * participant and/or staff IDs and run the orchestrators against the lot.
 */
export default function CompliancePage() {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [savingId, setSavingId] = useState(null);
  const [bulk, setBulk] = useState({ participants: '', staff: '', busy: false, result: null, error: '' });

  const refresh = () => {
    setState((s) => ({ ...s, loading: true }));
    compliance
      .practiceStandards()
      .then((d) => setState({ loading: false, error: '', data: d }))
      .catch((err) => setState({ loading: false, error: err.message, data: null }));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleStatusChange = async (standardId, status) => {
    setSavingId(standardId);
    try {
      await compliance.updateStandard(standardId, {
        status,
        last_reviewed_at: status === 'reviewed' ? new Date().toISOString() : null
      });
      refresh();
    } finally {
      setSavingId(null);
    }
  };

  const handleBulk = async () => {
    setBulk((b) => ({ ...b, busy: true, error: '', result: null }));
    try {
      const ids = (s) =>
        s
          .split(/[\s,]+/)
          .map((x) => x.trim())
          .filter(Boolean);
      const result = await bulkOps.onboarding({
        participant_ids: ids(bulk.participants),
        staff_ids: ids(bulk.staff)
      });
      setBulk((b) => ({ ...b, result, busy: false }));
    } catch (err) {
      setBulk((b) => ({ ...b, error: err.message, busy: false }));
    }
  };

  if (state.loading) return <div className="content"><p>Loading compliance dashboard…</p></div>;
  if (state.error) return <div className="content"><p style={{ color: '#b91c1c' }}>{state.error}</p></div>;

  const { summary, standards } = state.data || { summary: {}, standards: [] };
  const coveragePct = Math.round((summary.evidence_coverage || 0) * 100);

  return (
    <div className="content">
      <div className="page-header" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Compliance &amp; Practice Standards</h1>
        <p style={{ margin: '0.35rem 0 0', color: '#64748b' }}>
          Every NDIS Practice Standard mapped to your document library evidence and review status.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <SummaryTile label="Standards mapped" value={summary.total_standards || 0} />
        <SummaryTile label="Evidence coverage" value={`${coveragePct}%`} accent={coveragePct >= 80 ? '#16a34a' : coveragePct >= 50 ? '#ca8a04' : '#dc2626'} />
        <SummaryTile label="Reviewed in last year" value={summary.reviewed_in_last_year || 0} />
      </div>

      <div className="card" style={{ padding: 0, marginBottom: '1.5rem' }}>
        <div style={{ padding: '0.65rem 1rem', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', fontWeight: 600 }}>
          Practice Standards
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <table style={{ width: '100%', fontSize: '0.88rem' }}>
            <thead>
              <tr style={{ background: '#f1f5f9', textAlign: 'left' }}>
                <th style={{ padding: '0.5rem' }}>Code</th>
                <th style={{ padding: '0.5rem' }}>Standard</th>
                <th style={{ padding: '0.5rem' }}>Evidence</th>
                <th style={{ padding: '0.5rem' }}>Last reviewed</th>
                <th style={{ padding: '0.5rem' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {standards.map((s) => (
                <tr key={s.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '0.5rem', whiteSpace: 'nowrap', color: '#475569' }}>{s.standard_code}</td>
                  <td style={{ padding: '0.5rem' }}>
                    <div style={{ fontWeight: 500 }}>{s.title}</div>
                    {s.intent && <div style={{ fontSize: '0.78rem', color: '#64748b' }}>{s.intent}</div>}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    {s.evidence.length === 0 && <em style={{ color: '#94a3b8' }}>—</em>}
                    {s.evidence.map((e) => (
                      <div key={e.slug} style={{ fontSize: '0.75rem' }}>
                        <span style={{ color: e.missing ? '#dc2626' : !e.clone_id ? '#ca8a04' : '#16a34a' }}>●</span>{' '}
                        <code>{e.slug}</code>
                        {e.display_name && <span style={{ marginLeft: 4, color: '#475569' }}>— {e.display_name}</span>}
                      </div>
                    ))}
                  </td>
                  <td style={{ padding: '0.5rem', fontSize: '0.78rem', color: '#475569' }}>
                    {s.last_reviewed_at ? new Date(s.last_reviewed_at).toLocaleDateString('en-AU') : '—'}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <select
                      value={s.status || 'unreviewed'}
                      onChange={(e) => handleStatusChange(s.id, e.target.value)}
                      disabled={savingId === s.id}
                      style={{ padding: '.3rem .4rem', fontSize: '.85rem' }}
                    >
                      <option value="unreviewed">Unreviewed</option>
                      <option value="reviewed">Reviewed</option>
                      <option value="action_required">Action required</option>
                      <option value="not_applicable">Not applicable</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: '1rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Bulk one-click onboarding</h2>
        <p style={{ margin: '0.25rem 0 0.75rem', color: '#64748b', fontSize: '0.85rem' }}>
          Paste participant or staff IDs (comma- or newline-separated). Each runs the same orchestrator as the per-row buttons.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <label>
            <span style={{ fontSize: '.8rem', color: '#475569' }}>Participant IDs</span>
            <textarea
              rows={3}
              value={bulk.participants}
              onChange={(e) => setBulk((b) => ({ ...b, participants: e.target.value }))}
              style={{ width: '100%', padding: '.4rem', fontFamily: 'monospace', fontSize: '.8rem' }}
            />
          </label>
          <label>
            <span style={{ fontSize: '.8rem', color: '#475569' }}>Staff IDs</span>
            <textarea
              rows={3}
              value={bulk.staff}
              onChange={(e) => setBulk((b) => ({ ...b, staff: e.target.value }))}
              style={{ width: '100%', padding: '.4rem', fontFamily: 'monospace', fontSize: '.8rem' }}
            />
          </label>
        </div>
        <button type="button" className="btn btn-primary" onClick={handleBulk} disabled={bulk.busy}>
          {bulk.busy ? 'Running…' : 'Run bulk onboarding'}
        </button>
        {bulk.error && <div style={{ marginTop: '.5rem', color: '#b91c1c' }}>{bulk.error}</div>}
        {bulk.result && (
          <div style={{ marginTop: '.75rem', fontSize: '.85rem' }}>
            <div>
              Participants: {bulk.result.counts.participants_ok}/{bulk.result.counts.participants_total} ok &nbsp;|&nbsp;
              Staff: {bulk.result.counts.staff_ok}/{bulk.result.counts.staff_total} ok
            </div>
            <details style={{ marginTop: '.4rem' }}>
              <summary>Per-target detail</summary>
              <pre style={{ background: '#0f172a', color: '#e2e8f0', padding: '.5rem', borderRadius: 6, maxHeight: 280, overflow: 'auto' }}>
                {JSON.stringify(bulk.result.results, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, accent = '#1d4ed8' }) {
  return (
    <div className="card" style={{ padding: '.85rem 1rem', minWidth: 160 }}>
      <div style={{ fontSize: '.78rem', color: '#64748b' }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, color: accent }}>{value}</div>
    </div>
  );
}
