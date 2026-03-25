import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { coordinatorCases, participants, staff } from '../lib/api';
import SearchableSelect from '../components/SearchableSelect';
import { formatDate } from '../lib/dateUtils';

const BILLABLE_TASK_TYPE_OPTIONS = [
  { value: 'email', label: 'Email' },
  { value: 'meeting_f2f', label: 'Meeting (face-to-face)' },
  { value: 'meeting_non_f2f', label: 'Meeting (non face-to-face)' },
  { value: 'phone', label: 'Phone' },
  { value: 'other', label: 'Other' }
];

const F2F_NF2F_OPTIONS = [
  { value: 'meeting_f2f', label: 'Face-to-face (f2f)' },
  { value: 'meeting_non_f2f', label: 'Non-face-to-face (nf2f)' }
];

const CASE_STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In progress',
  completed: 'Completed',
  on_hold: 'On hold'
};

const TASK_STATUS_LABELS = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled'
};

export default function CaseTasksPage() {
  const { canAccessCaseTasks, user } = useAuth();
  const [cases, setCases] = useState([]);
  const [participantsList, setParticipantsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterParticipant, setFilterParticipant] = useState('');
  const [expandedCaseId, setExpandedCaseId] = useState(null);
  const [showCaseForm, setShowCaseForm] = useState(false);
  const [editingCase, setEditingCase] = useState(null);
  const [addingTaskCaseId, setAddingTaskCaseId] = useState(null);
  const [billTimeFor, setBillTimeFor] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [staffList, setStaffList] = useState([]);
  const [suggestedTaskTitles, setSuggestedTaskTitles] = useState([]);
  const [taskTitleFromList, setTaskTitleFromList] = useState(true);
  const [billableTaskForm, setBillableTaskForm] = useState({
    staff_id: '',
    task_type: 'email',
    activity_date: new Date().toISOString().slice(0, 10),
    duration_minutes: 15,
    description: ''
  });

  const [caseForm, setCaseForm] = useState({
    participant_id: '',
    title: '',
    description: '',
    status: 'open',
    due_date: ''
  });

  const [taskForm, setTaskForm] = useState({
    title: '',
    description: '',
    status: 'pending',
    due_date: '',
    notes: '',
    billable_minutes: '',
    task_type: 'meeting_non_f2f',
    staff_id: '',
    activity_date: '',
    travel_km: '',
    travel_time_min: ''
  });

  const loadCases = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = filterParticipant ? { participant_id: filterParticipant } : {};
      const list = await coordinatorCases.list(params);
      setCases(Array.isArray(list) ? list : []);
    } catch (e) {
      console.error(e);
      setError(e.message || 'Failed to load cases');
      setCases([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCases();
  }, [filterParticipant]);

  useEffect(() => {
    participants.list().then((p) => {
      setParticipantsList(Array.isArray(p) ? p.map((x) => ({ id: x.id, name: x.name })) : []);
    }).catch(() => []);
  }, []);

  useEffect(() => {
    staff.list().then((s) => setStaffList(Array.isArray(s) ? s.map((x) => ({ id: x.id, name: x.name })) : [])).catch(() => []);
  }, []);

  useEffect(() => {
    coordinatorCases.suggestedTaskTitles().then((data) => setSuggestedTaskTitles(Array.isArray(data?.titles) ? data.titles : [])).catch(() => setSuggestedTaskTitles([]));
  }, []);

  const loadCaseWithTasks = async (caseId) => {
    try {
      const full = await coordinatorCases.get(caseId);
      setCases((prev) =>
        prev.map((c) => (c.id === caseId ? { ...c, tasks: full.tasks || [] } : c))
      );
    } catch (e) {
      console.error(e);
    }
  };

  const toggleExpand = (caseId) => {
    if (expandedCaseId === caseId) {
      setExpandedCaseId(null);
    } else {
      setExpandedCaseId(caseId);
      const c = cases.find((x) => x.id === caseId);
      if (c && !c.tasks) loadCaseWithTasks(caseId);
    }
  };

  const handleCreateCase = async (e) => {
    e.preventDefault();
    try {
      await coordinatorCases.create({
        ...caseForm,
        due_date: caseForm.due_date || null
      });
      setShowCaseForm(false);
      setCaseForm({ participant_id: '', title: '', description: '', status: 'open', due_date: '' });
      loadCases();
    } catch (err) {
      alert(err.message || 'Failed to create case');
    }
  };

  const handleUpdateCase = async (e) => {
    e.preventDefault();
    if (!editingCase) return;
    try {
      await coordinatorCases.update(editingCase.id, {
        ...caseForm,
        due_date: caseForm.due_date || null
      });
      setEditingCase(null);
      setShowCaseForm(false);
      loadCases();
    } catch (err) {
      alert(err.message || 'Failed to update case');
    }
  };

  const handleDeleteCase = async (id) => {
    if (!confirm('Delete this case and all its tasks?')) return;
    try {
      await coordinatorCases.delete(id);
      if (expandedCaseId === id) setExpandedCaseId(null);
      loadCases();
    } catch (err) {
      alert(err.message || 'Failed to delete case');
    }
  };

  const handleAddTask = async (e) => {
    e.preventDefault();
    if (!addingTaskCaseId) return;
    if (!taskForm.title?.trim()) {
      alert('Choose a task from the list or type your own.');
      return;
    }
    const billable = Number(taskForm.billable_minutes);
    try {
      const payload = {
        title: taskForm.title,
        description: taskForm.description,
        status: taskForm.status,
        due_date: taskForm.due_date || null,
        notes: taskForm.notes || null
      };
      if (billable > 0) {
        payload.billable_minutes = billable;
        payload.task_type = taskForm.task_type;
        payload.activity_date = taskForm.activity_date || taskForm.due_date || new Date().toISOString().slice(0, 10);
        if (taskForm.travel_km != null && taskForm.travel_km !== '') payload.travel_km = Number(taskForm.travel_km);
        if (taskForm.travel_time_min != null && taskForm.travel_time_min !== '') payload.travel_time_min = Number(taskForm.travel_time_min);
      }
      await coordinatorCases.addTask(addingTaskCaseId, payload);
      setAddingTaskCaseId(null);
      setTaskForm(emptyTaskForm);
      loadCaseWithTasks(addingTaskCaseId);
      loadCases();
      coordinatorCases.suggestedTaskTitles().then((data) => setSuggestedTaskTitles(Array.isArray(data?.titles) ? data.titles : [])).catch(() => {});
    } catch (err) {
      alert(err.message || 'Failed to add task');
    }
  };

  const handleUpdateTask = async (e) => {
    e.preventDefault();
    if (!editingTask) return;
    try {
      await coordinatorCases.updateTask(editingTask.case_id, editingTask.id, {
        ...taskForm,
        due_date: taskForm.due_date || null
      });
      setEditingTask(null);
      setTaskForm({ title: '', description: '', status: 'pending', due_date: '', notes: '', billable_minutes: '', task_type: 'meeting_non_f2f', staff_id: '', activity_date: '', travel_km: '', travel_time_min: '' });
      loadCaseWithTasks(editingTask.case_id);
      loadCases();
    } catch (err) {
      alert(err.message || 'Failed to update task');
    }
  };

  const handleCompleteTask = async (c, task) => {
    try {
      await coordinatorCases.completeTask(c.id, task.id);
      loadCaseWithTasks(c.id);
      loadCases();
    } catch (err) {
      alert(err.message || 'Failed to complete task');
    }
  };

  const handleDeleteTask = async (c, taskId) => {
    if (!confirm('Delete this task?')) return;
    try {
      await coordinatorCases.deleteTask(c.id, taskId);
      loadCaseWithTasks(c.id);
      loadCases();
    } catch (err) {
      alert(err.message || 'Failed to delete task');
    }
  };

  const handleAddBillableTask = async (e) => {
    e.preventDefault();
    if (!billTimeFor?.caseId) return;
    if (!billableTaskForm.staff_id) {
      alert('Select a staff member.');
      return;
    }
    try {
      await coordinatorCases.addBillableTask(billTimeFor.caseId, {
        staff_id: billableTaskForm.staff_id,
        task_type: billableTaskForm.task_type,
        activity_date: billableTaskForm.activity_date,
        duration_minutes: Number(billableTaskForm.duration_minutes) || 15,
        description: billableTaskForm.description || undefined,
        case_task_id: billTimeFor.taskId || undefined
      });
      setBillTimeFor(null);
      setBillableTaskForm({ staff_id: '', task_type: 'email', activity_date: new Date().toISOString().slice(0, 10), duration_minutes: 15, description: '' });
      loadCaseWithTasks(billTimeFor.caseId);
      loadCases();
    } catch (err) {
      alert(err.message || 'Failed to log billable time');
    }
  };

  const openEditCase = (c) => {
    setEditingCase(c);
    setCaseForm({
      participant_id: c.participant_id,
      title: c.title,
      description: c.description || '',
      status: c.status,
      due_date: c.due_date || ''
    });
    setShowCaseForm(true);
  };

  const openEditTask = (c, task) => {
    setEditingTask({ ...task, case_id: c.id });
    setTaskForm({
      title: task.title,
      description: task.description || '',
      status: task.status,
      due_date: task.due_date || '',
      notes: task.notes || '',
      billable_minutes: '',
      task_type: 'meeting_non_f2f',
      staff_id: '',
      activity_date: '',
      travel_km: '',
      travel_time_min: ''
    });
  };

  const emptyTaskForm = { title: '', description: '', status: 'pending', due_date: '', notes: '', billable_minutes: '', task_type: 'meeting_non_f2f', staff_id: '', activity_date: '', travel_km: '', travel_time_min: '' };

  if (!canAccessCaseTasks) {
    return (
      <div className="case-tasks-page">
        <div className="card" style={{ maxWidth: 480, margin: '2rem auto', textAlign: 'center' }}>
          <h3>Access restricted</h3>
          <p style={{ color: '#64748b' }}>Client Cases is available to coordinators and admins only.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="case-tasks-page">
      <div className="page-header">
        <h2>Client Cases & Tasks</h2>
        <button type="button" className="btn btn-primary" onClick={() => { setEditingCase(null); setCaseForm({ participant_id: '', title: '', description: '', status: 'open', due_date: '' }); setShowCaseForm(true); }}>
          New case
        </button>
      </div>

      <p style={{ margin: '0 0 1rem', color: '#64748b', fontSize: '0.95rem' }}>
        Track multi-step work for clients—e.g. OT onboarding, change of situation—with cases and sub-tasks. Visible to coordinators and admins only.
      </p>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="form-group" style={{ maxWidth: 280 }}>
          <label>Filter by participant</label>
          <SearchableSelect
            options={participantsList}
            value={filterParticipant}
            onChange={setFilterParticipant}
            placeholder="All participants"
          />
        </div>
      </div>

      {showCaseForm && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>{editingCase ? 'Edit case' : 'New case'}</h3>
          <form onSubmit={editingCase ? handleUpdateCase : handleCreateCase}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label>Participant *</label>
                {editingCase ? (
                  <div className="form-input" style={{ background: '#f1f5f9', color: '#64748b' }}>{editingCase.participant_name}</div>
                ) : (
                  <SearchableSelect
                    options={participantsList}
                    value={caseForm.participant_id}
                    onChange={(id) => setCaseForm({ ...caseForm, participant_id: id })}
                    placeholder="Select participant"
                    required
                  />
                )}
              </div>
              <div className="form-group">
                <label>Title *</label>
                <input
                  type="text"
                  className="form-input"
                  value={caseForm.title}
                  onChange={(e) => setCaseForm({ ...caseForm, title: e.target.value })}
                  placeholder="e.g. OT onboarding, Change of situation"
                  required
                />
              </div>
              <div className="form-group">
                <label>Status</label>
                <select
                  className="form-input"
                  value={caseForm.status}
                  onChange={(e) => setCaseForm({ ...caseForm, status: e.target.value })}
                >
                  {Object.entries(CASE_STATUS_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Due date</label>
                <input
                  type="date"
                  className="form-input"
                  value={caseForm.due_date}
                  onChange={(e) => setCaseForm({ ...caseForm, due_date: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Description</label>
                <textarea
                  className="form-input"
                  value={caseForm.description}
                  onChange={(e) => setCaseForm({ ...caseForm, description: e.target.value })}
                  rows={2}
                  placeholder="Brief overview of the case..."
                />
              </div>
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button type="submit" className="btn btn-primary">{editingCase ? 'Save' : 'Create case'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowCaseForm(false); setEditingCase(null); }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {error && (
          <div style={{ background: '#fef2f2', color: '#dc2626', padding: '1rem', borderRadius: 8, marginBottom: '1rem' }}>
            <strong>Error loading cases:</strong> {error}
            {error.includes('403') && (
              <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
                You may not have access. Client Cases is for coordinators and admins. Support coordinators only see cases for participants they are assigned to (Admin → User assignments).
              </p>
            )}
            <button type="button" className="btn btn-secondary" style={{ marginTop: '0.5rem' }} onClick={() => loadCases()}>Retry</button>
          </div>
        )}
        {loading ? (
          <p>Loading...</p>
        ) : cases.length === 0 ? (
          <div className="empty-state">
            <p>
              {error ? 'Could not load cases.' : 'No cases yet.'}
              {!error && ' Create a case to track multi-step work for a client (e.g. OT onboarding, change of situation).'}
            </p>
            {!error && user?.role === 'support_coordinator' && (
              <p style={{ fontSize: '0.9rem', color: '#64748b', marginTop: '0.5rem' }}>
                Support coordinators only see cases for participants they are assigned to. If you expect to see cases, ask an admin to assign you participants (Admin → User assignments).
              </p>
            )}
            {!error && (
              <button type="button" className="btn btn-primary" style={{ marginTop: '0.5rem' }} onClick={() => { setShowCaseForm(true); setEditingCase(null); setCaseForm({ participant_id: '', title: '', description: '', status: 'open', due_date: '' }); }}>
                Create first case
              </button>
            )}
          </div>
        ) : (
          <div className="case-list">
            {cases.map((c) => (
              <div key={c.id} className="case-item">
                <div
                  className="case-item-header"
                  onClick={() => toggleExpand(c.id)}
                  style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 0', borderBottom: expandedCaseId === c.id ? '1px solid #e2e8f0' : 'none' }}
                >
                  <span style={{ fontSize: '1.1rem' }}>{expandedCaseId === c.id ? '▼' : '▶'}</span>
                  <div style={{ flex: 1 }}>
                    <strong>{c.title}</strong>
                    <span style={{ color: '#64748b', marginLeft: '0.5rem', fontSize: '0.9rem' }}>
                      {c.participant_name}
                      {c.ndis_number && ` (${c.ndis_number})`}
                    </span>
                  </div>
                  <span className={`badge badge-${c.status === 'completed' ? 'sent' : c.status === 'in_progress' ? 'pending' : 'draft'}`} style={{ fontSize: '0.75rem' }}>
                    {CASE_STATUS_LABELS[c.status] || c.status}
                  </span>
                  <span style={{ fontSize: '0.85rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span>{c.completed_tasks ?? 0}/{c.total_tasks ?? 0} tasks</span>
                    {(c.total_tasks ?? 0) > 0 && (
                      <span style={{ display: 'inline-block', width: 48, height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }} title={`${c.completed_tasks ?? 0} of ${c.total_tasks ?? 0} complete`}>
                        <span style={{ display: 'block', width: `${Math.round(((c.completed_tasks ?? 0) / (c.total_tasks ?? 1)) * 100)}%`, height: '100%', background: (c.completed_tasks ?? 0) === (c.total_tasks ?? 0) ? '#22c55e' : '#3b82f6', transition: 'width 0.2s' }} />
                      </span>
                    )}
                  </span>
                  <div style={{ display: 'flex', gap: '0.25rem' }} onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }} onClick={() => openEditCase(c)}>Edit</button>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }} onClick={() => handleDeleteCase(c.id)}>Delete</button>
                  </div>
                </div>

                {expandedCaseId === c.id && (
                  <div className="case-item-body" style={{ padding: '1rem 0 1rem 2rem', borderLeft: '2px solid #e2e8f0', marginLeft: '0.5rem' }}>
                    {c.description && (
                      <p style={{ margin: '0 0 0.75rem', color: '#64748b', fontSize: '0.9rem' }}>{c.description}</p>
                    )}

                    {addingTaskCaseId === c.id ? (
                      <form onSubmit={handleAddTask} style={{ marginBottom: '1rem', padding: '1rem', background: '#f8fafc', borderRadius: 8 }}>
                        <h4 style={{ margin: '0 0 0.75rem' }}>Add task</h4>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                          <div className="form-group">
                            <label>Task *</label>
                            {suggestedTaskTitles.length > 0 ? (
                              <>
                                <select
                                  className="form-input"
                                  value={taskTitleFromList && suggestedTaskTitles.some((t) => t.title === taskForm.title) ? taskForm.title : '__custom__'}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (v === '__custom__') {
                                      setTaskTitleFromList(false);
                                      setTaskForm((f) => ({ ...f, title: '' }));
                                    } else {
                                      setTaskTitleFromList(true);
                                      setTaskForm((f) => ({ ...f, title: v }));
                                    }
                                  }}
                                >
                                  <option value="">Choose a task...</option>
                                  {suggestedTaskTitles.map((t) => (
                                    <option key={t.title} value={t.title}>
                                      {t.title}{t.use_count > 1 ? ` (${t.use_count})` : ''}
                                    </option>
                                  ))}
                                  <option value="__custom__">+ Type my own...</option>
                                </select>
                                {(!taskTitleFromList || (taskForm.title && !suggestedTaskTitles.some((t) => t.title === taskForm.title))) && (
                                  <input
                                    type="text"
                                    className="form-input"
                                    style={{ marginTop: '0.35rem' }}
                                    value={taskForm.title}
                                    onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
                                    placeholder="Enter task title"
                                    required
                                  />
                                )}
                              </>
                            ) : (
                              <input type="text" className="form-input" value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} placeholder="e.g. Book OT assessment" required />
                            )}
                          </div>
                          <div className="form-group">
                            <label>Due date</label>
                            <input type="date" className="form-input" value={taskForm.due_date} onChange={(e) => setTaskForm({ ...taskForm, due_date: e.target.value })} />
                          </div>
                          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                            <label>Notes</label>
                            <input type="text" className="form-input" value={taskForm.notes} onChange={(e) => setTaskForm({ ...taskForm, notes: e.target.value })} placeholder="Optional notes..." />
                          </div>
                          <div className="form-group">
                            <label>Billable time (min)</label>
                            <input type="number" className="form-input" min={0} placeholder="Leave empty if not billed" value={taskForm.billable_minutes} onChange={(e) => setTaskForm({ ...taskForm, billable_minutes: e.target.value })} />
                          </div>
                          {Number(taskForm.billable_minutes) > 0 && (
                            <>
                              <div className="form-group">
                                <label>Type *</label>
                                <select className="form-input" value={taskForm.task_type} onChange={(e) => setTaskForm({ ...taskForm, task_type: e.target.value })}>
                                  {F2F_NF2F_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                                </select>
                              </div>
                              <div className="form-group">
                                <label>Date</label>
                                <input type="date" className="form-input" value={taskForm.activity_date || taskForm.due_date} onChange={(e) => setTaskForm({ ...taskForm, activity_date: e.target.value })} />
                              </div>
                              <div className="form-group">
                                <label>Travel (km)</label>
                                <input type="number" className="form-input" min={0} step={0.1} placeholder="Optional" value={taskForm.travel_km} onChange={(e) => setTaskForm({ ...taskForm, travel_km: e.target.value })} />
                              </div>
                              <div className="form-group">
                                <label>Travel (min)</label>
                                <input type="number" className="form-input" min={0} placeholder="Optional" value={taskForm.travel_time_min} onChange={(e) => setTaskForm({ ...taskForm, travel_time_min: e.target.value })} />
                              </div>
                            </>
                          )}
                        </div>
                        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
                          <button type="submit" className="btn btn-primary" style={{ fontSize: '0.85rem' }}>Add task</button>
                          <button type="button" className="btn btn-secondary" style={{ fontSize: '0.85rem' }} onClick={() => { setAddingTaskCaseId(null); setTaskForm(emptyTaskForm); }}>Cancel</button>
                        </div>
                      </form>
                    ) : (
                      <button type="button" className="btn btn-secondary" style={{ marginBottom: '1rem', fontSize: '0.85rem' }} onClick={() => { setAddingTaskCaseId(c.id); setTaskForm(emptyTaskForm); setTaskTitleFromList(true); }}>
                        + Add task
                      </button>
                    )}

                    <div className="task-list">
                      {(!c.tasks || c.tasks.length === 0) ? (
                        <p style={{ color: '#94a3b8', fontSize: '0.9rem', margin: 0 }}>No tasks yet. Add tasks to track progress.</p>
                      ) : (
                        c.tasks.map((task) => (
                          <div key={task.id} className="task-item" style={{ padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                              {editingTask?.id === task.id ? (
                                <form onSubmit={handleUpdateTask} style={{ flex: 1, display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                  <input type="text" className="form-input" style={{ flex: 1, minWidth: 180 }} value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} required />
                                  <select className="form-input" style={{ width: 120 }} value={taskForm.status} onChange={(e) => setTaskForm({ ...taskForm, status: e.target.value })}>
                                    {Object.entries(TASK_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                  </select>
                                  <input type="date" className="form-input" style={{ width: 130 }} value={taskForm.due_date} onChange={(e) => setTaskForm({ ...taskForm, due_date: e.target.value })} />
                                  <button type="submit" className="btn btn-primary" style={{ fontSize: '0.8rem' }}>Save</button>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => { setEditingTask(null); setTaskForm(emptyTaskForm); }}>Cancel</button>
                                </form>
                              ) : (
                                <>
                                  <input
                                    type="checkbox"
                                    checked={task.status === 'completed'}
                                    onChange={() => task.status !== 'completed' && handleCompleteTask(c, task)}
                                    style={{ margin: 0 }}
                                  />
                                  <span style={{ flex: 1, minWidth: 120, textDecoration: task.status === 'completed' ? 'line-through' : 'none', color: task.status === 'completed' ? '#94a3b8' : 'inherit' }}>
                                    {task.title}
                                    {task.due_date && <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: '#94a3b8' }}>(due {formatDate(task.due_date)})</span>}
                                  </span>
                                  <span className={`badge badge-${task.status === 'completed' ? 'sent' : 'draft'}`} style={{ fontSize: '0.7rem' }}>
                                    {TASK_STATUS_LABELS[task.status] || task.status}
                                  </span>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={() => openEditTask(c, task)}>Edit</button>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={() => handleDeleteTask(c, task.id)}>×</button>
                                  <button type="button" className="btn btn-primary" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={() => { setBillTimeFor({ caseId: c.id, taskId: task.id }); setBillableTaskForm((prev) => ({ ...prev, staff_id: user?.staff_id || prev.staff_id })); }}>
                                    Bill time
                                  </button>
                                </>
                              )}
                            </div>
                            {billTimeFor?.caseId === c.id && billTimeFor?.taskId === task.id && (
                              <form onSubmit={handleAddBillableTask} style={{ marginTop: '0.75rem', marginLeft: '1.5rem', padding: '0.75rem', background: '#f8fafc', borderRadius: 8 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                                  <div className="form-group">
                                    <label>Staff *</label>
                                    <SearchableSelect options={staffList} value={billableTaskForm.staff_id} onChange={(id) => setBillableTaskForm({ ...billableTaskForm, staff_id: id })} placeholder="Select staff..." required />
                                  </div>
                                  <div className="form-group">
                                    <label>Type *</label>
                                    <select className="form-input" value={billableTaskForm.task_type} onChange={(e) => setBillableTaskForm({ ...billableTaskForm, task_type: e.target.value })}>
                                      {BILLABLE_TASK_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                                    </select>
                                  </div>
                                  <div className="form-group">
                                    <label>Date *</label>
                                    <input type="date" className="form-input" value={billableTaskForm.activity_date} onChange={(e) => setBillableTaskForm({ ...billableTaskForm, activity_date: e.target.value })} required />
                                  </div>
                                  <div className="form-group">
                                    <label>Duration (min) *</label>
                                    <input type="number" className="form-input" min={1} value={billableTaskForm.duration_minutes} onChange={(e) => setBillableTaskForm({ ...billableTaskForm, duration_minutes: e.target.value })} required />
                                  </div>
                                  <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                                    <label>Description</label>
                                    <input type="text" className="form-input" value={billableTaskForm.description} onChange={(e) => setBillableTaskForm({ ...billableTaskForm, description: e.target.value })} placeholder="e.g. Email to OT, phone call" />
                                  </div>
                                </div>
                                <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
                                  <button type="submit" className="btn btn-primary" style={{ fontSize: '0.85rem' }}>Log time</button>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.85rem' }} onClick={() => { setBillTimeFor(null); setBillableTaskForm({ staff_id: '', task_type: 'email', activity_date: new Date().toISOString().slice(0, 10), duration_minutes: 15, description: '' }); }}>Cancel</button>
                                </div>
                              </form>
                            )}
                            {(task.billable_entries && task.billable_entries.length > 0) && (
                              <div style={{ marginTop: '0.5rem', marginLeft: '1.5rem', fontSize: '0.85rem', color: '#64748b' }}>
                                {task.billable_entries.map((bt) => (
                                  <div key={bt.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.2rem 0' }}>
                                    <span>{formatDate(bt.activity_date)}</span>
                                    <span>{BILLABLE_TASK_TYPE_OPTIONS.find((o) => o.value === bt.task_type)?.label || bt.task_type}</span>
                                    <span>{bt.duration_minutes} min</span>
                                    {bt.staff_name && <span style={{ color: '#94a3b8' }}>{bt.staff_name}</span>}
                                    {bt.description && <span>— {bt.description}</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
