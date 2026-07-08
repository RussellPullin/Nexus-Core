import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { documentLibrary, forms } from '../lib/api';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';

const CATEGORY_LABELS = {
  policy: 'Policy',
  procedure: 'Procedure',
  register: 'Register',
  contract: 'Contract',
  form: 'Form',
  guide: 'Guide'
};

const CATEGORY_ICONS = {
  policy: '📋',
  procedure: '🔧',
  register: '📊',
  contract: '📄',
  form: '✏️',
  guide: '📖'
};

const PACK_LABELS = {
  participant_onboarding: 'Participant onboarding',
  staff_onboarding: 'Staff onboarding',
  policy_library: 'Library only',
  compliance_register: 'Register template'
};

const LIBRARY_PACK_GROUPS = [
  {
    pack: 'participant_onboarding',
    title: 'Participant onboarding emails',
    lede: 'These branded library documents are automatically attached when you email a participant onboarding pack.',
    defaultExpanded: true
  },
  {
    pack: 'staff_onboarding',
    title: 'Staff onboarding emails',
    lede: 'Attached to staff onboarding emails and included in staff policy acknowledgement workflows.',
    defaultExpanded: true
  },
  {
    pack: 'policy_library',
    title: 'Library only (not auto-emailed)',
    lede: 'Available in your branded document library for manual use. Not attached to onboarding emails.',
    defaultExpanded: false
  },
  {
    pack: 'compliance_register',
    title: 'Register templates',
    lede: 'Used as templates on the Registers page — not sent in onboarding emails.',
    defaultExpanded: true
  }
];

const PARTICIPANT_SIGNING_FORMS = [
  { name: 'Service Agreement', note: 'Organisation template on Forms page' },
  { name: 'Support Plan', note: 'Generated from participant intake data' },
  { name: 'Privacy Consent', note: 'Generated from participant intake data' }
];

function PackBadge({ pack }) {
  const label = PACK_LABELS[pack] || pack || 'Unassigned';
  return (
    <span
      style={{
        fontSize: '0.7rem',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: '#475569',
        background: '#f1f5f9',
        borderRadius: 4,
        padding: '0.1rem 0.35rem',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </span>
  );
}

function CategoryBadge({ category }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.85rem', color: '#475569' }}>
      <span aria-hidden>{CATEGORY_ICONS[category] || '📄'}</span>
      {CATEGORY_LABELS[category] || category || '—'}
    </span>
  );
}

function LibraryDocTable({ docs }) {
  if (!docs.length) {
    return <p className="forms-muted" style={{ margin: 0 }}>No documents in this group.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="table-condensed forms-data-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Category</th>
            <th>Pack</th>
            <th>Signature</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => {
            const docId = doc.id || doc.slug;
            const previewUrl = documentLibrary.previewMasterUrl(docId);
            const sigCount = Number(doc.signature_count) || 0;
            return (
              <tr key={docId}>
                <td>
                  <strong style={{ fontWeight: 600, color: '#1e293b' }}>{doc.display_name || doc.name}</strong>
                </td>
                <td>
                  <CategoryBadge category={doc.category} />
                </td>
                <td>
                  <PackBadge pack={doc.pack} />
                </td>
                <td>
                  {sigCount > 0 ? (
                    <span style={{ fontSize: '0.85rem', color: '#7c3aed' }}>
                      ✍️ {sigCount} signature{sigCount === 1 ? '' : 's'}
                      {doc.required_signer_role ? ` (${doc.required_signer_role})` : ''}
                    </span>
                  ) : (
                    <span className="forms-muted">—</span>
                  )}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary btn-sm"
                    style={{ textDecoration: 'none' }}
                  >
                    Preview
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MappingSection({ title, countLabel, lede, defaultExpanded = true, children }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className="card forms-section" style={{ marginBottom: '1.25rem' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '0.75rem',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <div style={{ flex: 1 }}>
          <h2 className="forms-section-heading" style={{ marginBottom: '0.25rem' }}>
            {title}
            {countLabel ? (
              <span style={{ marginLeft: '0.5rem', fontSize: '0.85rem', fontWeight: 500, color: '#64748b' }}>
                ({countLabel})
              </span>
            ) : null}
          </h2>
          {lede ? <p className="forms-lede" style={{ marginBottom: 0 }}>{lede}</p> : null}
        </div>
        <span style={{ color: '#64748b', fontSize: '0.9rem', flexShrink: 0, marginTop: '0.15rem' }}>
          {expanded ? '▼' : '▶'}
        </span>
      </button>
      {expanded ? <div style={{ marginTop: '1rem' }}>{children}</div> : null}
    </section>
  );
}

export default function AutomationMappingPage() {
  const prefix = useProductPathPrefix();
  const [masters, setMasters] = useState([]);
  const [policyFiles, setPolicyFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [masterList, extraDocs] = await Promise.all([
        documentLibrary.listMasters(),
        forms.policyFilesList().catch(() => [])
      ]);
      const items = Array.isArray(masterList) ? masterList : (masterList?.templates || masterList?.masters || []);
      setMasters(items);
      setPolicyFiles(Array.isArray(extraDocs) ? extraDocs : []);
    } catch (e) {
      setError(e.message || 'Could not load document mapping');
      setMasters([]);
      setPolicyFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const byPack = useMemo(() => {
    const grouped = Object.fromEntries(LIBRARY_PACK_GROUPS.map((g) => [g.pack, []]));
    grouped._other = [];
    for (const doc of masters) {
      const pack = doc.pack || null;
      if (pack && grouped[pack]) grouped[pack].push(doc);
      else grouped._other.push(doc);
    }
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
    }
    return grouped;
  }, [masters]);

  const docCountLabel = (n) => `${n} document${n === 1 ? '' : 's'}`;

  return (
    <div className="forms-page">
      <div className="page-header" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div>
          <p style={{ margin: '0 0 0.35rem', fontSize: '0.85rem' }}>
            <Link to={`${prefix}/forms`} style={{ color: '#3b82f6', textDecoration: 'none' }}>
              ← Forms &amp; Documents
            </Link>
          </p>
          <h2 style={{ margin: 0 }}>Automation mapping</h2>
          <p className="forms-lede" style={{ marginTop: '0.5rem', marginBottom: 0, maxWidth: 720 }}>
            See which documents are linked to each onboarding automation. Library templates are tagged with a{' '}
            <strong>pack</strong> in their manifest — that pack controls email attachments and related workflows.
            This view is read-only; pack assignments are managed in the template library on disk.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={reload} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error ? (
        <div className="forms-banner" style={{ background: '#fef2f2', color: '#991b1b', marginBottom: '1rem' }}>
          {error}
        </div>
      ) : null}

      <section className="card forms-section" style={{ marginBottom: '1.25rem', background: '#f8fafc' }}>
        <h2 className="forms-section-heading" style={{ marginBottom: '0.5rem' }}>How automations work</h2>
        <ul className="forms-lede" style={{ margin: 0, paddingLeft: '1.25rem' }}>
          <li><strong>Participant onboarding emails</strong> — attach every library document tagged <em>participant_onboarding</em>, plus any extra organisation PDFs.</li>
          <li><strong>Staff onboarding emails</strong> — attach every document tagged <em>staff_onboarding</em>, plus the same extra organisation PDFs.</li>
          <li><strong>Library only</strong> — branded templates for reference and manual use; not auto-emailed.</li>
          <li><strong>Register templates</strong> — seed the Registers page; not part of onboarding email packs.</li>
          <li><strong>Participant signing forms</strong> — Service Agreement, Support Plan, and Privacy Consent are configured separately on the Forms page (not pack-driven).</li>
        </ul>
      </section>

      {loading ? (
        <p className="forms-muted">Loading document mapping…</p>
      ) : (
        <>
          {LIBRARY_PACK_GROUPS.map((group) => (
            <MappingSection
              key={group.pack}
              title={group.title}
              countLabel={docCountLabel(byPack[group.pack]?.length || 0)}
              lede={group.lede}
              defaultExpanded={group.defaultExpanded}
            >
              <LibraryDocTable docs={byPack[group.pack] || []} />
            </MappingSection>
          ))}

          {byPack._other.length > 0 ? (
            <MappingSection
              title="Unassigned library documents"
              countLabel={docCountLabel(byPack._other.length)}
              lede="These active library templates have no recognised pack tag."
              defaultExpanded={false}
            >
              <LibraryDocTable docs={byPack._other} />
            </MappingSection>
          ) : null}

          <MappingSection
            title="Extra organisation documents"
            countLabel={docCountLabel(policyFiles.length)}
            lede="Optional PDFs uploaded on the Forms page. Attached to both participant and staff onboarding emails alongside the branded library documents above."
            defaultExpanded
          >
            {policyFiles.length === 0 ? (
              <p className="forms-muted" style={{ margin: 0 }}>
                No extra documents uploaded.{' '}
                <Link to={`${prefix}/forms`} style={{ color: '#3b82f6' }}>Upload on Forms page</Link>
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table-condensed forms-data-table">
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Attached to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policyFiles.map((f) => (
                      <tr key={f.id}>
                        <td>{f.display_name}</td>
                        <td>Participant onboarding emails · Staff onboarding emails</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </MappingSection>

          <MappingSection
            title="Participant signing forms"
            lede="These are not controlled by library packs. Configure templates and behaviour on the Forms page."
            defaultExpanded
          >
            <div className="table-wrap">
              <table className="table-condensed forms-data-table">
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {PARTICIPANT_SIGNING_FORMS.map((form) => (
                    <tr key={form.name}>
                      <td><strong>{form.name}</strong></td>
                      <td className="forms-muted">{form.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="forms-muted" style={{ marginTop: '0.75rem', marginBottom: 0, fontSize: '0.85rem' }}>
              Manage these in the{' '}
              <Link to={`${prefix}/forms`} style={{ color: '#3b82f6' }}>Service Agreement section on Forms</Link>.
            </p>
          </MappingSection>
        </>
      )}
    </div>
  );
}
