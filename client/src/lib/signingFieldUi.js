export function fieldValueIsFilled(field, value) {
  if (field?.type === 'checkbox') {
    if (value === true || value === 1) return true;
    const s = String(value ?? '').trim().toLowerCase();
    return s === 'true' || s === 'yes' || s === 'on' || s === '1' || s === 'checked';
  }
  return String(value ?? '').trim().length > 0;
}

export function isSupportTeamConsentCheckbox(field) {
  if (field?.type !== 'checkbox') return false;
  const key = String(field.merge_key || field.api_id || field.key || '').toLowerCase();
  return key.startsWith('tp_');
}

/** Withdrawal / "do not consent" ticks — empty is a valid choice, not a missing answer. */
export function isOptionalEmptyCheckbox(field) {
  if (field?.type !== 'checkbox') return false;
  const key = String(field.merge_key || field.api_id || field.key || '').toLowerCase();
  return key.startsWith('w_');
}

export function shouldHighlightEmptyField(field, value, signatureDataUrl) {
  if (field?.type === 'signature') return !signatureDataUrl && !fieldValueIsFilled(field, value);
  if (isOptionalEmptyCheckbox(field)) return false;
  return !fieldValueIsFilled(field, value);
}

export function emptyHighlightStyle(active) {
  if (!active) {
    return {
      border: '1px solid #16a34a',
      background: 'rgba(255,255,255,0.75)'
    };
  }
  return {
    border: '2px solid #d97706',
    background: 'rgba(250, 204, 21, 0.42)',
    boxShadow: '0 0 0 1px rgba(217, 119, 6, 0.35)'
  };
}
