/**
 * Intake Form Parser - extracts structured data from completed Client Intake Form PDFs.
 * Uses LLM to parse free-form text into participant profile and intake fields.
 * Based on: Client Intake Form (Pristine Lifestyle Solutions / Spring 2 Health) Version 3.
 */

import * as llm from './llm.service.js';

/** Field labels from the Client Intake Form PDF (for deterministic fallback) */
const INTAKE_FORM_LABELS = {
  // Page 1 - Client Details
  full_legal_name: ['Full legal name', 'Full name', 'Legal name'],
  preferred_name: ['Preferred name', 'Preferred'],
  date_of_birth: ['Date of birth', 'DOB', 'Birth date'],
  ndis_number: ['NDIS number', 'NDIS number (if applicable)', 'NDIS #'],
  email: ['Email'],
  phone: ['Phone'],
  preferred_contact_method: ['Preferred contact method', 'Contact method'],
  best_time_to_contact: ['Best time to contact', 'Best time'],
  street_address: ['Street address', 'Address', 'Street'],
  suburb_city: ['Suburb/City', 'Suburb', 'City'],
  state: ['State'],
  postcode: ['Postcode', 'Post code', 'Postal code'],
  // Primary Contact / Guardian
  primary_contact_name: ['Primary Contact', 'Guardian', 'Primary Contact / Guardian', 'Name'],
  primary_contact_relationship: ['Relationship'],
  primary_contact_phone: ['Phone'],
  primary_contact_email: ['Email'],
  // Emergency Contact
  emergency_contact_name: ['Emergency Contact', 'Emergency'],
  emergency_contact_relationship: ['Relationship'],
  emergency_contact_phone: ['Phone'],
  // Page 2 - Service Details
  preferred_start_date: ['Preferred start date', 'Start date'],
  consent_email_sms: ['Consent to contact via email/SMS', 'Consent'],
  medical_conditions: ['Key medical conditions', 'Medical conditions'],
  medications: ['Medications'],
  allergies: ['Allergies/sensitivities', 'Allergies'],
  mobility_supports: ['Mobility supports or equipment', 'Mobility'],
  support_needs: ['Support needs', 'Support needs (key areas)'],
  goals_and_outcomes: ['Goals and outcomes', 'Goals'],
  additional_notes: ['Additional Notes', 'Anything else we should know'],
  // Page 3 - Support Category
  support_category: ['Support Coordination', 'Social Work', 'Positive Behaviour Support', 'Community Access', 'Assistance with Daily Living'],
  plan_start_date: ['Plan start date', 'Plan start'],
  plan_end_date: ['Plan end date', 'Plan end'],
  funding_management_type: ['Funding management type', 'Funding management', 'Management type'],
  plan_manager_details: ['Plan manager details', 'Plan manager'],
  plan_manager_invoice_email: ['Plan manager invoice email', 'Invoice email', 'Billing email', 'Plan manager email'],
  risks_at_home: ['Risks at home', 'Risks'],
  triggers_stressors: ['Known triggers or stressors', 'Triggers'],
  current_supports_strategies: ['Current supports or strategies'],
  functional_assistance_needs: ['Functional Assistance Needs', 'Daily living areas requiring support'],
  living_arrangements: ['Living Arrangements', 'Who do you live with'],
  mental_health_summary: ['Mental Health Summary', 'Mental health conditions']
};

const SUPPORT_CATEGORY_OPTIONS = [
  'Support Coordination',
  'Social Work',
  'Positive Behaviour Support',
  'Community Access',
  'Assistance with Daily Living'
];

/**
 * Parse a completed Client Intake Form PDF text into structured data.
 * Uses LLM when available for robust extraction; falls back to simple regex when not.
 * @param {string} pdfText - Raw text extracted from the PDF
 * @returns {Promise<{ participant: object, intake: object, contacts: object[], plan: object|null, goals: string[] }>}
 */
export async function parseIntakeFormText(pdfText) {
  const text = String(pdfText || '').trim();
  if (!text || text.length < 50) {
    return {
      participant: {},
      intake: {},
      contacts: [],
      plan: null,
      goals: [],
      error: 'Insufficient text to parse. Ensure the PDF contains the completed Client Intake Form.'
    };
  }

  if (await llm.isAvailable()) {
    return parseWithLlm(text);
  }
  return parseDeterministic(text);
}

/**
 * LLM-based parsing for flexible extraction from handwritten or varied layouts.
 */
async function parseWithLlm(text) {
  const prompt = `You are parsing a completed "Client Intake Form" from Pristine Lifestyle Solutions / Spring 2 Health.
Extract all filled-in fields from the form text below. Return valid JSON only, no markdown or explanation.

Form structure (3 pages):
- Page 1: Client Details (Full legal name, Preferred name, Date of birth, NDIS number, Email, Phone, Preferred contact method, Best time to contact, Street address, Suburb/City, State, Postcode)
- Primary Contact/Guardian: Name, Relationship, Phone, Email
- Emergency Contact: Name, Relationship, Phone
- Page 2: Preferred start date, Consent to contact via email/SMS, Medical Summary (key medical conditions, medications, allergies, mobility supports), Support needs, Goals and outcomes, Additional notes
- Page 3: Support Category (tick one: Support Coordination, Social Work, Positive Behaviour Support, Community Access, Assistance with Daily Living), NDIS Funding (Plan start date, Plan end date, Funding management type, Plan manager details), Risks at home, Known triggers or stressors, Current supports or strategies, Functional assistance needs, Living arrangements, Mental health summary

Return this exact JSON structure (use null for missing values, empty string "" for blank):
{
  "participant": {
    "name": "Full legal name as written",
    "preferred_name": "Preferred name if different",
    "date_of_birth": "YYYY-MM-DD or original format",
    "ndis_number": "NDIS number",
    "email": "email",
    "phone": "phone",
    "address": "Full address (street, suburb, state postcode combined)",
    "preferred_contact_method": "email or phone or sms",
    "best_time_to_contact": "e.g. mornings, afternoons"
  },
  "primary_guardian": {
    "name": "Name",
    "relationship": "e.g. Mother, Father",
    "phone": "phone",
    "email": "email"
  },
  "emergency_contact": {
    "name": "Name",
    "relationship": "e.g. Sister",
    "phone": "phone"
  },
  "intake": {
    "preferred_start_date": "YYYY-MM-DD or date string",
    "consent_email_sms": "yes/no or description",
    "medical_conditions": "text",
    "medications": "text",
    "allergies": "text",
    "mobility_supports": "text",
    "support_needs": "text",
    "goals_and_outcomes": "text",
    "additional_notes": "text",
    "support_category": "one of: Support Coordination, Social Work, Positive Behaviour Support, Community Access, Assistance with Daily Living",
    "plan_start_date": "YYYY-MM-DD",
    "plan_end_date": "YYYY-MM-DD",
    "funding_management_type": "self, plan, or ndia",
    "plan_manager_details": "text",
    "plan_manager_invoice_email": "email address for sending invoices to plan manager (or self-managed participant email for invoicing)",
    "risks_at_home": "text",
    "triggers_stressors": "text",
    "current_supports_strategies": "text",
    "functional_assistance_needs": "text",
    "living_arrangements": "text",
    "mental_health_summary": "text"
  },
  "goals": ["goal 1", "goal 2"]
}

Form text:
---
${text.slice(0, 12000)}
---`;

  try {
    const parsed = await llm.completeJson(prompt, { maxTokens: 2000 });
    if (!parsed) return parseDeterministic(text);

    const participant = buildParticipantFromParsed(parsed);
    const intake = buildIntakeFromParsed(parsed);
    const contacts = buildContactsFromParsed(parsed);
    const plan = buildPlanFromParsed(parsed);
    const goals = Array.isArray(parsed.goals) ? parsed.goals.filter((g) => g && String(g).trim().length >= 5) : [];

    return { participant, intake, contacts, plan, goals };
  } catch (err) {
    console.error('Intake form LLM parse error:', err);
    return parseDeterministic(text);
  }
}

/**
 * Deterministic parsing using label proximity and regex.
 */
function parseDeterministic(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lower = text.toLowerCase();
  const result = { participant: {}, intake: {}, contacts: [], plan: null, goals: [] };

  // Simple label: value extraction
  const extractAfter = (labels, maxLen = 100) => {
    for (const label of labels) {
      const idx = lower.indexOf(label.toLowerCase());
      if (idx >= 0) {
        const after = text.slice(idx + label.length).trim();
        const end = Math.min(after.indexOf('\n'), maxLen);
        const val = (end > 0 ? after.slice(0, end) : after.slice(0, maxLen)).trim();
        if (val && !/^(email|phone|name|relationship|address|state|postcode|date|consent|yes|no)$/i.test(val)) {
          return val;
        }
      }
    }
    return null;
  };

  result.participant.name = extractAfter(INTAKE_FORM_LABELS.full_legal_name) || extractAfter(['Full legal name', 'Name']);
  result.participant.preferred_name = extractAfter(INTAKE_FORM_LABELS.preferred_name);
  result.participant.date_of_birth = normalizeDate(extractAfter(INTAKE_FORM_LABELS.date_of_birth));
  result.participant.ndis_number = extractAfter(INTAKE_FORM_LABELS.ndis_number) || (text.match(/\b\d{3}\s*\d{3}\s*\d{3}\b/) || [null])[0]?.replace(/\s/g, '');
  result.participant.email = extractAfter(INTAKE_FORM_LABELS.email) || (text.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0] || null);
  result.participant.phone = extractAfter(INTAKE_FORM_LABELS.phone) || (text.match(/(?:\+61|0)[\s\d]{8,12}/)?.[0]?.trim() || null);
  result.participant.address = [
    extractAfter(INTAKE_FORM_LABELS.street_address),
    extractAfter(INTAKE_FORM_LABELS.suburb_city),
    extractAfter(INTAKE_FORM_LABELS.state),
    extractAfter(INTAKE_FORM_LABELS.postcode)
  ].filter(Boolean).join(', ') || null;
  result.participant.preferred_contact_method = extractAfter(INTAKE_FORM_LABELS.preferred_contact_method);
  result.participant.best_time_to_contact = extractAfter(INTAKE_FORM_LABELS.best_time_to_contact);

  const primaryName = extractAfter(INTAKE_FORM_LABELS.primary_contact_name);
  if (primaryName) {
    result.contacts.push({
      name: primaryName,
      relationship: extractAfter(INTAKE_FORM_LABELS.primary_contact_relationship),
      phone: extractAfter(INTAKE_FORM_LABELS.primary_contact_phone),
      email: extractAfter(INTAKE_FORM_LABELS.primary_contact_email),
      role: 'primary_guardian'
    });
  }

  const emergencyName = extractAfter(INTAKE_FORM_LABELS.emergency_contact_name);
  if (emergencyName) {
    result.contacts.push({
      name: emergencyName,
      relationship: extractAfter(INTAKE_FORM_LABELS.emergency_contact_relationship),
      phone: extractAfter(INTAKE_FORM_LABELS.emergency_contact_phone),
      role: 'emergency'
    });
  }

  result.intake.preferred_start_date = normalizeDate(extractAfter(INTAKE_FORM_LABELS.preferred_start_date));
  result.intake.consent_email_sms = extractAfter(INTAKE_FORM_LABELS.consent_email_sms);
  result.intake.medical_conditions = extractAfter(INTAKE_FORM_LABELS.medical_conditions, 300);
  result.intake.medications = extractAfter(INTAKE_FORM_LABELS.medications, 200);
  result.intake.allergies = extractAfter(INTAKE_FORM_LABELS.allergies, 150);
  result.intake.mobility_supports = extractAfter(INTAKE_FORM_LABELS.mobility_supports, 150);
  result.intake.support_needs = extractAfter(INTAKE_FORM_LABELS.support_needs, 300);
  result.intake.goals_and_outcomes = extractAfter(INTAKE_FORM_LABELS.goals_and_outcomes, 400);
  result.intake.additional_notes = extractAfter(INTAKE_FORM_LABELS.additional_notes, 300);
  result.intake.support_category = SUPPORT_CATEGORY_OPTIONS.find((opt) => lower.includes(opt.toLowerCase())) || null;
  result.intake.plan_start_date = normalizeDate(extractAfter(INTAKE_FORM_LABELS.plan_start_date));
  result.intake.plan_end_date = normalizeDate(extractAfter(INTAKE_FORM_LABELS.plan_end_date));
  result.intake.funding_management_type = extractAfter(INTAKE_FORM_LABELS.funding_management_type);
  result.intake.plan_manager_details = extractAfter(INTAKE_FORM_LABELS.plan_manager_details, 200);
  result.intake.plan_manager_invoice_email = extractAfter(INTAKE_FORM_LABELS.plan_manager_invoice_email, 100);
  result.intake.risks_at_home = extractAfter(INTAKE_FORM_LABELS.risks_at_home, 200);
  result.intake.triggers_stressors = extractAfter(INTAKE_FORM_LABELS.triggers_stressors, 200);
  result.intake.current_supports_strategies = extractAfter(INTAKE_FORM_LABELS.current_supports_strategies, 200);
  result.intake.functional_assistance_needs = extractAfter(INTAKE_FORM_LABELS.functional_assistance_needs, 200);
  result.intake.living_arrangements = extractAfter(INTAKE_FORM_LABELS.living_arrangements, 150);
  result.intake.mental_health_summary = extractAfter(INTAKE_FORM_LABELS.mental_health_summary, 200);

  if (result.intake.plan_start_date || result.intake.plan_end_date) {
    result.plan = {
      start_date: result.intake.plan_start_date,
      end_date: result.intake.plan_end_date
    };
  }

  const goalsText = result.intake.goals_and_outcomes;
  if (goalsText) {
    result.goals = goalsText.split(/[;\n•\-]/).map((g) => g.trim()).filter((g) => g.length >= 12);
  }

  return result;
}

function buildParticipantFromParsed(parsed) {
  const p = parsed.participant || {};
  const name = p.name || p.full_legal_name || '';
  const address = p.address || [p.street_address, p.suburb_city, p.state, p.postcode].filter(Boolean).join(', ');
  return {
    name: name.trim() || null,
    preferred_name: (p.preferred_name || '').trim() || null,
    date_of_birth: normalizeDate(p.date_of_birth),
    ndis_number: (p.ndis_number || '').trim() || null,
    email: (p.email || '').trim() || null,
    phone: (p.phone || '').trim() || null,
    address: (address || '').trim() || null,
    preferred_contact_method: (p.preferred_contact_method || '').trim() || null,
    best_time_to_contact: (p.best_time_to_contact || '').trim() || null
  };
}

function buildIntakeFromParsed(parsed) {
  const i = parsed.intake || {};
  const obj = {};
  const keys = [
    'preferred_start_date', 'consent_email_sms', 'medical_conditions', 'medications', 'allergies',
    'mobility_supports', 'support_needs', 'goals_and_outcomes', 'additional_notes', 'support_category',
    'plan_start_date', 'plan_end_date', 'funding_management_type', 'plan_manager_details',
    'plan_manager_invoice_email',
    'risks_at_home', 'triggers_stressors', 'current_supports_strategies', 'functional_assistance_needs',
    'living_arrangements', 'mental_health_summary'
  ];
  for (const k of keys) {
    const v = i[k];
    if (v != null && String(v).trim()) obj[k] = String(v).trim();
  }
  return obj;
}

function buildContactsFromParsed(parsed) {
  const contacts = [];
  const primary = parsed.primary_guardian || parsed.primary_contact;
  if (primary && (primary.name || primary.phone || primary.email)) {
    contacts.push({
      name: (primary.name || '').trim(),
      relationship: (primary.relationship || '').trim(),
      phone: (primary.phone || '').trim(),
      email: (primary.email || '').trim(),
      role: 'primary_guardian'
    });
  }
  const emergency = parsed.emergency_contact;
  if (emergency && (emergency.name || emergency.phone)) {
    contacts.push({
      name: (emergency.name || '').trim(),
      relationship: (emergency.relationship || '').trim(),
      phone: (emergency.phone || '').trim(),
      role: 'emergency'
    });
  }
  return contacts;
}

function buildPlanFromParsed(parsed) {
  const i = parsed.intake || {};
  const start = normalizeDate(i.plan_start_date);
  const end = normalizeDate(i.plan_end_date);
  if (!start && !end) return null;
  return {
    start_date: start || end,
    end_date: end || start
  };
}

function normalizeDate(val) {
  if (!val || typeof val !== 'string') return null;
  const s = val.trim();
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymd) return s;
  const monthNames = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  const longDate = s.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
  if (longDate) {
    const [, d, mon, y] = longDate;
    return `${y}-${monthNames[mon.toLowerCase()]}-${d.padStart(2, '0')}`;
  }
  return s;
}
