import { useCallback, useEffect, useMemo, useState } from 'react';
import { documentLibrary } from '../lib/api';
import {
  PARTICIPANT_SERVICE_TYPES,
  STAFF_ONBOARDING_ROLES,
  participantServiceTypeLabel,
  staffOnboardingRoleLabel
} from '@nexus-shared/onboardingDocumentContext.js';

/**
 * Modal for choosing service type / staff role and which onboarding pack documents to attach.
 */
export default function OnboardingDocumentSelectModal({
  open,
  mode,
  recipientEmail,
  recipientName,
  defaultContextValue = 'all',
  onClose,
  onSend,
  extraPdfCount = null
}) {
  const isParticipant = mode === 'participant';
  const contextOptions = isParticipant ? PARTICIPANT_SERVICE_TYPES : STAFF_ONBOARDING_ROLES;

  const [contextValue, setContextValue] = useState(defaultContextValue || 'all');
  const [documents, setDocuments] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [includeExtraPdfs, setIncludeExtraPdfs] = useState(true);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const workflow = isParticipant ? 'participant_onboarding' : 'staff_onboarding';

  const loadDocuments = useCallback(async (ctx) => {
    setLoading(true);
    setError('');
    try {
      const params = isParticipant
        ? { participantServiceType: ctx }
        : { staffRole: ctx };
      const result = await documentLibrary.onboardingPackDocuments(workflow, params);
      const docs = Array.isArray(result?.documents) ? result.documents : [];
      setDocuments(docs);
      setSelectedIds(new Set(docs.filter((d) => d.suggested).map((d) => d.id)));
    } catch (err) {
      setError(err.message || 'Could not load documents');
      setDocuments([]);
      setSelectedIds(new Set());
    } finally {
      setLoading(false);
    }
  }, [isParticipant, workflow]);

  useEffect(() => {
    if (!open) return;
    const initial = defaultContextValue || 'all';
    setContextValue(initial);
    setIncludeExtraPdfs(true);
    loadDocuments(initial);
  }, [open, defaultContextValue, loadDocuments]);

  const handleContextChange = (value) => {
    setContextValue(value);
    loadDocuments(value);
  };

  const toggleDoc = (docId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const toggleAll = (checked) => {
    if (checked) {
      setSelectedIds(new Set(documents.map((d) => d.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const allSelected = documents.length > 0 && selectedIds.size === documents.length;
  const contextLabel = isParticipant
    ? participantServiceTypeLabel(contextValue)
    : staffOnboardingRoleLabel(contextValue);

  const canSend = selectedIds.size > 0 || (includeExtraPdfs && extraPdfCount !== 0);

  const handleSend = async () => {
    if (!canSend) {
      setError('Select at least one document or include extra organisation PDFs.');
      return;
    }
    setSending(true);
    setError('');
    try {
      const payload = {
        master_ids: [...selectedIds],
        include_extra_pdfs: includeExtraPdfs
      };
      if (isParticipant) {
        payload.participant_service_type = contextValue;
      } else {
        payload.staff_role = contextValue;
      }
      await onSend(payload);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not send');
    } finally {
      setSending(false);
    }
  };

  const sortedDocs = useMemo(
    () => [...documents].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')),
    [documents]
  );

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
        <h3 style={{ marginTop: 0 }}>
          {isParticipant ? 'Send participant onboarding documents' : 'Send staff onboarding documents'}
        </h3>
        <p className="forms-muted" style={{ marginTop: 0 }}>
          Choose {isParticipant ? 'service type' : 'role'} and which documents to attach for{' '}
          <strong>{recipientName || recipientEmail}</strong>
          {recipientEmail ? ` (${recipientEmail})` : ''}.
        </p>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem' }}>
            {isParticipant ? 'Service type' : 'Staff role'}
          </label>
          <select
            className="form-input"
            value={contextValue}
            onChange={(e) => handleContextChange(e.target.value)}
            disabled={loading || sending}
          >
            {contextOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="forms-muted" style={{ fontSize: '0.85rem', margin: '0.35rem 0 0' }}>
            Documents tagged for <strong>{contextLabel}</strong> are pre-selected. You can change any selection before sending.
          </p>
        </div>

        {loading ? (
          <p className="forms-muted">Loading documents…</p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <label style={{ fontWeight: 600 }}>Documents to attach</label>
              {documents.length > 0 ? (
                <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => toggleAll(e.target.checked)}
                    disabled={sending}
                  />
                  Select all ({documents.length})
                </label>
              ) : null}
            </div>

            {sortedDocs.length === 0 ? (
              <p className="forms-muted">No branded documents in this pack for your organisation.</p>
            ) : (
              <div
                style={{
                  maxHeight: 280,
                  overflowY: 'auto',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  padding: '0.5rem 0.75rem',
                  marginBottom: '0.75rem'
                }}
              >
                {sortedDocs.map((doc) => (
                  <label
                    key={doc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                      padding: '0.35rem 0',
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(doc.id)}
                      onChange={() => toggleDoc(doc.id)}
                      disabled={sending}
                      style={{ marginTop: '0.2rem' }}
                    />
                    <span>
                      <strong>{doc.display_name}</strong>
                      {!doc.suggested ? (
                        <span className="forms-muted" style={{ display: 'block', fontSize: '0.8rem' }}>
                          Not tagged for {contextLabel.toLowerCase()}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <input
            type="checkbox"
            checked={includeExtraPdfs}
            onChange={(e) => setIncludeExtraPdfs(e.target.checked)}
            disabled={sending}
          />
          Include extra organisation PDFs
          {extraPdfCount != null ? (
            <span className="forms-muted" style={{ fontSize: '0.85rem' }}>
              ({extraPdfCount} uploaded)
            </span>
          ) : null}
        </label>

        {error ? (
          <div style={{ color: '#b91c1c', fontSize: '0.9rem', marginBottom: '0.75rem' }}>{error}</div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSend}
            disabled={sending || loading || !canSend}
          >
            {sending ? 'Sending…' : 'Send email'}
          </button>
        </div>
      </div>
    </div>
  );
}
