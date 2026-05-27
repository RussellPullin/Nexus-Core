import { useState, useEffect, useCallback } from 'react';
import { forms } from '../lib/api';

function engineLabel(engine) {
  if (engine === 'nexus') return 'Nexus Core';
  if (engine === 'custom_upload') return 'Custom upload';
  return 'Uploaded template';
}

export default function OrgFormsCatalog({ onMessage }) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    forms
      .catalog()
      .then(setCatalog)
      .catch((err) => {
        setCatalog(null);
        if (onMessage) onMessage(err.message || 'Could not load forms catalog', true);
      })
      .finally(() => setLoading(false));
  }, [onMessage]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleSample = (form) => {
    if (!form.sample_ready || !form.sample_url) return;
    window.open(forms.sampleUrl(form.sample_url), '_blank', 'noopener,noreferrer');
  };

  const readiness = catalog?.org_readiness;
  const formRows = catalog?.forms || [];

  if (loading) {
    return <p className="forms-muted">Loading your forms…</p>;
  }

  if (!catalog?.organisation_id) {
    return (
      <p className="forms-muted">
        Assign your user to an organisation to manage forms and download samples with your branding.
      </p>
    );
  }

  return (
    <div className="org-forms-catalog">
      <p className="forms-lede">
        Each form below can be previewed with your organisation details. Nexus Core generates the Service Agreement with your
        logo and brand colours; other forms use sample participant data so you can check layout before onboarding.
      </p>

      {readiness && !readiness.sample_ready && (
        <div className="forms-banner" style={{ background: '#fffbeb', color: '#92400e', marginBottom: '1rem' }}>
          Complete your organisation profile (at minimum your organisation name) to enable sample downloads.
          {readiness.hints?.length ? ` ${readiness.hints[0]}` : ''}
        </div>
      )}

      {readiness?.sample_ready && !readiness.has_logo && (
        <div className="forms-banner" style={{ background: '#eff6ff', color: '#1e40af', marginBottom: '1rem' }}>
          Samples are available. Upload your logo in the Service Agreement section below to see it on Nexus-generated PDFs.
        </div>
      )}

      {formRows.length === 0 ? (
        <p className="forms-muted">No forms configured yet. Finish organisation setup or add templates below.</p>
      ) : (
        <div className="table-wrap">
          <table className="table-condensed forms-data-table">
            <thead>
              <tr>
                <th>Form</th>
                <th>Type</th>
                <th>Branding</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {formRows.map((form) => {
                const canSample = Boolean(form.sample_ready && form.sample_url);
                const statusLabel = !form.has_template_file
                  ? 'No template file'
                  : !readiness?.sample_ready
                    ? 'Org profile incomplete'
                    : 'Ready';
                return (
                  <tr key={form.catalog_key}>
                    <td>
                      <strong>{form.display_name}</strong>
                      {form.version_label ? (
                        <span className="forms-muted" style={{ display: 'block', fontSize: '0.8rem' }}>
                          {form.version_label}
                        </span>
                      ) : null}
                    </td>
                    <td className="forms-muted" style={{ fontSize: '0.85rem' }}>
                      {engineLabel(form.engine)}
                    </td>
                    <td style={{ fontSize: '0.85rem' }}>
                      {form.org_branded ? (
                        <span style={{ color: '#166534' }}>Org logo &amp; colours</span>
                      ) : (
                        <span className="forms-muted">Sample data only</span>
                      )}
                    </td>
                    <td className="forms-muted" style={{ fontSize: '0.85rem' }}>
                      {statusLabel}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!canSample}
                        title={
                          canSample
                            ? 'Download a sample PDF to check how this form looks with your organisation details'
                            : statusLabel
                        }
                        onClick={() => handleSample(form)}
                      >
                        Sample
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
