import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { activityRiskAssessments } from '../lib/api';

GlobalWorkerOptions.workerSrc = pdfjsWorker;

const SIGN_OFF_FIELD_PREFIXES = ['pre_activity_', 'post_activity_'];
const SIGN_OFF_EXTRA_FIELDS = new Set(['consent_yes', 'consent_na']);

function isSignOffField(name) {
  const key = String(name || '');
  if (SIGN_OFF_EXTRA_FIELDS.has(key)) return true;
  return SIGN_OFF_FIELD_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const PAGE_WIDTH_PT = 595.28;
const PAGE_HEIGHT_PT = 841.89;
const DISPLAY_WIDTH = 820;

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

function PdfFieldInput({ field, scale, value, onChange }) {
  const baseStyle = scaledFieldStyle(field, scale);
  const fontSize = Math.max(8, Math.min(12, 7.5 * scale * 0.92));

  if (field.type === 'checkbox') {
    const size = Math.max(10, Math.min(field.height * scale, 16));
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(field.name, e.target.checked)}
        title={field.name}
        style={{
          ...baseStyle,
          margin: 0,
          width: `${size}px`,
          height: `${size}px`,
          cursor: 'pointer',
          accentColor: '#1A7A6E'
        }}
      />
    );
  }

  const shared = {
    ...baseStyle,
    margin: 0,
    padding: '1px 2px',
    border: '1px solid rgba(26, 122, 110, 0.55)',
    borderRadius: '1px',
    background: 'rgba(255, 255, 255, 0.88)',
    fontSize: `${fontSize}px`,
    lineHeight: 1.2,
    fontFamily: 'Helvetica, Arial, sans-serif',
    color: '#1C1C1C',
    outline: 'none'
  };

  if (field.type === 'textarea') {
    return (
      <textarea
        value={value ?? ''}
        onChange={(e) => onChange(field.name, e.target.value)}
        title={field.name}
        style={{
          ...shared,
          resize: 'none',
          overflow: 'auto'
        }}
      />
    );
  }

  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(field.name, e.target.value)}
      title={field.name}
      style={shared}
    />
  );
}

function PdfFormPage({ pageIndex, scale, fields, values, onFieldChange, canvasRef }) {
  const pageFields = fields.filter((f) => f.pageIndex === pageIndex);

  return (
    <div
      style={{
        position: 'relative',
        width: `${PAGE_WIDTH_PT * scale}px`,
        height: `${PAGE_HEIGHT_PT * scale}px`,
        margin: '0 auto 1.25rem',
        boxShadow: '0 4px 18px rgba(15, 23, 42, 0.12)',
        background: '#fff'
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: `${PAGE_WIDTH_PT * scale}px`,
          height: `${PAGE_HEIGHT_PT * scale}px`
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none'
        }}
      >
        {pageFields.map((field) => (
          <div key={field.name} style={{ pointerEvents: 'auto' }}>
            <PdfFieldInput field={field} scale={scale} value={values[field.name]} onChange={onFieldChange} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ActivityRiskAssessmentEditor({ recordId, onClose, onSaved }) {
  const [title, setTitle] = useState('');
  const [values, setValues] = useState({});
  const [schema, setSchema] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pdfLoading, setPdfLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(DISPLAY_WIDTH / PAGE_WIDTH_PT);

  const pdfDocRef = useRef(null);
  const canvasRefs = useRef([]);

  const setFieldValue = useCallback((name, value) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([activityRiskAssessments.getRecord(recordId), activityRiskAssessments.fieldSchema()])
      .then(([record, schemaRes]) => {
        if (cancelled) return;
        setTitle(record?.title || '');
        setValues(record?.field_values && typeof record.field_values === 'object' ? record.field_values : {});
        setSchema(
          (Array.isArray(schemaRes?.fields) ? schemaRes.fields : []).filter(
            (f) => !isSignOffField(f.name)
          )
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Could not load risk assessment.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  useEffect(() => {
    let cancelled = false;
    setPdfLoading(true);
    const loadingTask = getDocument({
      url: activityRiskAssessments.masterFileUrl(),
      withCredentials: true
    });
    loadingTask.promise
      .then((pdf) => {
        if (cancelled) return;
        pdfDocRef.current = pdf;
        setPageCount(pdf.numPages);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Could not load PDF layout.');
      })
      .finally(() => {
        if (!cancelled) setPdfLoading(false);
      });
    return () => {
      cancelled = true;
      loadingTask.destroy?.();
    };
  }, []);

  const pageIndexes = useMemo(() => Array.from({ length: pageCount }, (_, i) => i), [pageCount]);

  useEffect(() => {
    const pdf = pdfDocRef.current;
    if (!pdf || pdfLoading || !pageCount) return;

    let cancelled = false;
    (async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
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
    })().catch((e) => {
      if (!cancelled) setError(e.message || 'Could not render PDF pages.');
    });

    return () => {
      cancelled = true;
    };
  }, [pdfLoading, pageCount, scale, schema.length]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await activityRiskAssessments.updateRecord(recordId, { title: title.trim(), field_values: values });
      setSavedAt(new Date().toLocaleTimeString());
      if (onSaved) onSaved();
    } catch (e) {
      setError(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const busy = loading || pdfLoading;

  return (
    <div
      className="modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem'
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          width: 'min(980px, 100%)',
          maxHeight: '94vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          margin: 0
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '1rem',
            alignItems: 'flex-start',
            marginBottom: '0.75rem'
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>Complete risk assessment</h3>
            <p className="forms-muted" style={{ margin: '0.35rem 0 0', fontSize: '0.9rem' }}>
              Fill in the form on the PDF layout below. Pre-activity sign-off is completed by an admin via{' '}
              <strong>Sign with Nexus Core</strong> after saving — not on this form.
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
          <div className="form-group" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
            <label>Title</label>
            <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <a
            href={activityRiskAssessments.recordFileUrl(recordId)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
          >
            Preview PDF
          </a>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving || !title.trim()} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {error ? <p style={{ color: '#991b1b', marginTop: 0 }}>{error}</p> : null}
        {savedAt ? <p style={{ color: '#166534', marginTop: 0, fontSize: '0.9rem' }}>Saved at {savedAt}.</p> : null}

        <div
          style={{
            overflow: 'auto',
            flex: 1,
            padding: '0.5rem',
            background: '#e2e8f0',
            borderRadius: 8
          }}
        >
          {busy ? (
            <p className="forms-muted" style={{ textAlign: 'center', padding: '2rem 0' }}>
              Loading PDF form…
            </p>
          ) : (
            pageIndexes.map((pageIndex) => (
              <PdfFormPage
                key={pageIndex}
                pageIndex={pageIndex}
                scale={scale}
                fields={schema}
                values={values}
                onFieldChange={setFieldValue}
                canvasRef={(el) => {
                  canvasRefs.current[pageIndex] = el;
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
