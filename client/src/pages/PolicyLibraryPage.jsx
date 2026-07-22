import { useEffect, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { documentLibrary } from '../lib/api';
import DocumentPreviewModal from '../components/DocumentPreviewModal';

/**
 * Org-scoped policy content editor. Lets an org override individual named sections of a policy
 * (Policy Statement, Definitions, etc.) while continuing to inherit everything else — including
 * future master updates — from the shared template, or fully replace a policy with their own
 * uploaded document. Every org that clones a policy master otherwise gets byte-identical wording.
 */
export default function PolicyLibraryPage() {
  const [masters, setMasters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [preview, setPreview] = useState({ open: false, src: null, title: '' });

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await documentLibrary.listMasters();
      setMasters((Array.isArray(list) ? list : []).filter((m) => m.category === 'policy' && m.section_count > 0));
    } catch (e) {
      setError(e.message || 'Could not load policies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const selected = masters.find((m) => m.id === selectedId) || null;

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1200 }}>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Policy library</h2>
        <p style={{ color: '#64748b', margin: '.25rem 0 0', fontSize: '.9rem' }}>
          Override individual sections of a policy to match how you actually operate, or upload your own
          version entirely. Sections you don't touch keep inheriting the shared template — including future
          updates to it.
        </p>
      </div>

      {error && <div className="settings-error">{error}</div>}
      {loading && <p>Loading…</p>}

      {!loading && (
        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
          <div style={{ width: 320, flexShrink: 0 }}>
            {masters.length === 0 && (
              <div style={{ padding: '1rem', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 8 }}>
                <p style={{ margin: 0, color: '#334155', fontSize: '.9rem' }}>
                  No policies with editable sections found yet. Clone policy masters from the master document
                  library first.
                </p>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {masters.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelectedId(m.id)}
                  className="btn-sm"
                  style={{
                    textAlign: 'left',
                    padding: '.55rem .7rem',
                    borderRadius: 6,
                    border: '1px solid transparent',
                    background: m.id === selectedId ? '#eef2ff' : 'transparent',
                    borderColor: m.id === selectedId ? '#c7d2fe' : 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8
                  }}
                >
                  <span>{m.display_name}</span>
                  {m.override_mode && m.override_mode !== 'inherit' && (
                    <span style={{ fontSize: '.72rem', color: '#4f46e5', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {m.override_mode === 'full_upload' ? 'Custom upload' : 'Customised'}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {!selected && <p style={{ color: '#64748b' }}>Select a policy on the left to review or customise it.</p>}
            {selected && (
              <PolicyEditor
                key={selected.id}
                master={selected}
                onPreview={() =>
                  setPreview({
                    open: true,
                    src: documentLibrary.previewMasterUrl(selected.id),
                    title: `${selected.display_name} — preview`
                  })
                }
                onChanged={reload}
              />
            )}
          </div>
        </div>
      )}

      <DocumentPreviewModal
        open={preview.open}
        src={preview.src}
        title={preview.title}
        onClose={() => setPreview({ open: false, src: null, title: '' })}
      />
    </div>
  );
}

function PolicyEditor({ master, onPreview, onChanged }) {
  const [sections, setSections] = useState([]);
  const [overrideMode, setOverrideMode] = useState('inherit');
  const [sectionOverrides, setSectionOverrides] = useState([]);
  const [fullUpload, setFullUpload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [sectionList, overrides] = await Promise.all([
        documentLibrary.masterSections(master.id),
        documentLibrary.orgOverrides(master.id)
      ]);
      setSections(sectionList);
      setOverrideMode(overrides.override_mode || 'inherit');
      setSectionOverrides(overrides.section_overrides || []);
      setFullUpload(overrides.full_upload || null);
    } catch (e) {
      setError(e.message || 'Could not load policy content');
    } finally {
      setLoading(false);
    }
  }, [master.id]);

  useEffect(() => {
    load();
  }, [load]);

  const overrideByKey = new Map(sectionOverrides.map((o) => [o.section_key, o.content_html]));

  const handleModeChange = async (mode) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await documentLibrary.setOverrideMode(master.id, mode);
      setOverrideMode(mode);
      setMessage('Mode updated.');
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not change mode');
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await documentLibrary.uploadFullDocument(master.id, file);
      setMessage('Document uploaded.');
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSection = async (sectionKey, html) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await documentLibrary.saveSectionOverride(master.id, sectionKey, html);
      setMessage('Section saved.');
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not save section');
    } finally {
      setBusy(false);
    }
  };

  const handleRevertSection = async (sectionKey) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await documentLibrary.deleteSectionOverride(master.id, sectionKey);
      setMessage('Section reverted to master.');
      setExpandedKey((k) => (k === sectionKey ? null : k));
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not revert section');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: '1rem' }}>
        <div>
          <h3 style={{ margin: 0 }}>{master.display_name}</h3>
          <p style={{ margin: '.25rem 0 0', fontSize: '.85rem', color: '#64748b' }}>{sections.length} sections</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onPreview}>Preview rendered document</button>
      </div>

      {error && <div className="settings-error">{error}</div>}
      {message && <div className="settings-success">{message}</div>}

      <div style={{ display: 'flex', gap: '.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <ModeButton label="Inherit from master" active={overrideMode === 'inherit'} disabled={busy} onClick={() => handleModeChange('inherit')} />
        <ModeButton label="Override sections" active={overrideMode === 'sections'} disabled={busy} onClick={() => handleModeChange('sections')} />
        <ModeButton label="Upload your own document" active={overrideMode === 'full_upload'} disabled={busy} onClick={() => handleModeChange('full_upload')} />
      </div>

      {overrideMode === 'full_upload' && (
        <div style={{ padding: '1rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: '1.25rem' }}>
          {fullUpload ? (
            <p style={{ margin: '0 0 .75rem', fontSize: '.9rem' }}>
              Currently serving your uploaded file: <strong>{fullUpload.template_filename}</strong>
              {fullUpload.updated_at ? ` (uploaded ${fullUpload.updated_at})` : ''}
            </p>
          ) : (
            <p style={{ margin: '0 0 .75rem', fontSize: '.9rem', color: '#b91c1c' }}>
              Mode is set to "Upload your own document" but nothing has been uploaded yet — the master is
              still being served in the meantime.
            </p>
          )}
          <input
            type="file"
            accept=".docx,.pdf"
            disabled={busy}
            onChange={(e) => handleUpload(e.target.files?.[0])}
          />
        </div>
      )}

      {overrideMode === 'sections' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
          {sections.map((section) => {
            const isOverridden = overrideByKey.has(section.key);
            const isExpanded = expandedKey === section.key;
            return (
              <SectionRow
                key={section.key}
                section={section}
                isOverridden={isOverridden}
                overrideHtml={overrideByKey.get(section.key)}
                isExpanded={isExpanded}
                busy={busy}
                onToggleExpand={() => setExpandedKey(isExpanded ? null : section.key)}
                onSave={(html) => handleSaveSection(section.key, html)}
                onRevert={() => handleRevertSection(section.key)}
              />
            );
          })}
        </div>
      )}

      {overrideMode === 'inherit' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
          {sections.map((section) => (
            <div key={section.key} style={{ padding: '.6rem .8rem', border: '1px solid #e2e8f0', borderRadius: 6 }}>
              <strong style={{ fontSize: '.9rem' }}>{section.heading || 'Untitled section'}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModeButton({ label, active, disabled, onClick }) {
  return (
    <button
      className={active ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SectionRow({ section, isOverridden, overrideHtml, isExpanded, busy, onToggleExpand, onSave, onRevert }) {
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '.6rem .8rem',
          background: isOverridden ? '#eef2ff' : '#f8fafc',
          cursor: 'pointer'
        }}
        onClick={onToggleExpand}
      >
        <span style={{ fontWeight: 600, fontSize: '.9rem' }}>{section.heading || 'Untitled section'}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isOverridden && <span style={{ fontSize: '.72rem', color: '#4f46e5', fontWeight: 600 }}>Overridden</span>}
          <span style={{ fontSize: '.8rem', color: '#94a3b8' }}>{isExpanded ? '▲' : '▼'}</span>
        </span>
      </div>
      {isExpanded && (
        <SectionEditor
          section={section}
          isOverridden={isOverridden}
          overrideHtml={overrideHtml}
          busy={busy}
          onSave={onSave}
          onRevert={onRevert}
        />
      )}
    </div>
  );
}

function SectionEditor({ section, isOverridden, overrideHtml, busy, onSave, onRevert }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: overrideHtml || section.content_html,
    immediatelyRender: false
  });

  if (!editor) return null;

  return (
    <div style={{ padding: '.8rem', borderTop: '1px solid #e2e8f0' }}>
      {!isOverridden && (
        <p style={{ margin: '0 0 .6rem', fontSize: '.82rem', color: '#64748b' }}>
          Currently inheriting the master's wording. Edit below and save to override just this section —
          everything else keeps updating with the master.
        </p>
      )}
      <div style={{ border: '1px solid #cbd5e1', borderRadius: 6, padding: '.6rem', background: '#fff', minHeight: 120 }}>
        <EditorContent editor={editor} />
      </div>
      <div style={{ display: 'flex', gap: '.5rem', marginTop: '.6rem' }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => onSave(editor.getHTML())}
        >
          Save override
        </button>
        {isOverridden && (
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onRevert}>
            Revert to master
          </button>
        )}
      </div>
    </div>
  );
}
