import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { signingPublic } from '../lib/api';
import SignatureCanvas from '../components/SignatureCanvas';

/**
 * Native e-signature: public signer page. Token-authenticated, no login required.
 * One shared signature drawing per signer, reused across every signature field they own
 * (the server stores one signature_data value per signer, not per field) — date/checkbox
 * fields remain per-field. Modeled on IntakePage.jsx's token/autosave structure and
 * ActivityRiskAssessmentEditor.jsx's pdfjs-dist page-rendering approach.
 */

GlobalWorkerOptions.workerSrc = pdfjsWorker;

const DISPLAY_WIDTH = 700;

function scaledFieldStyle(field, scale) {
  return {
    position: 'absolute',
    left: `${field.x * scale}px`,
    top: `${field.y * scale}px`,
    width: `${field.width * scale}px`,
    height: `${field.height * scale}px`,
    boxSizing: 'border-box'
  };
}

function FieldOverlay({ field, scale, value, signatureDataUrl, onChange }) {
  const style = scaledFieldStyle(field, scale);

  if (field.type === 'signature') {
    return (
      <div
        style={{
          ...style,
          border: `1px dashed ${signatureDataUrl ? '#16a34a' : '#94a3b8'}`,
          background: 'rgba(255,255,255,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden'
        }}
      >
        {signatureDataUrl ? (
          <img src={signatureDataUrl} alt="Your signature" style={{ maxWidth: '100%', maxHeight: '100%' }} />
        ) : (
          <span style={{ fontSize: '0.7rem', color: '#64748b' }}>Sign below</span>
        )}
      </div>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
        style={{ ...style, margin: 0, cursor: 'pointer', width: Math.min(field.width * scale, 20), height: Math.min(field.height * scale, 20) }}
      />
    );
  }

  if (field.type === 'text') {
    return (
      <input
        type="text"
        value={value || ''}
        placeholder={field.label || ''}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...style, margin: 0, border: '1px solid #1d4ed8', borderRadius: 2, fontSize: '0.75rem', padding: '0 2px' }}
      />
    );
  }

  // date
  return (
    <input
      type="date"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...style, margin: 0, border: '1px solid #1d4ed8', borderRadius: 2, fontSize: '0.75rem', padding: '0 2px' }}
    />
  );
}

function DocumentPages({ doc, scale, values, onFieldChange, signatureDataUrl, tokenUrl }) {
  const [pageCount, setPageCount] = useState(0);
  const pdfDocRef = useRef(null);
  const canvasRefs = useRef([]);

  useEffect(() => {
    let cancelled = false;
    const loadingTask = getDocument({ url: tokenUrl });
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
  }, [tokenUrl]);

  useEffect(() => {
    const pdf = pdfDocRef.current;
    if (!pdf || !pageCount) return;
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

  const pageWidth = (doc.page_width || 595) * scale;
  const pageHeight = (doc.page_height || 842) * scale;

  return (
    <div style={{ marginBottom: '2rem' }}>
      <h3 style={{ fontSize: '1rem', color: '#1e293b', marginBottom: '0.75rem' }}>{doc.display_name}</h3>
      {Array.from({ length: pageCount }, (_, pageIndex) => (
        <div
          key={pageIndex}
          style={{ position: 'relative', width: pageWidth, height: pageHeight, margin: '0 auto 1rem', boxShadow: '0 2px 10px rgba(15,23,42,0.12)', background: '#fff' }}
        >
          <canvas ref={(el) => { canvasRefs.current[pageIndex] = el; }} style={{ display: 'block', width: pageWidth, height: pageHeight }} />
          <div style={{ position: 'absolute', inset: 0 }}>
            {(doc.fields || [])
              .filter((f) => (f.page || 1) - 1 === pageIndex)
              .map((f) => (
                <FieldOverlay
                  key={f.id || f.merge_key}
                  field={f}
                  scale={scale}
                  value={values[f.merge_key]}
                  signatureDataUrl={signatureDataUrl}
                  onChange={(v) => onFieldChange(f, v)}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SignDocumentPage() {
  const { token } = useParams();
  const [pageState, setPageState] = useState({ loading: true, error: '' });
  const [data, setData] = useState(null);
  const [values, setValues] = useState({});
  const [signatureDataUrl, setSignatureDataUrl] = useState(null);
  const [consentGiven, setConsentGiven] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);
  const [formError, setFormError] = useState('');
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declining, setDeclining] = useState(false);

  const signatureCanvasRef = useRef(null);
  const debouncers = useRef({});

  useEffect(() => {
    let cancelled = false;
    signingPublic
      .load(token)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setValues(res?.saved_values || {});
        setSignatureDataUrl(res?.saved_signature_data || null);
        setPageState({ loading: false, error: '' });
      })
      .catch((err) => {
        if (cancelled) return;
        setPageState({ loading: false, error: err.message, code: err.code });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const persist = useCallback((patch) => {
    signingPublic.save(token, patch).catch(() => {});
  }, [token]);

  const handleFieldChange = (field, value) => {
    setValues((v) => {
      const next = { ...v, [field.merge_key]: value };
      clearTimeout(debouncers.current.values);
      debouncers.current.values = setTimeout(() => persist({ values: next }), 600);
      return next;
    });
  };

  const captureSignature = () => {
    const dataUrl = signatureCanvasRef.current?.getDataUrl();
    if (!dataUrl) return;
    setSignatureDataUrl(dataUrl);
    clearTimeout(debouncers.current.signature);
    debouncers.current.signature = setTimeout(() => persist({ signature_data: dataUrl }), 600);
  };

  const clearSignature = () => {
    signatureCanvasRef.current?.clear();
    setSignatureDataUrl(null);
  };

  const hasSignatureField = (data?.documents || []).some((d) => (d.fields || []).some((f) => f.type === 'signature'));

  const validate = () => {
    if (!consentGiven) return 'You must consent to sign this document electronically before submitting.';
    for (const doc of data?.documents || []) {
      for (const f of doc.fields || []) {
        if (!f.required) continue;
        if (f.type === 'signature' && !signatureDataUrl) return 'Please draw your signature before submitting.';
        if (f.type !== 'signature' && !values[f.merge_key]) return `Please complete: ${f.label || f.merge_key}`;
      }
    }
    return '';
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError('');
    setSubmitting(true);
    try {
      const res = await signingPublic.submit(token, { values, signature_data: signatureDataUrl, consent_given: true });
      setSubmitResult(res);
    } catch (e) {
      setFormError(e.message || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecline = async () => {
    setDeclining(true);
    try {
      await signingPublic.decline(token, declineReason);
      setSubmitResult({ completed: false, declined: true });
    } catch (e) {
      setFormError(e.message || 'Could not submit decline. Please try again.');
    } finally {
      setDeclining(false);
    }
  };

  if (pageState.loading) {
    return (
      <div style={centerStyle}>
        <p style={{ color: '#64748b' }}>Loading your document…</p>
      </div>
    );
  }

  if (pageState.error) {
    return (
      <div style={{ ...centerStyle, padding: '2rem' }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <h2 style={{ color: '#b91c1c' }}>This link cannot be opened</h2>
          <p style={{ color: '#475569' }}>{pageState.error}</p>
        </div>
      </div>
    );
  }

  if (data?.terminal) {
    return (
      <div style={{ ...centerStyle, padding: '2rem' }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <h2 style={{ color: data.status === 'declined' ? '#b91c1c' : '#15803d' }}>
            {data.status === 'declined' ? 'This document was declined' : 'This document has already been signed'}
          </h2>
        </div>
      </div>
    );
  }

  if (data?.waiting) {
    return (
      <div style={{ ...centerStyle, padding: '2rem' }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <h2 style={{ color: '#1e293b' }}>Not your turn yet</h2>
          <p style={{ color: '#475569' }}>Another signer needs to sign this document first. We'll email you as soon as it's your turn.</p>
        </div>
      </div>
    );
  }

  if (submitResult?.declined) {
    return (
      <div style={{ ...centerStyle, padding: '2rem', background: '#f8fafc', minHeight: '100vh' }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <h2 style={{ color: '#b91c1c' }}>Declined</h2>
          <p style={{ color: '#475569' }}>You've declined to sign this document. The organisation has been notified.</p>
        </div>
      </div>
    );
  }

  if (submitResult) {
    return (
      <div style={{ ...centerStyle, padding: '2rem', background: '#f8fafc', minHeight: '100vh' }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: '3.5rem', marginBottom: '0.75rem' }}>✅</div>
          <h2 style={{ color: '#15803d', marginTop: 0 }}>Thank you!</h2>
          <p style={{ color: '#334155', lineHeight: 1.6 }}>
            {submitResult.completed
              ? 'Your signature has been recorded and this document is now complete.'
              : "Your signature has been recorded. We've notified the next signer."}
          </p>
        </div>
      </div>
    );
  }

  const branding = data?.organisation || null;
  const primary = branding?.primary_color || '#1d4ed8';
  const scale = DISPLAY_WIDTH / (data?.documents?.[0]?.page_width || 595);

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      <header style={{ background: primary, color: '#fff', padding: '1.2rem 1.5rem' }}>
        <div style={{ maxWidth: DISPLAY_WIDTH, margin: '0 auto' }}>
          <div style={{ fontSize: '.8rem', opacity: 0.85, marginBottom: '.2rem' }}>{branding?.name || 'Document signing'}</div>
          <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 700 }}>Please review and sign</h1>
        </div>
      </header>

      <main style={{ maxWidth: DISPLAY_WIDTH, margin: '0 auto', padding: '1.5rem 1rem 3rem' }}>
        {(data?.documents || []).map((doc) => (
          <DocumentPages
            key={doc.id}
            doc={doc}
            scale={scale}
            values={values}
            onFieldChange={handleFieldChange}
            signatureDataUrl={signatureDataUrl}
            tokenUrl={signingPublic.documentUrl(token, doc.id)}
          />
        ))}

        {hasSignatureField && (
          <div style={{ background: '#fff', borderRadius: 12, padding: '1.2rem', boxShadow: '0 1px 4px rgba(15,23,42,.08)', marginBottom: '1.25rem' }}>
            <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Your signature</h3>
            <div onMouseUp={captureSignature} onTouchEnd={captureSignature}>
              <SignatureCanvas ref={signatureCanvasRef} width={300} height={120} />
            </div>
            <div style={{ marginTop: '0.5rem' }}>
              <button type="button" onClick={clearSignature} style={secondaryBtn}>Clear</button>
            </div>
          </div>
        )}

        <div style={{ background: '#fff', borderRadius: 12, padding: '1.2rem', boxShadow: '0 1px 4px rgba(15,23,42,.08)', marginBottom: '1.25rem' }}>
          <label style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', cursor: 'pointer', fontSize: '.9rem', color: '#334155', lineHeight: 1.5 }}>
            <input
              type="checkbox"
              checked={consentGiven}
              onChange={(e) => setConsentGiven(e.target.checked)}
              style={{ width: 18, height: 18, flexShrink: 0, marginTop: 2 }}
            />
            <span>I consent to sign this document electronically, and confirm the information above is accurate.</span>
          </label>
        </div>

        {formError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 8, padding: '.65rem 1rem', marginBottom: '1rem', fontSize: '.88rem' }}>
            {formError}
          </div>
        )}

        <div style={{ display: 'flex', gap: '.75rem', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setDeclineOpen(true)} style={secondaryBtn}>
            I can't sign this
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            style={{ ...primaryBtn, background: primary, borderColor: primary, opacity: submitting ? 0.7 : 1 }}
          >
            {submitting ? 'Submitting…' : 'Sign and submit ✓'}
          </button>
        </div>

        {declineOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'grid', placeItems: 'center', padding: '1rem' }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: '1.5rem', maxWidth: 420, width: '100%' }}>
              <h3 style={{ marginTop: 0 }}>Decline to sign</h3>
              <p style={{ color: '#64748b', fontSize: '.88rem' }}>Let the organisation know why. This can't be undone.</p>
              <textarea
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                rows={3}
                placeholder="Reason (optional)"
                style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 6, padding: '.5rem', fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
                <button type="button" onClick={() => setDeclineOpen(false)} style={secondaryBtn}>Cancel</button>
                <button
                  type="button"
                  onClick={handleDecline}
                  disabled={declining}
                  style={{ ...primaryBtn, background: '#b91c1c', borderColor: '#b91c1c', opacity: declining ? 0.7 : 1 }}
                >
                  {declining ? 'Submitting…' : 'Confirm decline'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const centerStyle = { minHeight: '100vh', display: 'grid', placeItems: 'center' };

const primaryBtn = {
  padding: '.65rem 1.5rem',
  borderRadius: 8,
  color: '#fff',
  border: '2px solid transparent',
  fontSize: '.95rem',
  fontWeight: 600,
  cursor: 'pointer',
  background: '#1d4ed8'
};

const secondaryBtn = {
  padding: '.65rem 1.2rem',
  borderRadius: 8,
  color: '#475569',
  border: '1px solid #cbd5e1',
  fontSize: '.95rem',
  cursor: 'pointer',
  background: '#fff'
};
