import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { staff, learning, settings, ai, auth, microsoftDrive } from '../lib/api';
import SearchableSelect from '../components/SearchableSelect';
import { formatDate } from '../lib/dateUtils';

const SIGNATURE_WIDTH = 300;
const SIGNATURE_HEIGHT = 120;

export default function SettingsPage() {
  const { user, updateSettings, refreshUser, canManageUsers, isAdmin } = useAuth();
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
    ai.status().then(setAiStatus).catch(() => setAiStatus({ available: false }));
  }, []);

  const handleLinkOllama = async () => {
    setAiMessage('');
    setAiChecking(true);
    try {
      const result = await ai.status();
      setAiStatus(result);
      if (result?.available) {
        setAiMessage('Ollama connected.');
      } else {
        setAiMessage(result?.error || "Ollama isn't running. Install Ollama, open it, then click Link to Ollama again.");
      }
    } catch {
      setAiStatus({ available: false });
      setAiMessage("Could not check Ollama. Open the Ollama app on this machine and try again.");
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
      <div className="card">
        <h3 className="settings-section-title">Connect your email</h3>
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

      <div className="card">
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

      <div className="card">
        <h3 className="settings-section-title">AI (Ollama)</h3>
        <p className="settings-desc">Local AI for NDIS plan extraction, intake forms, and CSV mapping. Patient data never leaves this machine.</p>
        {aiStatus?.available ? (
          <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, marginBottom: '1rem' }}>
            <strong style={{ color: '#166534' }}>Linked to Ollama</strong>
            <span style={{ marginLeft: '0.5rem', color: '#15803d' }}>({aiStatus.model || 'default'})</span>
            <div style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleLinkOllama}
                disabled={aiChecking}
              >
                {aiChecking ? 'Checking...' : 'Check again'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label>Status</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: '#ef4444'
                  }}
                  title="Ollama not available"
                />
                <span>Not connected</span>
              </div>
            </div>
            <p className="settings-desc" style={{ marginBottom: '0.75rem' }}>Install and open the Ollama app, then click Link to Ollama below.</p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" className="btn btn-primary">
                Download Ollama
              </a>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleLinkOllama}
                disabled={aiChecking}
              >
                {aiChecking ? 'Checking...' : 'Link to Ollama'}
              </button>
            </div>
            {aiMessage && !aiStatus?.available && (
              <div className={aiMessage.includes('connected') ? 'settings-success' : 'settings-error'} style={{ marginTop: '0.25rem' }}>
                {aiMessage}
              </div>
            )}
            {aiMessage && !aiStatus?.available && !aiMessage.includes('connected') && (
              <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                1. Download and install Ollama · 2. Open the Ollama app · 3. Click Link to Ollama again.
              </p>
            )}
          </>
        )}
        <small className="form-hint" style={{ display: 'block', marginTop: '0.5rem' }}>Server admins: set OLLAMA_MODEL to any model name (e.g. gemma3, qwen2.5:14b). OLLAMA_BASE_URL defaults to 127.0.0.1:11434. If OLLAMA_MODEL is not set, the first model in Ollama is used.</small>
      </div>

      {isAdmin && (
        <div className="settings-section" style={{ marginBottom: '1.5rem' }}>
          <h3>Document archive (Microsoft 365)</h3>
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
            Azure app needs delegated <code>Files.ReadWrite.All</code> and redirect URI{' '}
            <code>{`${window.location.origin}/api/integrations/microsoft-drive/callback`}</code> (use <code>OAUTH_PUBLIC_URL</code> on the server if the API host differs).
          </p>
        </div>
      )}

      {canManageUsers && <ShifterOrgLinkCard />}
      {canManageUsers && <ScheduleShiftAppLinkCard />}
      {canManageUsers && <BusinessSetup />}
      <LearningSettings />
      </div>
    </div>
  );
}

function ShifterOrgLinkCard() {
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [shifterName, setShifterName] = useState('');
  const [linkInfo, setLinkInfo] = useState(null);

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
    const name = shifterName.trim();
    if (!name) {
      setMsg('Enter your Shifter organisation name first.');
      return;
    }
    setMsg('');
    setBusy(true);
    try {
      await auth.linkShifterOrg(name);
      await load();
      setMsg('Shifter organisation linked.');
      setShifterName('');
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

  return (
    <div className="card">
      <h3 className="settings-section-title" style={{ marginTop: 0 }}>Shifter organisation link</h3>
      <p className="settings-desc">
        Your Nexus Core organisation is created independently. Link to Shifter here when you are ready.
      </p>
      <div className="form-group">
        <label>Current status</label>
        {loading ? (
          <div className="form-hint">Loading…</div>
        ) : linkInfo?.linked ? (
          <div className="settings-success">Linked to Shifter org ID: {linkInfo.shifter_organization_id}</div>
        ) : (
          <div className="form-hint">Not linked</div>
        )}
      </div>
      <div className="form-group">
        <label>Shifter organisation name</label>
        <input
          className="form-input"
          type="text"
          value={shifterName}
          onChange={(e) => setShifterName(e.target.value)}
          placeholder="Exact name used in Shifter"
        />
      </div>
      <div className="settings-buttons">
        <button type="button" className="btn btn-primary" onClick={onLink} disabled={busy || loading}>
          {busy ? 'Saving...' : 'Link to Shifter'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onUnlink} disabled={busy || loading || !linkInfo?.linked}>
          Unlink
        </button>
      </div>
      {msg && <div className={msg.toLowerCase().includes('linked') && !msg.toLowerCase().includes('could not') ? 'settings-success' : 'settings-error'} style={{ marginTop: '0.75rem' }}>{msg}</div>}
    </div>
  );
}

function ScheduleShiftAppLinkCard() {
  const [copyMsg, setCopyMsg] = useState('');
  const base = window.location.origin.replace(/\/$/, '');
  const webhookUrl = `${base}/api/webhooks/progress-app`;
  const syncUrl = `${base}/api/sync/from-excel`;

  const copyText = async (label, value) => {
    setCopyMsg('');
    try {
      await navigator.clipboard.writeText(value);
      setCopyMsg(`${label} copied.`);
    } catch {
      setCopyMsg(`Could not copy automatically. Please copy ${label.toLowerCase()} manually.`);
    }
  };

  return (
    <div className="card">
      <h3 className="settings-section-title" style={{ marginTop: 0 }}>Schedule Shift App Link</h3>
      <p className="settings-desc">
        Use this URL in your external app when sending shift data into Nexus Core.
      </p>

      <div className="form-group">
        <label>Webhook endpoint (if enabled)</label>
        <input className="form-input" value={webhookUrl} readOnly />
        <small className="form-hint">
          Method: <code>POST</code>. If your current build does not expose this route, use the Excel sync endpoint below.
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
          Method: <code>POST</code> with signed-in session, or send header <code>x-api-key: CRM_API_KEY</code>.
        </small>
      </div>
      <div className="settings-buttons">
        <button type="button" className="btn btn-secondary" onClick={() => copyText('Sync URL', syncUrl)}>
          Copy sync URL
        </button>
      </div>

      <small className="form-hint" style={{ display: 'block', marginTop: '0.5rem' }}>
        You can always trigger the fallback manually from the Shifts page using <strong>Sync from Excel</strong>.
      </small>
      {copyMsg && <div className={copyMsg.includes('copied') ? 'settings-success' : 'settings-error'} style={{ marginTop: '0.75rem' }}>{copyMsg}</div>}
    </div>
  );
}

function BusinessSetup() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [biz, setBiz] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');
  const [logoKey, setLogoKey] = useState(0);

  useEffect(() => {
    settings.getBusiness().then(setBiz).catch(() => setBiz(null));
  }, []);

  useEffect(() => {
    const xero = searchParams.get('xero');
    const message = searchParams.get('message');
    if (xero === 'linked') {
      setMsg('Successfully linked to Xero.');
      setSearchParams({}, { replace: true });
      settings.getBusiness().then(setBiz).catch(() => {});
    } else if (xero === 'error') {
      setMsg('Xero connection failed: ' + (message || 'Unknown error'));
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
    <div className="card">
      <h3 className="settings-section-title" style={{ marginTop: 0 }}>Business setup</h3>
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
      <p className="settings-desc">
        Link your Xero organisation. Use <strong>Financial → Invoice Batches → Send batch to Xero</strong> to post each participant invoice as an
        authorised sales invoice (for payment / reconciliation). Set server env <code>XERO_SALES_ACCOUNT_CODE</code> (and tax type overrides if
        needed) to match your chart of accounts. Create an app at{' '}
        <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener noreferrer">developer.xero.com</a>{' '}
        (Auth Code grant), then enter the details below and connect.
      </p>
      {biz.xero_linked ? (
        <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, marginBottom: '1rem' }}>
          <strong style={{ color: '#166534' }}>Linked to Xero</strong>
          {biz.xero_tenant_name && <span style={{ marginLeft: '0.5rem', color: '#15803d' }}>({biz.xero_tenant_name})</span>}
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
        <>
          <div className="form-group">
            <label>Client ID</label>
            <input
              type="text"
              value={biz.xero_client_id || ''}
              onChange={(e) => setBiz({ ...biz, xero_client_id: e.target.value })}
              placeholder="From your Xero app"
              className="form-input"
              autoComplete="off"
            />
          </div>
          <div className="form-group">
            <label>Client Secret</label>
            <input
              type="password"
              value={biz.xero_client_secret || ''}
              onChange={(e) => setBiz({ ...biz, xero_client_secret: e.target.value })}
              placeholder="From your Xero app"
              className="form-input"
              autoComplete="new-password"
            />
            <small className="form-hint">Stored securely. Not shown after save.</small>
          </div>
          <div className="form-group">
            <label>Redirect URI</label>
            <input
              type="url"
              value={biz.xero_redirect_uri || ''}
              onChange={(e) => setBiz({ ...biz, xero_redirect_uri: e.target.value })}
              placeholder="https://your-nexus.com/api/settings/xero-callback"
              className="form-input"
            />
            <small className="form-hint">
              Must match exactly what you add in your Xero app. Production: https://…/api/settings/xero-callback. If Xero requires https on
              localhost, set <code>VITE_DEV_HTTPS=true</code> in project root <code>.env</code>, restart <code>npm start</code>, use{' '}
              https://localhost:5174/api/settings/xero-callback (accept the self-signed cert in your browser once). Otherwise use http:// for
              local dev.
            </small>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                setMsg('');
                const clientId = (biz.xero_client_id || '').trim();
                const clientSecret = (biz.xero_client_secret || '').trim();
                const redirectUri = (biz.xero_redirect_uri || '').trim();
                if (!clientId || !clientSecret || !redirectUri) {
                  setMsg('Enter Client ID, Client Secret, and Redirect URI.');
                  return;
                }
                try {
                  const { redirectUrl } = await settings.xeroSaveAndConnect({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
                  if (redirectUrl) window.location.href = redirectUrl;
                  else setMsg('No redirect URL returned.');
                } catch (err) {
                  setMsg(err?.message || 'Failed to connect');
                }
              }}
            >
              Save and connect to Xero
            </button>
          </div>
        </>
      )}

      {msg && <div className={msg.includes('saved') || msg.includes('uploaded') || msg.includes('removed') || msg.includes('Disconnected') || msg.includes('created in Xero') || msg.includes('Invoice #') ? 'settings-success' : 'settings-error'}>{msg}</div>}
      <div className="settings-buttons">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save business settings'}
        </button>
      </div>
    </div>
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
    <div className="card">
      <h3 className="settings-section-title" style={{ marginTop: 0 }}>Learning Layer</h3>
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
  );
}
