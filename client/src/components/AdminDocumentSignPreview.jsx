import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { staff as staffApi } from '../lib/api';
import SignatureCanvas from './SignatureCanvas';
import AdminFieldInput from './AdminFieldInput.jsx';

/**
 * Visual "prepare and sign" step for admin_fields before a library-master document is sent —
 * shows the actual rendered document with the org's fields overlaid at their real position
 * (signature/date/text boxes from the manifest's signing_layout, same coordinates the staff
 * signer's own SignDocumentPage.jsx renders), so the admin fills and signs in place rather than
 * through a plain form. Admin_fields with no matching signing_layout position (pure docxtemplater
 * merge tags embedded in flowing text, e.g. remuneration rate) stay a plain sidebar form, since
 * there's no meaningful page position to overlay them on.
 */

GlobalWorkerOptions.workerSrc = pdfjsWorker;

const DISPLAY_WIDTH = 700;

function scaledStyle(field, scale) {
  return {
    position: 'absolute',
    left: `${field.x * scale}px`,
    top: `${field.y * scale}px`,
    width: `${field.width * scale}px`,
    height: `${field.height * scale}px`,
    boxSizing: 'border-box'
  };
}

function PositionedFieldOverlay({ field, scale, value, onChange, onSignClick }) {
  const style = scaledStyle(field, scale);

  if (field.type === 'signature') {
    return (
      <button
        type="button"
        onClick={onSignClick}
        style={{
          ...style,
          border: `1px dashed ${value ? '#16a34a' : '#94a3b8'}`,
          background: 'rgba(255,255,255,0.85)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          padding: 0,
          cursor: 'pointer'
        }}
      >
        {value ? (
          <img src={value} alt="Signature" style={{ maxWidth: '100%', maxHeight: '100%' }} />
        ) : (
          <span style={{ fontSize: '0.7rem', color: '#475569' }}>Click to sign</span>
        )}
      </button>
    );
  }

  return (
    <input
      type={field.type === 'date' ? 'date' : 'text'}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...style, margin: 0, border: '1px solid #1d4ed8', borderRadius: 2, fontSize: '0.75rem', padding: '0 4px' }}
    />
  );
}

function DocumentPreviewPages({ pdfBytes, positionedFields, values, onFieldChange, onSignClick }) {
  const [pageCount, setPageCount] = useState(0);
  const pdfDocRef = useRef(null);
  const canvasRefs = useRef([]);

  useEffect(() => {
    let cancelled = false;
    if (!pdfBytes) return undefined;
    const loadingTask = getDocument({ data: pdfBytes.slice(0) });
    loadingTask.promise
      .then((pdf) => {
        if (cancelled) return;
        pdfDocRef.current = pdf;
        setPageCount(pdf.numPages);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      loadingTask.destroy?.();
    };
  }, [pdfBytes]);

  const scale = DISPLAY_WIDTH / 595;

  useEffect(() => {
    const pdf = pdfDocRef.current;
    if (!pdf || !pageCount) return undefined;
    let cancelled = false;
    (async () => {
      await new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < pageCount; i += 1) {
        if (cancelled) return;
        const canvas = canvasRefs.current[i];
        if (!canvas) continue;
        const page = await pdf.getPage(i + 1);
        const viewport = page.getViewport({ scale });
        const ctx = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pageCount, scale]);

  if (!pdfBytes) return null;

  return (
    <div>
      {Array.from({ length: pageCount }, (_, pageIndex) => {
        const pageNum = pageIndex + 1;
        const pageWidth = 595 * scale;
        const pageHeight = 842 * scale;
        return (
          <div
            key={pageIndex}
            style={{ position: 'relative', width: pageWidth, height: pageHeight, margin: '0 auto 1rem', boxShadow: '0 2px 10px rgba(15,23,42,0.12)', background: '#fff' }}
          >
            <canvas ref={(el) => { canvasRefs.current[pageIndex] = el; }} style={{ display: 'block', width: pageWidth, height: pageHeight }} />
            <div style={{ position: 'absolute', inset: 0 }}>
              {positionedFields
                .filter((f) => (f.page || 1) === pageNum)
                .map((f) => (
                  <PositionedFieldOverlay
                    key={f.id || f.merge_key}
                    field={f}
                    scale={scale}
                    value={values[f.merge_key]}
                    onChange={(v) => onFieldChange(f.merge_key, v)}
                    onSignClick={() => onSignClick(f)}
                  />
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function AdminDocumentSignPreview({ staffId, docs, index, values, onChange, onBack, onNext, sending }) {
  const doc = docs[index];
  const docValues = values[doc?.id] || {};

  const [orgFields, setOrgFields] = useState([]);
  const [pdfBytes, setPdfBytes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signingField, setSigningField] = useState(null);
  const signatureCanvasRef = useRef(null);

  const loadPreview = useCallback(
    async (fieldValues) => {
      if (!doc) return;
      setLoading(true);
      setError('');
      try {
        const buf = await staffApi.previewOnboardingDocument(staffId, doc.id, fieldValues);
        setPdfBytes(new Uint8Array(buf));
      } catch (err) {
        setError(err.message || 'Could not render preview');
      } finally {
        setLoading(false);
      }
    },
    [staffId, doc?.id]
  );

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    setPdfBytes(null);
    staffApi
      .getOnboardingOrgFields(staffId, doc.id)
      .then((res) => {
        if (!cancelled) setOrgFields(res?.fields || []);
      })
      .catch(() => {
        if (!cancelled) setOrgFields([]);
      });
    loadPreview(docValues);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id]);

  if (!doc) return null;

  const positionedKeys = new Set(orgFields.map((f) => f.merge_key));
  const plainFields = (doc.admin_fields || []).filter((f) => !positionedKeys.has(f.key));
  const positionedAdminFields = orgFields.filter((f) => (doc.admin_fields || []).some((af) => af.key === f.merge_key));

  const allRequiredKeys = [
    ...plainFields.filter((f) => f.required).map((f) => f.key),
    ...positionedAdminFields.filter((f) => f.required).map((f) => f.merge_key)
  ];
  const missingRequired = allRequiredKeys.some((key) => !String(docValues[key] || '').trim());

  const handlePlainChange = (key, value) => {
    onChange(doc.id, key, value);
  };

  const handlePositionedChange = (key, value) => {
    onChange(doc.id, key, value);
  };

  const openSignModal = (field) => {
    setSigningField(field);
  };

  const saveSignature = () => {
    const dataUrl = signatureCanvasRef.current?.getDataUrl();
    if (!dataUrl) return;
    onChange(doc.id, signingField.merge_key, dataUrl);
    setSigningField(null);
  };

  return (
    <div>
      <p className="forms-muted" style={{ marginTop: 0 }}>
        Prepare document {index + 1} of {docs.length} before it's sent to the staff member — fill in your part and
        sign directly on the document below.
      </p>

      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {plainFields.length > 0 ? (
          <div style={{ flex: '0 0 260px', border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.75rem 1rem' }}>
            <h4 style={{ marginTop: 0 }}>{doc.display_name}</h4>
            {plainFields.map((f) => (
              <label key={f.key} className="forms-label" style={{ display: 'block', marginBottom: '0.5rem' }}>
                {f.label}{f.required ? ' *' : ''}
                <AdminFieldInput field={f} value={docValues[f.key]} onChange={(v) => handlePlainChange(f.key, v)} />
              </label>
            ))}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => loadPreview(docValues)}
              disabled={loading}
              style={{ marginTop: '0.25rem' }}
            >
              {loading ? 'Updating…' : 'Update preview'}
            </button>
          </div>
        ) : null}

        <div style={{ flex: '1 1 auto', minWidth: 320 }}>
          {error ? (
            <div style={{ color: '#b91c1c', fontSize: '0.9rem', marginBottom: '0.75rem' }}>{error}</div>
          ) : null}
          {loading && !pdfBytes ? <p className="forms-muted">Rendering document…</p> : null}
          <DocumentPreviewPages
            pdfBytes={pdfBytes}
            positionedFields={positionedAdminFields}
            values={docValues}
            onFieldChange={handlePositionedChange}
            onSignClick={openSignModal}
          />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={sending}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onNext} disabled={sending || missingRequired}>
          {sending ? 'Sending…' : index === docs.length - 1 ? 'Send onboarding email' : 'Next'}
        </button>
      </div>

      {signingField ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'grid', placeItems: 'center', padding: '1rem', zIndex: 50 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '1.5rem', maxWidth: 380, width: '100%' }}>
            <h3 style={{ marginTop: 0 }}>{signingField.label || 'Sign'}</h3>
            <SignatureCanvas ref={signatureCanvasRef} width={300} height={120} />
            <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'space-between', marginTop: '1rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => signatureCanvasRef.current?.clear()}>
                Clear
              </button>
              <div style={{ display: 'flex', gap: '.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setSigningField(null)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={saveSignature}>
                  Save signature
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
