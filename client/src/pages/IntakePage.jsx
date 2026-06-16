import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { intakePublic } from '../lib/api';

/**
 * Participant self-service intake — 4-step wizard.
 * Token-authenticated, no login required. Autosaves every field on change.
 */

const STEPS = [
  { num: 1, title: 'About you' },
  { num: 2, title: 'Contact details' },
  { num: 3, title: 'NDIS plan' },
  { num: 4, title: 'Representative & consent' },
];

const STEP1_FIELDS = [
  { key: 'first_name',         label: 'First name',          required: true },
  { key: 'last_name',          label: 'Last name',           required: true },
  { key: 'date_of_birth',      label: 'Date of birth',       required: true, type: 'date' },
  { key: 'pronouns',           label: 'Pronouns',            optional: true },
  { key: 'preferred_language', label: 'Preferred language',  optional: true },
];

const STEP2_FIELDS = [
  { key: 'email',         label: 'Email address', type: 'email' },
  { key: 'phone',         label: 'Phone number',  type: 'tel' },
  { key: 'mobile_phone',  label: 'Mobile number', type: 'tel' },
  { key: 'street_address', label: 'Street address' },
  { key: 'suburb_city',   label: 'Suburb / City' },
  { key: 'state',         label: 'State',          placeholder: 'e.g. QLD' },
  { key: 'postcode',      label: 'Postcode',       inputMode: 'numeric' },
];

const STEP3_FIELDS = [
  { key: 'ndis_number',   label: 'NDIS number' },
  { key: 'plan_start',    label: 'Plan start date', type: 'date' },
  { key: 'plan_end',      label: 'Plan end date',   type: 'date' },
  {
    key: 'funding_management_type',
    label: 'Funding management',
    type: 'select',
    options: [
      { value: '', label: 'Select…' },
      { value: 'ndia_managed',  label: 'NDIA managed' },
      { value: 'plan_managed',  label: 'Plan managed' },
      { value: 'self_managed',  label: 'Self managed' },
    ],
  },
  { key: 'plan_manager_name',   label: 'Plan manager name (if plan managed)' },
  { key: 'plan_manager_email',  label: 'Plan manager email (if plan managed)', type: 'email' },
  { key: 'support_coordinator_name', label: 'Support coordinator (if any)' },
];

const STEP4_REP_FIELDS = [
  { key: 'representative_first_name',    label: 'First name' },
  { key: 'representative_last_name',     label: 'Last name' },
  { key: 'representative_relationship',  label: 'Relationship to you' },
  { key: 'representative_phone',         label: 'Phone', type: 'tel' },
  { key: 'representative_email',         label: 'Email', type: 'email' },
];

const STEP4_COMMS_FIELDS = [
  { key: 'preferred_contact_method', label: 'Preferred contact method', placeholder: 'e.g. email, phone, SMS' },
  { key: 'communication_notes',      label: 'Anything else we should know to communicate well with you?', type: 'textarea' },
];

const STEP4_CONSENT_FIELDS = [
  {
    key: 'consent_privacy',
    label: 'I consent to the collection and storage of my personal information for the purposes of NDIS support delivery.',
    type: 'checkbox',
    required: true,
  },
  {
    key: 'consent_share_with_providers',
    label: 'I consent to sharing necessary information with my support workers and approved providers.',
    type: 'checkbox',
    required: true,
  },
];

export default function IntakePage() {
  const { token } = useParams();
  const [pageState, setPageState] = useState({ loading: true, error: '' });
  const [data,        setData]        = useState(null);
  const [values,      setValues]      = useState({});
  const [step,        setStep]        = useState(1);
  const [savingKeys,  setSavingKeys]  = useState(new Set());
  const [stepError,   setStepError]   = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [submittedAt, setSubmittedAt] = useState(null);
  const debouncers = useRef({});

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    intakePublic
      .load(token)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setValues(res?.saved_fields || {});
        setPageState({ loading: false, error: '' });
      })
      .catch((err) => {
        if (cancelled) return;
        setPageState({ loading: false, error: err.message });
      });
    return () => { cancelled = true; };
  }, [token]);

  // ── Autosave ──────────────────────────────────────────────────────────────
  const persist = useCallback(async (key, value) => {
    setSavingKeys((s) => new Set(s).add(key));
    try {
      await intakePublic.save(token, { [key]: value });
    } catch {
      /* silent — user will retry on next change */
    } finally {
      setSavingKeys((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  }, [token]);

  const handleChange = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    setStepError('');
    clearTimeout(debouncers.current[key]);
    debouncers.current[key] = setTimeout(() => persist(key, value), 600);
  };

  // ── Validation ────────────────────────────────────────────────────────────
  const validate = (stepNum) => {
    const checks =
      stepNum === 1 ? STEP1_FIELDS :
      stepNum === 4 ? STEP4_CONSENT_FIELDS :
      [];
    for (const f of checks) {
      if (!f.required) continue;
      if (f.type === 'checkbox') {
        if (!values[f.key]) return `Please tick: "${f.label.slice(0, 50)}…"`;
      } else {
        if (!String(values[f.key] || '').trim()) return `Please fill in: ${f.label}`;
      }
    }
    return '';
  };

  // ── Navigation ────────────────────────────────────────────────────────────
  const handleNext = () => {
    const err = validate(step);
    if (err) { setStepError(err); return; }
    setStepError('');
    setStep((s) => Math.min(4, s + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleBack = () => {
    setStepError('');
    setStep((s) => Math.max(1, s - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async () => {
    const err = validate(4);
    if (err) { setStepError(err); return; }
    setSubmitting(true);
    setStepError('');
    try {
      await intakePublic.submit(token, values);
      setSubmittedAt(new Date().toISOString());
    } catch (e) {
      setStepError(e.message || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const branding   = data?.organisation || null;
  const primary    = branding?.primary_color || '#1d4ed8';
  const firstName  = data?.participant?.name?.split(' ')[0] || '';
  const expiresAt  = data?.expires_at ? new Date(data.expires_at).toLocaleDateString('en-AU') : '';

  // ── Loading / error / done ────────────────────────────────────────────────
  if (pageState.loading) {
    return (
      <div style={centerStyle}>
        <p style={{ color: '#64748b' }}>Loading your intake form…</p>
      </div>
    );
  }
  if (pageState.error) {
    return (
      <div style={{ ...centerStyle, padding: '2rem' }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <h2 style={{ color: '#b91c1c' }}>This link cannot be opened</h2>
          <p style={{ color: '#475569' }}>{pageState.error}</p>
          <p style={{ color: '#64748b', fontSize: '.85rem' }}>
            If you think this is a mistake, contact your support coordinator.
          </p>
        </div>
      </div>
    );
  }
  if (submittedAt) {
    return (
      <div style={{ ...centerStyle, padding: '2rem', background: '#f8fafc', minHeight: '100vh' }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: '3.5rem', marginBottom: '0.75rem' }}>✅</div>
          <h2 style={{ color: '#15803d', marginTop: 0, fontSize: '1.5rem' }}>Thank you!</h2>
          <p style={{ color: '#334155', fontSize: '1rem', lineHeight: 1.6 }}>
            Your details have been submitted. Your coordinator will be in touch shortly with the next steps.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>

      {/* ── Header ── */}
      <header style={{ background: primary, color: '#fff', padding: '1.2rem 1.5rem' }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div style={{ fontSize: '.8rem', opacity: 0.85, marginBottom: '.2rem' }}>
            {branding?.name || 'Your NDIS provider'}
          </div>
          <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 700 }}>
            {firstName ? `Welcome, ${firstName}` : 'Welcome'}
          </h1>
          <p style={{ margin: '.25rem 0 0', fontSize: '.78rem', opacity: 0.8 }}>
            Your answers save automatically · Link expires {expiresAt}
          </p>
        </div>
      </header>

      {/* ── Step progress ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '.65rem 1.5rem' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
          {STEPS.map((s) => (
            <span
              key={s.num}
              style={{
                padding: '.22rem .65rem',
                borderRadius: 20,
                fontSize: '.78rem',
                fontWeight: step === s.num ? 600 : 400,
                background: step === s.num ? primary : step > s.num ? '#dcfce7' : '#f1f5f9',
                color:      step === s.num ? '#fff'   : step > s.num ? '#166534' : '#64748b',
                border: `1px solid ${step === s.num ? primary : step > s.num ? '#bbf7d0' : '#e2e8f0'}`,
              }}
            >
              {step > s.num ? '✓ ' : `${s.num}. `}{s.title}
            </span>
          ))}
        </div>
      </div>

      {/* ── Main ── */}
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '1.5rem 1rem 3rem' }}>

        {/* ─── Step 1: About you ─── */}
        {step === 1 && (
          <Card title="Step 1 — About you">
            <FieldGrid fields={STEP1_FIELDS} values={values} savingKeys={savingKeys} onChange={handleChange} />
          </Card>
        )}

        {/* ─── Step 2: Contact details ─── */}
        {step === 2 && (
          <Card title="Step 2 — Contact details">
            <p style={hintStyle}>We use these to reach you about appointments, support, and your agreement.</p>
            <FieldGrid fields={STEP2_FIELDS} values={values} savingKeys={savingKeys} onChange={handleChange} />
          </Card>
        )}

        {/* ─── Step 3: NDIS plan ─── */}
        {step === 3 && (
          <Card title="Step 3 — Your NDIS plan">
            <p style={hintStyle}>Leave blank anything you don't have on hand — your coordinator can fill gaps later.</p>
            <FieldGrid fields={STEP3_FIELDS} values={values} savingKeys={savingKeys} onChange={handleChange} />
          </Card>
        )}

        {/* ─── Step 4: Representative & consent ─── */}
        {step === 4 && (
          <>
            <Card title="Step 4 — Representative & consent">
              {/* Representative */}
              <SectionHeading>Primary contact / representative</SectionHeading>
              <p style={hintStyle}>If you have a guardian, parent, or advocate who should be included, add their details below. Leave blank if not applicable.</p>
              <FieldGrid fields={STEP4_REP_FIELDS} values={values} savingKeys={savingKeys} onChange={handleChange} />

              {/* Communication */}
              <SectionHeading style={{ marginTop: '1.5rem' }}>Communication preferences</SectionHeading>
              <FieldGrid fields={STEP4_COMMS_FIELDS} values={values} savingKeys={savingKeys} onChange={handleChange} />

              {/* Consent */}
              <SectionHeading style={{ marginTop: '1.5rem' }}>Consent <span style={{ color: '#b91c1c' }}>*</span></SectionHeading>
              <p style={hintStyle}>Both boxes are required to proceed.</p>
              <div style={{ display: 'grid', gap: '.75rem' }}>
                {STEP4_CONSENT_FIELDS.map((f) => (
                  <ConsentCheckbox
                    key={f.key}
                    field={f}
                    value={values[f.key]}
                    onChange={(v) => handleChange(f.key, v)}
                  />
                ))}
              </div>
            </Card>
          </>
        )}

        {/* ─── Error ─── */}
        {stepError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 8, padding: '.65rem 1rem', marginBottom: '1rem', fontSize: '.88rem' }}>
            {stepError}
          </div>
        )}

        {/* ─── Navigation ─── */}
        <div style={{ display: 'flex', gap: '.75rem', justifyContent: step > 1 ? 'space-between' : 'flex-end' }}>
          {step > 1 && (
            <button onClick={handleBack} style={secondaryBtn}>
              ← Back
            </button>
          )}
          {step < 4 ? (
            <button onClick={handleNext} style={{ ...primaryBtn, background: primary, borderColor: primary }}>
              Continue →
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{ ...primaryBtn, background: primary, borderColor: primary, opacity: submitting ? .7 : 1 }}
            >
              {submitting ? 'Submitting…' : 'Submit my intake ✓'}
            </button>
          )}
        </div>

        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: '.75rem', marginTop: '1.5rem' }}>
          Your answers save automatically as you type. You can close this window and return using the same link.
        </p>
      </main>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Card({ title, children }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '1.4rem', boxShadow: '0 1px 4px rgba(15,23,42,.08)', marginBottom: '1rem' }}>
      <h2 style={{ margin: '0 0 1.1rem', fontSize: '1.05rem', color: '#1e293b', fontWeight: 700 }}>{title}</h2>
      {children}
    </div>
  );
}

function SectionHeading({ children, style }) {
  return (
    <h3 style={{ fontSize: '.82rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.05em', margin: '0 0 .6rem', ...style }}>
      {children}
    </h3>
  );
}

function FieldGrid({ fields, values, savingKeys, onChange }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '.7rem' }}>
      {fields.map((f) => (
        <FieldInput key={f.key} field={f} value={values[f.key]} saving={savingKeys.has(f.key)} onChange={(v) => onChange(f.key, v)} />
      ))}
    </div>
  );
}

function FieldInput({ field, value, saving, onChange }) {
  const label = (
    <span style={{ display: 'block', fontSize: '.8rem', color: '#475569', fontWeight: 600, marginBottom: '.22rem' }}>
      {field.label}
      {field.required && <span style={{ color: '#b91c1c' }}> *</span>}
      {field.optional && <span style={{ color: '#94a3b8', fontWeight: 400 }}> (optional)</span>}
      {saving && <span style={{ color: '#94a3b8', fontWeight: 400 }}> · saving…</span>}
    </span>
  );

  if (field.type === 'select') {
    return (
      <label>
        {label}
        <select value={value || ''} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
          {(field.options || []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
    );
  }

  if (field.type === 'textarea') {
    return (
      <label style={{ gridColumn: '1 / -1' }}>
        {label}
        <textarea
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </label>
    );
  }

  return (
    <label>
      {label}
      <input
        type={field.type || 'text'}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        inputMode={field.inputMode}
        style={inputStyle}
      />
    </label>
  );
}

function ConsentCheckbox({ field, value, onChange }) {
  const checked = Boolean(value) && value !== 'false' && value !== '';
  return (
    <label
      style={{
        display: 'flex',
        gap: '.75rem',
        alignItems: 'flex-start',
        padding: '.75rem',
        borderRadius: 8,
        border: `1px solid ${checked ? '#bbf7d0' : '#e2e8f0'}`,
        background: checked ? '#f0fdf4' : '#fafafa',
        cursor: 'pointer',
        fontSize: '.9rem',
        color: '#334155',
        lineHeight: 1.5,
        transition: 'background .15s, border-color .15s',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked ? '1' : '')}
        style={{ width: 18, height: 18, flexShrink: 0, marginTop: 2 }}
      />
      <span>{field.label}</span>
    </label>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const centerStyle = { minHeight: '100vh', display: 'grid', placeItems: 'center' };

const inputStyle = {
  width: '100%',
  padding: '.55rem .65rem',
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  fontSize: '.9rem',
  background: '#fff',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

const primaryBtn = {
  padding: '.65rem 1.5rem',
  borderRadius: 8,
  color: '#fff',
  border: '2px solid transparent',
  fontSize: '.95rem',
  fontWeight: 600,
  cursor: 'pointer',
  background: '#1d4ed8',
};

const secondaryBtn = {
  padding: '.65rem 1.2rem',
  borderRadius: 8,
  color: '#475569',
  border: '1px solid #cbd5e1',
  fontSize: '.95rem',
  cursor: 'pointer',
  background: '#fff',
};

const hintStyle = {
  color: '#64748b',
  fontSize: '.88rem',
  margin: '-.25rem 0 .9rem',
};
