import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { forms, documentLibrary, participants } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import ActivityRiskAssessmentsPanel from '../components/ActivityRiskAssessmentsPanel';

const CATEGORY_LABELS = {
  policy:    'Policy',
  procedure: 'Procedure',
  register:  'Register',
  contract:  'Contract',
  form:      'Form',
  guide:     'Guide',
};

function libraryUseKind(doc) {
  const signatureCount = Number(doc?.signature_count) || 0;
  if (signatureCount > 0 || doc?.category === 'form') return 'use';
  return 'send';
}

function libraryUseHint(doc) {
  const kind = libraryUseKind(doc);
  if (kind === 'use' && Number(doc?.signature_count) > 0) {
    return 'Sends this form to the participant to sign.';
  }
  if (kind === 'use') return 'Emails this form, filled in for the participant.';
  if (doc?.category === 'policy') return 'Emails this policy to the participant.';
  return 'Emails this document to the participant.';
}

export default function FormsPage() {
  const { isAdmin } = useAuth();
  const prefix = useProductPathPrefix();

  const [message, setMessage] = useState('');

  // Document Library (NDIS templates)
  const [libraryTemplates, setLibraryTemplates] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryCategoryFilter, setLibraryCategoryFilter] = useState('');
  const [activeDoc, setActiveDoc] = useState(null);
  const [participantOptions, setParticipantOptions] = useState([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantQuery, setParticipantQuery] = useState('');
  const [selectedParticipantId, setSelectedParticipantId] = useState('');
  const [usingDoc, setUsingDoc] = useState(false);

  // Extra organisation documents (escape hatch)
  const [policyFiles, setPolicyFiles] = useState([]);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyDisplayName, setPolicyDisplayName] = useState('');
  const [policyFile, setPolicyFile] = useState(null);

  // ── Load ────────────────────────────────────────────────────────────────

  const reloadPolicyFiles = useCallback(() => {
    forms.policyFilesList().then((list) => setPolicyFiles(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  const reloadLibrary = useCallback(() => {
    setLibraryLoading(true);
    documentLibrary
      .listMasters()
      .then((res) => {
        const items = Array.isArray(res) ? res : (res?.templates || res?.masters || []);
        setLibraryTemplates(items);
      })
      .catch(() => setLibraryTemplates([]))
      .finally(() => setLibraryLoading(false));
  }, []);

  useEffect(() => {
    reloadPolicyFiles();
  }, [reloadPolicyFiles]);

  // ── Extra document handlers ──────────────────────────────────────────────

  const handlePolicyUpload = async (e) => {
    e.preventDefault();
    if (!policyFile) { setMessage('Choose a PDF to upload.'); return; }
    setPolicyBusy(true);
    setMessage('');
    try {
      await forms.policyFilesUpload(policyFile, policyDisplayName.trim() || undefined);
      setPolicyFile(null);
      setPolicyDisplayName('');
      setMessage('Document uploaded.');
      reloadPolicyFiles();
    } catch (err) {
      setMessage(err.message || 'Upload failed');
    } finally {
      setPolicyBusy(false);
    }
  };

  const openDocument = (doc) => {
    setActiveDoc(doc);
    setParticipantQuery('');
    setSelectedParticipantId('');
    setMessage('');
    if (participantOptions.length > 0) return;
    setParticipantsLoading(true);
    participants
      .list()
      .then((list) => {
        const rows = Array.isArray(list) ? list : [];
        setParticipantOptions(rows.map((p) => ({
          id: p.id,
          name: p.name || 'Unnamed participant',
          email: p.email || ''
        })));
      })
      .catch(() => setParticipantOptions([]))
      .finally(() => setParticipantsLoading(false));
  };

  const closeDocument = () => {
    if (usingDoc) return;
    setActiveDoc(null);
  };

  const handleUseDocument = async () => {
    if (!activeDoc) return;
    const participant = participantOptions.find((p) => p.id === selectedParticipantId);
    if (!participant) {
      setMessage('Choose a participant.');
      return;
    }
    if (!participant.email) {
      setMessage('This participant has no email address.');
      return;
    }
    const docId = activeDoc.id || activeDoc.slug;
    const kind = libraryUseKind(activeDoc);
    setUsingDoc(true);
    setMessage('');
    try {
      await documentLibrary.useForParticipant(docId, participant.id);
      const name = activeDoc.display_name || activeDoc.name;
      setMessage(
        kind === 'use'
          ? `Sent “${name}” to ${participant.name} to complete.`
          : `Sent “${name}” to ${participant.name}.`
      );
      setActiveDoc(null);
    } catch (err) {
      setMessage(err.message || 'Could not send this document');
    } finally {
      setUsingDoc(false);
    }
  };

  const handlePolicyDelete = async (policyId, label) => {
    if (!confirm(`Remove document "${label}"?`)) return;
    setPolicyBusy(true);
    setMessage('');
    try {
      await forms.policyFilesDelete(policyId);
      setMessage('Document removed.');
      reloadPolicyFiles();
    } catch (err) {
      setMessage(err.message || 'Delete failed');
    } finally {
      setPolicyBusy(false);
    }
  };

  // ── Derived ──────────────────────────────────────────────────────────────

  const bannerIsError = (message || '').toLowerCase().includes('fail') || (message || '').toLowerCase().includes('could not');
  const libraryCategories = Array.from(new Set((libraryTemplates || []).map((t) => t.category).filter(Boolean))).sort();
  const filteredLibrary = libraryCategoryFilter
    ? (libraryTemplates || []).filter((t) => t.category === libraryCategoryFilter)
    : libraryTemplates;
  const participantMatches = participantQuery.trim()
    ? participantOptions.filter((p) => {
        const q = participantQuery.trim().toLowerCase();
        return p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
      })
    : participantOptions;
  const selectedParticipant = participantOptions.find((p) => p.id === selectedParticipantId) || null;
  const activeKind = activeDoc ? libraryUseKind(activeDoc) : 'send';
  const activeDocId = activeDoc ? (activeDoc.id || activeDoc.slug) : '';

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="forms-page">
      <div className="page-header">
        <h2>Forms &amp; Documents</h2>
      </div>

      {message && (
        <div
          className="forms-banner"
          style={{
            background: bannerIsError ? '#fef2f2' : '#f0fdf4',
            color: bannerIsError ? '#991b1b' : '#166534',
            marginBottom: '1rem'
          }}
        >
          {message}
          <button
            type="button"
            style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.7 }}
            onClick={() => setMessage('')}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── 1. Activity Risk Assessments ─────────────────────────────────── */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Activity risk assessments</h2>
        <ActivityRiskAssessmentsPanel onMessage={(msg) => setMessage(msg)} />
      </section>

      {/* ── 2. NDIS Document Library (collapsed until an admin opens it) ── */}
      <details
        className="card forms-section settings-collapsible"
        style={{ marginBottom: '1.25rem' }}
        onToggle={(e) => {
          if (!isAdmin) {
            e.currentTarget.open = false;
            return;
          }
          if (e.currentTarget.open && libraryTemplates.length === 0) reloadLibrary();
        }}
      >
        <summary className="settings-collapsible-summary">
          <span className="settings-collapsible-summary-main">
            <span className="forms-section-heading settings-collapsible-title" style={{ marginBottom: 0 }}>
              NDIS document library
            </span>
            <span className="forms-lede settings-collapsible-hint" style={{ marginBottom: 0 }}>
              {isAdmin
                ? (libraryTemplates.length
                    ? `${libraryTemplates.length} documents — open one to use it for a participant, or send it if it is a policy`
                    : 'Policies, procedures, registers, contracts, and guides. Open to browse.')
                : 'Admin only — ask an organisation admin to open the library.'}
            </span>
          </span>
        </summary>
        <div className="settings-collapsible-body">
        <div className="forms-row" style={{ justifyContent: 'flex-end', marginBottom: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
            <Link
              to={`${prefix}/forms/automation-mapping`}
              className="btn btn-secondary btn-sm"
              style={{ textDecoration: 'none' }}
            >
              View automation mapping
            </Link>
            <select
              className="form-input"
              style={{ maxWidth: 180 }}
              value={libraryCategoryFilter}
              onChange={(e) => setLibraryCategoryFilter(e.target.value)}
            >
              <option value="">All types</option>
              {libraryCategories.map((cat) => (
                <option key={cat} value={cat}>{CATEGORY_LABELS[cat] || cat}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={reloadLibrary}
              disabled={libraryLoading}
            >
              {libraryLoading ? 'Loading…' : '↻'}
            </button>
          </div>
        </div>

        {libraryLoading ? (
          <p className="forms-muted">Loading document library…</p>
        ) : filteredLibrary.length === 0 ? (
          <p className="forms-muted">No documents found. {libraryTemplates.length === 0 ? 'Check the server has synced templates.' : 'Try a different category filter.'}</p>
        ) : (
          <div className="library-doc-grid">
            {filteredLibrary.map((doc) => {
              const docId = doc.id || doc.slug;
              const kind = libraryUseKind(doc);
              return (
                <button
                  key={docId}
                  type="button"
                  className="library-doc-card"
                  onClick={() => openDocument(doc)}
                  title={`${doc.display_name || doc.name} — ${kind === 'use' ? 'use for a participant' : 'send'}`}
                >
                  <span className="library-doc-card-kind">
                    {CATEGORY_LABELS[doc.category] || doc.category || 'Document'}
                  </span>
                  <span className="library-doc-card-name">{doc.display_name || doc.name}</span>
                  <span className="library-doc-card-action">{kind === 'use' ? 'Use for participant' : 'Send'}</span>
                </button>
              );
            })}
          </div>
        )}

        {!libraryLoading && filteredLibrary.length > 0 && (
          <p className="forms-muted" style={{ marginTop: '0.75rem', fontSize: '0.82rem' }}>
            Showing {filteredLibrary.length} of {libraryTemplates.length} documents.
            {libraryCategoryFilter && (
              <button
                type="button"
                style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '0.82rem', padding: '0 0.25rem' }}
                onClick={() => setLibraryCategoryFilter('')}
              >
                Clear filter
              </button>
            )}
          </p>
        )}
        </div>
      </details>

      {/* ── 4. Extra organisation documents (escape hatch) ───────────────── */}
      <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
        <h2 className="forms-section-heading">Extra organisation documents</h2>
        <p className="forms-lede">
          Optional. Upload your own PDFs to attach to staff and participant onboarding emails alongside the branded
          NDIS library documents above. Most organisations don't need this.
        </p>

        <form onSubmit={handlePolicyUpload} className="forms-add-row" style={{ marginBottom: '1rem' }}>
          <input
            type="text"
            className="form-input"
            placeholder="Display name (optional)"
            value={policyDisplayName}
            onChange={(e) => setPolicyDisplayName(e.target.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <input type="file" accept=".pdf" onChange={(e) => setPolicyFile(e.target.files?.[0] || null)} />
          <button type="submit" className="btn btn-primary" disabled={policyBusy || !policyFile}>
            {policyBusy ? 'Uploading…' : 'Upload PDF'}
          </button>
        </form>

        {policyFiles.length > 0 ? (
          <div className="table-wrap">
            <table className="table-condensed forms-data-table">
              <thead>
                <tr><th>Name</th><th></th></tr>
              </thead>
              <tbody>
                {policyFiles.map((f) => (
                  <tr key={f.id}>
                    <td>{f.display_name}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ color: '#b91c1c' }}
                        disabled={policyBusy}
                        onClick={() => handlePolicyDelete(f.id, f.display_name)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="forms-muted" style={{ fontSize: '0.85rem' }}>No extra documents uploaded.</p>
        )}
      </section>

      {activeDoc && (
        <div className="modal-overlay" onClick={closeDocument}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 980, width: '94vw' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-doc-title"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <div>
                <span className="library-doc-card-kind">
                  {CATEGORY_LABELS[activeDoc.category] || activeDoc.category || 'Document'}
                </span>
                <h3 id="library-doc-title" style={{ margin: '0.35rem 0 0.25rem' }}>
                  {activeDoc.display_name || activeDoc.name}
                </h3>
                <p className="forms-muted" style={{ margin: 0 }}>{libraryUseHint(activeDoc)}</p>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={closeDocument} disabled={usingDoc}>
                Close
              </button>
            </div>

            <div className="library-use-layout">
              <div>
                <label className="forms-label" style={{ display: 'block' }}>
                  Participant
                  <input
                    type="search"
                    className="form-input"
                    placeholder="Search name or email"
                    value={participantQuery}
                    onChange={(e) => setParticipantQuery(e.target.value)}
                    style={{ marginTop: '0.35rem' }}
                    disabled={usingDoc}
                  />
                </label>
                <select
                  className="form-input"
                  size={8}
                  value={selectedParticipantId}
                  onChange={(e) => setSelectedParticipantId(e.target.value)}
                  disabled={usingDoc || participantsLoading}
                  style={{ width: '100%', marginTop: '0.4rem' }}
                >
                  {participantsLoading ? (
                    <option value="">Loading participants…</option>
                  ) : participantMatches.length === 0 ? (
                    <option value="">No participants found</option>
                  ) : (
                    participantMatches.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.email ? '' : ' (no email)'}
                      </option>
                    ))
                  )}
                </select>
                {selectedParticipant && (
                  <p className="forms-muted" style={{ margin: '0.4rem 0 0.6rem', fontSize: '0.8rem' }}>
                    {selectedParticipant.email || 'No email on file — add one before sending.'}
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginTop: '0.6rem', width: '100%' }}
                  disabled={usingDoc || !selectedParticipantId || !selectedParticipant?.email}
                  onClick={handleUseDocument}
                >
                  {usingDoc
                    ? 'Sending…'
                    : activeKind === 'use'
                      ? 'Use for participant'
                      : 'Send'}
                </button>
              </div>
              <iframe
                className="library-use-preview"
                title={`Preview of ${activeDoc.display_name || activeDoc.name}`}
                src={documentLibrary.previewMasterUrl(activeDocId, {
                  participantId: selectedParticipantId || undefined
                })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
