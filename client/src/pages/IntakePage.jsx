import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { intakePublic } from '../lib/api';

/**
 * Phase 4: Public participant self-service intake page.
 *
 * Token-authenticated, no Nexus login required. Autosaves every field on blur. On submit
 * the server marks the token completed and ensures the participant has an onboarding row
 * so a coordinator can click "Run onboarding" in one step.
 */

const SECTIONS = [
  {
    id: 'identity',
    title: 'About you',
    fields: [
      { key: 'first_name', label: 'First name' },
      { key: 'last_name', label: 'Last name' },
      { key: 'date_of_birth', label: 'Date of birth', type: 'date' },
      { key: 'pronouns', label: 'Pronouns' },
      { key: 'preferred_language', label: 'Preferred language' }
    ]
  },
  {
    id: 'contact',
    title: 'Contact details',
    fields: [
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'phone', label: 'Phone' },
      { key: 'mobile_phone', label: 'Mobile' },
      { key: 'street_address', label: 'Street address' },
      { key: 'suburb_city', label: 'Suburb / City' },
      { key: 'state', label: 'State' },
      { key: 'postcode', label: 'Postcode' }
    ]
  },
  {
    id: 'ndis',
    title: 'NDIS plan',
    fields: [
      { key: 'ndis_number', label: 'NDIS number' },
      { key: 'plan_start', label: 'Plan start', type: 'date' },
      { key: 'plan_end', label: 'Plan end', type: 'date' },
      { key: 'plan_manager_name', label: 'Plan manager (if any)' },
      { key: 'support_coordinator_name', label: 'Support coordinator (if any)' }
    ]
  },
  {
    id: 'representative',
    title: 'Primary contact / representative',
    fields: [
      { key: 'representative_first_name', label: 'First name' },
      { key: 'representative_last_name', label: 'Last name' },
      { key: 'representative_relationship', label: 'Relationship' },
      { key: 'representative_phone', label: 'Phone' },
      { key: 'representative_email', label: 'Email', type: 'email' }
    ]
  },
  {
    id: 'preferences',
    title: 'Communication & preferences',
    fields: [
      { key: 'preferred_contact_method', label: 'Preferred contact method (email / phone / SMS)' },
      { key: 'communication_notes', label: 'Anything else we should know to communicate well with you?', type: 'textarea' }
    ]
  },
  {
    id: 'consent',
    title: 'Consent',
    fields: [
      { key: 'consent_privacy', label: 'I consent to the collection and storage of my personal information for the purposes of NDIS support delivery.', type: 'checkbox' },
      { key: 'consent_share_with_providers', label: 'I consent to sharing necessary information with my support workers and approved providers.', type: 'checkbox' }
    ]
  }
];

export default function IntakePage() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: '', code: '' });
  const [data, setData] = useState(null);
  const [values, setValues] = useState({});
  const [savingKeys, setSavingKeys] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submittedAt, setSubmittedAt] = useState(null);
  const debouncers = useRef({});

  useEffect(() => {
    let cancelled = false;
    intakePublic
      .load(token)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setValues(res?.saved_fields || {});
        setState({ loading: false, error: '', code: '' });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, error: err.message, code: err.code || 'ERR' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const persist = useCallback(async (key, value) => {
    setSavingKeys((s) => new Set(s).add(key));
    try {
      await intakePublic.save(token, { [key]: value });
    } catch (err) {
      console.warn('[intake] save failed', err);
    } finally {
      setSavingKeys((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }, [token]);

  const handleChange = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (debouncers.current[key]) clearTimeout(debouncers.current[key]);
    debouncers.current[key] = setTimeout(() => persist(key, value), 600);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await intakePublic.submit(token, values);
      setSubmittedAt(new Date().toISOString());
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setSubmitting(false);
    }
  };

  const branding = data?.organisation || null;
  const headerStyle = useMemo(() => ({
    background: branding?.primary_color || '#1d4ed8',
    color: '#fff',
    padding: '1.2rem 1.5rem'
  }), [branding]);

  if (state.loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <p>Loading your intake form…</p>
      </div>
    );
  }
  if (state.error) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <h2 style={{ color: '#b91c1c' }}>This link cannot be opened</h2>
          <p style={{ color: '#475569' }}>{state.error}</p>
          <p style={{ color: '#64748b', fontSize: '.85rem' }}>If you think this is a mistake, contact your support coordinator.</p>
        </div>
      </div>
    );
  }
  if (submittedAt) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <h2 style={{ color: '#15803d' }}>Thank you</h2>
          <p style={{ color: '#334155' }}>Your details have been submitted. Your coordinator will be in touch shortly with the next steps.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      <header style={headerStyle}>
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <div>
            <div style={{ fontSize: '.8rem', opacity: 0.85 }}>{branding?.name || 'Your provider'}</div>
            <h1 style={{ margin: '.2rem 0 0', fontSize: '1.4rem' }}>Welcome, {data?.participant?.name || 'there'}</h1>
          </div>
          <div style={{ fontSize: '.75rem', opacity: 0.85 }}>
            Saves automatically · Expires {new Date(data?.expires_at).toLocaleDateString('en-AU')}
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '1.5rem' }}>
        <p style={{ color: '#475569', marginBottom: '1.5rem' }}>
          Please complete the sections below. Your answers save automatically as you type, so feel free to close this window
          and come back later using the same link.
        </p>

        {SECTIONS.map((section) => (
          <section key={section.id} style={cardStyle}>
            <h3 style={{ margin: '0 0 .75rem' }}>{section.title}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '.75rem' }}>
              {section.fields.map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={values[f.key]}
                  onChange={(v) => handleChange(f.key, v)}
                  saving={savingKeys.has(f.key)}
                />
              ))}
            </div>
          </section>
        ))}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              padding: '.7rem 1.4rem',
              borderRadius: 8,
              background: branding?.primary_color || '#1d4ed8',
              color: '#fff',
              border: 'none',
              fontSize: '1rem',
              cursor: 'pointer',
              opacity: submitting ? 0.6 : 1
            }}
          >
            {submitting ? 'Submitting…' : 'Submit my intake'}
          </button>
        </div>
      </main>
    </div>
  );
}

const cardStyle = {
  background: '#fff',
  padding: '1rem 1.25rem',
  borderRadius: 10,
  marginBottom: '1rem',
  boxShadow: '0 1px 3px rgba(15,23,42,0.06)'
};

function FieldInput({ field, value, onChange, saving }) {
  const labelStyle = { display: 'block', fontSize: '.8rem', color: '#475569', marginBottom: '.2rem' };
  const inputStyle = {
    width: '100%',
    padding: '.55rem .65rem',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: '.9rem',
    background: '#fff'
  };

  if (field.type === 'checkbox') {
    return (
      <label style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start', gridColumn: '1 / -1', fontSize: '.88rem', color: '#334155' }}>
        <input
          type="checkbox"
          checked={Boolean(value) && value !== 'false'}
          onChange={(e) => onChange(e.target.checked ? '1' : '')}
          style={{ marginTop: 3 }}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.type === 'textarea') {
    return (
      <label style={{ gridColumn: '1 / -1' }}>
        <span style={labelStyle}>{field.label}{saving ? ' · saving…' : ''}</span>
        <textarea
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </label>
    );
  }
  return (
    <label>
      <span style={labelStyle}>{field.label}{saving ? ' · saving…' : ''}</span>
      <input
        type={field.type || 'text'}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
  );
}
