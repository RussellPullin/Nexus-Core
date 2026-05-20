import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { getSupabaseBrowserClient } from '../lib/supabaseClient';
import { auth as authApi, organisations as orgApi } from '../lib/api';
import { useAuth } from '../context/AuthContext';

/**
 * Phase 1: Multi-step org setup wizard.
 *
 * Steps:
 *   1. Identity        — trading + legal name, ABN, ACN, NDIS provider number, products
 *   2. Contact         — address(es), phone, email, website, primary contact person
 *   3. Branding        — logo upload, primary + accent colour, letterhead footer
 *   4. Signatory       — default signing officer used on every document
 *   5. Banking         — used by invoices & service agreements
 *   6. Review + Finish — confirms, fires seedOrgFromMasters, hands off to dashboard
 *
 * Step 1 still creates the underlying organisation record through `supabaseRegisterOrg`
 * (legacy behaviour); the subsequent steps PUT incremental updates to
 * `/api/organisations/me/profile`, finishing with `setup_completed=true` which triggers
 * `seedOrgFromMasters` on the server.
 */
export default function SetupOrgPage() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [noSession, setNoSession] = useState(false);
  const [orgCreated, setOrgCreated] = useState(false);

  // Step 1 — identity / org creation
  const [tradingName, setTradingName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [abn, setAbn] = useState('');
  const [acn, setAcn] = useState('');
  const [ndisProviderNumber, setNdisProviderNumber] = useState('');
  const [coordinationProduct, setCoordinationProduct] = useState(false);
  const [agencyProduct, setAgencyProduct] = useState(true);

  // Step 2 — contact
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [streetAddress, setStreetAddress] = useState('');
  const [postalAddress, setPostalAddress] = useState('');
  const [primaryContactName, setPrimaryContactName] = useState('');
  const [primaryContactRole, setPrimaryContactRole] = useState('');
  const [primaryContactEmail, setPrimaryContactEmail] = useState('');
  const [primaryContactPhone, setPrimaryContactPhone] = useState('');

  // Step 3 — branding
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreview, setLogoPreview] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#1d4ed8');
  const [accentColor, setAccentColor] = useState('#0ea5e9');
  const [letterheadFooter, setLetterheadFooter] = useState('');

  // Step 4 — signatory
  const [signatoryName, setSignatoryName] = useState('');
  const [signatoryRole, setSignatoryRole] = useState('');
  const [signatoryEmail, setSignatoryEmail] = useState('');

  // Step 5 — banking
  const [bankName, setBankName] = useState('');
  const [bsb, setBsb] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [xeroShortCode, setXeroShortCode] = useState('');

  useEffect(() => {
    const sb = getSupabaseBrowserClient();
    if (!sb) {
      setNoSession(true);
      return;
    }
    sb.auth.getSession().then(({ data: { session } }) => {
      if (!session?.access_token) setNoSession(true);
    });
  }, []);

  const handleLogoFile = (file) => {
    setLogoFile(file || null);
    if (file) {
      const url = URL.createObjectURL(file);
      setLogoPreview(url);
    } else {
      setLogoPreview('');
    }
  };

  const validateStep = () => {
    setError('');
    if (step === 1) {
      if (!tradingName.trim()) return 'Trading name is required.';
      if (!coordinationProduct && !agencyProduct) return 'Select at least one product.';
    }
    if (step === 2) {
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Enter a valid org email.';
    }
    return null;
  };

  const persistStep = async () => {
    if (step === 1 && !orgCreated) {
      // Create the underlying org row first via Supabase + auth endpoint.
      const sb = getSupabaseBrowserClient();
      if (!sb) {
        setNoSession(true);
        throw new Error('Sign-in is not set up in this app.');
      }
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) {
        setNoSession(true);
        throw new Error('No session');
      }
      await authApi.supabaseRegisterOrg(session.access_token, tradingName.trim(), {
        coordination_enabled: coordinationProduct,
        agency_enabled: agencyProduct
      });
      await refreshUser();
      setOrgCreated(true);
    }

    // From step 1 onwards, every step PUTs the relevant fields to the org profile.
    const payload = {};
    if (step === 1) {
      payload.trading_name = tradingName.trim();
      payload.legal_name = legalName.trim() || tradingName.trim();
      payload.abn = abn.trim();
      payload.acn = acn.trim();
      payload.ndis_reg_number = ndisProviderNumber.trim();
    } else if (step === 2) {
      payload.email = email.trim();
      payload.phone = phone.trim();
      payload.website = website.trim();
      payload.street_address = streetAddress.trim();
      payload.postal_address = postalAddress.trim();
      payload.address = streetAddress.trim() || postalAddress.trim();
      payload.primary_contact_name = primaryContactName.trim();
      payload.primary_contact_role = primaryContactRole.trim();
      payload.primary_contact_email = primaryContactEmail.trim();
      payload.primary_contact_phone = primaryContactPhone.trim();
    } else if (step === 3) {
      payload.brand_primary_color = primaryColor;
      payload.brand_accent_color = accentColor;
      payload.letterhead_footer_text = letterheadFooter.trim();
      if (logoFile) {
        await orgApi.uploadMyLogo(logoFile);
      }
    } else if (step === 4) {
      payload.default_signatory_name = signatoryName.trim() || primaryContactName.trim();
      payload.default_signatory_role = signatoryRole.trim() || primaryContactRole.trim();
      payload.default_signatory_email = signatoryEmail.trim() || primaryContactEmail.trim();
    } else if (step === 5) {
      payload.bank_name = bankName.trim();
      payload.bsb = bsb.trim();
      payload.account_name = accountName.trim() || tradingName.trim();
      payload.account_number = accountNumber.trim();
      payload.xero_short_code = xeroShortCode.trim();
    }

    if (Object.keys(payload).length) {
      await orgApi.updateMyProfile(payload);
    }
  };

  const handleNext = async (e) => {
    e?.preventDefault();
    const v = validateStep();
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    try {
      await persistStep();
      setStep((s) => s + 1);
    } catch (err) {
      setError(err.message || 'Could not save this step');
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async () => {
    setError('');
    setBusy(true);
    try {
      await orgApi.updateMyProfile({ setup_completed: true });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Could not finalise setup');
    } finally {
      setBusy(false);
    }
  };

  if (noSession) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="login-subtitle">Sign in first</p>
          <p style={{ marginBottom: '1rem', color: '#64748b' }}>
            You need to be signed in to create your organisation. Open the link from your email or sign in again.
          </p>
          <Link to="/login" className="btn btn-primary">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page" style={{ alignItems: 'flex-start', paddingTop: '3rem' }}>
      <div className="login-card" style={{ maxWidth: 640 }}>
        <img src="/logo.png" alt="NexusCore" className="login-logo" />
        <p className="login-tagline">Where paperwork disappears.</p>
        <p className="login-subtitle">Set up your organisation</p>
        <Stepper currentStep={step} />
        {error && <div className="login-error">{error}</div>}

        {step === 1 && (
          <form onSubmit={handleNext}>
            <Section title="Identity">
              <Field label="Trading name *" value={tradingName} onChange={setTradingName} autoComplete="organization" required />
              <Field label="Legal name (if different)" value={legalName} onChange={setLegalName} />
              <TwoCol>
                <Field label="ABN" value={abn} onChange={setAbn} />
                <Field label="ACN (optional)" value={acn} onChange={setAcn} />
              </TwoCol>
              <Field label="NDIS provider number" value={ndisProviderNumber} onChange={setNdisProviderNumber} />
            </Section>
            <Section title="Products">
              <label style={{ display: 'flex', gap: '.4rem', marginBottom: '.3rem' }}>
                <input type="checkbox" checked={coordinationProduct} onChange={(e) => setCoordinationProduct(e.target.checked)} />
                Nexus Coordination — planning, allocations, plan-manager workflows
              </label>
              <label style={{ display: 'flex', gap: '.4rem' }}>
                <input type="checkbox" checked={agencyProduct} onChange={(e) => setAgencyProduct(e.target.checked)} />
                Nexus Agency — staff, Shifter, shifts & payroll-oriented admin
              </label>
            </Section>
            <StepButtons busy={busy} canBack={false} onBack={() => {}} nextLabel="Continue" />
          </form>
        )}

        {step === 2 && (
          <form onSubmit={handleNext}>
            <Section title="Contact details">
              <Field label="Organisation email" value={email} onChange={setEmail} type="email" />
              <Field label="Phone" value={phone} onChange={setPhone} />
              <Field label="Website" value={website} onChange={setWebsite} />
              <Field label="Street address" value={streetAddress} onChange={setStreetAddress} />
              <Field label="Postal address" value={postalAddress} onChange={setPostalAddress} />
            </Section>
            <Section title="Primary contact person">
              <Field label="Name" value={primaryContactName} onChange={setPrimaryContactName} />
              <Field label="Role" value={primaryContactRole} onChange={setPrimaryContactRole} />
              <TwoCol>
                <Field label="Email" value={primaryContactEmail} onChange={setPrimaryContactEmail} type="email" />
                <Field label="Phone" value={primaryContactPhone} onChange={setPrimaryContactPhone} />
              </TwoCol>
            </Section>
            <StepButtons busy={busy} onBack={() => setStep(1)} nextLabel="Continue" />
          </form>
        )}

        {step === 3 && (
          <form onSubmit={handleNext}>
            <Section title="Brand">
              <label style={{ display: 'block', marginBottom: '.5rem', fontSize: '.85rem', color: '#475569' }}>
                Logo (PNG, JPG or SVG — max 4 MB)
              </label>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => handleLogoFile(e.target.files?.[0] || null)}
                style={{ marginBottom: '.75rem' }}
              />
              {logoPreview && (
                <div style={{ marginBottom: '.75rem' }}>
                  <img src={logoPreview} alt="Logo preview" style={{ maxHeight: 80 }} />
                </div>
              )}
              <TwoCol>
                <Field label="Primary brand colour" value={primaryColor} onChange={setPrimaryColor} type="color" />
                <Field label="Accent colour" value={accentColor} onChange={setAccentColor} type="color" />
              </TwoCol>
              <Field label="Letterhead footer text" value={letterheadFooter} onChange={setLetterheadFooter} placeholder="e.g. Confidential — © Your Org" />
            </Section>
            <StepButtons busy={busy} onBack={() => setStep(2)} nextLabel="Continue" />
          </form>
        )}

        {step === 4 && (
          <form onSubmit={handleNext}>
            <Section title="Default signatory">
              <p style={{ fontSize: '.85rem', color: '#64748b', marginBottom: '.6rem' }}>
                This person's name &amp; role will appear on every signed Service Agreement, consent and contract by default.
                You can still override per-document later.
              </p>
              <Field label="Name" value={signatoryName} onChange={setSignatoryName} placeholder={primaryContactName} />
              <Field label="Role / title" value={signatoryRole} onChange={setSignatoryRole} placeholder={primaryContactRole || 'Director'} />
              <Field label="Email" value={signatoryEmail} onChange={setSignatoryEmail} type="email" placeholder={primaryContactEmail} />
            </Section>
            <StepButtons busy={busy} onBack={() => setStep(3)} nextLabel="Continue" />
          </form>
        )}

        {step === 5 && (
          <form onSubmit={handleNext}>
            <Section title="Banking (for invoices)">
              <Field label="Bank name" value={bankName} onChange={setBankName} />
              <TwoCol>
                <Field label="BSB" value={bsb} onChange={setBsb} />
                <Field label="Account number" value={accountNumber} onChange={setAccountNumber} />
              </TwoCol>
              <Field label="Account name" value={accountName} onChange={setAccountName} placeholder={tradingName} />
              <Field label="Xero short code (optional)" value={xeroShortCode} onChange={setXeroShortCode} />
            </Section>
            <StepButtons busy={busy} onBack={() => setStep(4)} nextLabel="Review" />
          </form>
        )}

        {step === 6 && (
          <div>
            <Section title="Review">
              <Summary label="Organisation" lines={[tradingName, legalName !== tradingName ? `Legal: ${legalName || tradingName}` : null, abn ? `ABN ${abn}` : null, ndisProviderNumber ? `NDIS ${ndisProviderNumber}` : null]} />
              <Summary label="Contact" lines={[email, phone, website, streetAddress, postalAddress]} />
              <Summary label="Primary contact" lines={[primaryContactName, primaryContactRole, primaryContactEmail, primaryContactPhone]} />
              <Summary label="Brand" lines={[logoFile ? `Logo: ${logoFile.name}` : null, `Primary ${primaryColor}`, `Accent ${accentColor}`]} />
              <Summary label="Signatory" lines={[signatoryName || primaryContactName, signatoryRole || primaryContactRole, signatoryEmail || primaryContactEmail]} />
              <Summary label="Banking" lines={[bankName, bsb && accountNumber ? `${bsb} / ${accountNumber}` : null, accountName || tradingName]} />
            </Section>
            <p style={{ fontSize: '.85rem', color: '#475569', marginBottom: '1rem' }}>
              When you finish, Nexus Core will clone every template in our master document library into your org — so every
              policy, register and form is ready to use, pre-branded with the details above.
            </p>
            <div style={{ display: 'flex', gap: '.5rem' }}>
              <button type="button" className="btn" onClick={() => setStep(5)} disabled={busy}>Back</button>
              <button type="button" className="btn btn-primary" onClick={handleFinish} disabled={busy}>
                {busy ? 'Finalising…' : 'Finish & enter Nexus Core'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stepper({ currentStep }) {
  const labels = ['Identity', 'Contact', 'Brand', 'Signatory', 'Banking', 'Review'];
  return (
    <div style={{ display: 'flex', gap: '.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
      {labels.map((l, i) => {
        const n = i + 1;
        const active = currentStep === n;
        const done = currentStep > n;
        return (
          <div
            key={l}
            style={{
              padding: '.25rem .55rem',
              borderRadius: 16,
              fontSize: '.75rem',
              border: '1px solid',
              borderColor: active ? '#1d4ed8' : done ? '#10b981' : '#cbd5e1',
              color: active ? '#1d4ed8' : done ? '#10b981' : '#64748b',
              background: active ? '#eff6ff' : 'transparent'
            }}
          >
            {n}. {l}
          </div>
        );
      })}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ fontWeight: 600, marginBottom: '.4rem', fontSize: '.95rem', color: '#1e293b' }}>{title}</div>
      {children}
    </div>
  );
}

function TwoCol({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.5rem' }}>{children}</div>;
}

function Field({ label, value, onChange, type = 'text', placeholder, required, autoComplete }) {
  return (
    <label style={{ display: 'block', marginBottom: '.5rem', fontSize: '.85rem', color: '#475569' }}>
      <div style={{ marginBottom: '.2rem' }}>{label}</div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="login-input"
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        style={{ marginBottom: 0 }}
      />
    </label>
  );
}

function StepButtons({ busy, onBack, nextLabel, canBack = true }) {
  return (
    <div style={{ display: 'flex', gap: '.5rem' }}>
      {canBack && (
        <button type="button" className="btn" onClick={onBack} disabled={busy}>
          Back
        </button>
      )}
      <button type="submit" className="btn btn-primary" disabled={busy} style={{ flex: 1 }}>
        {busy ? 'Saving…' : nextLabel}
      </button>
    </div>
  );
}

function Summary({ label, lines }) {
  const cleaned = (lines || []).filter(Boolean);
  if (!cleaned.length) return null;
  return (
    <div style={{ marginBottom: '.6rem' }}>
      <div style={{ fontSize: '.7rem', fontWeight: 600, color: '#1e293b', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: '.85rem', color: '#334155' }}>{cleaned.join(' · ')}</div>
    </div>
  );
}
