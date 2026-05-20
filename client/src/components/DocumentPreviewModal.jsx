import { useEffect } from 'react';

/**
 * Generic full-screen preview modal. Pass `src` (a URL the browser can iframe) and
 * `title` for the header. Closes on Escape and on the backdrop click.
 */
export default function DocumentPreviewModal({ open, src, title, onClose, downloadHref = null }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.65)',
        zIndex: 9999,
        display: 'grid',
        placeItems: 'center',
        padding: '2rem'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 10,
          width: 'min(1100px, 100%)',
          height: 'min(90vh, 100%)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(15,23,42,0.35)',
          overflow: 'hidden'
        }}
      >
        <div style={{ padding: '.75rem 1rem', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.5rem' }}>
          <div style={{ fontWeight: 600, fontSize: '.95rem', color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title || 'Preview'}
          </div>
          <div style={{ display: 'flex', gap: '.5rem' }}>
            {src && (
              <a className="btn btn-secondary btn-sm" href={src} target="_blank" rel="noreferrer">Open in new tab</a>
            )}
            {downloadHref && (
              <a className="btn btn-secondary btn-sm" href={downloadHref} download>Download</a>
            )}
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, background: '#f1f5f9' }}>
          {src ? (
            <iframe
              key={src}
              src={src}
              title={title || 'Preview'}
              style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
            />
          ) : (
            <div style={{ padding: '2rem', color: '#64748b' }}>Nothing to preview.</div>
          )}
        </div>
      </div>
    </div>
  );
}
