import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import { organisations } from '../lib/api';
import { DIRECTORY_LIST_STORAGE_KEY, participantsProfileQueryFromDirectory } from '../lib/listViewUrl.js';
import AddressAutocomplete from '../components/AddressAutocomplete';

export default function DirectoryPage() {
  const pathPrefix = useProductPathPrefix();
  const [searchParams, setSearchParams] = useSearchParams();
  const listHydratedRef = useRef(false);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const q = searchParams.get('q') ?? '';
  const orgFromUrl = searchParams.get('org') || '';
  const search = q;
  const [showModal, setShowModal] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [form, setForm] = useState({ name: '', type: '', abn: '', ndis_reg_number: '', email: '', phone: '', address: '', website: '' });
  const [contactForm, setContactForm] = useState({ name: '', email: '', phone: '', role: '' });
  const [showContactModal, setShowContactModal] = useState(false);

  useEffect(() => {
    if (searchParams.toString() !== '') {
      listHydratedRef.current = true;
      return;
    }
    if (listHydratedRef.current) return;
    listHydratedRef.current = true;
    try {
      const raw = sessionStorage.getItem(DIRECTORY_LIST_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p?.q && !p?.org) return;
      setSearchParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          if (p?.q) n.set('q', p.q);
          if (p?.org) n.set('org', p.org);
          return n;
        },
        { replace: true }
      );
    } catch (_) { /* ignore */ }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    try {
      sessionStorage.setItem(DIRECTORY_LIST_STORAGE_KEY, JSON.stringify({ q, org: orgFromUrl || '' }));
    } catch (_) { /* ignore */ }
  }, [q, orgFromUrl]);

  const load = async () => {
    setLoading(true);
    try {
      const o = await organisations.list(search);
      setOrgs(o);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [search]);

  useEffect(() => {
    if (!orgFromUrl) {
      setSelectedOrg(null);
      return;
    }
    let cancelled = false;
    organisations
      .get(orgFromUrl)
      .then((o) => {
        if (!cancelled) setSelectedOrg(o);
      })
      .catch(() => {
        if (!cancelled) setSelectedOrg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [orgFromUrl]);

  const selectOrgInUrl = (id) => {
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set('org', id);
        return n;
      },
      { replace: true }
    );
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await organisations.create(form);
      setShowModal(false);
      setForm({ name: '', type: '', abn: '', ndis_reg_number: '', email: '', phone: '', address: '', website: '' });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUpdateOrg = async (e) => {
    e.preventDefault();
    if (!selectedOrg) return;
    try {
      await organisations.update(selectedOrg.id, form);
      const o = await organisations.get(selectedOrg.id);
      setSelectedOrg(o);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAddContact = async (e) => {
    e.preventDefault();
    if (!selectedOrg) return;
    try {
      await organisations.addContact(selectedOrg.id, contactForm);
      setContactForm({ name: '', email: '', phone: '', role: '' });
      setShowContactModal(false);
      const o = await organisations.get(selectedOrg.id);
      setSelectedOrg(o);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteOrg = async (org) => {
    if (!confirm(`Delete "${org.name}"? This will remove it from the directory. Participants linked to this plan manager will have their plan manager cleared.`)) return;
    try {
      await organisations.delete(org.id);
      if (selectedOrg?.id === org.id) {
        setSelectedOrg(null);
        setSearchParams(
          (prev) => {
            const n = new URLSearchParams(prev);
            n.delete('org');
            return n;
          },
          { replace: true }
        );
      }
      load();
    } catch (err) {
      alert(err.message || 'Failed to delete organisation.');
    }
  };

  useEffect(() => {
    if (selectedOrg) setForm(selectedOrg);
  }, [selectedOrg]);

  return (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <div style={{ flex: 1 }}>
        <div className="page-header">
          <h2>Directory</h2>
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>Add Organisation</button>
        </div>
        <div className="search-bar">
          <input
            placeholder="Search organisations..."
            value={q}
            onChange={(e) => {
              const v = e.target.value;
              setSearchParams(
                (prev) => {
                  const n = new URLSearchParams(prev);
                  if (v) n.set('q', v);
                  else n.delete('q');
                  return n;
                },
                { replace: true }
              );
            }}
          />
        </div>
        <div className="card">
          {loading ? <p>Loading...</p> : orgs.length === 0 ? (
            <div className="empty-state">
              <p>No organisations. Add plan managers, providers, or allied health.</p>
              <button className="btn btn-primary" onClick={() => setShowModal(true)}>Add Organisation</button>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Name</th><th>Type</th><th>ABN</th><th>Contacts</th><th>Participants</th><th></th></tr>
                </thead>
                <tbody>
                  {orgs.map((o) => (
                    <tr key={o.id}>
                      <td>{o.name}</td>
                      <td>{o.type || '-'}</td>
                      <td>{o.abn || '-'}</td>
                      <td>{o.contact_count || 0}</td>
                      <td>{o.participant_count ?? 0}</td>
                      <td>
                        <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => selectOrgInUrl(o.id)}>View</button>
                        {' '}
                        <button className="btn btn-secondary" style={{ fontSize: '0.8rem', color: '#c53030' }} onClick={() => handleDeleteOrg(o)} title="Delete">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selectedOrg && (
        <div className="card" style={{ width: 400 }}>
          <h3>{selectedOrg.name}</h3>
          <form onSubmit={handleUpdateOrg}>
            <div className="form-group">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Type</label>
              <select value={form.type || ''} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="">Select...</option>
                <option value="Plan Manager">Plan Manager</option>
                <option value="Provider">Provider</option>
                <option value="Allied Health">Allied Health</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>ABN</label>
              <input value={form.abn || ''} onChange={(e) => setForm({ ...form, abn: e.target.value })} />
            </div>
            <div className="form-group">
              <label>NDIS Reg Number</label>
              <input value={form.ndis_reg_number || ''} onChange={(e) => setForm({ ...form, ndis_reg_number: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Phone</label>
              <input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Address</label>
              <AddressAutocomplete value={form.address || ''} onChange={(v) => setForm({ ...form, address: v })} placeholder="Start typing an address..." />
            </div>
            <div className="form-group">
              <label>Website</label>
              <input value={form.website || ''} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            </div>
            <button type="submit" className="btn btn-primary">Save</button>
            <button type="button" className="btn btn-secondary" style={{ marginLeft: '0.5rem', color: '#c53030' }} onClick={() => handleDeleteOrg(selectedOrg)}>Delete</button>
          </form>
          <hr style={{ margin: '1.5rem 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h4>Contacts</h4>
            <button className="btn btn-primary" style={{ fontSize: '0.85rem' }} onClick={() => setShowContactModal(true)}>Add Contact</button>
          </div>
          {selectedOrg.contacts?.length ? (
            <table>
              <thead>
                <tr><th>Name</th><th>Role</th><th>Contact</th></tr>
              </thead>
              <tbody>
                {selectedOrg.contacts.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.role || '-'}</td>
                    <td>{c.email || c.phone || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No contacts. Add contacts for this organisation.</p>
          )}
          <hr style={{ margin: '1.5rem 0' }} />
          <h4>Participants (invoices go to plan manager email above)</h4>
          {selectedOrg.participants?.length ? (
            <table>
              <thead>
                <tr><th>Name</th><th>NDIS #</th><th></th></tr>
              </thead>
              <tbody>
                {selectedOrg.participants.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.ndis_number || '-'}</td>
                    <td>
                      <Link
                        to={`${pathPrefix}/participants/${p.id}?${participantsProfileQueryFromDirectory({ q, orgId: orgFromUrl || selectedOrg?.id })}`}
                        className="btn btn-secondary"
                        style={{ fontSize: '0.8rem' }}
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No participants linked. Participants are linked when created from intake form or CSV with this plan manager, or when set on the participant profile.</p>
          )}
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Organisation</h3>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Type</label>
                <select value={form.type || ''} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  <option value="">Select...</option>
                  <option value="Plan Manager">Plan Manager</option>
                  <option value="Provider">Provider</option>
                  <option value="Allied Health">Allied Health</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="form-group">
                <label>ABN</label>
                <input value={form.abn} onChange={(e) => setForm({ ...form, abn: e.target.value })} />
              </div>
              <div className="form-group">
                <label>NDIS Registration Number</label>
                <input value={form.ndis_reg_number} onChange={(e) => setForm({ ...form, ndis_reg_number: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Address</label>
                <AddressAutocomplete value={form.address} onChange={(v) => setForm({ ...form, address: v })} placeholder="Start typing an address..." />
              </div>
              <div className="form-group">
                <label>Website</label>
                <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
              </div>
              <button type="submit" className="btn btn-primary">Create</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            </form>
          </div>
        </div>
      )}

      {showContactModal && selectedOrg && (
        <div className="modal-overlay" onClick={() => setShowContactModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Contact to {selectedOrg.name}</h3>
            <form onSubmit={handleAddContact}>
              <div className="form-group">
                <label>Name *</label>
                <input value={contactForm.name} onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Role</label>
                <input value={contactForm.role} onChange={(e) => setContactForm({ ...contactForm, role: e.target.value })} placeholder="e.g. OT, Plan Manager" />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} />
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowContactModal(false)}>Cancel</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
