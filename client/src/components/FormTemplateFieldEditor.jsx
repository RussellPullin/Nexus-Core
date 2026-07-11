import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { forms } from '../lib/api';
import '../fieldEditor.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const FIELD_TYPES = [
  { value: 'text', label: 'Text (pre-filled from intake)' },
  { value: 'date', label: 'Date signed' },
  { value: 'signature', label: 'Signature' },
  { value: 'checkbox', label: 'Checkbox' }
];

const SIGNERS = [
  { value: 'participant', label: 'Participant' },
  { value: 'staff', label: 'Staff' },
  { value: 'org', label: 'Organisation' }
];

const FIELD_COLORS = [
  { border: '#2563eb', bg: 'rgba(37, 99, 235, 0.22)', text: '#1e3a8a' },
  { border: '#059669', bg: 'rgba(5, 150, 105, 0.22)', text: '#064e3b' },
  { border: '#d97706', bg: 'rgba(217, 119, 6, 0.22)', text: '#78350f' },
  { border: '#7c3aed', bg: 'rgba(124, 58, 237, 0.22)', text: '#4c1d95' },
  { border: '#db2777', bg: 'rgba(219, 39, 119, 0.22)', text: '#831843' },
  { border: '#0891b2', bg: 'rgba(8, 145, 178, 0.22)', text: '#164e63' }
];

function defaultCoverForField(type, mergeKey = '', apiId = '') {
  if (type === 'signature' || type === 'checkbox') return false;
  const text = `${apiId} ${mergeKey}`.toLowerCase();
  if (/insert\s*value|<\s*insert|\[insert\]|____+|___+/.test(text)) return true;
  if (/hourly_rate|pay.?rate/.test(text)) return true;
  return type === 'text' || type === 'date';
}

function fieldCoversUnderlying(f) {
  if (f?.cover_underlying === false) return false;
  if (f?.cover_underlying === true) return true;
  return defaultCoverForField(f?.type, f?.merge_key, f?.api_id);
}

function newField(page, mergeKeyOptions) {
  const merge_key = mergeKeyOptions[0] || 'first_name';
  return {
    id: crypto.randomUUID(),
    page,
    x: 72,
    y: 200,
    width: 220,
    height: 22,
    type: 'text',
    merge_key,
    label: humanizeMergeKey(merge_key),
    signer: 'participant',
    required: false,
    api_id: `field_${Date.now()}`,
    cover_underlying: true
  };
}

function humanizeMergeKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fieldColor(index, selected) {
  const c = FIELD_COLORS[index % FIELD_COLORS.length];
  if (selected) {
    return {
      border: '#0f172a',
      bg: 'rgba(15, 23, 42, 0.12)',
      text: '#0f172a',
      boxShadow: '0 0 0 3px rgba(37, 99, 235, 0.45)'
    };
  }
  return c;
}

export default function FormTemplateFieldEditor({ templateId, displayName, onClose, onSaved, onError }) {
  const [loading, setLoading] = useState(true);
  const [pdfLoading, setPdfLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [layout, setLayout] = useState(null);
  const [mergeKeyOptions, setMergeKeyOptions] = useState([]);
  const [workflow, setWorkflow] = useState('participant_onboarding');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [drag, setDrag] = useState(null);
  const [zoom, setZoom] = useState(1.25);
  const [pdfDoc, setPdfDoc] = useState(null);

  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const scrollRef = useRef(null);

  const pageW = layout?.page_width || 595;
  const pageH = layout?.page_height || 842;
  const pageCount = layout?.page_count || 1;
  const renderScale = zoom;
  const displayWidth = pageW * renderScale;
  const displayHeight = pageH * renderScale;

  useEffect(() => {
    setLoading(true);
    forms
      .getSigningLayout(templateId)
      .then((res) => {
        const sl = res.signing_layout;
        setLayout(sl);
        setMergeKeyOptions(res.merge_key_options || []);
        setWorkflow(res.workflow || 'participant_onboarding');
        const firstField = sl?.fields?.[0];
        setCurrentPage(firstField?.page || 1);
        setSelectedId(firstField?.id || null);
      })
      .catch((e) => onError?.(e.message || 'Could not load field layout'))
      .finally(() => setLoading(false));
  }, [templateId, onError]);

  useEffect(() => {
    let cancelled = false;
    setPdfLoading(true);
    fetch(forms.templateDocumentUrl(templateId), { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error('Could not load PDF');
        return res.arrayBuffer();
      })
      .then((buf) => pdfjsLib.getDocument({ data: buf }).promise)
      .then((doc) => {
        if (!cancelled) setPdfDoc(doc);
      })
      .catch((e) => onError?.(e.message || 'Could not load PDF'))
      .finally(() => {
        if (!cancelled) setPdfLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId, onError]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return undefined;
    let cancelled = false;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    pdfDoc
      .getPage(currentPage)
      .then((page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: renderScale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        return page.render({ canvasContext: ctx, viewport }).promise;
      })
      .catch((e) => onError?.(e.message || 'Could not render page'));
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, renderScale, onError]);

  const allFields = layout?.fields || [];

  const pageFields = useMemo(
    () => allFields.filter((f) => (f.page || 1) === currentPage),
    [allFields, currentPage]
  );

  const selectedField = useMemo(
    () => allFields.find((f) => f.id === selectedId) || null,
    [allFields, selectedId]
  );

  const fieldIndexById = useMemo(() => {
    const map = new Map();
    allFields.forEach((f, i) => map.set(f.id, i));
    return map;
  }, [allFields]);

  const hasOrgField = useMemo(() => allFields.some((f) => f.signer === 'org'), [allFields]);

  const updateField = useCallback((id, patch) => {
    setLayout((prev) => ({
      ...prev,
      fields: (prev.fields || []).map((f) => (f.id === id ? { ...f, ...patch } : f))
    }));
  }, []);

  const deleteField = useCallback((id) => {
    setLayout((prev) => ({
      ...prev,
      fields: (prev.fields || []).filter((f) => f.id !== id)
    }));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const addField = () => {
    const f = newField(currentPage, mergeKeyOptions);
    setLayout((prev) => ({ ...prev, fields: [...(prev.fields || []), f] }));
    setSelectedId(f.id);
  };

  const selectField = (field) => {
    setSelectedId(field.id);
    if ((field.page || 1) !== currentPage) {
      setCurrentPage(field.page || 1);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await forms.saveSigningLayout(templateId, layout);
      onSaved?.();
      onClose?.();
    } catch (e) {
      onError?.(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const onCanvasMouseDown = (e, field) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(field.id);
    setDrag({
      id: field.id,
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: field.x,
      origY: field.y
    });
  };

  const onResizeMouseDown = (e, field) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(field.id);
    setDrag({
      id: field.id,
      mode: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      origW: field.width,
      origH: field.height
    });
  };

  useEffect(() => {
    if (!drag) return undefined;
    const onMove = (e) => {
      const dx = (e.clientX - drag.startX) / renderScale;
      const dy = (e.clientY - drag.startY) / renderScale;
      if (drag.mode === 'move') {
        updateField(drag.id, {
          x: Math.max(0, Math.round(drag.origX + dx)),
          y: Math.max(0, Math.round(drag.origY + dy))
        });
      } else {
        updateField(drag.id, {
          width: Math.max(40, Math.round(drag.origW + dx)),
          height: Math.max(14, Math.round(drag.origH + dy))
        });
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, renderScale, updateField]);

  if (loading || !layout) {
    return (
      <div className="field-editor-overlay" role="dialog" aria-modal="true">
        <div className="field-editor-shell field-editor-shell--loading">
          <p className="forms-muted">Loading field editor…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="field-editor-overlay" role="dialog" aria-modal="true">
      <div className="field-editor-shell">
        <header className="field-editor-header">
          <div>
            <h2 className="field-editor-title">Edit signing fields</h2>
            <p className="field-editor-subtitle">
              {displayName} · {workflowLabel(workflow)} · {allFields.length} field
              {allFields.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="field-editor-header-actions">
            <a
              href={forms.signerPreviewPdfUrl(templateId)}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-sm"
            >
              Preview PDF
            </a>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="field-editor-tip">
          <strong>How it works:</strong> coloured boxes show where each field goes. Click a field in the list on the
          left, then drag it on the PDF. Text fields pre-fill automatically; signature and date fields are collected
          at signing time.
          {hasOrgField
            ? ' Because this form has an Organisation field, the organisation always signs first — the other signer only gets access once the organisation has completed their part.'
            : ''}
        </div>

        <div className="field-editor-body">
          <aside className="field-editor-list">
            <div className="field-editor-list-head">
              <h3>Fields</h3>
              <button type="button" className="btn btn-primary btn-sm" onClick={addField}>
                + Add
              </button>
            </div>
            {allFields.length === 0 ? (
              <p className="field-editor-empty">
                No fields yet. Click <strong>Add</strong> to place a box on the PDF.
              </p>
            ) : (
              <ul className="field-editor-list-items">
                {allFields.map((f, idx) => {
                  const isSel = f.id === selectedId;
                  const colors = fieldColor(idx, isSel);
                  return (
                    <li key={f.id}>
                      <button
                        type="button"
                        className={`field-editor-list-item${isSel ? ' is-selected' : ''}`}
                        onClick={() => selectField(f)}
                        style={{ borderLeftColor: colors.border }}
                      >
                        <span className="field-editor-list-num" style={{ background: colors.border }}>
                          {idx + 1}
                        </span>
                        <span className="field-editor-list-text">
                          <strong>{f.label || humanizeMergeKey(f.merge_key)}</strong>
                          <span>
                            Page {f.page || 1} · {f.type || 'text'} · {SIGNERS.find((s) => s.value === f.signer)?.label || f.signer}
                            {fieldCoversUnderlying(f) ? ' · covers placeholder' : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <main className="field-editor-main">
            <div className="field-editor-toolbar">
              <label className="field-editor-toolbar-group">
                Page
                <select
                  className="form-input"
                  value={currentPage}
                  onChange={(e) => setCurrentPage(Number(e.target.value))}
                >
                  {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
                    <option key={p} value={p}>
                      {p} of {pageCount}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-editor-toolbar-group">
                Zoom
                <select className="form-input" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                  <option value={0.85}>85%</option>
                  <option value={1}>100%</option>
                  <option value={1.25}>125%</option>
                  <option value={1.5}>150%</option>
                  <option value={1.75}>175%</option>
                  <option value={2}>200%</option>
                </select>
              </label>
              <span className="field-editor-toolbar-meta">
                {pageFields.length} on this page
                {pdfLoading ? ' · Loading PDF…' : ''}
              </span>
            </div>

            <div className="field-editor-scroll" ref={scrollRef}>
              <div
                className="field-editor-stage"
                style={{ width: displayWidth, height: displayHeight }}
                onClick={() => setSelectedId(null)}
              >
                <canvas ref={canvasRef} className="field-editor-canvas" />
                <div
                  ref={overlayRef}
                  className="field-editor-overlay-layer"
                  style={{ width: displayWidth, height: displayHeight }}
                >
                  {pageFields.map((f) => {
                    const isSel = f.id === selectedId;
                    const idx = fieldIndexById.get(f.id) ?? 0;
                    const colors = fieldColor(idx, isSel);
                    const covers = fieldCoversUnderlying(f);
                    return (
                      <div
                        key={f.id}
                        className={`field-editor-box${isSel ? ' is-selected' : ''}${covers ? ' field-editor-box--cover' : ''}`}
                        onMouseDown={(e) => onCanvasMouseDown(e, f)}
                        style={{
                          left: f.x * renderScale,
                          top: f.y * renderScale,
                          width: f.width * renderScale,
                          height: f.height * renderScale,
                          borderColor: colors.border,
                          background: covers ? '#ffffff' : colors.bg,
                          color: colors.text,
                          boxShadow: colors.boxShadow || undefined
                        }}
                      >
                        <span className="field-editor-box-badge" style={{ background: colors.border }}>
                          {idx + 1}
                        </span>
                        <span className="field-editor-box-label">{f.label || humanizeMergeKey(f.merge_key)}</span>
                        {isSel ? (
                          <span
                            className="field-editor-box-resize"
                            onMouseDown={(e) => onResizeMouseDown(e, f)}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </main>

          <aside className="field-editor-props">
            <h3>Field properties</h3>
            {selectedField ? (
              <div className="field-editor-props-form">
                <label className="forms-label">
                  Merge key
                  <select
                    className="form-input"
                    value={selectedField.merge_key || ''}
                    onChange={(e) => {
                      const merge_key = e.target.value;
                      updateField(selectedField.id, {
                        merge_key,
                        label: humanizeMergeKey(merge_key)
                      });
                    }}
                  >
                    {mergeKeyOptions.map((k) => (
                      <option key={k} value={k}>
                        {humanizeMergeKey(k)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="forms-label">
                  Label (preview)
                  <input
                    className="form-input"
                    value={selectedField.label || ''}
                    onChange={(e) => updateField(selectedField.id, { label: e.target.value })}
                  />
                </label>
                <label className="forms-label">
                  Type
                  <select
                    className="form-input"
                    value={selectedField.type || 'text'}
                    onChange={(e) => {
                      const type = e.target.value;
                      const patch = { type };
                      if (type === 'signature' || type === 'checkbox') {
                        patch.cover_underlying = false;
                      } else if (selectedField.cover_underlying === undefined) {
                        patch.cover_underlying = defaultCoverForField(
                          type,
                          selectedField.merge_key,
                          selectedField.api_id
                        );
                      }
                      updateField(selectedField.id, patch);
                    }}
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="forms-label">
                  Signer
                  <select
                    className="form-input"
                    value={selectedField.signer || 'participant'}
                    onChange={(e) => updateField(selectedField.id, { signer: e.target.value })}
                  >
                    {SIGNERS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="forms-label">
                  Page
                  <input
                    type="number"
                    min={1}
                    max={pageCount}
                    className="form-input"
                    value={selectedField.page || 1}
                    onChange={(e) => updateField(selectedField.id, { page: Number(e.target.value) || 1 })}
                  />
                </label>
                <div className="field-editor-coords">
                  {['x', 'y', 'width', 'height'].map((prop) => (
                    <label key={prop} className="forms-label">
                      {prop}
                      <input
                        type="number"
                        className="form-input"
                        value={selectedField[prop] ?? 0}
                        onChange={(e) => updateField(selectedField.id, { [prop]: Number(e.target.value) || 0 })}
                      />
                    </label>
                  ))}
                </div>
                {(selectedField.type === 'text' || selectedField.type === 'date' || !selectedField.type) ? (
                  <label className="field-editor-required">
                    <input
                      type="checkbox"
                      checked={fieldCoversUnderlying(selectedField)}
                      onChange={(e) =>
                        updateField(selectedField.id, { cover_underlying: e.target.checked })
                      }
                    />
                    Cover placeholder text
                  </label>
                ) : null}
                <label className="field-editor-required">
                  <input
                    type="checkbox"
                    checked={selectedField.required === true}
                    onChange={(e) => updateField(selectedField.id, { required: e.target.checked })}
                  />
                  Required
                </label>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm field-editor-delete"
                  onClick={() => deleteField(selectedField.id)}
                >
                  Delete field
                </button>
              </div>
            ) : (
              <p className="forms-muted">Select a numbered field from the list or click a box on the PDF.</p>
            )}
          </aside>
        </div>

        <footer className="field-editor-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save layout'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function workflowLabel(w) {
  if (w === 'staff_onboarding') return 'Staff onboarding';
  return 'Participant onboarding';
}
