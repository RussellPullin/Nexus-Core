import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import '../App.css';

const API = '/api';

const DOCUMENT_LABELS = {
  drivers_licence_front: "Driver's licence (front)",
  drivers_licence_back: "Driver's licence (back)",
  blue_card: 'Blue Card',
  yellow_card: 'Yellow Card',
  first_aid: 'First Aid Certificate',
  car_insurance: 'Car insurance certificate',
};

export default function StaffRenewalPage() {
  const { token } = useParams();
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [documentType, setDocumentType] = useState('');
  const [file, setFile] = useState(null);
  const [expiryDate, setExpiryDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('Missing link');
      setLoading(false);
      return;
    }
    fetch(`${API}/public/staff-onboarding/renew/${token}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Invalid or expired link' : 'Failed to load');
        return r.json();
      })
      .then((data) => {
        setContext(data);
        if (data.documentTypes?.length) setDocumentType(data.documentTypes[0]);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file || !documentType) {
      alert('Please select a document type and choose a file.');
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('document_type', documentType);
      if (expiryDate) form.append('expiry_date', expiryDate);
      const res = await fetch(`${API}/public/staff-onboarding/renew/${token}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setSuccess(true);
    } catch (err) {
      alert(err.message || 'Upload failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8' }}>
        <p>Loading...</p>
      </div>
    );
  }
  if (error || !context) {
    return (
      <div style={{ minHeight: '100vh', padding: '2rem', background: '#f5f6f8' }}>
        <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
          <h2 style={{ color: '#1e293b' }}>Invalid link</h2>
          <p>{error || 'This renewal link is invalid or has expired. Please contact your manager for a new link.'}</p>
        </div>
      </div>
    );
  }
  if (success) {
    return (
      <div style={{ minHeight: '100vh', padding: '2rem', background: '#f5f6f8' }}>
        <div className="card" style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ color: '#22c55e' }}>Document uploaded</h2>
          <p>Thank you. Your renewed document has been received. You can close this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f6f8', padding: '1.5rem' }}>
      <header style={{ marginBottom: '1.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem', color: '#1e293b' }}>Nexus Core – Upload renewed document</h1>
        {context.staffName && <p style={{ margin: '0.5rem 0 0', color: '#64748b' }}>Hello, {context.staffName}</p>}
      </header>

      <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}>
        <h3 style={{ marginTop: 0 }}>Upload your renewed compliance document</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Document type *</label>
            <select className="form-input" value={documentType} onChange={(e) => setDocumentType(e.target.value)} required>
              {(context.documentTypes || []).map((key) => (
                <option key={key} value={key}>{DOCUMENT_LABELS[key] || key}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>File (image or PDF) *</label>
            <input type="file" accept="image/*,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} required />
          </div>
          <div className="form-group">
            <label>Expiry date (if applicable)</label>
            <input type="date" className="form-input" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Uploading…' : 'Upload'}
          </button>
        </form>
      </div>
    </div>
  );
}
