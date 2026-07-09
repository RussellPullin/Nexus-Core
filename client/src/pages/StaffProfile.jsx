import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import { backToStaffListPath } from '../lib/listViewUrl.js';
import { staff, participants, shifts, forms } from '../lib/api';
import SearchableSelect from '../components/SearchableSelect';
import OnboardingDocumentSelectPanel from '../components/OnboardingDocumentSelectPanel.jsx';
import { inferStaffOnboardingRole } from '@nexus-shared/onboardingDocumentContext.js';
import { groupShiftsByExcelPeriods, groupShiftsByPayPeriod } from '../lib/payPeriod';
import { formatDate } from '../lib/dateUtils';
import {
  STAFF_AVAILABILITY_DAYS,
  parseStaffAvailabilityFromRow,
  hasAnyAvailabilitySlots,
  validateAvailabilitySlots,
  formatHmLocal,
} from '../lib/staffAvailability.js';
import {
  effectivePayRates,
  payRateFormFieldsFromRow,
  payRateOverridesFromFormFields,
} from '../lib/payrollRates.js';
import { NEXUS_CORE_SIGN_COMING_SOON_TITLE } from '../lib/featureFlags.js';

const PAYROLL_SHIFT_STATUSES = ['completed', 'completed_by_admin'];

function staffEditFormFromRow(staffRow) {
  return {
    name: staffRow?.name || '',
    email: staffRow?.email || '',
    phone: staffRow?.phone || '',
    notify_email: !!staffRow?.notify_email,
    notify_sms: !!staffRow?.notify_sms,
    role: staffRow?.role || '',
    employment_type: staffRow?.employment_type || 'employee',
    hourly_rate: staffRow?.hourly_rate != null ? String(staffRow.hourly_rate) : '',
    pay_frequency: staffRow?.pay_frequency || '',
    governing_state: staffRow?.governing_state || '',
    supervisor_name: staffRow?.supervisor_name || '',
    ...payRateFormFieldsFromRow(staffRow),
    availability: parseStaffAvailabilityFromRow(staffRow),
  };
}

export default function StaffProfile() {
  const pathPrefix = useProductPathPrefix();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const staffListPath = backToStaffListPath(searchParams, pathPrefix);
  const [data, setData] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [participantsList, setParticipantsList] = useState([]);
  const [assignParticipantId, setAssignParticipantId] = useState('');
  const [staffShifts, setStaffShifts] = useState([]);
  const [hoursSummary, setHoursSummary] = useState([]);
  const [loadingHoursSummary, setLoadingHoursSummary] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [onboardingSending, setOnboardingSending] = useState(false);
  const [showOnboardPanel, setShowOnboardPanel] = useState(false);
  const [onboardPackFeedback, setOnboardPackFeedback] = useState(null);
  const [extraPdfCount, setExtraPdfCount] = useState(null);
  const onboardPanelRef = useRef(null);
  // Phase 3: one-click orchestrator UI state.
  const [orchBusy, setOrchBusy] = useState(false);
  const [orchResult, setOrchResult] = useState(null);
  const [orchError, setOrchError] = useState('');
  const [staffReadiness, setStaffReadiness] = useState(null);
  const [contractDownloading, setContractDownloading] = useState(false);
  const [complianceDocs, setComplianceDocs] = useState([]);
  const [policyFiles, setPolicyFiles] = useState([]);
  const [policyUploading, setPolicyUploading] = useState(false);
  const [renewalSending, setRenewalSending] = useState(false);
  const [intakeViewing, setIntakeViewing] = useState(false);
  const [intakePreview, setIntakePreview] = useState(null);
  const [complianceUploading, setComplianceUploading] = useState(false);
  const [newDocType, setNewDocType] = useState('first_aid');
  const [newDocFile, setNewDocFile] = useState(null);
  const [newDocExpiry, setNewDocExpiry] = useState('');
  const [editingExpiryDocId, setEditingExpiryDocId] = useState(null);
  const [editingExpiryValue, setEditingExpiryValue] = useState('');
  const [editForm, setEditForm] = useState(() => staffEditFormFromRow({}));

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setData(null);
    try {
      let staffData = null;
      try {
        staffData = await staff.get(id);
      } catch (getErr) {
        const list = await staff.list(true);
        staffData = list?.find((s) => s.id === id) || null;
      }
      if (!staffData) {
        setLoading(false);
        return;
      }
      const [assignList, partList, shiftsList] = await Promise.all([
        staff.getAssignments(id).catch(() => []),
        participants.list().catch(() => []),
        shifts.list({ staff_id: id }).catch(() => [])
      ]);
      setData(staffData);
      setAssignments(assignList || []);
      setParticipantsList(partList || []);
      setStaffShifts(shiftsList || []);
      const [compList, policyList] = await Promise.all([
        staff.getComplianceDocuments(id).catch(() => []),
        forms.policyFilesList().catch(() => [])
      ]);
      setComplianceDocs(Array.isArray(compList) ? compList : []);
      setPolicyFiles(Array.isArray(policyList) ? policyList : []);
      setEditForm(staffEditFormFromRow(staffData));
      // Phase 3: pull readiness so the run-onboarding button can show why it's disabled.
      staff
        .onboardingRunStatus(id)
        .then((r) => setStaffReadiness(r?.readiness || null))
        .catch(() => setStaffReadiness(null));
    } catch (err) {
      console.error('StaffProfile load:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) load();
    else setLoading(false);
  }, [id]);

  useEffect(() => {
    if (showOnboardPanel && onboardPanelRef.current) {
      onboardPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showOnboardPanel]);

  const loadHoursSummary = async () => {
    if (!id) return;
    setLoadingHoursSummary(true);
    try {
      const res = await staff.getShiftHoursSummary(id);
      setHoursSummary(res?.summaryRows || []);
    } catch (err) {
      console.error('Shift hours summary:', err);
      setHoursSummary([]);
    } finally {
      setLoadingHoursSummary(false);
    }
  };

  const loadHoursData = () => {
    loadHoursSummary();
  };

  useEffect(() => {
    if (data?.name) loadHoursData();
  }, [data?.name, id]);

  const completedStaffShifts = useMemo(
    () => (staffShifts || []).filter((s) => PAYROLL_SHIFT_STATUSES.includes(s.status)),
    [staffShifts]
  );

  const viewAvail = useMemo(
    () => (data ? parseStaffAvailabilityFromRow(data) : null),
    [data]
  );
  const viewPayRates = useMemo(
    () => (data ? effectivePayRates(data) : null),
    [data]
  );

  const handleAssign = async () => {
    if (!assignParticipantId) return;
    setSaving(true);
    try {
      await staff.assignParticipant(id, assignParticipantId);
      setAssignParticipantId('');
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveAssignment = async (assignmentId) => {
    if (!confirm('Remove this participant assignment?')) return;
    try {
      await staff.removeAssignment(id, assignmentId);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    const slotCheck = validateAvailabilitySlots(editForm.availability);
    if (!slotCheck.ok) {
      alert(slotCheck.message);
      return;
    }
    setSaving(true);
    try {
      await staff.update(id, {
        name: editForm.name,
        email: editForm.email,
        phone: editForm.phone,
        notify_email: editForm.notify_email,
        notify_sms: editForm.notify_sms,
        role: editForm.role,
        employment_type: editForm.employment_type,
        hourly_rate: editForm.hourly_rate,
        pay_frequency: editForm.pay_frequency,
        governing_state: editForm.governing_state,
        supervisor_name: editForm.supervisor_name,
        pay_rates: payRateOverridesFromFormFields(editForm),
        availability: editForm.availability,
      });
      setShowEdit(false);
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadEmploymentContract = async () => {
    setContractDownloading(true);
    try {
      await staff.downloadEmploymentContract(id);
    } catch (err) {
      alert(err.message || 'Could not download contract');
    } finally {
      setContractDownloading(false);
    }
  };

  const handleViewIntakeForm = async () => {
    setIntakeViewing(true);
    try {
      const result = await staff.getIntakeForm(id);
      setIntakePreview(result);
    } catch (err) {
      alert(err.message || 'Could not load staff intake form');
    } finally {
      setIntakeViewing(false);
    }
  };

  // Phase 3: one-click orchestrator. Runs readiness + library clone + ensures the
  // staff_onboarding row exists. Does NOT send the invite email — the existing
  // "Onboard" / "Resend onboarding email" buttons still drive that, and the
  // signing layer remains untouched.
  const handleRunStaffOnboarding = async () => {
    setOrchBusy(true);
    setOrchError('');
    try {
      const result = await staff.onboardingRun(id);
      setOrchResult(result);
      try {
        const rs = await staff.onboardingRunStatus(id);
        setStaffReadiness(rs?.readiness || null);
      } catch {
        /* keep prev readiness */
      }
    } catch (err) {
      setOrchError(err?.message || 'Run failed');
    } finally {
      setOrchBusy(false);
    }
  };

  const onboardEmailButtonLabel = () => {
    if (showOnboardPanel) return 'Hide onboarding pack';
    if (onboardingSending) return 'Sending…';
    if (data?.onboarding_status === 'complete') return 'Resend with selected docs';
    if (data?.onboarding_status === 'in_progress') return 'Resend onboarding email';
    return 'Onboard';
  };

  const handleOpenOnboardPanel = async () => {
    if (!data?.email) {
      alert('Add an email address for this staff member first.');
      return;
    }
    if (showOnboardPanel) {
      setShowOnboardPanel(false);
      setOnboardPackFeedback(null);
      return;
    }
    setOnboardPackFeedback(null);
    try {
      const extraDocs = await forms.policyFilesList().catch(() => []);
      setExtraPdfCount(Array.isArray(extraDocs) ? extraDocs.length : 0);
    } catch {
      setExtraPdfCount(null);
    }
    setShowOnboardPanel(true);
  };

  const handleConfirmSendStaffOnboarding = async (payload) => {
    setOnboardingSending(true);
    setOnboardPackFeedback(null);
    try {
      const result = await staff.startOnboarding(id, payload);
      const policyCount = result?.attachment_count ?? 0;
      const sigCount = result?.signature_request_count ?? result?.signature_requests?.length ?? 0;
      let message;
      if (policyCount > 0 && sigCount > 0) {
        message = `Email sent with ${policyCount} policy PDF${policyCount === 1 ? '' : 's'}. ${sigCount} form${sigCount === 1 ? ' was' : 's were'} sent for signature via Dropbox Sign.`;
      } else if (policyCount > 0) {
        message = `Onboarding email sent with ${policyCount} policy PDF attachment${policyCount === 1 ? '' : 's'}.`;
      } else if (sigCount > 0) {
        message = `Onboarding email sent. ${sigCount} form${sigCount === 1 ? ' was' : 's were'} sent for signature via Dropbox Sign.`;
      } else {
        message = 'Onboarding email sent (form link only, no attachments).';
      }
      setOnboardPackFeedback({ type: 'success', message });
      load();
    } catch (err) {
      const message = err.message || 'Could not send onboarding email';
      setOnboardPackFeedback({ type: 'error', message });
      throw err;
    } finally {
      setOnboardingSending(false);
    }
  };

  const handleSendRenewalReminder = async () => {
    setRenewalSending(true);
    try {
      await staff.sendRenewalReminder(id);
      alert('Renewal reminder sent to the staff member and their manager.');
      load();
    } catch (err) {
      alert(err.message || 'Failed to send reminder');
    } finally {
      setRenewalSending(false);
    }
  };

  const handleSendRenewalLink = async () => {
    if (!data?.email) { alert('No email address.'); return; }
    setRenewalSending(true);
    try {
      await staff.sendRenewalLink(id);
      alert('Renewal upload link sent to ' + data.email);
      load();
    } catch (err) {
      alert(err.message || 'Failed to send link');
    } finally {
      setRenewalSending(false);
    }
  };

  const handlePolicyUpload = async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    setPolicyUploading(true);
    try {
      await forms.policyFilesUpload(file, file.name.replace(/\.pdf$/i, ''));
      load();
    } catch (err) {
      alert(err.message || 'Upload failed');
    } finally {
      setPolicyUploading(false);
      e.target.value = '';
    }
  };

  const handlePolicyDelete = async (policyId) => {
    if (!confirm('Remove this policy file from the list?')) return;
    try {
      await forms.policyFilesDelete(policyId);
      setPolicyFiles((prev) => prev.filter((p) => p.id !== policyId));
    } catch (err) {
      alert(err.message || 'Delete failed');
    }
  };

  const docTypeLabel = (type) => {
    const labels = {
      drivers_licence_front: "Driver's licence (front)",
      drivers_licence_back: "Driver's licence (back)",
      blue_card: 'Blue Card',
      yellow_card: 'Yellow Card',
      first_aid: 'First Aid',
      car_insurance: 'Car insurance'
    };
    return labels[type] || type;
  };

  const formatIntakeValue = (field) => {
    const raw = field?.value;
    if (raw == null || raw === '') return '—';
    if (field?.type === 'boolean') {
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return 'Yes';
      if (s === 'false' || s === '0' || s === 'no') return 'No';
    }
    const text = String(raw);
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.length ? parsed.join(', ') : '—';
        if (parsed && typeof parsed === 'object') {
          return Object.entries(parsed)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
            .join('; ');
        }
      } catch {
        return text;
      }
    }
    return text;
  };

  const COMPLIANCE_DOC_OPTIONS = [
    { value: 'drivers_licence_front', label: "Driver's licence (front)" },
    { value: 'drivers_licence_back', label: "Driver's licence (back)" },
    { value: 'blue_card', label: 'Blue Card' },
    { value: 'yellow_card', label: 'Yellow Card' },
    { value: 'first_aid', label: 'First Aid Certificate' },
    { value: 'car_insurance', label: 'Car insurance' }
  ];

  const handleUploadCompliance = async (e) => {
    e.preventDefault();
    if (!newDocFile) { alert('Choose a file.'); return; }
    setComplianceUploading(true);
    try {
      await staff.uploadComplianceDocument(id, newDocFile, newDocType, newDocExpiry || undefined);
      setNewDocFile(null);
      setNewDocExpiry('');
      if (e.target?.reset) e.target.reset();
      load();
    } catch (err) {
      alert(err.message || 'Upload failed');
    } finally {
      setComplianceUploading(false);
    }
  };

  const handleSaveExpiry = async (docId) => {
    try {
      await staff.updateComplianceDocumentExpiry(id, docId, editingExpiryValue || undefined);
      setEditingExpiryDocId(null);
      setEditingExpiryValue('');
      load();
    } catch (err) {
      alert(err.message || 'Failed to update expiry');
    }
  };

  const handleDeleteComplianceDocument = async (docId) => {
    if (!confirm('Remove this compliance document?')) return;
    try {
      await staff.deleteComplianceDocument(id, docId);
      setComplianceDocs((prev) => prev.filter((doc) => doc.id !== docId));
    } catch (err) {
      alert(err.message || 'Failed to remove document');
    }
  };

  const addAvailabilitySlot = (dayKey) => {
    setEditForm((f) => ({
      ...f,
      availability: {
        ...f.availability,
        [dayKey]: [...(f.availability[dayKey] || []), { start: '09:00', end: '17:00' }],
      },
    }));
  };

  const updateAvailabilitySlot = (dayKey, index, field, value) => {
    setEditForm((f) => {
      const slots = [...(f.availability[dayKey] || [])];
      slots[index] = { ...slots[index], [field]: value };
      return { ...f, availability: { ...f.availability, [dayKey]: slots } };
    });
  };

  const removeAvailabilitySlot = (dayKey, index) => {
    setEditForm((f) => {
      const slots = (f.availability[dayKey] || []).filter((_, i) => i !== index);
      return { ...f, availability: { ...f.availability, [dayKey]: slots } };
    });
  };

  const assignedIds = new Set(assignments.map((a) => a.participant_id));
  const availableParticipants = participantsList
    .filter((p) => !assignedIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name + (p.ndis_number ? ` (${p.ndis_number})` : '') }));

  if (!id) {
    return (
      <div className="content">
        <p>Invalid staff link.</p>
        <Link to={staffListPath} className="btn btn-primary" style={{ display: 'inline-block', marginTop: '1rem' }}>Back to Staff</Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="content">
        <p>Loading...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="content">
        <p>Staff not found.</p>
        <p style={{ marginTop: '0.5rem', color: '#64748b' }}>
          Staff must be added on the Staff page first. Go to Staff and click &quot;Add Staff&quot; to create support workers.
        </p>
        <Link to={staffListPath} className="btn btn-primary" style={{ display: 'inline-block', marginTop: '1rem' }}>Back to Staff</Link>
      </div>
    );
  }

  return (
    <div className="content">
      <div className="page-header" style={{ marginBottom: '1rem' }}>
        <Link to={staffListPath} className="participant-name-link" style={{ marginRight: '0.5rem' }}>← Staff</Link>
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', minWidth: 0 }}>
            <h2 style={{ marginTop: 0, marginBottom: 0 }}>{data.name}</h2>
            {data.archived_at && <span className="archived-badge">(archived)</span>}
            {data.onboarding_status === 'complete' && <span className="badge" style={{ background: '#22c55e', color: '#fff', padding: '0.2rem 0.5rem', borderRadius: 4, fontSize: '0.8rem' }}>Onboarding complete</span>}
            {data.onboarding_status === 'in_progress' && <span className="badge" style={{ background: '#f59e0b', color: '#fff', padding: '0.2rem 0.5rem', borderRadius: 4, fontSize: '0.8rem' }}>Onboarding in progress</span>}
            {(!data.onboarding_status || data.onboarding_status === 'not_started') && <span className="badge" style={{ background: '#64748b', color: '#fff', padding: '0.2rem 0.5rem', borderRadius: 4, fontSize: '0.8rem' }}>Onboarding not started</span>}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginLeft: 'auto' }}>
            {staffReadiness?.ready === false && (
              <div
                style={{
                  flexBasis: '100%',
                  padding: '0.5rem 0.75rem',
                  border: '1px solid #fcd34d',
                  background: '#fef3c7',
                  color: '#78350f',
                  borderRadius: 6,
                  fontSize: '0.85rem'
                }}
              >
                <strong>Not ready:</strong> {staffReadiness.reason}
                {(staffReadiness.code === 'ONBOARDING_DISABLED' || staffReadiness.code === 'PROVIDER_PROFILE_MISSING') && (
                  <>
                    {' '}
                    <Link to={`${pathPrefix}/forms`}>Open Forms to fix</Link>.
                  </>
                )}
              </div>
            )}
            {staffReadiness?.ready === true && staffReadiness.warning && (
              <div
                style={{
                  flexBasis: '100%',
                  padding: '0.5rem 0.75rem',
                  border: '1px solid #bfdbfe',
                  background: '#eff6ff',
                  color: '#1e3a8a',
                  borderRadius: 6,
                  fontSize: '0.85rem'
                }}
              >
                {staffReadiness.warning}
                {staffReadiness.warning_code === 'NO_ONBOARDING_DOCUMENTS' ? (
                  <>
                    {' '}
                    <Link to={`${pathPrefix}/forms/automation-mapping`}>Open Automation mapping</Link>.
                  </>
                ) : null}
              </div>
            )}
            {orchError && (
              <div
                style={{
                  flexBasis: '100%',
                  padding: '0.5rem 0.75rem',
                  border: '1px solid #fecaca',
                  background: '#fee2e2',
                  color: '#991b1b',
                  borderRadius: 6,
                  fontSize: '0.85rem'
                }}
              >
                {orchError}
              </div>
            )}
            {orchResult?.steps?.length > 0 && (
              <details style={{ flexBasis: '100%', fontSize: '0.85rem' }}>
                <summary style={{ cursor: 'pointer', color: '#334155' }}>
                  Last run — {orchResult.completed_steps}/{orchResult.total_steps} steps OK · next: {orchResult.next_action}
                </summary>
                <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
                  {orchResult.steps.map((s) => (
                    <li key={s.name} style={{ color: s.ok ? '#15803d' : '#b91c1c' }}>
                      {s.ok ? '✓' : '✗'} {s.name}
                      {s.skipped ? ' (skipped)' : ''}
                      {s.error ? ` — ${s.error}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleRunStaffOnboarding}
              disabled={orchBusy || staffReadiness?.ready === false}
              title={
                staffReadiness?.ready === false
                  ? staffReadiness?.reason
                  : 'Prepare onboarding setup (clone library documents, create record). Does not send email — use the button beside this to choose documents and send.'
              }
            >
              {orchBusy ? 'Running…' : 'Run staff onboarding'}
            </button>
            {data.email && (
              <button
                type="button"
                className={showOnboardPanel ? 'btn btn-secondary' : 'btn btn-primary'}
                onClick={handleOpenOnboardPanel}
                disabled={onboardingSending}
                title="Choose role and documents, then send the onboarding email"
              >
                {onboardEmailButtonLabel()}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleDownloadEmploymentContract}
              disabled={contractDownloading}
              title="Prefilled employment contract (template-based forms coming soon)"
            >
              {contractDownloading ? 'Downloading…' : 'Download to sign'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleViewIntakeForm}
              disabled={intakeViewing}
              title="View the saved staff onboarding intake answers"
            >
              {intakeViewing ? 'Loading…' : 'View intake form'}
            </button>
            <button type="button" className="btn btn-primary" disabled title={NEXUS_CORE_SIGN_COMING_SOON_TITLE}>
              Sign with Nexus Core
            </button>
          </div>
        </div>

        {!showEdit ? (
          <div>
            <p><strong>Email:</strong> {data.email || '—'}</p>
            <p><strong>Phone:</strong> {data.phone || '—'}</p>
            <p><strong>Role:</strong> {data.role || '—'}</p>
            <p><strong>Employment type:</strong> {data.employment_type === 'subcontractor' ? 'Subcontractor' : (data.employment_type === 'employee' ? 'Employee' : (data.employment_type || '—'))}</p>
            {data.pay_frequency && <p><strong>Pay frequency:</strong> {data.pay_frequency.charAt(0).toUpperCase() + data.pay_frequency.slice(1)}</p>}
            {data.governing_state && <p><strong>Governing state:</strong> {data.governing_state}</p>}
            {data.supervisor_name && <p><strong>Supervisor:</strong> {data.supervisor_name}</p>}
            <div style={{ marginTop: '0.5rem' }}>
              <p style={{ marginBottom: '0.35rem' }}><strong>Pay rates (per hour)</strong></p>
              <p style={{ margin: '0.15rem 0', color: '#334155', fontSize: '0.95rem' }}>
                <strong>Weekday (default):</strong>{' '}
                {viewPayRates?.weekday != null && Number.isFinite(viewPayRates.weekday) ? `$${viewPayRates.weekday.toFixed(2)}` : '—'}
              </p>
              {['saturday', 'sunday', 'public_holiday', 'evening'].map((key) => {
                const labels = {
                  saturday: 'Saturday',
                  sunday: 'Sunday',
                  public_holiday: 'Public holiday',
                  evening: 'Weekday evening (after 8:30pm finish)',
                };
                const v = viewPayRates?.[key];
                return (
                  <p key={key} style={{ margin: '0.15rem 0', color: '#334155', fontSize: '0.95rem' }}>
                    <strong>{labels[key]}:</strong>{' '}
                    {v != null && Number.isFinite(v) ? `$${v.toFixed(2)}` : '—'}
                  </p>
                );
              })}
            </div>
            <p><strong>Notifications:</strong> {data.notify_email ? 'Email ' : ''}{data.notify_sms ? 'SMS' : ''}{!data.notify_email && !data.notify_sms ? '—' : ''}</p>
            <h3 style={{ marginTop: '1.25rem', marginBottom: '0.5rem', fontSize: '1.05rem' }}>Weekly availability</h3>
            {!hasAnyAvailabilitySlots(viewAvail) ? (
              <p style={{ color: '#64748b', marginTop: 0 }}>Not set</p>
            ) : (
              <ul style={{ margin: '0 0 0.75rem 0', paddingLeft: '1.25rem' }}>
                {STAFF_AVAILABILITY_DAYS.map(({ key, label }) => {
                  const slots = viewAvail[key] || [];
                  if (!slots.length) return null;
                  return (
                    <li key={key}>
                      <strong>{label}:</strong>{' '}
                      {slots.map((s) => `${formatHmLocal(s.start)} – ${formatHmLocal(s.end)}`).join('; ')}
                    </li>
                  );
                })}
              </ul>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => { setEditForm(staffEditFormFromRow(data)); setShowEdit(true); }}>Edit</button>
          </div>
        ) : (
          <form onSubmit={handleSaveEdit}>
            <div className="form-group">
              <label>Name *</label>
              <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Phone</label>
              <input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Role / position</label>
              <input value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Employment type</label>
              <select value={editForm.employment_type} onChange={(e) => setEditForm({ ...editForm, employment_type: e.target.value })}>
                <option value="employee">Employee</option>
                <option value="subcontractor">Subcontractor</option>
              </select>
            </div>
            <div className="form-group">
              <label>Hourly rate (weekday default, daytime)</label>
              <input type="number" step="0.01" min="0" value={editForm.hourly_rate} onChange={(e) => setEditForm({ ...editForm, hourly_rate: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Pay frequency</label>
              <select value={editForm.pay_frequency} onChange={(e) => setEditForm({ ...editForm, pay_frequency: e.target.value })}>
                <option value="">— Select —</option>
                <option value="weekly">Weekly</option>
                <option value="fortnightly">Fortnightly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div className="form-group">
              <label>Governing state (for contract)</label>
              <select value={editForm.governing_state} onChange={(e) => setEditForm({ ...editForm, governing_state: e.target.value })}>
                <option value="">— Select —</option>
                <option value="Queensland">Queensland</option>
                <option value="New South Wales">New South Wales</option>
                <option value="Victoria">Victoria</option>
                <option value="South Australia">South Australia</option>
                <option value="Western Australia">Western Australia</option>
                <option value="Tasmania">Tasmania</option>
                <option value="Northern Territory">Northern Territory</option>
                <option value="Australian Capital Territory">Australian Capital Territory</option>
              </select>
            </div>
            <div className="form-group">
              <label>Supervisor / manager name (for contract)</label>
              <input value={editForm.supervisor_name} onChange={(e) => setEditForm({ ...editForm, supervisor_name: e.target.value })} placeholder="e.g. Sarah Jones" />
            </div>
            <p style={{ color: '#64748b', fontSize: '0.9rem', marginTop: 0, marginBottom: '0.5rem' }}>
              Optional: set different pay for weekend, public holidays, or weekday evening shifts. Leave blank to use the default hourly rate.
            </p>
            <div className="form-group">
              <label>Saturday ($/h)</label>
              <input type="number" step="0.01" min="0" value={editForm.pay_saturday} onChange={(e) => setEditForm({ ...editForm, pay_saturday: e.target.value })} placeholder="Default" />
            </div>
            <div className="form-group">
              <label>Sunday ($/h)</label>
              <input type="number" step="0.01" min="0" value={editForm.pay_sunday} onChange={(e) => setEditForm({ ...editForm, pay_sunday: e.target.value })} placeholder="Default" />
            </div>
            <div className="form-group">
              <label>Public holiday ($/h)</label>
              <input type="number" step="0.01" min="0" value={editForm.pay_public_holiday} onChange={(e) => setEditForm({ ...editForm, pay_public_holiday: e.target.value })} placeholder="Default" />
            </div>
            <div className="form-group">
              <label>Weekday evening — shift ends after 8:30pm ($/h)</label>
              <input type="number" step="0.01" min="0" value={editForm.pay_evening} onChange={(e) => setEditForm({ ...editForm, pay_evening: e.target.value })} placeholder="Default" />
            </div>
            <div className="form-group">
              <label>
                <input type="checkbox" checked={editForm.notify_email} onChange={(e) => setEditForm({ ...editForm, notify_email: e.target.checked })} />
                Notify by email when shift scheduled
              </label>
            </div>
            <div className="form-group">
              <label>
                <input type="checkbox" checked={editForm.notify_sms} onChange={(e) => setEditForm({ ...editForm, notify_sms: e.target.checked })} />
                Notify by SMS when shift scheduled
              </label>
            </div>
            <div className="form-group" style={{ marginTop: '1.25rem' }}>
              <label style={{ fontWeight: 600, display: 'block', marginBottom: '0.35rem' }}>Weekly availability</label>
              <p style={{ color: '#64748b', fontSize: '0.9rem', marginTop: 0, marginBottom: '0.75rem' }}>
                Typical hours this person is available to work (recurring each week). Add one or more time ranges per day.
              </p>
              {STAFF_AVAILABILITY_DAYS.map(({ key, label }) => (
                <div
                  key={key}
                  style={{
                    borderBottom: '1px solid #e2e8f0',
                    paddingBottom: '0.75rem',
                    marginBottom: '0.75rem',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>{label}</div>
                  {(editForm.availability[key] || []).map((slot, idx) => (
                    <div
                      key={`${key}-${idx}`}
                      style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginTop: '0.35rem' }}
                    >
                      <input
                        type="time"
                        value={slot.start}
                        step={300}
                        onChange={(e) => updateAvailabilitySlot(key, idx, 'start', e.target.value)}
                        aria-label={`${label} start time ${idx + 1}`}
                      />
                      <span style={{ color: '#64748b' }}>to</span>
                      <input
                        type="time"
                        value={slot.end}
                        step={300}
                        onChange={(e) => updateAvailabilitySlot(key, idx, 'end', e.target.value)}
                        aria-label={`${label} end time ${idx + 1}`}
                      />
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeAvailabilitySlot(key, idx)}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '0.35rem' }} onClick={() => addAvailabilitySlot(key)}>
                    Add hours
                  </button>
                </div>
              ))}
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>Save</button>
            <button type="button" className="btn btn-secondary" onClick={() => { setEditForm(staffEditFormFromRow(data)); setShowEdit(false); }}>Cancel</button>
          </form>
        )}
      </div>

      {showOnboardPanel && data?.email && (
        <div
          ref={onboardPanelRef}
          className="card forms-section"
          style={{ marginBottom: '1.5rem' }}
        >
          <h3 className="forms-section-heading" style={{ marginTop: 0 }}>
            Staff onboarding pack
          </h3>
          {data.onboarding_status === 'complete' ? (
            <p className="forms-muted" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
              This staff member has already completed onboarding. You can still choose documents and resend the email to
              test automation or share updated policies.
            </p>
          ) : null}
          {onboardPackFeedback ? (
            <div
              style={{
                padding: '0.5rem 0.75rem',
                marginBottom: '0.75rem',
                borderRadius: 6,
                fontSize: '0.9rem',
                border: `1px solid ${onboardPackFeedback.type === 'success' ? '#86efac' : '#fecaca'}`,
                background: onboardPackFeedback.type === 'success' ? '#f0fdf4' : '#fee2e2',
                color: onboardPackFeedback.type === 'success' ? '#166534' : '#991b1b'
              }}
            >
              {onboardPackFeedback.message}
            </div>
          ) : null}
          <OnboardingDocumentSelectPanel
            mode="staff"
            recipientEmail={data.email.trim()}
            recipientName={data.name || ''}
            defaultContextValue={inferStaffOnboardingRole(data || {})}
            extraPdfCount={extraPdfCount}
            active={showOnboardPanel}
            automationMappingHref={`${pathPrefix}/forms/automation-mapping`}
            onCancel={() => {
              setShowOnboardPanel(false);
              setOnboardPackFeedback(null);
            }}
            onSend={handleConfirmSendStaffOnboarding}
            sending={onboardingSending}
          />
        </div>
      )}

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3>Assigned Participants</h3>
        <p style={{ color: '#64748b', marginBottom: '1rem' }}>Participants this staff member can work with. Assign participants to restrict or pre-select who appears when scheduling shifts.</p>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <SearchableSelect
            options={availableParticipants}
            value={assignParticipantId}
            onChange={setAssignParticipantId}
            placeholder="Select participant to assign"
          />
          <button type="button" className="btn btn-primary" onClick={handleAssign} disabled={!assignParticipantId || saving}>
            Assign
          </button>
        </div>

        {assignments.length === 0 ? (
          <p>No participants assigned. Assign participants above or leave empty to allow all.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Participant</th><th></th></tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`${pathPrefix}/participants/${a.participant_id}`} className="participant-name-link">{a.participant_name}</Link>
                    {a.ndis_number && <span style={{ marginLeft: '0.35rem', color: '#64748b' }}>({a.ndis_number})</span>}
                  </td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleRemoveAssignment(a.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3>Compliance documents</h3>
        <p style={{ color: '#64748b', marginBottom: '1rem' }}>Documents uploaded during onboarding. Expiry dates are checked daily; reminders are sent at 60, 30 and 7 days before expiry.</p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <button type="button" className="btn btn-secondary" onClick={handleSendRenewalReminder} disabled={renewalSending || !data?.email}>
            {renewalSending ? 'Sending…' : 'Send renewal reminder'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={handleSendRenewalLink} disabled={renewalSending || !data?.email}>
            Send renewal upload link
          </button>
        </div>
        {complianceDocs.length === 0 ? (
          <p>No compliance documents yet. Staff can upload these when they complete the onboarding form.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Expiry date</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {complianceDocs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.display_name || docTypeLabel(d.document_type)}</td>
                    <td>
                      {editingExpiryDocId === d.id ? (
                        <span style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                          <input type="date" value={editingExpiryValue} onChange={(e) => setEditingExpiryValue(e.target.value)} style={{ padding: '0.2rem', fontSize: '0.9rem' }} />
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => handleSaveExpiry(d.id)}>Save</button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditingExpiryDocId(null); setEditingExpiryValue(''); }}>Cancel</button>
                        </span>
                      ) : (
                        <span>
                          {d.expiry_date ? formatDate(d.expiry_date) : '—'}
                          <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }} onClick={() => { setEditingExpiryDocId(d.id); setEditingExpiryValue(d.expiry_date ? d.expiry_date.slice(0, 10) : ''); }} title="Add or edit expiry date">
                            {d.expiry_date ? 'Edit' : 'Add expiry'}
                          </button>
                        </span>
                      )}
                    </td>
                    <td>
                      <span style={{
                        padding: '0.2rem 0.5rem',
                        borderRadius: 4,
                        fontSize: '0.8rem',
                        background: d.status === 'expired' ? '#fecaca' : d.status === 'expiring_soon' ? '#fef3c7' : '#d1fae5',
                        color: d.status === 'expired' ? '#991b1b' : d.status === 'expiring_soon' ? '#92400e' : '#065f46'
                      }}>
                        {d.status === 'expired' ? 'Expired' : d.status === 'expiring_soon' ? 'Expiring soon' : 'Valid'}
                      </span>
                    </td>
                    <td>
                      <a href={`/api/staff/${id}/compliance-documents/${d.id}/file`} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ fontSize: '0.8rem' }}>View</a>
                      <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem', marginLeft: '0.35rem' }} onClick={() => handleDeleteComplianceDocument(d.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #e2e8f0' }}>
          <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Upload renewed document</h4>
          <form onSubmit={handleUploadCompliance} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Document type</label>
              <select value={newDocType} onChange={(e) => setNewDocType(e.target.value)} style={{ minWidth: 180 }}>
                {COMPLIANCE_DOC_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>File</label>
              <input type="file" accept="image/*,.pdf" onChange={(e) => setNewDocFile(e.target.files?.[0] || null)} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Expiry date</label>
              <input type="date" value={newDocExpiry} onChange={(e) => setNewDocExpiry(e.target.value)} style={{ minWidth: 140 }} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={complianceUploading || !newDocFile}>
              {complianceUploading ? 'Uploading…' : 'Upload'}
            </button>
          </form>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3>Extra organisation PDFs (optional)</h3>
        <p style={{ color: '#64748b', marginBottom: '1rem' }}>
          Optional escape hatch — attach your own PDFs alongside branded library documents when sending onboarding.
          Most organisations use the document library only. Manage these under{' '}
          <strong>Forms → Extra organisation documents</strong>.
        </p>
        <div style={{ marginBottom: '1rem' }}>
          <input type="file" accept=".pdf" onChange={handlePolicyUpload} disabled={policyUploading} />
          {policyUploading && <span style={{ marginLeft: '0.5rem' }}>Uploading…</span>}
        </div>
        {policyFiles.length === 0 ? (
          <p>No policy files yet. Upload PDFs above.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {policyFiles.map((p) => (
              <li key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                <span>{p.display_name}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => handlePolicyDelete(p.id)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h3>Hours Summary</h3>
        <p style={{ color: '#64748b', marginBottom: '0.5rem' }}>
          Total hours by pay period calculated from <strong>completed</strong> shifts in Nexus (fortnightly periods from the same anchor date as payroll exports). Travel time and km come from linked progress notes where present.
        </p>
        <p style={{ color: '#64748b', marginBottom: '1rem', fontSize: '0.9rem' }}>
          <strong>Note:</strong> Total hours include travel time. You pay the total amount; the Travel column is for reference only.
        </p>
        {loadingHoursSummary ? (
          <p>Loading…</p>
        ) : hoursSummary.length === 0 ? (
          <p>No completed shifts with valid start and end times yet, so there is nothing to summarise.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Period Start</th>
                  <th>Period End</th>
                  <th>Total</th>
                  <th>Weekday</th>
                  <th>Saturday</th>
                  <th>Sunday</th>
                  <th>Public Holiday</th>
                  <th>Evening</th>
                  <th>Travel</th>
                  <th>Expenses</th>
                </tr>
              </thead>
              <tbody>
                {hoursSummary.map((row, i) => (
                  <tr key={i}>
                    <td>{row.periodStart ? formatDate(row.periodStart) : row.periodStart}</td>
                    <td>{row.periodEnd ? formatDate(row.periodEnd) : row.periodEnd}</td>
                    <td>{row.totalHours?.toFixed(1)}</td>
                    <td>{row.weekdayHours?.toFixed(1)}</td>
                    <td>{row.saturdayHours?.toFixed(1)}</td>
                    <td>{row.sundayHours?.toFixed(1)}</td>
                    <td>{row.holidayHours?.toFixed(1)}</td>
                    <td>{row.eveningHours?.toFixed(1)}</td>
                    <td>{row.travelHours?.toFixed(1)}</td>
                    <td>{row.totalExpenses != null ? `$${row.totalExpenses.toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button type="button" className="btn btn-secondary" style={{ marginTop: '0.5rem' }} onClick={loadHoursData} disabled={loadingHoursSummary}>
          Refresh
        </button>
      </div>

      <div className="card">
        <h3>Completed shifts</h3>
        <p style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: '#64748b' }}>
          Same shifts as the hours summary above (completed or completed by admin).{' '}
          <Link to={`${pathPrefix}/shifts?staff_id=${id}`}>All shifts for this staff</Link>
          {' · '}
          <Link to={`${pathPrefix}/shifts?duplicates=1&staff_id=${id}`}>Check duplicates</Link>
        </p>
        {staffShifts.length === 0 ? (
          <p>No shifts yet.</p>
        ) : completedStaffShifts.length === 0 ? (
          <p>No completed shifts yet. Scheduled shifts are listed under <Link to={`${pathPrefix}/shifts?staff_id=${id}`}>Shifts</Link>.</p>
        ) : (
          <>
            {(hoursSummary.length > 0 ? groupShiftsByExcelPeriods(completedStaffShifts, hoursSummary, groupShiftsByPayPeriod) : groupShiftsByPayPeriod(completedStaffShifts)).map((period) => (
              <div key={`${period.periodStart}-${period.periodEnd}`} style={{ marginBottom: '1.5rem' }}>
                <h4 style={{ marginBottom: '0.5rem', fontSize: '1rem', color: '#475569' }}>
                  Period: {period.periodStart ? formatDate(period.periodStart) : period.periodStart} – {period.periodEnd ? formatDate(period.periodEnd) : period.periodEnd}
                </h4>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Date</th><th>Participant</th><th>Time</th><th></th></tr>
                    </thead>
                    <tbody>
                      {period.shifts.map((s) => (
                        <tr key={s.id}>
                          <td>{s.start_time ? formatDate(s.start_time) : ''}</td>
                          <td>
                            <Link to={`${pathPrefix}/participants/${s.participant_id}`} className="participant-name-link">{s.participant_name}</Link>
                          </td>
                          <td>{s.start_time?.slice(11, 16)} – {s.end_time?.slice(11, 16)}</td>
                          <td>
                            <Link to={`${pathPrefix}/shifts/${s.id}`} className="btn btn-secondary btn-sm">View</Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {intakePreview && (
        <div className="modal-overlay" onClick={() => setIntakePreview(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '90vh', overflow: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
              <div>
                <h3 style={{ marginTop: 0, marginBottom: '0.25rem' }}>Staff intake form</h3>
                <p style={{ margin: 0, color: '#64748b' }}>
                  {intakePreview.staff?.name || data.name}
                  {intakePreview.onboarding?.status ? ` · ${intakePreview.onboarding.status.replace(/_/g, ' ')}` : ''}
                  {intakePreview.onboarding?.completed_at ? ` · completed ${formatDate(intakePreview.onboarding.completed_at)}` : ''}
                </p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setIntakePreview(null)}>
                Close
              </button>
            </div>

            {!intakePreview.onboarding ? (
              <p style={{ color: '#64748b' }}>No staff onboarding record has been created for this staff member yet.</p>
            ) : intakePreview.sections?.length === 0 ? (
              <p style={{ color: '#64748b' }}>No intake answers have been saved yet.</p>
            ) : (
              <div style={{ display: 'grid', gap: '1rem' }}>
                {intakePreview.sections.map((section) => (
                  <section key={section.key} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem' }}>
                    <h4 style={{ marginTop: 0, marginBottom: '0.75rem' }}>{section.label}</h4>
                    <div className="table-wrap">
                      <table className="table">
                        <tbody>
                          {section.fields.map((field) => (
                            <tr key={field.key}>
                              <th style={{ width: '35%', verticalAlign: 'top' }}>{field.label}</th>
                              <td style={{ whiteSpace: 'pre-wrap' }}>{formatIntakeValue(field)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
