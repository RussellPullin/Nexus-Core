import { useState, useEffect, useCallback } from 'react';
import { learning } from '../lib/api';

const CONFIDENCE_COLORS = { high: '#22c55e', medium: '#eab308', low: '#94a3b8' };

function confidenceLevel(c) {
  if (c >= 0.7) return 'high';
  if (c >= 0.4) return 'medium';
  return 'low';
}

function ConfidenceBadge({ confidence }) {
  const level = confidenceLevel(confidence);
  const pct = Math.round(confidence * 100);
  return (
    <span style={{
      display: 'inline-block', fontSize: '0.7rem', fontWeight: 600,
      padding: '2px 6px', borderRadius: 8,
      background: CONFIDENCE_COLORS[level] + '22', color: CONFIDENCE_COLORS[level],
      border: `1px solid ${CONFIDENCE_COLORS[level]}44`
    }}>
      {pct}%
    </span>
  );
}

/**
 * SuggestionPanel — shown inside the shift form when a participant is selected.
 * Displays learned suggestions for start/end times and line items with
 * confidence scores and explanations. Supports one-tap accept and feedback.
 */
export default function SuggestionPanel({ participantId, staffId, date, onApplySuggestion }) {
  const [suggestions, setSuggestions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(new Set());

  const fetchSuggestions = useCallback(async () => {
    if (!participantId) { setSuggestions(null); return; }
    setLoading(true);
    try {
      const params = { participant_id: participantId };
      if (staffId) params.staff_id = staffId;
      if (date) params.date = date;
      const data = await learning.shiftSuggestions(params);
      setSuggestions(data);
    } catch (err) {
      console.warn('Failed to load suggestions:', err.message);
      setSuggestions(null);
    } finally {
      setLoading(false);
    }
  }, [participantId, staffId, date]);

  useEffect(() => { fetchSuggestions(); }, [fetchSuggestions]);

  const handleAccept = async (field, value, suggestionId) => {
    if (onApplySuggestion) onApplySuggestion(field, value);
    if (suggestionId && !feedbackSent.has(suggestionId)) {
      try {
        await learning.submitFeedback({ suggestion_id: suggestionId, outcome: 'accepted' });
        setFeedbackSent(prev => new Set([...prev, suggestionId]));
      } catch { /* ignore */ }
    }
  };

  const handleReject = async (suggestionId) => {
    if (suggestionId && !feedbackSent.has(suggestionId)) {
      try {
        await learning.submitFeedback({ suggestion_id: suggestionId, outcome: 'rejected' });
        setFeedbackSent(prev => new Set([...prev, suggestionId]));
      } catch { /* ignore */ }
    }
  };

  const handleSuppress = async (suggestionId) => {
    if (suggestionId) {
      try {
        await learning.submitFeedback({ suggestion_id: suggestionId, outcome: 'rejected', dont_suggest_again: true });
        setFeedbackSent(prev => new Set([...prev, suggestionId]));
        fetchSuggestions();
      } catch { /* ignore */ }
    }
  };

  if (!participantId || loading) return null;
  if (!suggestions) return null;

  const hasSuggestions = suggestions.start_time || suggestions.end_time || suggestions.line_items?.length > 0;
  const hasAnomalies = suggestions.anomalies?.length > 0;
  if (!hasSuggestions && !hasAnomalies) return null;

  return (
    <div style={{
      margin: '0.75rem 0', padding: '0.75rem', borderRadius: 8,
      background: '#f0f9ff', border: '1px solid #bae6fd', fontSize: '0.85rem'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: hasSuggestions ? '0.5rem' : 0 }}>
        <span style={{ fontWeight: 600, color: '#0369a1' }}>Suggestions</span>
        <button type="button" onClick={() => setExpanded(!expanded)} style={{
          background: 'none', border: 'none', color: '#0369a1', cursor: 'pointer', fontSize: '0.75rem', textDecoration: 'underline'
        }}>
          {expanded ? 'Hide details' : 'Why?'}
        </button>
      </div>

      {hasAnomalies && suggestions.anomalies.map((a, i) => (
        <div key={i} style={{
          padding: '0.4rem 0.6rem', borderRadius: 6, marginBottom: '0.4rem',
          background: a.severity === 'warning' ? '#fef3c7' : a.severity === 'error' ? '#fee2e2' : '#f1f5f9',
          border: `1px solid ${a.severity === 'warning' ? '#fbbf24' : a.severity === 'error' ? '#f87171' : '#cbd5e1'}`,
          fontSize: '0.8rem'
        }}>
          <strong>{a.severity === 'warning' ? 'Warning' : a.severity === 'error' ? 'Error' : 'Note'}:</strong> {a.message}
        </div>
      ))}

      {suggestions.start_time && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
          <span>Start: <strong>{suggestions.start_time.value}</strong></span>
          <ConfidenceBadge confidence={suggestions.start_time.confidence} />
          {!feedbackSent.has(suggestions.start_time.suggestion_id) && (
            <button type="button" className="btn btn-sm" onClick={() => handleAccept('start_time', suggestions.start_time.value, suggestions.start_time.suggestion_id)}
              style={{ padding: '1px 8px', fontSize: '0.75rem', background: '#e0f2fe', border: '1px solid #7dd3fc', borderRadius: 4, cursor: 'pointer' }}>
              Apply
            </button>
          )}
        </div>
      )}

      {suggestions.end_time && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
          <span>End: <strong>{suggestions.end_time.value}</strong></span>
          <ConfidenceBadge confidence={suggestions.end_time.confidence} />
          {!feedbackSent.has(suggestions.end_time.suggestion_id) && (
            <button type="button" className="btn btn-sm" onClick={() => handleAccept('end_time', suggestions.end_time.value, suggestions.end_time.suggestion_id)}
              style={{ padding: '1px 8px', fontSize: '0.75rem', background: '#e0f2fe', border: '1px solid #7dd3fc', borderRadius: 4, cursor: 'pointer' }}>
              Apply
            </button>
          )}
        </div>
      )}

      {suggestions.line_items?.length > 0 && (
        <div style={{ marginTop: '0.4rem' }}>
          <span style={{ fontWeight: 500 }}>Suggested line items:</span>
          {suggestions.line_items.map((li, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem', fontSize: '0.8rem' }}>
              <span>{li.support_item_number}</span>
              <ConfidenceBadge confidence={li.confidence} />
              {!feedbackSent.has(li.suggestion_id) && (
                <>
                  <button type="button" onClick={() => handleReject(li.suggestion_id)}
                    style={{ padding: '1px 6px', fontSize: '0.7rem', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, cursor: 'pointer', color: '#dc2626' }}>
                    Dismiss
                  </button>
                  <button type="button" onClick={() => handleSuppress(li.suggestion_id)}
                    style={{ padding: '1px 6px', fontSize: '0.7rem', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', textDecoration: 'underline' }}>
                    Don't suggest
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {expanded && suggestions.explanations?.length > 0 && (
        <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: '#e0f2fe', borderRadius: 6, fontSize: '0.78rem', color: '#0c4a6e' }}>
          <strong>Why these suggestions:</strong>
          <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
            {suggestions.explanations.map((ex, i) => <li key={i}>{ex}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
