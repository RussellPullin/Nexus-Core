import { useCallback, useEffect, useMemo, useState } from 'react';
import { documentLibrary } from '../lib/api';
import {
  PARTICIPANT_SERVICE_TYPES,
  STAFF_ONBOARDING_ROLES,
  participantServiceTypeLabel,
  staffOnboardingRoleLabel
} from '@nexus-shared/onboardingDocumentContext.js';

function DocumentChecklist({ docs, selectedIds, toggleDoc, sending, contextLabel }) {
  if (docs.length === 0) return null;
  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 6,
        padding: '0.5rem 0.75rem',
        marginBottom: '0.75rem'
      }}
    >
      {docs.map((doc) => (
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
            {doc.requires_signature ? (
              <span
                className="badge"
                style={{
                  marginLeft: '0.4rem',
                  background: '#dbeafe',
                  color: '#1e40af',
                  padding: '0.1rem 0.35rem',
                  borderRadius: 4,
                  fontSize: '0.72rem',
                  fontWeight: 600
                }}
              >
                Signature required
              </span>
            ) : null}
            {!doc.suggested ? (
              <span className="forms-muted" style={{ display: 'block', fontSize: '0.8rem' }}>
                Not tagged for {contextLabel.toLowerCase()}
              </span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  );
}

function AdminFieldInput({ field, value, onChange }) {
  if (field.type === 'select') {
    return (
      <select className="form-input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {(field.options || []).map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.type === 'date' ? 'date' : 'text'}
      className="form-input"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * One-document-at-a-time wizard for filling admin_fields declared on a document's manifest
 * before it's sent for signature (e.g. remuneration rate, governing state).
 */
function AdminFieldsWizard({ docs, index, values, onChange, onBack, onNext, sending }) {
  const doc = docs[index];
  if (!doc) return null;
  const missingRequired = (doc.admin_fields || []).some(
    (f) => f.required && !String(values[doc.id]?.[f.key] || '').trim()
  );
  return (
    <div>
      <p className="forms-muted" style={{ marginTop: 0 }}>
        Prepare document {index + 1} of {docs.length} before it's sent to the staff member.
      </p>
      <div style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
        <h4 style={{ marginTop: 0 }}>{doc.display_name}</h4>
        {(doc.admin_fields || []).map((f) => (
          <label key={f.key} className="forms-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
            {f.label}{f.required ? ' *' : ''}
            <AdminFieldInput
              field={f}
              value={values[doc.id]?.[f.key]}
              onChange={(v) => onChange(doc.id, f.key, v)}
            />
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={sending}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onNext} disabled={sending || missingRequired}>
          {sending ? 'Sending…' : index === docs.length - 1 ? 'Send onboarding email' : 'Next'}
        </button>
      </div>
    </div>
  );
}

/**
 * Inline panel for choosing service type / staff role and onboarding pack documents.
 * Used on StaffProfile (inline) and wrapped by OnboardingDocumentSelectModal.
 */
export default function OnboardingDocumentSelectPanel({
  mode,
  recipientEmail,
  recipientName,
  defaultContextValue = 'all',
  extraPdfCount = null,
  active = true,
  automationMappingHref = null,
  onCancel,
  onSend,
  sending: externalSending = false
}) {
  const isParticipant = mode === 'participant';
  const contextOptions = isParticipant ? PARTICIPANT_SERVICE_TYPES : STAFF_ONBOARDING_ROLES;

  const [contextValue, setContextValue] = useState(defaultContextValue || 'all');
  const [documents, setDocuments] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [includeExtraPdfs, setIncludeExtraPdfs] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [wizardDocs, setWizardDocs] = useState(null);
  const [wizardIndex, setWizardIndex] = useState(0);
  const [adminFieldValues, setAdminFieldValues] = useState({});

  const workflow = isParticipant ? 'participant_onboarding' : 'staff_onboarding';
  const busy = sending || externalSending;
  const showExtraPdfs = extraPdfCount == null || extraPdfCount > 0;

  const loadDocuments = useCallback(
    async (ctx) => {
      setLoading(true);
      setError('');
      try {
        const params = isParticipant ? { participantServiceType: ctx } : { staffRole: ctx };
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
    },
    [isParticipant, workflow]
  );

  useEffect(() => {
    if (!active) return;
    const initial = defaultContextValue || 'all';
    setContextValue(initial);
    setIncludeExtraPdfs(false);
    loadDocuments(initial);
  }, [active, defaultContextValue, loadDocuments]);

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

  const performSend = async (adminValues) => {
    setSending(true);
    setError('');
    try {
      const payload = {
        master_ids: [...selectedIds],
        include_extra_pdfs: includeExtraPdfs,
        admin_field_values: adminValues || {}
      };
      if (isParticipant) {
        payload.participant_service_type = contextValue;
      } else {
        payload.staff_role = contextValue;
      }
      await onSend(payload);
      setWizardDocs(null);
      setWizardIndex(0);
      setAdminFieldValues({});
    } catch (err) {
      setError(err.message || 'Could not send');
    } finally {
      setSending(false);
    }
  };

  const handleSend = async () => {
    if (selectedIds.size === 0 && !(includeExtraPdfs && showExtraPdfs && (extraPdfCount == null || extraPdfCount > 0))) {
      const proceed = window.confirm(
        'No documents selected. Send the onboarding email with just the form link and no attachments?'
      );
      if (!proceed) return;
    }
    const docsNeedingInput = documents.filter((d) => selectedIds.has(d.id) && d.admin_fields?.length);
    if (docsNeedingInput.length) {
      setWizardDocs(docsNeedingInput);
      setWizardIndex(0);
      return;
    }
    await performSend({});
  };

  const handleWizardFieldChange = (docId, key, value) => {
    setAdminFieldValues((prev) => ({ ...prev, [docId]: { ...(prev[docId] || {}), [key]: value } }));
  };

  const handleWizardNext = async () => {
    if (wizardIndex < wizardDocs.length - 1) {
      setWizardIndex((i) => i + 1);
      return;
    }
    await performSend(adminFieldValues);
  };

  const handleWizardBack = () => {
    if (wizardIndex === 0) {
      setWizardDocs(null);
      return;
    }
    setWizardIndex((i) => i - 1);
  };

  const sortedDocs = useMemo(
    () => [...documents].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')),
    [documents]
  );

  const signatureDocs = useMemo(
    () => sortedDocs.filter((d) => d.requires_signature),
    [sortedDocs]
  );
  const policyDocs = useMemo(
    () => sortedDocs.filter((d) => !d.requires_signature),
    [sortedDocs]
  );

  if (!active) return null;

  if (wizardDocs) {
    return (
      <AdminFieldsWizard
        docs={wizardDocs}
        index={wizardIndex}
        values={adminFieldValues}
        onChange={handleWizardFieldChange}
        onBack={handleWizardBack}
        onNext={handleWizardNext}
        sending={busy}
      />
    );
  }

  return (
    <div>
      <p className="forms-muted" style={{ marginTop: 0 }}>
        Choose {isParticipant ? 'service type' : 'role'} and which documents to send for{' '}
        <strong>{recipientName || recipientEmail}</strong>
        {recipientEmail ? ` (${recipientEmail})` : ''}. Forms requiring signature are sent via DocuSeal;
        policies and information documents are attached as PDFs in the email.
      </p>

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem' }}>
          {isParticipant ? 'Service type' : 'Staff role'}
        </label>
        <select
          className="form-input"
          value={contextValue}
          onChange={(e) => handleContextChange(e.target.value)}
          disabled={loading || busy}
        >
          {contextOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="forms-muted" style={{ fontSize: '0.85rem', margin: '0.35rem 0 0' }}>
          Documents tagged for <strong>{contextLabel}</strong> are pre-selected. You can change any selection before
          sending.
        </p>
      </div>

      {loading ? (
        <p className="forms-muted">Loading documents…</p>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '0.5rem'
            }}
          >
            <label style={{ fontWeight: 600 }}>Documents to send</label>
            {documents.length > 0 ? (
              <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                  disabled={busy}
                />
                Select all ({documents.length})
              </label>
            ) : null}
          </div>

          {sortedDocs.length === 0 ? (
            <p className="forms-muted" style={{ marginBottom: '0.75rem' }}>
              No branded documents in the {isParticipant ? 'participant' : 'staff'} onboarding pack for your organisation.
              {automationMappingHref ? (
                <>
                  {' '}
                  Clone documents from the library under{' '}
                  <a href={automationMappingHref}>Automation mapping</a>, or include extra organisation PDFs below.
                </>
              ) : (
                ' Clone documents from the library under Automation mapping, or include extra organisation PDFs below.'
              )}
            </p>
          ) : (
            <>
              {signatureDocs.length > 0 ? (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.35rem' }}>
                    Requires signature ({signatureDocs.length})
                  </div>
                  <p className="forms-muted" style={{ fontSize: '0.82rem', margin: '0 0 0.35rem' }}>
                    Forms are sent via DocuSeal for e-signature — not as PDF attachments.
                    {isParticipant
                      ? ' Participant or guardian receives a separate signing request.'
                      : ' The staff member receives a separate signing request.'}
                  </p>
                  <DocumentChecklist
                    docs={signatureDocs}
                    selectedIds={selectedIds}
                    toggleDoc={toggleDoc}
                    sending={busy}
                    contextLabel={contextLabel}
                  />
                </div>
              ) : null}

              {policyDocs.length > 0 ? (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.35rem' }}>
                    Policies &amp; information ({policyDocs.length})
                  </div>
                  <p className="forms-muted" style={{ fontSize: '0.82rem', margin: '0 0 0.35rem' }}>
                    Attached as branded PDFs in the onboarding email (information and acknowledgement only).
                  </p>
                  <DocumentChecklist
                    docs={policyDocs}
                    selectedIds={selectedIds}
                    toggleDoc={toggleDoc}
                    sending={busy}
                    contextLabel={contextLabel}
                  />
                </div>
              ) : null}
            </>
          )}
        </>
      )}

      {showExtraPdfs ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <input
            type="checkbox"
            checked={includeExtraPdfs}
            onChange={(e) => setIncludeExtraPdfs(e.target.checked)}
            disabled={busy}
          />
          Include extra organisation PDFs
          {extraPdfCount != null ? (
            <span className="forms-muted" style={{ fontSize: '0.85rem' }}>
              ({extraPdfCount} uploaded — optional)
            </span>
          ) : (
            <span className="forms-muted" style={{ fontSize: '0.85rem' }}>
              (optional)
            </span>
          )}
        </label>
      ) : null}

      {error ? (
        <div style={{ color: '#b91c1c', fontSize: '0.9rem', marginBottom: '0.75rem' }}>{error}</div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
        {onCancel ? (
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSend}
          disabled={busy || loading}
        >
          {busy ? 'Sending…' : 'Send onboarding email'}
        </button>
      </div>
    </div>
  );
}
