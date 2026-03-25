import { useState, useEffect, useRef, useCallback } from 'react';

const DEBOUNCE_MS = 400;
const MIN_CHARS = 3;

/**
 * Fetches address suggestions from Nominatim (OpenStreetMap) - free, no API key.
 * Australian addresses are well supported.
 */
async function fetchAddressSuggestions(query) {
  if (!query || query.trim().length < MIN_CHARS) return [];
  const q = query.trim();
  const url = `https://nominatim.openstreetmap.org/search?` + new URLSearchParams({
    q,
    format: 'json',
    addressdetails: 1,
    limit: 6
  });
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en' }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data || []).map((item) => ({
    id: item.place_id,
    display: item.display_name,
    address: item.address
  }));
}

export default function AddressAutocomplete({ value, onChange, placeholder, id, className, ...rest }) {
  const [inputValue, setInputValue] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef(null);
  const debounceRef = useRef(null);

  // Sync with controlled value when it changes externally
  useEffect(() => {
    setInputValue(value || '');
  }, [value]);

  const fetchSuggestions = useCallback(async (q) => {
    if (!q || q.length < MIN_CHARS) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    try {
      const results = await fetchAddressSuggestions(q);
      setSuggestions(results);
      setOpen(results.length > 0);
      setHighlightedIndex(-1);
    } catch (err) {
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = (e) => {
    const v = e.target.value;
    setInputValue(v);
    onChange?.(v);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (v.length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => fetchSuggestions(v), DEBOUNCE_MS);
  };

  const selectSuggestion = (suggestion) => {
    const display = suggestion.display;
    setInputValue(display);
    onChange?.(display);
    setSuggestions([]);
    setOpen(false);
    setHighlightedIndex(-1);
  };

  const handleKeyDown = (e) => {
    if (!open || suggestions.length === 0) {
      if (e.key === 'Escape') setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => (i < suggestions.length - 1 ? i + 1 : i));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => (i > 0 ? i - 1 : -1));
    } else if (e.key === 'Enter' && highlightedIndex >= 0 && suggestions[highlightedIndex]) {
      e.preventDefault();
      selectSuggestion(suggestions[highlightedIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setHighlightedIndex(-1);
    }
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="address-autocomplete" style={{ position: 'relative' }}>
      <input
        type="text"
        value={inputValue}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder={placeholder || 'Start typing an address...'}
        id={id}
        className={className}
        autoComplete="off"
        {...rest}
      />
      {loading && (
        <span className="address-autocomplete-spinner" aria-hidden="true">
          …
        </span>
      )}
      {open && suggestions.length > 0 && (
        <ul className="address-autocomplete-list" role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === highlightedIndex}
              className={`address-autocomplete-item ${i === highlightedIndex ? 'highlighted' : ''}`}
              onMouseEnter={() => setHighlightedIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(s);
              }}
            >
              {s.display}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
