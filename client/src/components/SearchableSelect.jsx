import { useState, useRef, useEffect } from 'react';

/**
 * A searchable select/combobox for long lists.
 * @param {Object} props
 * @param {Array<{id: string, name: string}>} props.options - List of { id, name }
 * @param {string} props.value - Selected id
 * @param {function} props.onChange - (id) => void
 * @param {string} props.placeholder - Placeholder when empty
 * @param {boolean} props.required - Whether the field is required
 * @param {string} props.id - Input id for form association
 */
export default function SearchableSelect({ options = [], value, onChange, placeholder = 'Select...', required, id }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef(null);

  const selected = options.find((o) => o.id === value);
  const displayValue = selected?.name ?? '';

  const filtered = query.trim()
    ? options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    const onDocClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const handleSelect = (opt) => {
    onChange(opt.id);
    setQuery('');
    setOpen(false);
  };

  const handleInputChange = (e) => {
    const v = e.target.value;
    setQuery(v);
    setOpen(true);
    if (!v.trim() && value) onChange('');
  };

  const handleFocus = () => {
    setOpen(true);
    setQuery(displayValue);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      setOpen(false);
      setQuery(displayValue);
    }
  };

  return (
    <div ref={containerRef} className="searchable-select">
      <input
        type="text"
        id={id}
        value={open ? query : displayValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        required={required && !value}
        autoComplete="off"
        className="searchable-select-input"
      />
      {open && (
        <div className="searchable-select-dropdown">
          {filtered.length === 0 ? (
            <div className="searchable-select-empty">No matches</div>
          ) : (
            filtered.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`searchable-select-option ${opt.id === value ? 'selected' : ''}`}
                onClick={() => handleSelect(opt)}
              >
                {opt.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
