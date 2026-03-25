import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import '../App.css';

const API = '/api';

const STEPS = [
  { num: 1, title: 'Personal details' },
  { num: 2, title: 'Employment details' },
  { num: 3, title: 'Compliance documents' },
  { num: 4, title: 'Policy acknowledgement' },
  { num: 5, title: 'Tax File Declaration' },
];

const DOCUMENT_TYPES = [
  { key: 'drivers_licence_front', label: "Driver's licence (front)" },
  { key: 'drivers_licence_back', label: "Driver's licence (back)" },
  { key: 'blue_card', label: 'Blue Card (Working With Children Check)' },
  { key: 'yellow_card', label: 'Yellow Card (Disability Worker Screening)' },
  { key: 'first_aid', label: 'First Aid Certificate' },
  { key: 'car_insurance', label: 'Car insurance certificate' },
];

const ATO_TFD_URL = 'https://www.ato.gov.au/forms-and-instructions/tfn-declaration';

export default function StaffOnboardingFormPage() {
  const { token } = useParams();
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const [step1, setStep1] = useState({ full_name: '', date_of_birth: '', address: '', phone: '', emergency_contact_name: '', emergency_contact_phone: '' });
  const [step2, setStep2] = useState({ role: '', employment_type: 'employee', hourly_rate: '', abn: '', tfn: '', super_fund_name: '', super_member_number: '', bank_bsb: '', bank_account: '' });
  const [complianceDocs, setComplianceDocs] = useState({});
  const [policyAck, setPolicyAck] = useState(false);
  const [signature, setSignature] = useState('');
  const [tfdConfirmed, setTfdConfirmed] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('Missing link');
      setLoading(false);
      return;
    }
    fetch(`${API}/public/staff-onboarding/${token}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Invalid or expired link' : 'Failed to load');
        return r.json();
      })
      .then((data) => {
        setContext(data);
        if (data.staff) {
          setStep1((s) => ({ ...s, full_name: data.staff.name || '', phone: data.staff.phone || '' }));
          setStep2((s) => ({
            ...s,
            role: data.staff.role || '',
            employment_type: data.staff.employment_type || 'employee',
            hourly_rate: data.staff.hourly_rate != null ? String(data.staff.hourly_rate) : '',
          }));
        }
        setStep(data.currentStep || 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const saveStep = async (stepNum, data) => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/public/staff-onboarding/${token}/step`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: stepNum, data }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Save failed');
      }
      const out = await res.json();
      if (out.currentStep != null) setStep(out.currentStep);
    } finally {
      setSaving(false);
    }
  };

  const uploadDocument = async (documentType, file, expiryDate) => {
    const form = new FormData();
    form.append('file', file);
    form.append('document_type', documentType);
    if (expiryDate) form.append('expiry_date', expiryDate);
    const res = await fetch(`${API}/public/staff-onboarding/${token}/upload-document`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Upload failed');
    }
    return res.json();
  };

  const handleNext = async () => {
    if (step === 1) await saveStep(1, step1);
    if (step === 2) await saveStep(2, step2);
    if (step === 3) {
      for (const { key } of DOCUMENT_TYPES) {
        const entry = complianceDocs[key];
        if (entry?.file) {
          await uploadDocument(key, entry.file, entry.expiry_date || undefined);
        }
      }
      await saveStep(3, { documents: Object.keys(complianceDocs).filter((k) => complianceDocs[k]?.file) });
    }
    if (step === 4) await saveStep(4, { policy_acknowledged: policyAck, signature });
    if (step === 5) {
      await saveStep(5, { tfd_confirmed: tfdConfirmed });
      setSaving(true);
      try {
        const res = await fetch(`${API}/public/staff-onboarding/${token}/submit`, { method: 'POST', credentials: 'include' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Submit failed');
        }
        setSubmitSuccess(true);
      } finally {
        setSaving(false);
      }
      return;
    }
    setStep((s) => Math.min(5, s + 1));
  };

  const handleBack = () => setStep((s) => Math.max(1, s - 1));

  const setCompliance = (key, field, value) => {
    setComplianceDocs((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), [field]: value } }));
  };

  const docStatus = (expiryDate) => {
    if (!expiryDate) return null;
    const exp = new Date(expiryDate);
    const now = new Date();
    if (exp < now) return { label: 'Expired', class: 'expired' };
    const days = (exp - now) / (24 * 60 * 60 * 1000);
    if (days <= 30) return { label: 'Expiring soon', class: 'expiring' };
    return { label: 'Valid', class: 'valid' };
  };

  if (loading) {
    return (
      <div className="staff-onboarding-wrap" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8' }}>
        <p>Loading...</p>
      </div>
    );
  }
  if (error || !context) {
    return (
      <div className="staff-onboarding-wrap" style={{ minHeight: '100vh', padding: '2rem', background: '#f5f6f8' }}>
        <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
          <h2 style={{ color: '#1e293b' }}>Invalid link</h2>
          <p>{error || 'This onboarding link is invalid or has expired. Please contact your manager.'}</p>
        </div>
      </div>
    );
  }
  if (submitSuccess) {
    return (
      <div className="staff-onboarding-wrap" style={{ minHeight: '100vh', padding: '2rem', background: '#f5f6f8' }}>
        <div className="card" style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ color: '#22c55e' }}>Onboarding complete</h2>
          <p>Thank you. Your details have been submitted. Your manager will be notified.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="staff-onboarding-wrap" style={{ minHeight: '100vh', background: '#f5f6f8', padding: '1.5rem' }}>
      <header style={{ marginBottom: '1.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem', color: '#1e293b' }}>Nexus Core – Staff Onboarding</h1>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
          {STEPS.map((s) => (
            <span
              key={s.num}
              style={{
                padding: '0.25rem 0.5rem',
                borderRadius: 4,
                fontSize: '0.8rem',
                background: step === s.num ? '#3b82f6' : (step > s.num ? '#e0e7ff' : '#e2e8f0'),
                color: step === s.num ? '#fff' : '#475569',
              }}
            >
              {s.num}. {s.title}
            </span>
          ))}
        </div>
      </header>

      <div className="card" style={{ maxWidth: 640, margin: '0 auto' }}>
        {step === 1 && (
          <>
            <h3 style={{ marginTop: 0 }}>Personal details</h3>
            <div className="form-group">
              <label>Full name *</label>
              <input className="form-input" value={step1.full_name} onChange={(e) => setStep1({ ...step1, full_name: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Date of birth *</label>
              <input type="date" className="form-input" value={step1.date_of_birth} onChange={(e) => setStep1({ ...step1, date_of_birth: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Address *</label>
              <input className="form-input" value={step1.address} onChange={(e) => setStep1({ ...step1, address: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Phone number *</label>
              <input type="tel" className="form-input" value={step1.phone} onChange={(e) => setStep1({ ...step1, phone: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Emergency contact name *</label>
              <input className="form-input" value={step1.emergency_contact_name} onChange={(e) => setStep1({ ...step1, emergency_contact_name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Emergency contact phone *</label>
              <input type="tel" className="form-input" value={step1.emergency_contact_phone} onChange={(e) => setStep1({ ...step1, emergency_contact_phone: e.target.value })} />
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h3 style={{ marginTop: 0 }}>Employment details</h3>
            <div className="form-group">
              <label>Role / position *</label>
              <input className="form-input" value={step2.role} onChange={(e) => setStep2({ ...step2, role: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Employment type</label>
              <select className="form-input" value={step2.employment_type} onChange={(e) => setStep2({ ...step2, employment_type: e.target.value })}>
                <option value="employee">Employee</option>
                <option value="subcontractor">Subcontractor</option>
              </select>
            </div>
            <div className="form-group">
              <label>Hourly rate *</label>
              <input type="number" step="0.01" min="0" className="form-input" value={step2.hourly_rate} onChange={(e) => setStep2({ ...step2, hourly_rate: e.target.value })} />
            </div>
            {step2.employment_type === 'subcontractor' && (
              <div className="form-group">
                <label>ABN</label>
                <input className="form-input" value={step2.abn} onChange={(e) => setStep2({ ...step2, abn: e.target.value })} placeholder="e.g. 12 345 678 901" />
              </div>
            )}
            <div className="form-group">
              <label>Tax File Number</label>
              <input className="form-input" type="password" autoComplete="off" value={step2.tfn} onChange={(e) => setStep2({ ...step2, tfn: e.target.value })} placeholder="Stored securely" />
            </div>
            <div className="form-group">
              <label>Superannuation fund name</label>
              <input className="form-input" value={step2.super_fund_name} onChange={(e) => setStep2({ ...step2, super_fund_name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Superannuation member number</label>
              <input className="form-input" value={step2.super_member_number} onChange={(e) => setStep2({ ...step2, super_member_number: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Bank BSB (for payroll)</label>
              <input className="form-input" value={step2.bank_bsb} onChange={(e) => setStep2({ ...step2, bank_bsb: e.target.value })} placeholder="e.g. 000-000" />
            </div>
            <div className="form-group">
              <label>Bank account number</label>
              <input className="form-input" type="password" autoComplete="off" value={step2.bank_account} onChange={(e) => setStep2({ ...step2, bank_account: e.target.value })} placeholder="Stored securely" />
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h3 style={{ marginTop: 0 }}>Compliance documents</h3>
            <p style={{ color: '#64748b', marginBottom: '1rem' }}>Upload image or PDF for each. Add expiry date if known (or it will be requested later).</p>
            {DOCUMENT_TYPES.map(({ key, label }) => (
              <div key={key} className="card" style={{ marginBottom: '1rem', padding: '1rem' }}>
                <div className="form-group">
                  <label>{label}</label>
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    onChange={(e) => setCompliance(key, 'file', e.target.files?.[0] || null)}
                  />
                </div>
                <div className="form-group">
                  <label>Expiry date (if applicable)</label>
                  <input
                    type="date"
                    className="form-input"
                    value={complianceDocs[key]?.expiry_date || ''}
                    onChange={(e) => setCompliance(key, 'expiry_date', e.target.value)}
                  />
                </div>
                {complianceDocs[key]?.expiry_date && (
                  <span style={{ fontSize: '0.85rem', fontWeight: 500, color: docStatus(complianceDocs[key].expiry_date)?.class === 'expired' ? '#dc2626' : docStatus(complianceDocs[key].expiry_date)?.class === 'expiring' ? '#d97706' : '#16a34a' }}>
                    {docStatus(complianceDocs[key].expiry_date)?.label}
                  </span>
                )}
              </div>
            ))}
          </>
        )}

        {step === 4 && (
          <>
            <h3 style={{ marginTop: 0 }}>Policy acknowledgement</h3>
            {context.policyFiles?.length > 0 ? (
              <ul style={{ marginBottom: '1rem' }}>
                {context.policyFiles.map((p) => (
                  <li key={p.id}>
                    <a href={`${API}/public/staff-onboarding/${token}/policy/${p.id}`} target="_blank" rel="noopener noreferrer">{p.display_name}</a>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ color: '#64748b', marginBottom: '1rem' }}>Policy documents were attached to your welcome email. Please read them before acknowledging below.</p>
            )}
            <div className="form-group">
              <label>
                <input type="checkbox" checked={policyAck} onChange={(e) => setPolicyAck(e.target.checked)} />
                I confirm I have read and understood all policies and procedures *
              </label>
            </div>
            <div className="form-group">
              <label>Digital signature (type your full name) *</label>
              <input className="form-input" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Full name" />
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <h3 style={{ marginTop: 0 }}>Tax File Declaration</h3>
            <p>
              <a href={ATO_TFD_URL} target="_blank" rel="noopener noreferrer">Complete the ATO Tax File Number declaration</a> and submit as required. Your employer will collect the signed copy separately.
            </p>
            <div className="form-group">
              <label>
                <input type="checkbox" checked={tfdConfirmed} onChange={(e) => setTfdConfirmed(e.target.checked)} />
                I confirm I have completed and submitted my Tax File Declaration *
              </label>
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem' }}>
          {step > 1 && (
            <button type="button" className="btn btn-secondary" onClick={handleBack} disabled={saving}>Back</button>
          )}
          <button type="button" className="btn btn-primary" onClick={handleNext} disabled={saving}>
            {saving ? 'Saving…' : step === 5 ? 'Submit' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
