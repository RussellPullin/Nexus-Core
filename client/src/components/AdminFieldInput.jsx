/**
 * A single admin_fields input (select/date/text) — shared between the plain wizard fallback
 * (OnboardingDocumentSelectPanel.jsx) and the visual fill-and-sign preview
 * (AdminDocumentSignPreview.jsx) for fields with no fixed page position.
 */
export default function AdminFieldInput({ field, value, onChange }) {
  if (field.type === 'select') {
    return (
      <select className="form-input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {(field.options || []).map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.type === 'date' ? 'date' : 'text'}
      className="form-input"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
