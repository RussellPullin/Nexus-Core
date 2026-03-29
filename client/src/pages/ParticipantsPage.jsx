import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { participants, organisations, ndis } from '../lib/api';
import AddressAutocomplete from '../components/AddressAutocomplete';
import { formatDate } from '../lib/dateUtils';

// Fallback 15 NDIS support categories (from price guide) - used if API returns empty
const FALLBACK_SUPPORT_CATEGORIES = [
  { id: '01', name: 'Assistance with Daily Life' },
  { id: '02', name: 'Transport' },
  { id: '03', name: 'Consumables' },
  { id: '04', name: 'Assistance with Social, Economic and Community Participation' },
  { id: '05', name: 'Assistive Technology' },
  { id: '06', name: 'Home Modifications and SDA' },
  { id: '07', name: 'Support Coordination' },
  { id: '08', name: 'Improved Living Arrangements' },
  { id: '09', name: 'Increased Social and Community Participation' },
  { id: '10', name: 'Finding and Keeping a Job' },
  { id: '11', name: 'Improved Relationships' },
  { id: '12', name: 'Improved Health and Wellbeing' },
  { id: '13', name: 'Improved Learning' },
  { id: '14', name: 'Improved Life Choices' },
  { id: '15', name: 'Improved Daily Living Skills' }
];

const defaultForm = () => ({
  name: '', ndis_number: '', email: '', phone: '', address: '', date_of_birth: '',
  plan_manager_id: '', remoteness: 'standard', diagnosis: '',
  parent_guardian_phone: '', parent_guardian_email: '',
  management_type: 'self',
  services_required: [],
  ndia_managed_services: [],
  plan_managed_services: [],
  invoice_emails: []
});

export default function ParticipantsPage() {
  const { canManageUsers } = useAuth();
  const [list, setList] = useState([]);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showIntakeModal, setShowIntakeModal] = useState(false);
  const [intakeFile, setIntakeFile] = useState(null);
  const [intakePreview, setIntakePreview] = useState(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intakeCreating, setIntakeCreating] = useState(false);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvFile, setCsvFile] = useState(null);
  const [csvPreview, setCsvPreview] = useState(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvUseLlm, setCsvUseLlm] = useState(true);
  const [form, setForm] = useState(defaultForm());
  const [invoiceEmailInput, setInvoiceEmailInput] = useState('');
  const [orgs, setOrgs] = useState([]);
  const [supportCategories, setSupportCategories] = useState([]);

  const load = async () => {
    setLoading(true);
    try {
      const p = await participants.list(search, showArchived);
      setList(p);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [search, showArchived]);

  useEffect(() => {
    organisations.list('', 'plan_manager').then(setOrgs).catch(() => {});
  }, []);

  useEffect(() => {
    ndis.supportCategories()
      .then((cats) => setSupportCategories(Array.isArray(cats) && cats.length > 0 ? cats : FALLBACK_SUPPORT_CATEGORIES))
      .catch(() => setSupportCategories(FALLBACK_SUPPORT_CATEGORIES));
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await participants.create(form);
      setShowModal(false);
      setForm(defaultForm());
      setInvoiceEmailInput('');
      load().catch((loadErr) => console.error('Refresh after create:', loadErr));
    } catch (err) {
      const msg = err.message || 'Create failed';
      alert(msg.includes('fetch') || msg.includes('Load failed') || msg.includes('NetworkError')
        ? 'Could not reach server. Check that the server is running (npm run dev) and try again.'
        : msg);
    }
  };

  const toggleServiceRequired = (catId) => {
    const current = form.services_required || [];
    const next = current.includes(catId)
      ? current.filter((c) => c !== catId)
      : [...current, catId];
    const ndia = (form.ndia_managed_services || []).filter((c) => c !== catId);
    const plan = (form.plan_managed_services || []).filter((c) => c !== catId);
    setForm({ ...form, services_required: next, ndia_managed_services: ndia, plan_managed_services: plan });
  };

  const toggleNdiaManaged = (catId) => {
    const ndia = form.ndia_managed_services || [];
    const plan = form.plan_managed_services || [];
    const inNdia = ndia.includes(catId);
    const nextNdia = inNdia ? ndia.filter((c) => c !== catId) : [...ndia, catId];
    const nextPlan = inNdia ? plan : plan.filter((c) => c !== catId);
    setForm({ ...form, ndia_managed_services: nextNdia, plan_managed_services: nextPlan });
  };

  const togglePlanManaged = (catId) => {
    const ndia = form.ndia_managed_services || [];
    const plan = form.plan_managed_services || [];
    const inPlan = plan.includes(catId);
    const nextPlan = inPlan ? plan.filter((c) => c !== catId) : [...plan, catId];
    const nextNdia = inPlan ? ndia : ndia.filter((c) => c !== catId);
    setForm({ ...form, plan_managed_services: nextPlan, ndia_managed_services: nextNdia });
  };

  const handleIntakeFileChange = (e) => {
    const f = e.target.files?.[0];
    setIntakeFile(f || null);
    setIntakePreview(null);
  };

  const handleParseIntake = async () => {
    if (!intakeFile) return;
    setIntakeLoading(true);
    try {
      const parsed = await participants.parseIntakeForm(intakeFile);
      setIntakePreview(parsed);
    } catch (err) {
      alert(err.message || 'Could not parse intake form.');
    } finally {
      setIntakeLoading(false);
    }
  };

  const handleCreateFromIntake = async () => {
    if (intakePreview?.participant?.name) {
      setIntakeCreating(true);
      try {
        const result = await participants.createFromIntakeForm(intakePreview);
        setShowIntakeModal(false);
        setIntakeFile(null);
        setIntakePreview(null);
        load().catch((e) => console.error(e));
        if (result?.participant?.id) {
          window.location.href = `/participants/${result.participant.id}`;
        }
      } catch (err) {
        alert(err.message || 'Could not create participant.');
      } finally {
        setIntakeCreating(false);
      }
    } else {
      alert('Parse the form first and ensure a participant name was extracted.');
    }
  };

  const handleCreateFromIntakeFileDirect = async () => {
    if (!intakeFile) return;
    setIntakeCreating(true);
    try {
      const result = await participants.createFromIntakeForm(intakeFile);
      setShowIntakeModal(false);
      setIntakeFile(null);
      setIntakePreview(null);
      load().catch((e) => console.error(e));
      if (result?.participant?.id) {
        window.location.href = `/participants/${result.participant.id}`;
      }
    } catch (err) {
      alert(err.message || 'Could not create participant.');
    } finally {
      setIntakeCreating(false);
    }
  };

  const handleCsvFileChange = (e) => {
    const f = e.target.files?.[0];
    setCsvFile(f || null);
    setCsvPreview(null);
  };

  const handleParseCsv = async () => {
    if (!csvFile) return;
    setCsvLoading(true);
    setCsvPreview(null);
    try {
      const parsed = await participants.parseCsv(csvFile, csvUseLlm);
      setCsvPreview(parsed);
    } catch (err) {
      setCsvPreview({ rows: [], error: err.message || 'Could not parse CSV.' });
    } finally {
      setCsvLoading(false);
    }
  };

  const handleImportCsv = async () => {
    if (!csvFile) return;
    setCsvImporting(true);
    try {
      const result = await participants.importCsv(csvFile, csvUseLlm);
      setShowCsvModal(false);
      setCsvFile(null);
      setCsvPreview(null);
      load().catch((e) => console.error(e));
      alert(`Imported ${result.created} participant(s).${result.skipped > 0 ? ` ${result.skipped} skipped (duplicate NDIS numbers).` : ''}`);
    } catch (err) {
      alert(err.message || 'Could not import participants.');
    } finally {
      setCsvImporting(false);
    }
  };

  const handleArchive = async (p) => {
    if (!confirm(`Archive ${p.name}? They will be hidden from the list but can be restored.`)) return;
    try {
      await participants.archive(p.id);
      load().catch((e) => console.error(e));
    } catch (err) {
      alert(err.message || 'Could not archive participant.');
    }
  };

  const handleUnarchive = async (p) => {
    try {
      await participants.unarchive(p.id);
      load().catch((e) => console.error(e));
    } catch (err) {
      alert(err.message || 'Could not restore participant.');
    }
  };

  const handleDelete = async (p) => {
    if (!confirm(`Permanently delete ${p.name}? This cannot be undone. All plans, goals, documents, shifts and related data will be removed.`)) return;
    try {
      await participants.delete(p.id);
      load().catch((e) => console.error(e));
    } catch (err) {
      alert(err.message || 'Could not delete participant.');
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>Participants</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={() => { setShowCsvModal(true); setCsvPreview(null); setCsvFile(null); }}>
            Import from CSV
          </button>
          <button className="btn btn-secondary" onClick={() => { setShowIntakeModal(true); setIntakePreview(null); setIntakeFile(null); }}>
            Add from Intake Form
          </button>
          <button className="btn btn-add-participant" onClick={() => setShowModal(true)}>Add Participant</button>
        </div>
      </div>
      <div className="search-bar" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search by name or NDIS number..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="checkbox-label" style={{ margin: 0 }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
      <div className="card">
        {loading ? (
          <p>Loading...</p>
        ) : list.length === 0 ? (
          <div className="empty-state">
            <p>No participants yet.</p>
            {!canManageUsers && (
              <p style={{ color: '#64748b', fontSize: '0.95rem', marginTop: '0.75rem', maxWidth: 520 }}>
                Accounts without admin access only see participants assigned to them. If clients are missing, ask an
                organisation admin to assign you to those participants (Admin), or confirm you are signed into the
                correct workspace.
              </p>
            )}
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>Add your first participant</button>
          </div>
        ) : (
          <div className="table-wrap table-condensed">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>NDIS Number</th>
                  <th>Management</th>
                  <th>Contact</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} style={p.archived_at ? { opacity: 0.7 } : undefined}>
                    <td>
                      <Link to={`/participants/${p.id}`} className="participant-name-link">{p.name}</Link>
                      {p.archived_at && <span className="archived-badge">(archived)</span>}
                    </td>
                    <td>{p.ndis_number || '-'}</td>
                    <td>{p.management_type === 'plan' ? 'Plan' : p.management_type === 'ndia' ? 'NDIA' : 'Self'}</td>
                    <td>{p.phone || p.email || '-'}</td>
                    <td className="participant-actions">
                      <Link to={`/participants/${p.id}`} className="btn btn-secondary btn-sm">View</Link>
                      <Link to={`/onboarding/${p.id}`} className="btn btn-secondary btn-sm">Onboarding</Link>
                      {p.archived_at ? (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleUnarchive(p)}>Restore</button>
                      ) : (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleArchive(p)} title="Hide from list (can restore)">Archive</button>
                      )}
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => handleDelete(p)} title="Permanently delete">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>Add Participant</h3>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>NDIS Number</label>
                <input value={form.ndis_number} onChange={(e) => setForm({ ...form, ndis_number: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Management Type</label>
                <div className="management-type-options">
                  <label className="checkbox-label">
                    <input
                      type="radio"
                      name="management_type"
                      checked={form.management_type === 'self'}
                      onChange={() => setForm({ ...form, management_type: 'self', plan_manager_id: '' })}
                    />
                    <span>Self-managed</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="radio"
                      name="management_type"
                      checked={form.management_type === 'plan'}
                      onChange={() => setForm({ ...form, management_type: 'plan' })}
                    />
                    <span>Plan-managed</span>
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="radio"
                      name="management_type"
                      checked={form.management_type === 'ndia'}
                      onChange={() => setForm({ ...form, management_type: 'ndia', plan_manager_id: '' })}
                    />
                    <span>NDIA-managed</span>
                  </label>
                </div>
              </div>
              <div className="form-group">
                <label>Email {form.management_type === 'self' ? '(for invoicing – can leave blank)' : ''}</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Leave blank if not needed" />
              </div>
              {form.management_type === 'plan' && (
                <div className="form-group">
                  <label>Plan Manager (optional – can leave blank)</label>
                  <select value={form.plan_manager_id} onChange={(e) => setForm({ ...form, plan_manager_id: e.target.value || '' })}>
                    <option value="">Select plan manager...</option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {form.management_type !== 'ndia' && (
                <div className="form-group">
                  <label>
                    Invoice Email(s) {form.management_type === 'plan' ? '(plan manager / billing contact)' : '(for sending invoices)'}
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.5rem' }}>
                    {(form.invoice_emails || []).map((em, idx) => (
                      <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', background: '#e2e8f0', borderRadius: '4px', padding: '2px 8px', fontSize: '0.85rem' }}>
                        {em}
                        <button type="button" onClick={() => setForm({ ...form, invoice_emails: form.invoice_emails.filter((_, i) => i !== idx) })} style={{ marginLeft: '4px', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '1rem', lineHeight: 1, color: '#64748b' }}>&times;</button>
                      </span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="email"
                      value={invoiceEmailInput}
                      onChange={(e) => setInvoiceEmailInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          const val = invoiceEmailInput.trim();
                          if (val && val.includes('@') && !(form.invoice_emails || []).includes(val)) {
                            setForm({ ...form, invoice_emails: [...(form.invoice_emails || []), val] });
                            setInvoiceEmailInput('');
                          }
                        }
                      }}
                      placeholder="Type email and press Enter to add"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        const val = invoiceEmailInput.trim();
                        if (val && val.includes('@') && !(form.invoice_emails || []).includes(val)) {
                          setForm({ ...form, invoice_emails: [...(form.invoice_emails || []), val] });
                          setInvoiceEmailInput('');
                        }
                      }}
                    >Add</button>
                  </div>
                </div>
              )}
              <div className="form-group">
                <label>Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Address</label>
                <AddressAutocomplete value={form.address} onChange={(v) => setForm({ ...form, address: v })} placeholder="Start typing an address..." />
              </div>
              <div className="form-group">
                <label>Date of Birth</label>
                <input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Pricing Region (Remoteness)</label>
                <select value={form.remoteness} onChange={(e) => setForm({ ...form, remoteness: e.target.value })}>
                  <option value="standard">Standard (Non-Remote)</option>
                  <option value="remote">Remote</option>
                  <option value="very_remote">Very Remote</option>
                </select>
              </div>
              <div className="form-group">
                <label>Parent/Guardian Phone (optional – leave blank if not needed)</label>
                <input value={form.parent_guardian_phone || ''} onChange={(e) => setForm({ ...form, parent_guardian_phone: e.target.value })} placeholder="Leave blank if not needed" />
              </div>
              <div className="form-group">
                <label>Parent/Guardian Email (optional – leave blank if not needed)</label>
                <input type="email" value={form.parent_guardian_email || ''} onChange={(e) => setForm({ ...form, parent_guardian_email: e.target.value })} placeholder="Leave blank if not needed" />
              </div>
              <div className="form-group">
                <label>Diagnosis</label>
                <textarea value={form.diagnosis || ''} onChange={(e) => setForm({ ...form, diagnosis: e.target.value })} rows={2} placeholder="Diagnosis or condition" />
              </div>
              <div className="form-group">
                <label>Services Required (select categories, then tick NDIA or Plan managed per service)</label>
                <div className="services-with-management">
                  {(supportCategories.length > 0 ? supportCategories : FALLBACK_SUPPORT_CATEGORIES).map((c) => {
                    const required = (form.services_required || []).includes(c.id);
                    const ndia = (form.ndia_managed_services || []).includes(c.id);
                    const plan = (form.plan_managed_services || []).includes(c.id);
                    return (
                      <div key={c.id} className="service-row">
                        <label className="checkbox-label">
                          <input type="checkbox" checked={required} onChange={() => toggleServiceRequired(c.id)} />
                          <span className="service-name">{c.id} – {c.name}</span>
                        </label>
                        {required && (
                          <div className="management-ticks">
                            <label className="checkbox-label">
                              <input type="checkbox" checked={ndia} onChange={() => toggleNdiaManaged(c.id)} />
                              <span>NDIA</span>
                            </label>
                            <label className="checkbox-label">
                              <input type="checkbox" checked={plan} onChange={() => togglePlanManaged(c.id)} />
                              <span>Plan</span>
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button type="submit" className="btn btn-primary">Create</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showIntakeModal && (
        <div className="modal-overlay" onClick={() => setShowIntakeModal(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>Add Participant from Client Intake Form</h3>
            <p style={{ color: '#64748b', marginBottom: '1rem' }}>
              Upload a completed Client Intake Form PDF. The form will be parsed and a new participant profile will be created.
            </p>
            <div className="form-group">
              <label>Client Intake Form (PDF)</label>
              <input
                type="file"
                accept=".pdf"
                onChange={handleIntakeFileChange}
              />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                className="btn btn-secondary"
                onClick={handleParseIntake}
                disabled={!intakeFile || intakeLoading}
              >
                {intakeLoading ? 'Parsing...' : 'Parse & Preview'}
              </button>
              {intakePreview && (
                <button
                  className="btn btn-primary"
                  onClick={handleCreateFromIntake}
                  disabled={intakeCreating || !intakePreview?.participant?.name}
                >
                  {intakeCreating ? 'Creating...' : 'Create Participant'}
                </button>
              )}
              {intakeFile && !intakePreview && (
                <button
                  className="btn btn-primary"
                  onClick={handleCreateFromIntakeFileDirect}
                  disabled={intakeCreating}
                >
                  {intakeCreating ? 'Creating...' : 'Create Without Preview'}
                </button>
              )}
            </div>
            {intakePreview && (
              <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: 8, marginTop: '0.5rem', maxHeight: 320, overflowY: 'auto' }}>
                <h4 style={{ marginTop: 0 }}>Parsed data</h4>
                <p><strong>Name:</strong> {intakePreview.participant?.name || '(not found)'}</p>
                <p><strong>Preferred name:</strong> {intakePreview.participant?.preferred_name || '-'}</p>
                <p><strong>NDIS number:</strong> {intakePreview.participant?.ndis_number || '-'}</p>
                <p><strong>Email:</strong> {intakePreview.participant?.email || '-'}</p>
                <p><strong>Phone:</strong> {intakePreview.participant?.phone || '-'}</p>
                <p><strong>Address:</strong> {intakePreview.participant?.address || '-'}</p>
                <p><strong>Date of birth:</strong> {intakePreview.participant?.date_of_birth ? formatDate(intakePreview.participant.date_of_birth) : '-'}</p>
                {intakePreview.contacts?.length > 0 && (
                  <p><strong>Contacts:</strong> {intakePreview.contacts.map((c) => `${c.name} (${c.relationship || c.role})`).join(', ')}</p>
                )}
                {intakePreview.plan && (
                  <p><strong>Plan dates:</strong> {intakePreview.plan.start_date ? formatDate(intakePreview.plan.start_date) : '-'} – {intakePreview.plan.end_date ? formatDate(intakePreview.plan.end_date) : '-'}</p>
                )}
                {intakePreview.goals?.length > 0 && (
                  <p><strong>Goals:</strong> {intakePreview.goals.length} extracted</p>
                )}
              </div>
            )}
            <div style={{ marginTop: '1rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowIntakeModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showCsvModal && (
        <div className="modal-overlay" onClick={() => setShowCsvModal(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            <h3>Import Participants from CSV</h3>
            <p style={{ color: '#64748b', marginBottom: '1rem', flexShrink: 0 }}>
              Upload a CSV export. Supported columns: name (or first_name + last_name/family_name/surname), preferred_name, ndis_number, email, phone, address, date_of_birth, management_type (plan/self/ndia), plan_manager_name, invoice_email (self-managed = participant email; plan-managed = plan manager email), additional_invoice_emails (semicolon/comma separated CC emails for invoices), plan_start_date, plan_end_date, diagnosis, medications, allergies, goals, support_category, notes. Contacts: primary_contact (or guardian_name, contact_name), primary_contact_email, primary_contact_phone (or guardian_phone), parent_guardian_phone, parent_guardian_email; emergency_contact_name, emergency_contact_phone, emergency_contact_email.
            </p>
            <div className="form-group" style={{ flexShrink: 0 }}>
              <label>Participants CSV</label>
              <input
                type="file"
                accept=".csv,.txt"
                onChange={handleCsvFileChange}
              />
            </div>
            <label className="checkbox-label" style={{ flexShrink: 0, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={csvUseLlm} onChange={(e) => setCsvUseLlm(e.target.checked)} />
              <span>Use AI (Ollama) to map columns – recommended for non-standard CSV formats</span>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexShrink: 0 }}>
              <button
                className="btn btn-secondary"
                onClick={handleParseCsv}
                disabled={!csvFile || csvLoading}
              >
                {csvLoading ? 'Parsing...' : 'Parse & Preview'}
              </button>
              {csvFile && (
                <button
                  className="btn btn-primary"
                  onClick={handleImportCsv}
                  disabled={csvImporting}
                >
                  {csvImporting ? 'Importing...' : 'Import All'}
                </button>
              )}
            </div>
            {(csvPreview != null) && (
              <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: 8, marginTop: '0.5rem', minHeight: 120, maxHeight: 360, overflowY: 'auto', flex: '1 1 auto' }}>
                {csvPreview?.rows?.length > 0 ? (
                  <>
                    <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.8rem', fontWeight: 500 }}>
                      {csvPreview.llmUsed ? (
                        <span style={{ color: '#059669' }}>AI (Ollama) mapped columns</span>
                      ) : (
                        <span style={{ color: '#d97706' }}>Rule-based mapping{csvUseLlm ? ' (Ollama not available – start Ollama to use AI)' : ''}</span>
                      )}
                    </p>
                    {csvPreview.columnMapping && (
                      <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.8rem', color: '#64748b' }}>
                        Detected columns: {csvPreview.columnMapping.name ? `name→"${csvPreview.columnMapping.name}"` : ''}
                        {csvPreview.columnMapping.first_name ? `, first_name→"${csvPreview.columnMapping.first_name}"` : ''}
                        {csvPreview.columnMapping.last_name ? `, last_name→"${csvPreview.columnMapping.last_name}"` : ' (family name not detected – using Name column fallback if it has "First Last" format)'}
                      </p>
                    )}
                    <h4 style={{ marginTop: 0, marginBottom: '0.75rem' }}>Preview: {csvPreview.total} participant(s)</h4>
                    <div className="table-wrap" style={{ overflowX: 'auto' }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>NDIS #</th>
                            <th>Management</th>
                            <th>Plan Manager</th>
                            <th>Invoice Email(s)</th>
                            <th>Plan Dates</th>
                            <th>Medical/Diagnosis</th>
                            <th>Plan Manager Details</th>
                          </tr>
                        </thead>
                        <tbody>
                          {csvPreview.rows.slice(0, 10).map((r, i) => (
                            <tr key={i}>
                              <td>{r.name}</td>
                              <td>{r.ndis_number || '-'}</td>
                              <td>{r.management_type || '-'}</td>
                              <td>{r.plan_manager_name || '-'}</td>
                              <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={(r.invoice_emails || []).join(', ') || r.plan_manager_email || ''}>{(r.invoice_emails || []).join(', ') || r.plan_manager_email || '-'}</td>
                              <td>{(r.plan_start_date && r.plan_end_date) ? `${formatDate(r.plan_start_date)} – ${formatDate(r.plan_end_date)}` : '-'}</td>
                              <td style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.medical_conditions || r.diagnosis || ''}>{r.medical_conditions || r.diagnosis || '-'}</td>
                              <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.plan_manager_details || ''}>{r.plan_manager_details || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {csvPreview.rows.length > 10 && (
                      <p style={{ marginTop: '0.5rem', color: '#64748b', fontSize: '0.9rem' }}>
                        … and {csvPreview.rows.length - 10} more
                      </p>
                    )}
                  </>
                ) : (
                  <p style={{ margin: 0, color: '#64748b' }}>
                    {csvPreview?.error || 'No valid rows found. Ensure your CSV has a header row and a name column (e.g. name, participant_name, client_name).'}
                  </p>
                )}
              </div>
            )}
            <div style={{ marginTop: '1rem', flexShrink: 0 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCsvModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
