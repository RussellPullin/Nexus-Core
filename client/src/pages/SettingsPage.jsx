import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useParams } from 'react-router-dom';
import { PRODUCT_AGENCY } from '@nexus-shared/tenantProduct.js';
import { useAuth } from '../context/AuthContext';
import { staff, learning, settings, ai, auth, microsoftDrive } from '../lib/api';
import { probeLocalOllama, resolveLocalOllamaBaseUrl } from '../lib/localOllama.js';
import SearchableSelect from '../components/SearchableSelect';
import FormTemplatesSettings from '../components/FormTemplatesSettings';
import { formatDate } from '../lib/dateUtils';

const SIGNATURE_WIDTH = 300;
const SIGNATURE_HEIGHT = 120;

function SettingsSection({ title, summary, defaultOpen = false, children, className = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`card settings-collapsible ${className}`.trim()}>
      <button
        type="button"
        className="settings-collapsible__header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="settings-collapsible__chevron" aria-hidden>
          {open ? '▼' : '▶'}
        </span>
        <span className="settings-collapsible__header-text">
          <span className="settings-section-title settings-collapsible__title">{title}</span>
          {!open && summary ? (
            <span className="settings-collapsible__summary">{summary}</span>
          ) : null}
        </span>
      </button>
      {open ? <div className="settings-collapsible__body">{children}</div> : null}
    </div>
  );
}

export default function SettingsPage() {
  const { user, updateSettings, refreshUser, canManageUsers, isAdmin } = useAuth();
  const { productSurface } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [emailWizardView, setEmailWizardView] = useState('choose');
  const [disconnecting, setDisconnecting] = useState(false);
  const [billingIntervalMinutes, setBillingIntervalMinutes] = useState(user?.billing_interval_minutes ?? 15);
  const [staffId, setStaffId] = useState(user?.staff_id || '');
  const [staffList, setStaffList] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [aiStatus, setAiStatus] = useState(null);
  const [aiMessage, setAiMessage] = useState('');
  const [aiChecking, setAiChecking] = useState(false);
  const [ollamaLocalUrlDraft, setOllamaLocalUrlDraft] = useState('http://127.0.0.1:11434');
  const [localOllamaProbe, setLocalOllamaProbe] = useState({ ok: null, error: '', models: 0 });
  const [savingOllamaUrl, setSavingOllamaUrl] = useState(false);
  const [signatureDraft, setSignatureDraft] = useState(null);
  const [savingSignature, setSavingSignature] = useState(false);
  const [signatureMessage, setSignatureMessage] = useState('');
  const signatureCanvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const [msDriveStatus, setMsDriveStatus] = useState(null);
  const [msDriveBusy, setMsDriveBusy] = useState(false);

  useEffect(() => {
    setBillingIntervalMinutes(user?.billing_interval_minutes ?? 15);
    setStaffId(user?.staff_id || '');
  }, [user?.billing_interval_minutes, user?.staff_id]);

  useEffect(() => {
    setOllamaLocalUrlDraft(resolveLocalOllamaBaseUrl(user));
  }, [user?.ollama_local_base_url, user]);

  useEffect(() => {
    if (searchParams.get('email_connected') === '1') {
      refreshUser().then(() => {
        setMessage('Your email is connected. You can send rosters from your inbox.');
        setSearchParams({}, { replace: true });
      });
    }
    const err = searchParams.get('email_error');
    if (err) {
      setTestResult(decodeURIComponent(err));
      setSearchParams({}, { replace: true });
    }
    if (searchParams.get('ms_drive_connected') === '1') {
      setMessage('Microsoft OneDrive is connected. New documents will be copied into the Nexus Core folder on that account.');
      setSearchParams({}, { replace: true });
    }
    const msErr = searchParams.get('ms_drive_error');
    if (msErr) {
      setTestResult(decodeURIComponent(msErr));
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, refreshUser]);

  useEffect(() => {
    const expand = searchParams.get('expand');
    if (!expand) return;
    const t = window.setTimeout(() => {
      if (expand === 'form-templates') {
        const el = document.getElementById('settings-section-form-templates');
        if (el) {
          el.open = true;
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
      if (expand === 'company') {
        const el = document.getElementById('settings-section-company');
        if (el) {
          el.open = true;
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    }, 150);
    return () => clearTimeout(t);
  }, [searchParams]);

  useEffect(() => {
    if (!isAdmin) return;
    microsoftDrive
      .status()
      .then(setMsDriveStatus)
      .catch(() => setMsDriveStatus(null));
  }, [isAdmin, searchParams]);
  useEffect(() => {
    staff.list().then((s) => setStaffList(Array.isArray(s) ? s.map((x) => ({ id: x.id, name: x.name })) : [])).catch(() => []);
  }, []);
  useEffect(() => {
    let cancel = false;
    ai.status()
      .then(async (s) => {
        if (cancel) return;
        setAiStatus(s);
        if (s?.orgAllowsLocalOllama) {
          const base = s.userOllamaLocalBaseUrl || resolveLocalOllamaBaseUrl(user);
          const p = await probeLocalOllama(base);
          if (cancel) return;
          setLocalOllamaProbe({
            ok: p.ok,
            error: p.error || '',
            models: p.models?.length ?? 0
          });
        } else {
          setLocalOllamaProbe({ ok: null, error: '', models: 0 });
        }
      })
      .catch(() => {
        if (!cancel) {
          setAiStatus(null);
          setLocalOllamaProbe({ ok: false, error: '', models: 0 });
        }
      });
    return () => {
      cancel = true;
    };
  }, [user?.id, user?.ollama_local_base_url]);

  const handleLinkOllama = async () => {
    setAiMessage('');
    setAiChecking(true);
    try {
      const result = await ai.status();
      setAiStatus(result);
      if (result?.orgAllowsLocalOllama) {
        const base =
          result.userOllamaLocalBaseUrl ||
          ollamaLocalUrlDraft.trim() ||
          resolveLocalOllamaBaseUrl(user);
        const p = await probeLocalOllama(base);
        setLocalOllamaProbe({
          ok: p.ok,
          error: p.error || '',
          models: p.models?.length ?? 0
        });
        if (!p.ok) setAiMessage('');
      } else {
        setLocalOllamaProbe({ ok: null, error: '', models: 0 });
        setAiMessage('');
      }
    } catch {
      setAiStatus(null);
      setLocalOllamaProbe({ ok: false, error: '', models: 0 });
      setAiMessage('');
    } finally {
      setAiChecking(false);
    }
  };

  const handleTestEmail = async () => {
    setTestResult('');
    setTesting(true);
    try {
      const res = await auth.testEmail();
      setTestResult(res?.ok ? 'Test email sent. Check your inbox.' : res?.error || 'Test failed');
    } catch (err) {
      setTestResult(err.message || 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnectEmail = async () => {
    if (!window.confirm('Disconnect this email? You will need to connect again to send rosters.')) return;
    setDisconnecting(true);
    setTestResult('');
    try {
      await auth.disconnectEmail();
      await refreshUser();
      setEmailWizardView('choose');
      setMessage('Email disconnected.');
    } catch (err) {
      setTestResult(err.message || 'Could not disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  const oauthBase = () => `${window.location.origin}/api/email/oauth`;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage('');
    setSaving(true);
    try {
      await updateSettings({
        billing_interval_minutes: billingIntervalMinutes,
        staff_id: staffId || null
      });
      setMessage('Settings saved.');
    } catch (err) {
      setMessage(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const getSignatureDataFromCanvas = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hasContent = imageData.data.some((v, i) => i % 4 === 3 && v > 0);
    return hasContent ? canvas.toDataURL('image/png') : null;
  };

  const handleSaveSignature = async () => {
    setSignatureMessage('');
    setSavingSignature(true);
    try {
      const data = signatureDraft === null ? null : (signatureDraft !== undefined ? signatureDraft : (getSignatureDataFromCanvas() || user?.signature_data || null));
      await updateSettings({ signature_data: data || null });
      setSignatureDraft(undefined);
      if (signatureCanvasRef.current) {
        const ctx = signatureCanvasRef.current.getContext('2d');
        ctx.clearRect(0, 0, signatureCanvasRef.current.width, signatureCanvasRef.current.height);
      }
      setSignatureMessage(data ? 'Signature saved. It will appear on documents you send for signature.' : 'Signature cleared.');
    } catch (err) {
      setSignatureMessage(err.message || 'Failed to save signature');
    } finally {
      setSavingSignature(false);
    }
  };

  const handleClearSignature = () => {
    setSignatureDraft(null);
    if (signatureCanvasRef.current) {
      const ctx = signatureCanvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, signatureCanvasRef.current.width, signatureCanvasRef.current.height);
    }
    setSignatureMessage('');
  };

  const handleSignatureUpload = (e) => {
    const file = e?.target?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      setSignatureDraft(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  useEffect(() => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    };

    const start = (e) => {
      e.preventDefault();
      isDrawingRef.current = true;
      const pos = getPos(e);
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    };
    const move = (e) => {
      e.preventDefault();
      if (!isDrawingRef.current) return;
      const pos = getPos(e);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    };
    const end = () => { isDrawingRef.current = false; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    return () => {
      canvas.removeEventListener('mousedown', start);
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseup', end);
      canvas.removeEventListener('mouseleave', end);
      canvas.removeEventListener('touchstart', start);
      canvas.removeEventListener('touchmove', move);
      canvas.removeEventListener('touchend', end);
    };
  }, []);

  const displaySignature = signatureDraft === null ? null : (signatureDraft !== undefined ? signatureDraft : user?.signature_data);

  return (
    <div className="settings-page">
      <h2>Settings</h2>

      <div className="settings-cards-grid">
      <details className="card settings-collapsible">
        <summary className="settings-collapsible-summary">
          <span className="settings-collapsible-summary-main">
            <span className="settings-collapsible-title">Connect your email</span>
            <span className="settings-collapsible-hint">Send rosters and messages from your inbox</span>
          </span>
        </summary>
        <div className="settings-collapsible-body">
        <p className="settings-desc">
          Roster emails and staff messages are sent from <strong>your</strong> address. Choose your email provider and sign in once.
        </p>

        {user?.email_reconnect_required && (
          <div className="settings-error" style={{ marginBottom: '1rem' }}>
            Your connection expired. Please sign in again with the same provider below.
          </div>
        )}

        {user?.email_connected_address && !user?.email_reconnect_required ? (
          <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, marginBottom: '1rem' }}>
            <p style={{ margin: '0 0 0.5rem 0', color: '#166534', fontWeight: 600 }}>Connected</p>
            <p style={{ margin: 0, color: '#15803d' }}>
              Sending as <strong>{user.email_connected_address}</strong>
              {user.email_provider === 'google' ? ' (Gmail)' : user.email_provider === 'microsoft' ? ' (Microsoft 365)' : ''}
            </p>
            {user.email_relay_configured === false && (
              <div
                className="settings-error"
                style={{ marginTop: '0.75rem', marginBottom: 0, background: '#fff7ed', borderColor: '#fdba74', color: '#9a3412' }}
              >
                Outgoing mail is not set up on this server yet. Ask your administrator to finish email setup — test email and roster send will not work until then.
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="button" className="btn btn-secondary" onClick={handleTestEmail} disabled={testing}>
                {testing ? 'Sending…' : 'Send test email to me'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => window.location.assign(`${oauthBase()}/${user.email_provider === 'google' ? 'google' : 'microsoft'}`)}>
                Reconnect / switch account
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleDisconnectEmail} disabled={disconnecting}>
                {disconnecting ? '…' : 'Disconnect'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {emailWizardView === 'choose' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 360 }}>
                <p style={{ margin: 0, color: '#64748b', fontSize: '0.95rem' }}>Step 1 — Where is your email?</p>
                <button type="button" className="btn btn-primary" onClick={() => window.location.assign(`${oauthBase()}/google`)}>
                  Continue with Gmail
                </button>
                <button type="button" className="btn btn-primary" onClick={() => window.location.assign(`${oauthBase()}/microsoft`)}>
                  Continue with Microsoft 365 / Outlook
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setEmailWizardView('other')}>
                  Other provider
                </button>
              </div>
            )}
            {emailWizardView === 'other' && (
              <div style={{ padding: '1rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                <p style={{ margin: '0 0 0.75rem 0' }}>
                  Sending works with <strong>Gmail</strong> or <strong>Microsoft 365</strong> (work or personal Outlook). Please use one of those buttons above.
                </p>
                <button type="button" className="btn btn-secondary" onClick={() => setEmailWizardView('choose')}>
                  Back
                </button>
              </div>
            )}
          </>
        )}
        {testResult && (
          <div className={testResult.includes('sent') || testResult.includes('connected') ? 'settings-success' : 'settings-error'} style={{ marginTop: '1rem' }}>
            {testResult}
          </div>
        )}
        </div>
      </details>

      <details className="card settings-collapsible">
        <summary className="settings-collapsible-summary">
          <span className="settings-collapsible-summary-main">
            <span className="settings-collapsible-title">Company, coordinator &amp; signature</span>
            <span className="settings-collapsible-hint">Billing interval, default staff, document signature</span>
          </span>
        </summary>
        <div className="settings-collapsible-body">
      <form onSubmit={handleSubmit} className="settings-form">
        <h3 className="settings-section-title">Company setup</h3>
        <p className="settings-desc">Company-wide settings used for billing and invoicing.</p>
        <div className="form-group">
          <label>Billing interval (minutes)</label>
          <input
            type="number"
            min={1}
            max={60}
            value={billingIntervalMinutes}
            onChange={(e) => setBillingIntervalMinutes(Number(e.target.value) || 15)}
            className="form-input"
          />
          <small className="form-hint">
            Coordinator tasks are billed in intervals of this many minutes (e.g. 15 = round up to nearest 15 min). Enter duration in minutes when adding tasks; time charged rounds up automatically.
          </small>
        </div>

        <h3 className="settings-section-title">Support coordinator</h3>
        <p className="settings-desc">Used when recording tasks in Coordinator Tasks.</p>
        <div className="form-group">
          <label>Default coordinator (staff)</label>
          <SearchableSelect
            options={staffList}
            value={staffId}
            onChange={setStaffId}
            placeholder="Select yourself if you are a coordinator"
          />
          <small className="form-hint">
            Link your login to a staff record so tasks default to you.
          </small>
        </div>

        <h3 className="settings-section-title">Your signature</h3>
        <p className="settings-desc">
          Set your signature here so it is automatically added to documents when you send them for signature (participant onboarding, service agreements, consent forms). The participant will still sign separately.
        </p>
        <div className="form-group">
          <label>Draw or upload your signature</label>
          {displaySignature ? (
            <div style={{ marginBottom: '0.5rem' }}>
              <img src={displaySignature} alt="Your signature" style={{ maxWidth: 280, maxHeight: 100, border: '1px solid #e2e8f0', borderRadius: 4 }} />
            </div>
          ) : (
            <canvas
              ref={signatureCanvasRef}
              width={SIGNATURE_WIDTH}
              height={SIGNATURE_HEIGHT}
              style={{ display: 'block', border: '1px solid #cbd5e1', borderRadius: 4, touchAction: 'none', cursor: 'crosshair', maxWidth: '100%', height: 'auto' }}
              aria-label="Draw your signature"
            />
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            {!displaySignature && (
              <>
                <label className="btn btn-secondary" style={{ margin: 0 }}>
                  Upload image
                  <input type="file" accept="image/*" onChange={handleSignatureUpload} style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} />
                </label>
                <button type="button" className="btn btn-secondary" onClick={handleClearSignature}>Clear</button>
              </>
            )}
            {displaySignature && (
              <>
                {signatureDraft === undefined && (
                  <label className="btn btn-secondary" style={{ margin: 0 }}>
                    Replace (upload)
                    <input type="file" accept="image/*" onChange={handleSignatureUpload} style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} />
                  </label>
                )}
                <button type="button" className="btn btn-secondary" onClick={handleClearSignature}>Clear</button>
              </>
            )}
            <button type="button" className="btn btn-primary" onClick={handleSaveSignature} disabled={savingSignature}>
              {savingSignature ? 'Saving...' : displaySignature ? 'Update signature' : 'Save signature'}
            </button>
          </div>
          {signatureMessage && <div className={signatureMessage.includes('saved') || signatureMessage.includes('cleared') ? 'settings-success' : 'settings-error'} style={{ marginTop: '0.5rem' }}>{signatureMessage}</div>}
        </div>

        {message && <div className={message.includes('saved') ? 'settings-success' : 'settings-error'}>{message}</div>}
        <div className="settings-buttons">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
        </div>
      </details>

      {isAdmin && (
        <details id="settings-section-form-templates" className="card settings-collapsible">
          <summary className="settings-collapsible-summary">
            <span className="settings-collapsible-summary-main">
              <span className="settings-collapsible-title">Form templates</span>
              <span className="settings-collapsible-hint">Service Agreement variables &amp; branding</span>
            </span>
          </summary>
          <div className="settings-collapsible-body">
            <FormTemplatesSettings />
          </div>
        </details>
      )}

      <details className="card settings-collapsible">
        <summary className="settings-collapsible-summary">
          <span className="settings-collapsible-summary-main">
            <span className="settings-collapsible-title">Ollama</span>
            <span className="settings-collapsible-hint">This device</span>
          </span>
        </summary>
        <div className="settings-collapsible-body">
        {aiStatus?.orgAllowsLocalOllama ? (
          <>
            <p className="form-hint" style={{ margin: '0 0 0.75rem 0' }}>
              Local AI runs in <strong>Ollama on this computer</strong>, not inside Nexus. Install it once, then allow this website to talk to Ollama (below). Open Nexus in{' '}
              <strong>Chrome or Edge</strong> for testing; Safari often blocks the connection.
            </p>
            <div style={{ marginBottom: '0.85rem' }}>
              <p className="form-hint" style={{ margin: '0 0 0.35rem 0', fontWeight: 600 }}>
                Address to use in Ollama (copy exactly)
              </p>
              <code
                style={{
                  display: 'block',
                  padding: '0.45rem 0.55rem',
                  background: 'var(--surface-muted, #f1f5f9)',
                  borderRadius: 4,
                  fontSize: '0.9rem',
                  wordBreak: 'break-all'
                }}
              >
                {typeof window !== 'undefined' ? window.location.origin : ''}
              </code>
            </div>
            <details style={{ marginBottom: '0.65rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Windows — first-time setup</summary>
              <ol className="form-hint" style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.25rem', lineHeight: 1.55 }}>
                <li>
                  <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">
                    Download and install Ollama
                  </a>{' '}
                  for Windows, then open the Ollama app.
                </li>
                <li>
                  Download at least one model. In Command Prompt or PowerShell run, for example:{' '}
                  <code>ollama pull llama3.2</code>
                </li>
                <li>
                  <strong>Shut down Ollama completely</strong> (so it can pick up the next step):
                  <ul style={{ margin: '0.35rem 0 0 0', paddingLeft: '1.25rem', listStyleType: 'disc' }}>
                    <li>Look at the <strong>bottom-right</strong> of your screen, near the clock. That area is called the <strong>notification area</strong> or system tray.</li>
                    <li>
                      Find the <strong>small Ollama (llama) icon</strong>. If you do not see it, click the <strong>^</strong> arrow to show hidden icons.
                    </li>
                    <li>
                      <strong>Right-click</strong> that icon (or click it and look for Quit) and choose <strong>Quit</strong> or <strong>Exit</strong>. Ollama should no longer be running.
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Tell Windows to allow this website to use Ollama</strong> (one new setting — not inside the Ollama app):
                  <ul style={{ margin: '0.35rem 0 0 0', paddingLeft: '1.25rem', listStyleType: 'disc' }}>
                    <li>
                      Press the <strong>Windows key</strong> on your keyboard (or open the <strong>Start</strong> menu).
                    </li>
                    <li>
                      Start typing: <strong>environment variables</strong> (you can type the whole phrase or just part of it).
                    </li>
                    <li>
                      Open <strong>Edit environment variables for your account</strong> if it appears. If you only see{' '}
                      <strong>Edit the system environment variables</strong>, open that, then click <strong>Environment Variables…</strong> at the bottom — we only use the{' '}
                      <strong>top</strong> list on that screen (<strong>User variables</strong> for your name), not the bottom “System variables” list.
                    </li>
                    <li>
                      In the <strong>User variables</strong> section, click <strong>New…</strong>
                    </li>
                    <li>
                      <strong>Variable name:</strong> type exactly <code>OLLAMA_ORIGINS</code> (all capitals, with the underscore).
                    </li>
                    <li>
                      <strong>Variable value:</strong> click in the box, then paste the <strong>same address</strong> as in the gray box at the top of this page (select it, Ctrl+C, then Ctrl+V here). It should start with{' '}
                      <code>https://</code> or <code>http://</code>. No spaces before or after.
                    </li>
                    <li>
                      Click <strong>OK</strong>, then <strong>OK</strong> again to close the windows.
                    </li>
                  </ul>
                  <p style={{ margin: '0.45rem 0 0 0' }}>
                    If you cannot find these menus, ask <strong>IT or your admin</strong> to add a user variable named <code>OLLAMA_ORIGINS</code> with that address — only once per PC.
                  </p>
                </li>
                <li>Start Ollama again from the Start menu.</li>
                <li>
                  Come back here: leave the URL as <code>http://127.0.0.1:11434</code> unless your IT team said otherwise, click{' '}
                  <strong>Save</strong>, then <strong>Test</strong>.
                </li>
              </ol>
            </details>
            <details style={{ marginBottom: '0.85rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Mac — first-time setup</summary>
              <ol className="form-hint" style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.25rem', lineHeight: 1.55 }}>
                <li>
                  <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">
                    Download and install Ollama
                  </a>{' '}
                  for Mac, then open the Ollama app.
                </li>
                <li>
                  In Terminal, download at least one model, for example: <code>ollama pull llama3.2</code>
                </li>
                <li>
                  <strong>Shut down Ollama completely</strong> before the next step:
                  <ul style={{ margin: '0.35rem 0 0 0', paddingLeft: '1.25rem', listStyleType: 'disc' }}>
                    <li>Look at the <strong>top</strong> of the screen (the menu bar), near the Wi‑Fi and battery icons.</li>
                    <li>
                      Click the <strong>small Ollama (llama) icon</strong> there.
                    </li>
                    <li>
                      Choose <strong>Quit Ollama</strong>. The app should fully close.
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Run one line in Terminal</strong> (this is not inside Ollama — it tells the Mac to allow this website to talk to Ollama):
                  <ul style={{ margin: '0.35rem 0 0 0', paddingLeft: '1.25rem', listStyleType: 'disc' }}>
                    <li>
                      Open <strong>Terminal</strong>: press <strong>Command + Space</strong>, type <code>Terminal</code>, press <strong>Enter</strong>.
                    </li>
                    <li>
                      Click inside the Terminal window so you see a blinking cursor.
                    </li>
                    <li>
                      Copy the <strong>entire</strong> line in the gray box below (triple-click the line to select all, then <strong>Command + C</strong>).
                    </li>
                    <li>
                      Click in Terminal again and paste (<strong>Command + V</strong>), then press <strong>Enter</strong>.
                    </li>
                    <li>
                      If nothing scary appears and you get a new prompt line, that is normal. If you see “command not found,” install Ollama from the link in step 1 first.
                    </li>
                  </ul>
                  <code
                    style={{
                      display: 'block',
                      marginTop: '0.35rem',
                      padding: '0.35rem 0.5rem',
                      background: 'var(--surface-muted, #f1f5f9)',
                      borderRadius: 4,
                      fontSize: '0.85rem',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all'
                    }}
                  >
                    {typeof window !== 'undefined'
                      ? `launchctl setenv OLLAMA_ORIGINS '${window.location.origin}'`
                      : "launchctl setenv OLLAMA_ORIGINS 'https://your-crm-address'"}
                  </code>
                  <p style={{ margin: '0.45rem 0 0 0' }}>
                    If Terminal feels unfamiliar, ask <strong>IT or your admin</strong> to run that one line for you — only once per Mac (you may need it again after a full restart).
                  </p>
                </li>
                <li>Open the Ollama app again.</li>
                <li>
                  After you log out or restart the Mac, you may need to run the <code>launchctl setenv</code> line again, then open Ollama.
                </li>
                <li>
                  Come back here: leave the URL as <code>http://127.0.0.1:11434</code> unless your IT team said otherwise, click <strong>Save</strong>, then{' '}
                  <strong>Test</strong> (use Chrome or Edge).
                </li>
              </ol>
            </details>
            <div className="form-group" style={{ marginBottom: '0.75rem' }}>
              <label>URL</label>
              <input
                type="url"
                className="form-control"
                value={ollamaLocalUrlDraft}
                onChange={(e) => setOllamaLocalUrlDraft(e.target.value)}
                placeholder="http://127.0.0.1:11434"
              />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={savingOllamaUrl}
                onClick={async () => {
                  setSavingOllamaUrl(true);
                  setAiMessage('');
                  try {
                    await updateSettings({
                      ollama_local_base_url: ollamaLocalUrlDraft.trim() || null
                    });
                    await refreshUser();
                    setAiMessage('Saved.');
                  } catch {
                    setAiMessage('Error');
                  } finally {
                    setSavingOllamaUrl(false);
                  }
                }}
              >
                {savingOllamaUrl ? 'Saving...' : 'Save'}
              </button>
              <button type="button" className="btn btn-primary" onClick={handleLinkOllama} disabled={aiChecking}>
                {aiChecking ? '…' : 'Test'}
              </button>
            </div>
            {localOllamaProbe.ok === true && (
              <p className="settings-success" style={{ margin: '0.65rem 0 0 0' }}>
                {localOllamaProbe.models ? 'Connected' : 'Connected (no models)'}
              </p>
            )}
            {localOllamaProbe.ok === false && localOllamaProbe.error && (
              <p className="settings-error" style={{ margin: '0.65rem 0 0 0' }}>{localOllamaProbe.error}</p>
            )}
            {aiMessage && (
              <p
                className={aiMessage === 'Saved.' || aiMessage.includes('Connected') ? 'settings-success' : 'settings-error'}
                style={{ margin: '0.5rem 0 0 0' }}
              >
                {aiMessage}
              </p>
            )}
          </>
        ) : (
          <div>
            <p className="form-hint" style={{ margin: 0 }}>
              Off for your organisation — per-device Ollama and browser-side CSV mapping stay disabled.
            </p>
            <p className="form-hint" style={{ margin: '0.5rem 0 0 0', fontSize: '0.9rem' }}>
              Turn on <strong>AI: Ollama on staff computers</strong> in Admin → Feature flags (super admin), or set{' '}
              <code style={{ fontSize: '0.85em' }}>AI_STAFF_LOCAL_OLLAMA=true</code> on the API server.
            </p>
          </div>
        )}
        </div>
      </details>

      {isAdmin && (
        <details className="card settings-collapsible">
          <summary className="settings-collapsible-summary">
            <span className="settings-collapsible-summary-main">
              <span className="settings-collapsible-title">Document archive (Microsoft 365)</span>
              <span className="settings-collapsible-hint">OneDrive folder for participant and staff documents</span>
            </span>
          </summary>
          <div className="settings-collapsible-body">
          <p className="settings-desc">
            Connect a Microsoft work account (typically the practice admin). The app creates a <strong>Nexus Core</strong> folder on that user&apos;s OneDrive
            and copies new participant and staff documents there. Files are never deleted by Nexus; each upload gets a new timestamped name.
          </p>
          {msDriveStatus?.organization_id == null && msDriveStatus?.message && (
            <p className="settings-error" style={{ marginBottom: '0.5rem' }}>{msDriveStatus.message}</p>
          )}
          {msDriveStatus?.connected ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <span className="settings-success">OneDrive connected</span>
              {msDriveStatus.connected_at && (
                <span className="form-hint">({formatDate(msDriveStatus.connected_at)})</span>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={msDriveBusy}
                onClick={async () => {
                  if (!window.confirm('Disconnect Microsoft? New documents will stay on the server only until you connect again.')) return;
                  setMsDriveBusy(true);
                  try {
                    await microsoftDrive.disconnect();
                    setMsDriveStatus((s) => ({ ...s, connected: false }));
                    setMessage('Microsoft document archive disconnected.');
                  } catch (e) {
                    setTestResult(e.message || 'Disconnect failed');
                  } finally {
                    setMsDriveBusy(false);
                  }
                }}
              >
                {msDriveBusy ? 'Working…' : 'Disconnect'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                window.location.href = '/api/integrations/microsoft-drive/start';
              }}
            >
              Connect Microsoft for documents
            </button>
          )}
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            If connection fails, your IT administrator may need to allow this app in Microsoft 365 and register the redirect address{' '}
            <code>{`${window.location.origin}/api/integrations/microsoft-drive/callback`}</code>.
          </p>
          </div>
        </details>
      )}

      {canManageUsers &&
        productSurface === PRODUCT_AGENCY &&
        Boolean(user?.can_use_agency) &&
        Boolean(user?.agency_enabled) && <ShifterIntegrationCard />}
      {canManageUsers && <BusinessSetup />}
      <LearningSettings />
      </div>
    </div>
  );
}

function ShifterIntegrationCard() {
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  const [linkInfo, setLinkInfo] = useState(null);
  const [manualUrlsOpen, setManualUrlsOpen] = useState(false);
  /** When Shifter organisations.name differs from Nexus, enter it here (optional). */
  const [shifterNameOverride, setShifterNameOverride] = useState('');
  /** Shifter public.organizations.id — link by UUID when names do not match (optional). */
  const [shifterOrgIdOverride, setShifterOrgIdOverride] = useState('');

  const clientOrigin = typeof window !== 'undefined' ? window.location.origin.replace(/\/$/, '') : '';
  const webhookUrl =
    (linkInfo?.webhook_url && String(linkInfo.webhook_url).trim()) ||
    `${clientOrigin}/api/webhooks/progress-app`;
  const syncUrl =
    (linkInfo?.sync_url && String(linkInfo.sync_url).trim()) || `${clientOrigin}/api/sync/from-excel`;

  const load = async () => {
    setLoading(true);
    try {
      const data = await auth.getShifterOrgLink();
      setLinkInfo(data || null);
    } catch {
      setLinkInfo(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onLink = async () => {
    setMsg('');
    setBusy(true);
    try {
      const sid = shifterOrgIdOverride.trim();
      const sn = shifterNameOverride.trim();
      const data = await auth.linkShifterOrg(
        sid ? { shifter_organization_id: sid, shifter_org_name: sn || undefined } : sn ? { shifter_org_name: sn } : undefined
      );
      await load();
      const push = data?.schedule_shift_push;
      if (push?.ok) {
        const hostMissingKey = data?.crm_api_key_configured === false;
        const keyPart = push.api_key_set
          ? ' The shared security key was saved in Shifter too, so the Progress app can call Nexus without anyone pasting it.'
          : hostMissingKey
            ? ' The webhook address was saved, but the server security key is not set yet — your administrator should add it, then use Link to Shifter again or paste the key manually in Shifter.'
            : ' The webhook address was saved. If Shifter still asks for a key, use Link to Shifter again or paste the same server key in Shifter admin.';
        const nexusIdPart =
          push.nexus_org_push?.ok === true
            ? ' Nexus also saved this organisation’s id in Shifter for scoped webhook payloads.'
            : push.nexus_org_push?.reason === 'no_nexus_org_column'
              ? ' Your administrator may need to update Shifter so Nexus can store this organisation’s id automatically.'
              : '';
        setMsg(`Shifter linked. ${keyPart}${nexusIdPart}`);
        setManualUrlsOpen(false);
      } else if (push?.skipped && push.reason === 'nexus_shift_api_base_unresolved') {
        setMsg(
          'Shifter linked, but the public web address for Nexus could not be determined. Ask your administrator to set the correct API base URL, then use Link to Shifter again.'
        );
        setManualUrlsOpen(true);
      } else if (push?.skipped && push.reason === 'no_webhook_url') {
        setMsg('Shifter linked, but webhook URL could not be resolved. Use manual setup below or fix API base URL / Admin profile.');
        setManualUrlsOpen(true);
      } else if (push && !push.skipped && !push.ok) {
        setMsg(
          'Shifter linked, but the Shifter database has no matching webhook columns — use manual setup below, or add columns your Progress / Shifter app expects.'
        );
        setManualUrlsOpen(true);
      } else if (push?.skipped && push.reason === 'shifter_not_configured_or_invalid_org_id') {
        setMsg(
          'Shifter linked in Nexus. Automatic setup into Shifter is not available until your administrator finishes server configuration — or use manual setup below.'
        );
        setManualUrlsOpen(true);
      } else {
        setMsg('Shifter organisation linked.');
        setManualUrlsOpen(true);
      }
    } catch (err) {
      setMsg(err.message || 'Could not link Shifter organisation');
    } finally {
      setBusy(false);
    }
  };

  const onUnlink = async () => {
    setMsg('');
    setBusy(true);
    try {
      await auth.unlinkShifterOrg();
      await load();
      setMsg('Shifter organisation link removed.');
    } catch (err) {
      setMsg(err.message || 'Could not unlink Shifter organisation');
    } finally {
      setBusy(false);
    }
  };

  const copyText = async (label, value) => {
    setCopyMsg('');
    try {
      await navigator.clipboard.writeText(value);
      setCopyMsg(`${label} copied.`);
    } catch {
      setCopyMsg(`Could not copy automatically. Please copy ${label.toLowerCase()} manually.`);
    }
  };

  const crmReady = linkInfo?.crm_api_key_configured === true;
  const shifterRemoteReady = linkInfo?.shifter_remote_configured === true;

  return (
    <details className="card settings-collapsible">
      <summary className="settings-collapsible-summary">
        <span className="settings-collapsible-summary-main">
          <span className="settings-collapsible-title">Shifter and shift schedule</span>
          <span className="settings-collapsible-hint">Link Nexus to Shifter, webhooks, shift sync</span>
        </span>
      </summary>
      <div className="settings-collapsible-body">

      <div
        style={{
          padding: '0.85rem 1rem',
          marginBottom: '1rem',
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          fontSize: '0.95rem',
          lineHeight: 1.55,
        }}
      >
        <p style={{ margin: '0 0 0.6rem 0', fontWeight: 600, color: '#334155' }}>How linking works</p>
        <p style={{ margin: '0 0 0.5rem 0', color: '#475569' }}>
          By default, Nexus looks up Shifter using your <strong>Nexus organisation name</strong> against{' '}
          <code>organizations.name</code> in the Shifter database (same spelling, any case). If they differ — for example Shifter still
          says <code>Shifter</code> — use the fields beside the button to enter the Shifter name or paste the Shifter organisation UUID.
        </p>
        <p style={{ margin: '0 0 0.5rem 0', color: '#475569' }}>
          If something still fails, your administrator may need to finish server setup, or you can copy the URLs below into Shifter manually.
        </p>
        {!loading && (
          <ul style={{ margin: '0.4rem 0 0 1.1rem', padding: 0, color: '#475569' }}>
            <li>
              <strong>Server security key:</strong>{' '}
              {crmReady ? (
                <span className="settings-success" style={{ display: 'inline', fontWeight: 600 }}>
                  Ready — webhook requests can be authenticated.
                </span>
              ) : (
                <span className="settings-error" style={{ display: 'inline', fontWeight: 600 }}>
                  Not set — your administrator must configure the server. Organisation admins cannot fix this here.
                </span>
              )}
            </li>
            <li style={{ marginTop: '0.35rem' }}>
              <strong>Shifter database access (Nexus server):</strong>{' '}
              {shifterRemoteReady ? (
                <span className="settings-success" style={{ display: 'inline', fontWeight: 600 }}>
                  Ready — Nexus can find your Shifter organisation by name and write webhook settings.
                </span>
              ) : (
                <span style={{ color: '#92400e', fontWeight: 600 }}>
                  Not configured — set <code>SHIFTER_SUPABASE_URL</code> and <code>SHIFTER_SERVICE_ROLE_KEY</code> on the{' '}
                  <strong>same Fly app as Nexus Core</strong> (not the Shifter Functions app), then restart. Without this,{' '}
                  <strong>Link to Shifter</strong> cannot run; you can still copy URLs below into Shifter admin by hand.
                </span>
              )}
            </li>
          </ul>
        )}
      </div>

      <p className="settings-desc">
        <strong>Pulls from Shifter:</strong> link your Nexus Core organisation to the matching org in Shifter (same organisation
        name in both apps
        {linkInfo?.organization_name ? (
          <>
            {' '}
            — yours is <strong>{linkInfo.organization_name}</strong>
          </>
        ) : null}
        ). <strong>Push into Nexus:</strong> when you use <strong>Link to Shifter</strong>, Nexus tries to save the webhook URL and server
        security key in Shifter so shifts can flow in automatically.
      </p>

      <div className="settings-shifter-card-layout">
        <div className="settings-shifter-card-main">
          <div className="form-group">
            <label>Shifter link status</label>
            {loading ? (
              <div className="form-hint">Loading…</div>
            ) : linkInfo?.linked ? (
              <div className="settings-success">Linked to Shifter.</div>
            ) : (
              <div className="form-hint">Not linked — use Link to Shifter on the right.</div>
            )}
            {!loading && linkInfo?.org_id && (
              <small className="form-hint" style={{ display: 'block', marginTop: '0.35rem' }}>
                Nexus organisation id (include as <code>org_id</code> in webhook JSON if your app supports it):{' '}
                <code style={{ wordBreak: 'break-all' }}>{linkInfo.org_id}</code>
              </small>
            )}
          </div>

          <h4 className="settings-subsection-title">Send shifts into Nexus Core</h4>
          <p className="form-hint" style={{ marginTop: 0 }}>
            Webhook links use the public web address your administrator configured (admin profile or server settings), or this browser
            if nothing else is set. If the address looks wrong, ask your administrator before linking.
          </p>
          {!loading && linkInfo?.shift_urls_source === 'supabase_profile' && linkInfo?.shift_url_profile_email && (
            <p className="settings-success" style={{ marginTop: '0.5rem', marginBottom: 0, fontSize: '0.9rem' }}>
              URLs use the base address from the admin account <strong>{linkInfo.shift_url_profile_email}</strong>.
            </p>
          )}
          {!loading && linkInfo?.shift_urls_source === 'env' && (
            <p className="form-hint" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
              Using the public address set on the server.
            </p>
          )}
          {!loading && linkInfo?.shift_urls_source === 'client_origin' && (
            <p className="form-hint" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
              Using this browser&apos;s address. If that is not your real Nexus web address, ask your administrator to set the correct one.
            </p>
          )}

          <details
            style={{ marginTop: '0.75rem' }}
            open={manualUrlsOpen}
            onToggle={(e) => setManualUrlsOpen(e.target.open)}
          >
            <summary className="form-hint" style={{ cursor: 'pointer', fontWeight: 600 }}>
              Manual webhook / Excel sync (only if auto-config failed or you use a custom Shifter schema)
            </summary>
            <div className="form-group" style={{ marginTop: '0.75rem' }}>
              <label>Webhook endpoint</label>
              <input className="form-input" value={webhookUrl} readOnly />
              <small className="form-hint">
                Method: <code>POST</code>. Use the same API key your administrator configured for Nexus in your app.
              </small>
            </div>
            <div className="settings-buttons">
              <button type="button" className="btn btn-secondary" onClick={() => copyText('Webhook URL', webhookUrl)}>
                Copy webhook URL
              </button>
            </div>
            <div className="form-group" style={{ marginTop: '1rem' }}>
              <label>Excel sync endpoint (fallback)</label>
              <input className="form-input" value={syncUrl} readOnly />
              <small className="form-hint">
                Method: <code>POST</code> while signed in, or with the same API key header your administrator uses for Nexus.
              </small>
            </div>
            <div className="settings-buttons">
              <button type="button" className="btn btn-secondary" onClick={() => copyText('Sync URL', syncUrl)}>
                Copy sync URL
              </button>
            </div>
          </details>
          <small className="form-hint" style={{ display: 'block', marginTop: '0.75rem' }}>
            <strong>Pull from OneDrive Excel</strong> (Shifts page) uses your connected Microsoft account and the workbook path stored in
            Shifter for your organisation. If the file is missing there, Nexus may pull shifts from Shifter directly when that is set up.
          </small>
        </div>

        <div className="settings-shifter-card-actions" style={{ minWidth: 0 }}>
          <div className="form-group" style={{ marginBottom: '0.65rem', width: '100%' }}>
            <label htmlFor="shifter-name-override">Shifter organisation name (optional)</label>
            <input
              id="shifter-name-override"
              className="form-input"
              placeholder={
                linkInfo?.organization_name
                  ? `Default: Nexus name “${linkInfo.organization_name}”`
                  : 'Leave blank to use Nexus organisation name'
              }
              value={shifterNameOverride}
              onChange={(e) => setShifterNameOverride(e.target.value)}
              disabled={busy || loading || Boolean(linkInfo?.linked)}
              autoComplete="off"
            />
            <small className="form-hint">Must match <code>organizations.name</code> in Shifter Supabase exactly (spaces count).</small>
          </div>
          <div className="form-group" style={{ marginBottom: '0.65rem', width: '100%' }}>
            <label htmlFor="shifter-org-uuid">Or Shifter organisation id (optional)</label>
            <input
              id="shifter-org-uuid"
              className="form-input"
              placeholder="e.g. 00000000-0000-0000-0000-000000000001"
              value={shifterOrgIdOverride}
              onChange={(e) => setShifterOrgIdOverride(e.target.value)}
              disabled={busy || loading || Boolean(linkInfo?.linked)}
              autoComplete="off"
            />
            <small className="form-hint">From Shifter project → Table Editor → organizations → id. If set, the name field is ignored.</small>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onLink}
            disabled={
              busy ||
              loading ||
              Boolean(linkInfo?.linked) ||
              (!loading && linkInfo != null && !shifterRemoteReady)
            }
          >
            {busy ? 'Linking…' : 'Link to Shifter'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onUnlink} disabled={busy || loading || !linkInfo?.linked}>
            Unlink
          </button>
        </div>
      </div>

      {msg && (
        <div
          className={
            msg.toLowerCase().includes('linked') && !msg.toLowerCase().includes('could not')
              ? 'settings-success'
              : 'settings-error'
          }
          style={{ marginTop: '0.75rem' }}
        >
          {msg}
        </div>
      )}
      {copyMsg && (
        <div className={copyMsg.includes('copied') ? 'settings-success' : 'settings-error'} style={{ marginTop: '0.75rem' }}>
          {copyMsg}
        </div>
      )}
      </div>
    </details>
  );
}

function BusinessSetup() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [biz, setBiz] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');
  const [logoKey, setLogoKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBiz(null);
    settings
      .getBusiness()
      .then((data) => {
        if (!cancelled) setBiz(data);
      })
      .catch(() => {
        if (!cancelled) setBiz(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.org_id]);

  useEffect(() => {
    const xero = searchParams.get('xero');
    const adobe = searchParams.get('adobe_sign');
    const message = searchParams.get('message');
    if (xero === 'linked') {
      setMsg('Successfully linked to Xero.');
      setSearchParams({}, { replace: true });
      settings.getBusiness().then(setBiz).catch(() => {});
    } else if (xero === 'error') {
      setMsg('Xero connection failed: ' + (message || 'Unknown error'));
      setSearchParams({}, { replace: true });
    } else if (adobe === 'linked') {
      setMsg('Successfully linked to Adobe Acrobat Sign.');
      setSearchParams({}, { replace: true });
      settings.getBusiness().then(setBiz).catch(() => {});
    } else if (adobe === 'error') {
      setMsg('Adobe Sign connection failed: ' + (message || 'Unknown error'));
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleSave = async (e) => {
    e?.preventDefault();
    if (!biz) return;
    setSaving(true);
    setMsg('');
    try {
      await settings.updateBusiness({
        pay_period_start: biz.pay_period_start || null,
        company_name: biz.company_name || null,
        company_abn: biz.company_abn || null,
        company_acn: biz.company_acn || null,
        ndis_provider_number: biz.ndis_provider_number || null,
        company_email: biz.company_email || null,
        company_address: biz.company_address || null,
        company_phone: biz.company_phone || null,
        account_name: biz.account_name || null,
        bsb: biz.bsb || null,
        account_number: biz.account_number || null,
        payment_terms_days: biz.payment_terms_days ?? 7,
        accounting_provider: biz.accounting_provider || null
      });
      setMsg('Business settings saved.');
    } catch (err) {
      setMsg(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e?.target?.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) {
      setMsg('Logo too large. Max 500KB.');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/jpg'].includes(file.type)) {
      setMsg('Use PNG or JPG.');
      return;
    }
    setUploading(true);
    setMsg('');
    try {
      const res = await settings.uploadLogo(file);
      setBiz((prev) => ({ ...prev, logo_path: res?.logo_path || 'business-logo.' + (file.type === 'image/png' ? 'png' : 'jpg') }));
      setLogoKey((k) => k + 1);
      setMsg('Logo uploaded.');
    } catch (err) {
      setMsg(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveLogo = async () => {
    setUploading(true);
    setMsg('');
    try {
      await settings.deleteLogo();
      setBiz((prev) => ({ ...prev, logo_path: null }));
      setLogoKey((k) => k + 1);
      setMsg('Logo removed.');
    } catch (err) {
      setMsg(err.message || 'Failed to remove');
    } finally {
      setUploading(false);
    }
  };

  if (!biz) return null;

  return (
    <details id="settings-section-company" className="card settings-collapsible">
      <summary className="settings-collapsible-summary">
        <span className="settings-collapsible-summary-main">
          <span className="settings-collapsible-title">Business setup</span>
          <span className="settings-collapsible-hint">Company details, logo, bank details, Xero, Adobe Sign</span>
        </span>
      </summary>
      <div className="settings-collapsible-body">
      <p className="settings-desc">Company details and payment info shown on invoices.</p>

      <h4 className="settings-subsection-title">Business details</h4>
      <div className="form-group">
        <label>Company name</label>
        <input
          type="text"
          value={biz.company_name || ''}
          onChange={(e) => setBiz({ ...biz, company_name: e.target.value })}
          placeholder="Your business name"
          className="form-input"
        />
      </div>
      <div className="form-group">
        <label>Pay period start (anchor date)</label>
        <input
          type="date"
          value={biz.pay_period_start || ''}
          onChange={(e) => setBiz({ ...biz, pay_period_start: e.target.value || null })}
          className="form-input"
          style={{ maxWidth: 180 }}
        />
        <small className="form-hint">
          Fortnightly pay periods are calculated from this start date. Keep this stable per organisation so hours summaries and payroll exports don’t shift.
        </small>
      </div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
          <label>ABN</label>
          <input
            type="text"
            value={biz.company_abn || ''}
            onChange={(e) => setBiz({ ...biz, company_abn: e.target.value })}
            placeholder="00 000 000 000"
            className="form-input"
          />
        </div>
        <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
          <label>ACN (optional)</label>
          <input
            type="text"
            value={biz.company_acn || ''}
            onChange={(e) => setBiz({ ...biz, company_acn: e.target.value })}
            placeholder="000 000 000"
            className="form-input"
          />
        </div>
        <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
          <label>NDIS provider number</label>
          <input
            type="text"
            value={biz.ndis_provider_number || ''}
            onChange={(e) => setBiz({ ...biz, ndis_provider_number: e.target.value })}
            placeholder="e.g. 4-XXXX-XXXX"
            className="form-input"
          />
        </div>
      </div>
      <div className="form-group">
        <label>Email</label>
        <input
          type="email"
          value={biz.company_email || ''}
          onChange={(e) => setBiz({ ...biz, company_email: e.target.value })}
          placeholder="billing@company.com"
          className="form-input"
        />
      </div>
      <div className="form-group">
        <label>Address</label>
        <input
          type="text"
          value={biz.company_address || ''}
          onChange={(e) => setBiz({ ...biz, company_address: e.target.value })}
          placeholder="Street, suburb, state, postcode"
          className="form-input"
        />
      </div>
      <div className="form-group">
        <label>Phone</label>
        <input
          type="tel"
          value={biz.company_phone || ''}
          onChange={(e) => setBiz({ ...biz, company_phone: e.target.value })}
          placeholder=""
          className="form-input"
        />
      </div>

      <h4 className="settings-subsection-title">Logo</h4>
      <div className="form-group">
        {biz.logo_path ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <img
              src={`${settings.logoUrl()}?t=${logoKey}`}
              alt="Business logo"
              style={{ maxWidth: 120, maxHeight: 80, objectFit: 'contain', border: '1px solid #e2e8f0', borderRadius: 4 }}
            />
            <div>
              <button type="button" className="btn btn-secondary" onClick={handleRemoveLogo} disabled={uploading}>
                {uploading ? 'Removing...' : 'Remove logo'}
              </button>
              <span style={{ marginLeft: '0.5rem', color: '#64748b', fontSize: '0.85rem' }}>PNG or JPG, max 500KB</span>
            </div>
          </div>
        ) : (
          <div>
            <input
              type="file"
              accept="image/png,image/jpeg,image/jpg"
              onChange={handleLogoUpload}
              disabled={uploading}
              style={{ fontSize: '0.9rem' }}
            />
            <small className="form-hint" style={{ display: 'block', marginTop: '0.25rem' }}>PNG or JPG, max 500KB. Shown on invoices.</small>
          </div>
        )}
      </div>

      <h4 className="settings-subsection-title">Payment details</h4>
      <p className="settings-desc">Bank details shown on invoices for payment.</p>
      <div className="form-group">
        <label>Account name</label>
        <input
          type="text"
          value={biz.account_name || ''}
          onChange={(e) => setBiz({ ...biz, account_name: e.target.value })}
          placeholder="As shown on bank statement"
          className="form-input"
        />
      </div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 100 }}>
          <label>BSB</label>
          <input
            type="text"
            value={biz.bsb || ''}
            onChange={(e) => setBiz({ ...biz, bsb: e.target.value })}
            placeholder="000-000"
            className="form-input"
          />
        </div>
        <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
          <label>Account number</label>
          <input
            type="text"
            value={biz.account_number || ''}
            onChange={(e) => setBiz({ ...biz, account_number: e.target.value })}
            placeholder=""
            className="form-input"
          />
        </div>
        <div className="form-group" style={{ flex: 0, minWidth: 100 }}>
          <label>Payment terms (days)</label>
          <input
            type="number"
            min={1}
            max={90}
            value={biz.payment_terms_days ?? 7}
            onChange={(e) => setBiz({ ...biz, payment_terms_days: parseInt(e.target.value, 10) || 7 })}
            className="form-input"
          />
        </div>
      </div>

      <h4 className="settings-subsection-title">Accounting software – Xero</h4>
      <div
        className="settings-desc"
        style={{
          marginBottom: '0.75rem',
          padding: '0.75rem 1rem',
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          fontSize: '0.95rem',
          lineHeight: 1.5,
        }}
      >
        <strong>One Xero company for this Nexus organisation.</strong> The link is not per staff member: you connect once, and everyone in this
        organisation uses the same Xero tenant for billing (for example <strong>Financial → Invoice Batches → Send invoices</strong>, which syncs invoices to Xero for reconciliation). An
        admin or delegate runs the connection flow and signs in to Xero; if that account can access several Xero organisations, the one Nexus
        attaches is determined during that login (you can disconnect and reconnect to change it).
      </div>
      <p className="settings-desc">
        Authorised sales invoices are posted for payment and reconciliation. Your administrator can align account codes on the server with your
        Xero chart of accounts. Use <strong>Connect to Xero</strong> below and sign in to authorise Nexus for this organisation.
      </p>
      {biz.xero_linked ? (
        <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, marginBottom: '1rem' }}>
          <strong style={{ color: '#166534' }}>Linked to Xero</strong>
          {biz.xero_tenant_name && <span style={{ marginLeft: '0.5rem', color: '#15803d' }}>({biz.xero_tenant_name})</span>}
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: '#166534' }}>
            This Xero organisation is shared for all billing actions in this Nexus organisation.
          </p>
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                setMsg('');
                try {
                  const r = await settings.xeroTestInvoice();
                  setMsg(r?.message || 'Test invoice created in Xero.' + (r?.invoiceNumber ? ` Invoice #${r.invoiceNumber}` : ''));
                } catch (err) {
                  setMsg(err?.message || 'Test failed');
                }
              }}
            >
              Test connection (create dummy invoice)
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                setMsg('');
                try {
                  await settings.xeroDisconnect();
                  const fresh = await settings.getBusiness();
                  setBiz(fresh);
                  setMsg('Disconnected from Xero.');
                } catch (err) {
                  setMsg(err?.message || 'Failed to disconnect');
                }
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: '1rem' }}>
          {!biz.xero_oauth_via_env && (
            <p className="settings-desc" style={{ marginBottom: '0.75rem', color: '#b45309', background: '#fffbeb', border: '1px solid #fcd34d', padding: '0.75rem 1rem', borderRadius: 8 }}>
              Xero is not enabled on this server yet. Ask your administrator to turn on Xero integration. They can register the app in the{' '}
              <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener noreferrer">Xero developer portal</a>.
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!biz.xero_oauth_via_env}
            onClick={async () => {
              setMsg('');
              try {
                const { redirectUrl } = await settings.xeroConnect();
                if (redirectUrl) window.location.href = redirectUrl;
                else setMsg('No redirect URL returned.');
              } catch (err) {
                setMsg(err?.message || 'Failed to connect');
              }
            }}
          >
            Connect to Xero
          </button>
        </div>
      )}

      <h4 className="settings-subsection-title">Signatures – Adobe Acrobat Sign</h4>
      <p className="settings-desc">
        Connect once per Nexus organisation. An admin or delegate signs in to Acrobat Sign and approves access so participant onboarding agreements are sent from{' '}
        <strong>your</strong> Adobe account (API calls use the correct regional host for that account). This replaces past setups that used a single access token in server env
        only—both still work if your host sets{' '}
        <code style={{ background: '#f1f5f9', padding: '0 4px', borderRadius: 4, fontSize: '0.9em' }}>ADOBE_SIGN_ACCESS_TOKEN</code>.
      </p>
      {biz.adobe_sign_linked ? (
        <div style={{ padding: '1rem', background: '#f0f9ff', border: '1px solid #7dd3fc', borderRadius: 8, marginBottom: '1rem' }}>
          <strong style={{ color: '#0369a1' }}>Adobe Sign is connected</strong>
          {biz.adobe_sign_web_access_point ? (
            <span style={{ marginLeft: '0.5rem', color: '#0c4a6e', fontSize: '0.9rem' }}>({biz.adobe_sign_web_access_point})</span>
          ) : null}
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: '#0369a1' }}>
            {biz.adobe_sign_oauth_linked
              ? 'OAuth tokens for this organisation are stored on the server and refreshed automatically.'
              : 'Using access token from server environment (hosting configuration).'}
          </p>
          {biz.adobe_sign_oauth_linked ? (
            <div style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={async () => {
                  setMsg('');
                  try {
                    await settings.adobeSignDisconnect();
                    const fresh = await settings.getBusiness();
                    setBiz(fresh);
                    setMsg('Disconnected from Adobe Sign.');
                  } catch (err) {
                    setMsg(err?.message || 'Failed to disconnect');
                  }
                }}
              >
                Disconnect Adobe Sign
              </button>
            </div>
          ) : biz.adobe_sign_via_host_token_only ? (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#0c4a6e' }}>
              To switch to “Connect to Adobe Sign” for this org, remove{' '}
              <code style={{ background: '#f1f5f9', padding: '0 4px', borderRadius: 4, fontSize: '0.9em' }}>ADOBE_SIGN_ACCESS_TOKEN</code> from the
              server and use the button below, or keep using the host token.
            </p>
          ) : null}
        </div>
      ) : (
        <div style={{ marginBottom: '1rem' }}>
          {!biz.adobe_sign_oauth_via_env && (
            <p
              className="settings-desc"
              style={{
                marginBottom: '0.75rem',
                color: '#b45309',
                background: '#fffbeb',
                border: '1px solid #fcd34d',
                padding: '0.75rem 1rem',
                borderRadius: 8,
              }}
            >
              One-click Adobe Sign is not enabled on this server yet. Your administrator adds{' '}
              <code style={{ background: '#f1f5f9', padding: '0 4px', borderRadius: 4, fontSize: '0.9em' }}>ADOBE_SIGN_CLIENT_ID</code> and{' '}
              <code style={{ background: '#f1f5f9', padding: '0 4px', borderRadius: 4, fontSize: '0.9em' }}>ADOBE_SIGN_CLIENT_SECRET</code> to the API
              host, registers the callback URL in the Acrobat Sign API application, and restarts the server.
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!biz.adobe_sign_oauth_via_env}
            onClick={async () => {
              setMsg('');
              try {
                const { redirectUrl } = await settings.adobeSignConnect();
                if (redirectUrl) window.location.href = redirectUrl;
                else setMsg('No redirect URL returned.');
              } catch (err) {
                setMsg(err?.message || 'Failed to connect');
              }
            }}
          >
            Connect to Adobe Sign
          </button>
        </div>
      )}

      {msg && (
        <div
          className={
            msg.includes('saved') ||
            msg.includes('uploaded') ||
            msg.includes('removed') ||
            msg.includes('Disconnected') ||
            msg.includes('Disconnected from Adobe') ||
            msg.includes('created in Xero') ||
            msg.includes('Invoice #') ||
            msg.includes('Successfully linked to Adobe') ||
            msg.includes('Successfully linked to Xero')
              ? 'settings-success'
              : 'settings-error'
          }
        >
          {msg}
        </div>
      )}
      <div className="settings-buttons">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save business settings'}
        </button>
      </div>
      </div>
    </details>
  );
}

function LearningSettings() {
  const [config, setConfig] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [showAudit, setShowAudit] = useState(false);
  const [audit, setAudit] = useState([]);

  useEffect(() => {
    learning.getConfig().then(setConfig).catch(() => {});
    learning.metrics().then(setMetrics).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMsg('');
    try {
      await learning.updateConfig(config);
      setMsg('Learning settings saved.');
    } catch (err) {
      setMsg(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const loadAudit = async () => {
    try {
      const data = await learning.audit({ limit: 30 });
      setAudit(data.rows || []);
      setShowAudit(true);
    } catch { setAudit([]); setShowAudit(true); }
  };

  if (!config) return null;

  const acc = metrics?.suggestions;

  return (
    <details className="card settings-collapsible">
      <summary className="settings-collapsible-summary">
        <span className="settings-collapsible-summary-main">
          <span className="settings-collapsible-title">Learning Layer</span>
          <span className="settings-collapsible-hint">Shift-pattern suggestions and retention</span>
        </span>
      </summary>
      <div className="settings-collapsible-body">
      <p className="settings-desc">
        The CRM learns from shift patterns and usage to make suggestions. All suggestions require your confirmation before applying.
      </p>

      <div className="form-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={config.learning_enabled === 'true'} onChange={(e) => setConfig({ ...config, learning_enabled: e.target.checked ? 'true' : 'false' })} />
          Enable learning
        </label>
        <small className="form-hint">When enabled, the system records shift patterns and provides suggestions.</small>
      </div>

      <div className="form-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={config.per_user_learning === 'true'} onChange={(e) => setConfig({ ...config, per_user_learning: e.target.checked ? 'true' : 'false' })} />
          Per-staff learning
        </label>
        <small className="form-hint">Learn patterns per staff member in addition to per participant and org-wide.</small>
      </div>

      <div className="form-group">
        <label>Suggestion confidence threshold</label>
        <input
          type="range" min="0" max="1" step="0.05"
          value={parseFloat(config.suggestion_confidence_threshold) || 0.3}
          onChange={(e) => setConfig({ ...config, suggestion_confidence_threshold: e.target.value })}
          style={{ width: '100%', maxWidth: 300 }}
        />
        <small className="form-hint">
          {Math.round((parseFloat(config.suggestion_confidence_threshold) || 0.3) * 100)}% — higher = fewer but more confident suggestions.
        </small>
      </div>

      <div className="form-group">
        <label>Event retention (days)</label>
        <input
          type="number" min={30} max={3650}
          value={parseInt(config.event_retention_days) || 730}
          onChange={(e) => setConfig({ ...config, event_retention_days: String(e.target.value) })}
          className="form-input" style={{ maxWidth: 120 }}
        />
        <small className="form-hint">Learning events older than this are automatically deleted. Default 730 days (2 years).</small>
      </div>

      {acc && acc.total > 0 && (
        <div style={{ margin: '1rem 0', padding: '0.75rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: '0.85rem' }}>
          <strong>Metrics</strong>
          <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <div><span style={{ color: '#64748b' }}>Suggestions:</span> {acc.total}</div>
            <div><span style={{ color: '#22c55e' }}>Accepted:</span> {acc.accepted} ({Math.round(acc.acceptance_rate * 100)}%)</div>
            <div><span style={{ color: '#ef4444' }}>Rejected:</span> {acc.rejected}</div>
            <div><span style={{ color: '#94a3b8' }}>Suppressed:</span> {acc.suppressed}</div>
          </div>
          {metrics?.events && (
            <div style={{ marginTop: '0.3rem', color: '#64748b' }}>
              Events recorded: {metrics.events.total} | Aggregates: {metrics.aggregates?.total || 0} | CSV mappings: {metrics.csv_mappings?.total || 0}
            </div>
          )}
        </div>
      )}

      {msg && <div className={msg.includes('saved') ? 'settings-success' : 'settings-error'}>{msg}</div>}

      <div className="settings-buttons">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save learning settings'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={loadAudit}>
          View audit log
        </button>
      </div>

      {showAudit && (
        <div style={{ marginTop: '1rem' }}>
          <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Recent suggestion audit</h4>
          {audit.length === 0 ? <p style={{ color: '#64748b', fontSize: '0.85rem' }}>No suggestions recorded yet.</p> : (
            <div className="table-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                    <th style={{ padding: '0.3rem' }}>Type</th>
                    <th style={{ padding: '0.3rem' }}>Value</th>
                    <th style={{ padding: '0.3rem' }}>Confidence</th>
                    <th style={{ padding: '0.3rem' }}>Outcome</th>
                    <th style={{ padding: '0.3rem' }}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '0.3rem' }}>{a.suggestion_type}</td>
                      <td style={{ padding: '0.3rem', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.suggested_value}</td>
                      <td style={{ padding: '0.3rem' }}>{a.confidence != null ? `${Math.round(a.confidence * 100)}%` : ''}</td>
                      <td style={{ padding: '0.3rem', color: a.outcome === 'accepted' ? '#22c55e' : a.outcome === 'rejected' ? '#ef4444' : '#64748b' }}>{a.outcome}</td>
                      <td style={{ padding: '0.3rem', color: '#64748b' }}>{a.created_at ? formatDate(a.created_at) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => setShowAudit(false)} style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
            Close audit log
          </button>
        </div>
      )}
      </div>
    </details>
  );
}
