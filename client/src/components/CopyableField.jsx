import { useState } from 'react';

/**
 * A field that displays a label and value with a copy icon on hover.
 * Clicking the copy icon copies the value to clipboard.
 * Useful for NDIS number, email, phone, address when completing referrals.
 * Use compact=true for inline use (e.g. in tables) - shows only value + copy icon.
 */
export default function CopyableField({ label, value, showCopy = true, compact = false }) {
  const [copied, setCopied] = useState(false);
  const [hovering, setHovering] = useState(false);

  const displayValue = value || '-';
  const hasValue = value && String(value).trim() !== '';

  const handleCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hasValue) return;
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  const valueContent = (
    <span className="copyable-field-value">
      {displayValue}
      {showCopy && hasValue && (hovering || copied) && (
        <button
          type="button"
          className="copyable-field-btn"
          onClick={handleCopy}
          title={copied ? 'Copied!' : 'Copy to clipboard'}
          aria-label={copied ? 'Copied!' : 'Copy to clipboard'}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      )}
    </span>
  );

  if (compact) {
    return (
      <span
        className="copyable-field copyable-field-compact"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {valueContent}
      </span>
    );
  }

  return (
    <div
      className="copyable-field"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="copyable-field-label">{label}</span>
      {valueContent}
    </div>
  );
}
