import { useState, useEffect } from 'react';
import { learning } from '../lib/api';

const CONFIDENCE_COLORS = { high: '#22c55e', medium: '#eab308', low: '#94a3b8' };

function confidenceLevel(c) {
  if (c >= 0.7) return 'high';
  if (c >= 0.4) return 'medium';
  return 'low';
}

/**
 * MappingReview — shows a CSV column mapping review table with learned suggestions.
 * Used during CSV import to let the user confirm or correct auto-suggested mappings.
 *
 * Props:
 * - importType: 'participants' | 'ndis_line_items' | 'shifts'
 * - headers: string[] — CSV column headers
 * - sampleRows: string[][] — first few data rows
 * - targetFields: { value: string, label: string }[] — available target fields
 * - onConfirm: (confirmedMappings: { header, mapped_field, was_corrected, original_field }[]) => void
 * - onCancel: () => void
 */
export default function MappingReview({ importType, headers, sampleRows, targetFields, onConfirm, onCancel }) {
  const [mappings, setMappings] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!headers || headers.length === 0) return;
    setLoading(true);
    learning.previewMapping({
      import_type: importType || 'participants',
      headers,
      sample_rows: sampleRows || []
    }).then(data => {
      setMappings(data.mappings || headers.map((h, i) => ({
        column_index: i, header: h, mapped_field: null, confidence: 0, source: 'none', is_sensitive: false
      })));
      setWarnings(data.warnings || []);
    }).catch(err => {
      console.warn('Mapping preview failed:', err.message);
      setMappings(headers.map((h, i) => ({
        column_index: i, header: h, mapped_field: null, confidence: 0, source: 'none', is_sensitive: false
      })));
    }).finally(() => setLoading(false));
  }, [headers, sampleRows, importType]);

  const handleFieldChange = (index, newField) => {
    setMappings(prev => prev.map((m, i) => i === index ? { ...m, mapped_field: newField, was_corrected: true, original_field: m.mapped_field } : m));
  };

  const handleConfirm = async () => {
    const feedback = mappings
      .filter(m => m.mapped_field)
      .map(m => ({
        header: m.header,
        mapped_field: m.mapped_field,
        was_corrected: !!m.was_corrected,
        original_field: m.original_field || null
      }));

    try {
      await learning.mappingFeedback({ import_type: importType, mappings: feedback });
    } catch { /* ignore */ }

    if (onConfirm) onConfirm(feedback);
  };

  if (loading) return <p style={{ color: '#666', fontSize: '0.85rem' }}>Analyzing columns...</p>;

  return (
    <div style={{ fontSize: '0.85rem' }}>
      {warnings.length > 0 && (
        <div style={{ marginBottom: '0.75rem' }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ padding: '0.4rem 0.6rem', borderRadius: 6, marginBottom: '0.3rem', background: '#fef3c7', border: '1px solid #fbbf24', fontSize: '0.8rem' }}>
              {w}
            </div>
          ))}
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
            <th style={{ padding: '0.4rem 0.5rem' }}>CSV Column</th>
            <th style={{ padding: '0.4rem 0.5rem' }}>Sample</th>
            <th style={{ padding: '0.4rem 0.5rem' }}>Maps To</th>
            <th style={{ padding: '0.4rem 0.5rem', width: 60 }}>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((m, i) => {
            const level = confidenceLevel(m.confidence);
            const sample = (sampleRows && sampleRows[0] && sampleRows[0][i]) ? String(sampleRows[0][i]).slice(0, 30) : '';
            return (
              <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '0.35rem 0.5rem', fontWeight: 500 }}>{m.header}</td>
                <td style={{ padding: '0.35rem 0.5rem', color: '#64748b', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sample}</td>
                <td style={{ padding: '0.35rem 0.5rem' }}>
                  <select
                    value={m.mapped_field || ''}
                    onChange={(e) => handleFieldChange(i, e.target.value || null)}
                    style={{ fontSize: '0.82rem', padding: '2px 4px', width: '100%', border: m.is_sensitive && m.confidence < 0.8 ? '2px solid #fbbf24' : '1px solid #cbd5e1', borderRadius: 4 }}
                  >
                    <option value="">(skip)</option>
                    {(targetFields || []).map(f => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: '0.35rem 0.5rem', textAlign: 'center' }}>
                  {m.confidence > 0 && (
                    <span style={{
                      display: 'inline-block', fontSize: '0.7rem', fontWeight: 600,
                      padding: '2px 6px', borderRadius: 8,
                      background: CONFIDENCE_COLORS[level] + '22', color: CONFIDENCE_COLORS[level],
                      border: `1px solid ${CONFIDENCE_COLORS[level]}44`
                    }}>
                      {Math.round(m.confidence * 100)}%
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button type="button" className="btn btn-primary" onClick={handleConfirm}>Confirm Mapping</button>
        {onCancel && <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
