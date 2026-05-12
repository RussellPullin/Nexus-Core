/**
 * Detects common NDIS / provider "Services Agreement" style labels in flat PDF text
 * (no AcroForm widgets). Spring 2 / Pristine style packs labels on one line, e.g.
 * "First NameLast Name", "PhoneMobile", "SuburbStatePostal Code".
 */

/** @typedef {{ key: string, label: string, method: string }} AgreementDetectedField */

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeParticipantServicesAgreement(text) {
  const raw = String(text || '');
  const u = raw.toUpperCase();
  const compact = raw.replace(/\s/g, '').length;
  if (compact < 35) return false;
  if (u.includes('SERVICES AGREEMENT') && (u.includes('NDIS') || u.includes('CLIENT DETAILS') || u.includes('SERVICE PROVIDER'))) {
    return true;
  }
  if (u.includes('SERVICE AGREEMENT') && (u.includes('NDIS') || u.includes('CLIENT DETAILS') || u.includes('SERVICE PROVIDER'))) {
    return true;
  }
  if (u.includes('CLIENT DETAILS') && u.includes('NDIS')) return true;
  if (u.includes('PLAN MANAGER') && u.includes('SERVICES AGREEMENT')) return true;
  return false;
}

/**
 * @param {string} text
 * @returns {{ mergeKeys: string[], detected_fields: AgreementDetectedField[] }}
 */
export function scanParticipantServicesAgreementFields(text) {
  const raw = String(text || '');
  const u = raw.toUpperCase();
  /** @type {Map<string, AgreementDetectedField>} */
  const byKey = new Map();

  const add = (mergeKey, label) => {
    const k = String(mergeKey || '').trim();
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, { key: k, label: label || k, method: 'services_agreement_template' });
  };

  // --- Section 1 style (concatenated labels common in fixed PDFs) ---
  if (/first\s*name/i.test(raw)) add('first_name', 'First Name');
  if (/last\s*name/i.test(raw)) add('last_name', 'Last Name');
  if (/\bmobile\b/i.test(raw)) add('phone', 'Mobile');
  if (/\bphone\b/i.test(raw)) add('phone', 'Phone');
  if (/email\s*address/i.test(raw)) add('email', 'Email Address');
  if (/date\s*of\s*birth/i.test(raw)) add('date_of_birth', 'Date of Birth');
  if (/ndi?s\s*number/i.test(raw)) add('ndis_number', 'NDIS Number');
  if (/street\s*address/i.test(raw)) add('street_address', 'Street Address');
  // Jammed labels (no spaces): "SuburbStatePostal Code" — \bsuburb\b does not match before "State".
  const jammedSuburbStatePostal = /suburb\s*state\s*postal/i.test(raw.replace(/\s/g, ''));
  if (jammedSuburbStatePostal || /\bsuburb\b/i.test(raw)) add('suburb_city', 'Suburb');
  if (jammedSuburbStatePostal || /\bpostal\s*code\b/i.test(raw) || /\bpostcode\b/i.test(raw) || /postal\s*code/i.test(raw)) {
    add('postcode', 'Postal Code');
  }
  if (jammedSuburbStatePostal || /SUBURBSTATEPOSTAL/.test(u.replace(/\s/g, ''))) {
    add('state', 'State');
  } else if (/\bstate\b/i.test(raw) && (u.includes('SUBURB') || u.includes('POSTAL'))) {
    add('state', 'State');
  }

  if (/plan\s*start\s*date/i.test(raw)) add('plan_start_date', 'Plan Start Date');
  if (/plan\s*expiry\s*date/i.test(raw) || /plan\s*end\s*date/i.test(raw)) add('plan_end_date', 'Plan Expiry Date');

  if (/plan\s*manager\s*email/i.test(raw)) add('plan_manager_invoice_email', 'Plan Manager Email');
  if (/plan\s*manager\s*name/i.test(raw)) add('plan_manager_company_name', 'Plan Manager Name');

  if (/relationship\s*to\s*client/i.test(raw)) add('primary_contact_relationship', 'Relationship to Client');

  if (/date\s*of\s*agreement/i.test(raw)) add('date', 'Date of Agreement');
  if (/scheduled\s*review\s*date/i.test(raw)) add('scheduled_review_date', 'Scheduled Review Date');

  if (/communication\s*preferences/i.test(raw)) add('preferred_contact_method', 'Communication Preferences');

  if (/signature/i.test(raw) && u.includes('EXECUTION')) add('signature', 'Signature');

  if (/organisation:/i.test(raw) || (/\borganisation\b/i.test(raw) && u.includes('SERVICE PROVIDER'))) {
    add('organisation_name', 'Organisation');
  }
  // Provider block: labels before "Client Details" (avoids clashing with participant Email/Phone lines).
  const providerHead = /client\s*details/i.test(raw) ? raw.slice(0, raw.search(/client\s*details/i)) : '';
  if (providerHead.length > 80 && /organisation\s*:/i.test(providerHead)) {
    if (/\babn\s*:/i.test(providerHead)) add('abn', 'ABN');
    if (/\baddress\s*:/i.test(providerHead)) add('organisation_address', 'Provider address');
    if (/\bemail\s*:/i.test(providerHead)) add('organisation_email', 'Provider email');
    if (/\bphone\s*:/i.test(providerHead)) add('organisation_phone', 'Provider phone');
    if (/\bcontact\s*:/i.test(providerHead)) add('organisation_contact_name', 'Provider contact name');
  }
  if (/name\s*\(?\s*please\s*print\s*\)?/i.test(raw)) add('full_legal_name', 'Name (please print)');

  const detected_fields = [...byKey.values()];
  const mergeKeys = detected_fields.map((d) => d.key);
  return { mergeKeys, detected_fields };
}

/**
 * Identity map mergeKey -> mergeKey for auto-suggested contract_field_map entries.
 * @param {string[]} mergeKeys
 * @returns {Record<string, string>}
 */
export function identityContractFieldMapFromMergeKeys(mergeKeys) {
  const m = {};
  for (const k of mergeKeys || []) {
    const s = String(k || '').trim();
    if (s) m[s] = s;
  }
  return m;
}
