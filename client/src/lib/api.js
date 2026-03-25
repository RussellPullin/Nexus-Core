import { getSupabaseBrowserClient } from './supabaseClient';

const API = '/api';

export const settings = {
  getBusiness: () => fetchApi('/settings/business'),
  updateBusiness: (data) => fetchApi('/settings/business', { method: 'PUT', body: JSON.stringify(data) }),
  xeroSaveAndConnect: (data) => fetchApi('/settings/xero/save-and-connect', { method: 'POST', body: JSON.stringify(data) }),
  xeroDisconnect: () => fetchApi('/settings/xero/disconnect', { method: 'POST' }),
  xeroTestInvoice: () => fetchApi('/settings/xero/test-invoice', { method: 'POST' }),
  uploadLogo: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API}/settings/logo`, {
      method: 'POST',
      credentials: 'include',
      body: formData
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || res.statusText);
    }
    return text ? JSON.parse(text) : {};
  },
  deleteLogo: () => fetchApi('/settings/logo', { method: 'DELETE' }),
  logoUrl: () => `${API}/settings/logo`
};

export const users = {
  list: () => fetchApi('/users'),
  setRole: (id, role) => fetchApi(`/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
  listAssignments: (userId) => fetchApi(`/users/user-participants${userId ? `?user_id=${encodeURIComponent(userId)}` : ''}`),
  assignParticipant: (userId, participantId) => fetchApi('/users/user-participants', { method: 'POST', body: JSON.stringify({ user_id: userId, participant_id: participantId }) }),
  removeAssignment: (id) => fetchApi(`/users/user-participants/${id}`, { method: 'DELETE' }),
  grantDelegate: (userId, expiresAt) => fetchApi('/users/delegate-grants', { method: 'POST', body: JSON.stringify({ user_id: userId, expires_at: expiresAt || null }) }),
  revokeDelegate: (userId) => fetchApi(`/users/delegate-grants/${userId}`, { method: 'DELETE' })
};

export const admin = {
  coordinatorActivity: (params) => fetchApi(`/admin/coordinator-activity?${new URLSearchParams(params || {}).toString()}`),
  billableSummary: (params) => fetchApi(`/admin/billable-summary?${new URLSearchParams(params || {}).toString()}`),
  financialOverview: (params) => fetchApi(`/admin/financial-overview?${new URLSearchParams(params || {}).toString()}`),
  paySummary: () => fetchApi('/admin/pay-summary'),
  refreshRegisters: () => fetchApi('/integrations/microsoft-drive/refresh-registers', { method: 'POST' })
};

/** Per-org flags in Supabase org_features; server uses service role. */
export const orgFeatures = {
  mine: () => fetchApi('/org-features'),
  superAdminMatrix: () => fetchApi('/org-features/super-admin/matrix'),
  superAdminSet: (org_id, feature_key, enabled) =>
    fetchApi('/org-features/super-admin', {
      method: 'PUT',
      body: JSON.stringify({ org_id, feature_key, enabled })
    })
};

export const ai = {
  status: () => fetchApi('/ai/status')
};

/** Per-org Microsoft OneDrive document archive (admin OAuth). */
export const microsoftDrive = {
  status: () => fetchApi('/integrations/microsoft-drive/status'),
  disconnect: () => fetchApi('/integrations/microsoft-drive/disconnect', { method: 'POST' }),
  register: (params) =>
    fetchApi(`/integrations/microsoft-drive/register${params ? `?${new URLSearchParams(params)}` : ''}`)
};

export const auth = {
  me: () => fetchApi('/auth/me'),
  login: (email, password) => fetchApi('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email, password, name) => fetchApi('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  logout: () => fetchApi('/auth/logout', { method: 'POST' }),
  updateSettings: (data) => fetchApi('/auth/settings', { method: 'PUT', body: JSON.stringify(data) }),
  changePassword: (currentPassword, newPassword) => fetchApi('/auth/password', { method: 'PUT', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),
  testEmail: () => fetchApi('/auth/test-email', { method: 'POST' }),
  disconnectEmail: () => fetchApi('/email/oauth/disconnect', { method: 'POST' }),
  supabasePublicConfig: () =>
    fetch(`${API}/auth/supabase/public-config`, { credentials: 'include' }).then((r) => r.json()),
  supabaseSession: (access_token) =>
    fetchApi('/auth/supabase/session', { method: 'POST', body: JSON.stringify({ access_token }) }),
  supabaseRegisterOrg: (access_token, organization_name) =>
    fetchApi('/auth/supabase/register-org', { method: 'POST', body: JSON.stringify({ access_token, organization_name }) }),
  supabaseInviteStaff: (email, full_name) =>
    fetchApi('/auth/supabase/invite-staff', { method: 'POST', body: JSON.stringify({ email, full_name: full_name || undefined }) })
};

function parseJsonSafe(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid response from server');
  }
}

export async function fetchApi(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.includes('/auth/')) {
      window.location.href = '/login';
    }
    const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    const msg = err?.error || text || res.statusText;
    const extra = err?.errorDetail || err?.detail;
    const detail = extra ? `\n\n${extra}` : '';
    const e = new Error(msg + detail);
    if (err?.code) e.code = err.code;
    throw e;
  }
  if (res.status === 204 || !text.trim()) return null;
  return parseJsonSafe(text);
}

/**
 * When Express session is missing but Supabase still has a session (e.g. server restart, new API instance),
 * re-post the access token so cookie-based API calls work again.
 */
export async function tryRestoreExpressSessionFromSupabase() {
  const sb = getSupabaseBrowserClient();
  if (!sb) return false;
  try {
    const { data, error } = await sb.auth.getSession();
    if (error || !data?.session?.access_token) return false;
    await fetchApi('/auth/supabase/session', {
      method: 'POST',
      body: JSON.stringify({ access_token: data.session.access_token })
    });
    return true;
  } catch {
    return false;
  }
}

async function postMultipartWithSessionRetry(path, formData) {
  const url = `${API}${path}`;
  let res = await fetch(url, { method: 'POST', body: formData, credentials: 'include' });
  if (res.status === 401 && (await tryRestoreExpressSessionFromSupabase())) {
    res = await fetch(url, { method: 'POST', body: formData, credentials: 'include' });
  }
  return res;
}

export const participants = {
  list: (search, includeArchived) => fetchApi(`/participants${search ? `?search=${encodeURIComponent(search)}` : ''}${includeArchived ? `${search ? '&' : '?'}include_archived=true` : ''}`),
  get: (id) => fetchApi(`/participants/${id}`),
  create: (data) => fetchApi('/participants', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchApi(`/participants/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchApi(`/participants/${id}`, { method: 'DELETE' }),
  archive: (id) => fetchApi(`/participants/${id}/archive`, { method: 'POST' }),
  unarchive: (id) => fetchApi(`/participants/${id}/unarchive`, { method: 'POST' }),
  listPlans: (id) => fetchApi(`/participants/${id}/plans`),
  addPlan: (id, data) => fetchApi(`/participants/${id}/plans`, { method: 'POST', body: JSON.stringify(data) }),
  updatePlan: (id, planId, data) => fetchApi(`/participants/${id}/plans/${planId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlan: (id, planId) => fetchApi(`/participants/${id}/plans/${planId}`, { method: 'DELETE' }),
  refreshPlanAvailableFunding: (id, planId) => fetchApi(`/participants/${id}/plans/${planId}/refresh-available-funding`, { method: 'POST' }),
  addContact: (id, data) => fetchApi(`/participants/${id}/contacts`, { method: 'POST', body: JSON.stringify(data) }),
  updateContact: (id, pcId, data) => fetchApi(`/participants/${id}/contacts/${pcId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteContact: (id, pcId) => fetchApi(`/participants/${id}/contacts/${pcId}`, { method: 'DELETE' }),
  addGoal: (id, data) => fetchApi(`/participants/${id}/goals`, { method: 'POST', body: JSON.stringify(data) }),
  updateGoal: (id, goalId, data) => fetchApi(`/participants/${id}/goals/${goalId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGoal: (id, goalId) => fetchApi(`/participants/${id}/goals/${goalId}`, { method: 'DELETE' }),
  addCaseNote: (id, data) => fetchApi(`/participants/${id}/case-notes`, { method: 'POST', body: JSON.stringify(data) }),
  getBudgets: (id, planId) => fetchApi(`/participants/${id}/plans/${planId}/budgets`),
  addBudget: (id, planId, data) => fetchApi(`/participants/${id}/plans/${planId}/budgets`, { method: 'POST', body: JSON.stringify(data) }),
  updateBudget: (id, planId, budgetId, data) => fetchApi(`/participants/${id}/plans/${planId}/budgets/${budgetId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBudget: (id, planId, budgetId) => fetchApi(`/participants/${id}/plans/${planId}/budgets/${budgetId}`, { method: 'DELETE' }),
  addImplementation: (id, planId, data) => fetchApi(`/participants/${id}/plans/${planId}/implementations`, { method: 'POST', body: JSON.stringify(data) }),
  updateImplementation: (id, planId, implId, data) => fetchApi(`/participants/${id}/plans/${planId}/implementations/${implId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteImplementation: (id, planId, implId) => fetchApi(`/participants/${id}/plans/${planId}/implementations/${implId}`, { method: 'DELETE' }),
  budgetUtilization: (id) => fetchApi(`/participants/${id}/budget-utilization`),
  parsePlan: async (id, file, useAi = true) => {
    const form = new FormData();
    form.append('file', file);
    form.append('useAi', useAi ? 'true' : 'false');
    const res = await fetch(`${API}/participants/${id}/parse-plan`, { method: 'POST', body: form, credentials: 'include' });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Parse failed');
    }
    return text ? JSON.parse(text) : null;
  },
  applyPlanBreakdown: (id, data) => fetchApi(`/participants/${id}/apply-plan-breakdown`, { method: 'POST', body: JSON.stringify(data) }),
  uploadDocument: (id, file, category) => {
    const form = new FormData();
    form.append('file', file);
    if (category) form.append('category', category);
    return fetch(`${API}/participants/${id}/documents`, { method: 'POST', body: form, credentials: 'include' });
  },
  parseIntakeForm: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/participants/parse-intake-form`, { method: 'POST', body: form, credentials: 'include' });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Parse failed');
    }
    return text ? JSON.parse(text) : null;
  },
  createFromIntakeForm: async (fileOrParsed) => {
    if (fileOrParsed instanceof File || fileOrParsed instanceof Blob) {
      const form = new FormData();
      form.append('file', fileOrParsed);
      const res = await fetch(`${API}/participants/from-intake-form`, { method: 'POST', body: form, credentials: 'include' });
      const text = await res.text();
      if (!res.ok) {
        const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
        throw new Error(err?.error || text || 'Create failed');
      }
      return text ? JSON.parse(text) : null;
    }
    const res = await fetch(`${API}/participants/from-intake-form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fileOrParsed),
      credentials: 'include'
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Create failed');
    }
    return text ? JSON.parse(text) : null;
  },
  parseCsv: async (file, useLlm = false) => {
    const form = new FormData();
    form.append('file', file);
    if (useLlm) form.append('useLlm', 'true');
    const res = await postMultipartWithSessionRetry('/participants/parse-csv', form);
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Parse failed');
    }
    return text ? JSON.parse(text) : null;
  },
  importCsv: async (file, useLlm = false) => {
    const form = new FormData();
    form.append('file', file);
    if (useLlm) form.append('useLlm', 'true');
    const res = await postMultipartWithSessionRetry('/participants/import-csv', form);
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Import failed');
    }
    return text ? JSON.parse(text) : null;
  }
};

export const organisations = {
  list: (search, type) => fetchApi(`/organisations?${new URLSearchParams({ search: search || '', type: type || '' }).toString()}`),
  get: (id) => fetchApi(`/organisations/${id}`),
  create: (data) => fetchApi('/organisations', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchApi(`/organisations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchApi(`/organisations/${id}`, { method: 'DELETE' }),
  addContact: (id, data) => fetchApi(`/organisations/${id}/contacts`, { method: 'POST', body: JSON.stringify(data) }),
  updateContact: (id, cId, data) => fetchApi(`/organisations/${id}/contacts/${cId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteContact: (id, cId) => fetchApi(`/organisations/${id}/contacts/${cId}`, { method: 'DELETE' }),
  allContacts: (search) => fetchApi(`/organisations/contacts/all?${search ? `search=${encodeURIComponent(search)}` : ''}`)
};

export const staff = {
  list: (includeArchived) => fetchApi(`/staff${includeArchived ? '?include_archived=true' : ''}`),
  get: (id) => fetchApi(`/staff/${id}`),
  create: (data) => fetchApi('/staff', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchApi(`/staff/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchApi(`/staff/${id}`, { method: 'DELETE' }),
  archive: (id) => fetchApi(`/staff/${id}/archive`, { method: 'POST' }),
  unarchive: (id) => fetchApi(`/staff/${id}/unarchive`, { method: 'POST' }),
  sendTestEmail: (id) => fetchApi('/staff/send-test-email', { method: 'POST', body: JSON.stringify({ id }) }),
  getAssignments: (staffId) => fetchApi(`/staff/${staffId}/assignments`),
  assignParticipant: (staffId, participantId) => fetchApi(`/staff/${staffId}/assignments`, { method: 'POST', body: JSON.stringify({ participant_id: participantId }) }),
  removeAssignment: (staffId, assignmentId) => fetchApi(`/staff/${staffId}/assignments/${assignmentId}`, { method: 'DELETE' }),
  getExcelSummary: (staffId) => fetchApi(`/staff/${staffId}/excel-summary`),
  getShiftHoursSummary: (staffId) => fetchApi(`/staff/${staffId}/shift-hours-summary`),
  startOnboarding: (staffId) => fetchApi(`/staff/${staffId}/start-onboarding`, { method: 'POST' }),
  getComplianceDocuments: (staffId) => fetchApi(`/staff/${staffId}/compliance-documents`),
  updateComplianceDocumentExpiry: (staffId, docId, expiryDate) =>
    fetchApi(`/staff/${staffId}/compliance-documents/${docId}`, { method: 'PATCH', body: JSON.stringify({ expiry_date: expiryDate || null }) }),
  uploadComplianceDocument: async (staffId, file, documentType, expiryDate) => {
    const form = new FormData();
    form.append('file', file);
    form.append('document_type', documentType);
    if (expiryDate) form.append('expiry_date', expiryDate);
    const res = await fetch(`${API}/staff/${staffId}/compliance-documents`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Upload failed');
    }
    return text ? JSON.parse(text) : null;
  },
  sendRenewalReminder: (staffId) => fetchApi(`/staff/${staffId}/send-renewal-reminder`, { method: 'POST' }),
  sendRenewalLink: (staffId) => fetchApi(`/staff/${staffId}/renewal-link`, { method: 'POST' }),
  /** Syncs public.profiles.shifter_enabled in Supabase (matched by staff email). */
  setShifterEnabled: (id, shifter_enabled) =>
    fetchApi('/staff/set-shifter-enabled', { method: 'POST', body: JSON.stringify({ staff_id: id, shifter_enabled }) }),
  sendShifterInvites: (staff_ids) =>
    fetchApi('/staff/shifter-invites', { method: 'POST', body: JSON.stringify({ staff_ids }) })
};

export const shifts = {
  list: (params) => fetchApi(`/shifts?${new URLSearchParams(params || {}).toString()}`),
  listByRecurringGroup: (groupId) => fetchApi(`/shifts?recurring_group_id=${encodeURIComponent(groupId)}`),
  get: (id) => fetchApi(`/shifts/${id}`),
  create: (data) => fetchApi('/shifts', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchApi(`/shifts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchApi(`/shifts/${id}`, { method: 'DELETE' }),
  lineItems: {
    list: (shiftId) => fetchApi(`/shifts/${shiftId}/line-items`),
    add: (shiftId, data) => fetchApi(`/shifts/${shiftId}/line-items`, { method: 'POST', body: JSON.stringify(data) }),
    update: (shiftId, lineItemId, data) => fetchApi(`/shifts/${shiftId}/line-items/${lineItemId}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (shiftId, lineItemId) => fetchApi(`/shifts/${shiftId}/line-items/${lineItemId}`, { method: 'DELETE' })
  },
  icsUrl: (id) => `${API}/shifts/${id}/ics`,
  sendIcs: (id) => fetchApi(`/shifts/${id}/send-ics`, { method: 'POST' }),
  sendRoster: (start, end) => fetchApi('/shifts/send-roster', { method: 'POST', body: JSON.stringify({ start, end }) }),
  receipts: (id) => fetchApi(`/shifts/${id}/receipts`),
  refreshExpense: (id) => fetchApi(`/shifts/${id}/refresh-expense`),
  /** Get duplicate shift groups (optional staff_id to filter by staff). */
  duplicates: (params) => fetchApi(`/shifts/duplicates?${new URLSearchParams(params || {}).toString()}`)
};

export const ndis = {
  travelItems: (category) => fetchApi(`/ndis/travel-items${category ? `?category=${encodeURIComponent(category)}` : ''}`),
  list: (categoryOrParams, search) => {
    const params = typeof categoryOrParams === 'object' && categoryOrParams !== null
      ? categoryOrParams
      : { category: categoryOrParams || '', search: search || '' };
    if (params.line_item_ids && Array.isArray(params.line_item_ids)) {
      params.line_item_ids = params.line_item_ids.join(',');
    }
    return fetchApi(`/ndis?${new URLSearchParams(params).toString()}`);
  },
  supportCategories: () => fetchApi('/ndis/support-categories'),
  categories: () => fetchApi('/ndis/categories'),
  get: (id) => fetchApi(`/ndis/${id}`),
  create: (data) => fetchApi('/ndis', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchApi(`/ndis/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: async (id) => {
    const res = await fetch(`${API}/ndis/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text ? (JSON.parse(text).error || text) : res.statusText);
    }
    return null;
  },
  deleteSelected: async (ids) => {
    const res = await fetch(`${API}/ndis/delete-selected`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text ? (JSON.parse(text).error || text) : res.statusText);
    return text ? JSON.parse(text) : { deleted: 0 };
  },
  deleteAll: async () => {
    const res = await fetch(`${API}/ndis/bulk`, { method: 'DELETE', credentials: 'include' });
    const text = await res.text();
    if (!res.ok) {
      try {
        const err = JSON.parse(text);
        throw new Error(err.error || 'Delete failed');
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error(text || res.statusText || 'Delete failed');
        throw e;
      }
    }
    if (!text.trim()) return { deleted: 0 };
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Invalid response from server');
    }
  },
  importPreview: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/ndis/import-preview`, { method: 'POST', body: form, credentials: 'include' });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || res.statusText || 'Preview failed');
    }
    return text ? JSON.parse(text) : null;
  },
  importCsv: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/ndis/import`, { method: 'POST', body: form, credentials: 'include' });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || res.statusText || 'Import failed');
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Invalid response from server');
    }
  },
};

export const smartDefaults = {
  get: () => fetchApi('/smart-defaults'),
  shiftSuggestions: (participantId) => fetchApi(`/smart-defaults/shift-suggestions?${participantId ? `participant_id=${encodeURIComponent(participantId)}` : ''}`),
  budgetLineItems: (category) => fetchApi(`/smart-defaults/budget-line-items/${encodeURIComponent(category)}`)
};

export const learning = {
  shiftSuggestions: (params) => fetchApi(`/suggestions/shifts?${new URLSearchParams(params).toString()}`),
  anomalies: (shiftId) => fetchApi(`/suggestions/anomalies/${shiftId}`),
  submitFeedback: (data) => fetchApi('/feedback/suggestions', { method: 'POST', body: JSON.stringify(data) }),
  previewMapping: (data) => fetchApi('/imports/csv/preview-mapping', { method: 'POST', body: JSON.stringify(data) }),
  mappingFeedback: (data) => fetchApi('/imports/csv/mapping-feedback', { method: 'POST', body: JSON.stringify(data) }),
  getConfig: () => fetchApi('/learning/config'),
  updateConfig: (data) => fetchApi('/learning/config', { method: 'PUT', body: JSON.stringify(data) }),
  audit: (params) => fetchApi(`/learning/audit?${new URLSearchParams(params || {}).toString()}`),
  metrics: () => fetchApi('/learning/metrics')
};

export const billing = {
  draftBatch: (fromDate, toDate) => fetchApi(`/billing/draft-batch?from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`),
  createBatch: (data) => fetchApi('/billing/create-batch', { method: 'POST', body: JSON.stringify(data) }),
  list: () => fetchApi('/billing'),
  listBatches: () => fetchApi('/billing/batches'),
  sendBatch: (batchRef) =>
    fetchApi(`/billing/batches/${encodeURIComponent(batchRef)}/send`, { method: 'POST', body: JSON.stringify({}) }),
  recordBatchPayment: (batchRef, data) => fetchApi(`/billing/batches/${encodeURIComponent(batchRef)}/payments`, { method: 'POST', body: JSON.stringify(data) }),
  recordInvoicePayment: (invoiceId, data) =>
    fetchApi(`/billing/${encodeURIComponent(invoiceId)}/payments`, { method: 'POST', body: JSON.stringify(data) }),
  get: (id) => fetchApi(`/billing/${id}`),
  pdfUrl: (id) => `${API}/billing/${id}/pdf`,
  updateStatus: (id, status) => fetchApi(`/billing/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  delete: (id) => fetchApi(`/billing/${id}`, { method: 'DELETE' })
};

export const invoices = {
  list: (params) => fetchApi(`/invoices${params?.shift_id ? `?shift_id=${encodeURIComponent(params.shift_id)}` : ''}`),
  get: (id) => fetchApi(`/invoices/${id}`),
  pdfUrl: (id) => `${API}/invoices/${id}/pdf`,
  updateStatus: (id, status) => fetchApi(`/invoices/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  delete: (id) => fetchApi(`/invoices/${id}`, { method: 'DELETE' }),
  downloadNdiaManagedCsv: async () => {
    const res = await fetch(`${API}/invoices/ndia-managed-csv`, { credentials: 'include' });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ndia-managed-invoices.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
};

export const appShifts = {
  list: (params) => fetchApi(`/app-shifts?${new URLSearchParams(params || {}).toString()}`),
  update: (shiftId, data) => fetchApi(`/app-shifts/${encodeURIComponent(shiftId)}`, { method: 'PUT', body: JSON.stringify(data) }),
  resolve: (shiftId, data) => fetchApi(`/app-shifts/${encodeURIComponent(shiftId)}/resolve`, { method: 'POST', body: JSON.stringify(data) }),
  delete: (shiftId) => fetchApi(`/app-shifts/${encodeURIComponent(shiftId)}`, { method: 'DELETE' })
};

export const syncFromExcel = {
  run: () => fetchApi('/sync/from-excel', { method: 'POST' })
};

export const coordinatorCases = {
  list: (params) => fetchApi(`/coordinator-cases?${new URLSearchParams(params || {}).toString()}`),
  get: (id) => fetchApi(`/coordinator-cases/${id}`),
  suggestedTaskTitles: () => fetchApi('/coordinator-cases/suggested-task-titles'),
  create: (data) => fetchApi('/coordinator-cases', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchApi(`/coordinator-cases/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchApi(`/coordinator-cases/${id}`, { method: 'DELETE' }),
  addTask: (caseId, data) => fetchApi(`/coordinator-cases/${caseId}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (caseId, taskId, data) => fetchApi(`/coordinator-cases/${caseId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(data) }),
  completeTask: (caseId, taskId) => fetchApi(`/coordinator-cases/${caseId}/tasks/${taskId}/complete`, { method: 'PUT' }),
  deleteTask: (caseId, taskId) => fetchApi(`/coordinator-cases/${caseId}/tasks/${taskId}`, { method: 'DELETE' }),
  addBillableTask: (caseId, data) => fetchApi(`/coordinator-cases/${caseId}/billable-tasks`, { method: 'POST', body: JSON.stringify(data) })
};

export const coordinatorTasks = {
  list: (params) => fetchApi(`/coordinator-tasks?${new URLSearchParams(params || {}).toString()}`),
  get: (id) => fetchApi(`/coordinator-tasks/${id}`),
  create: (data) => fetchApi('/coordinator-tasks', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchApi(`/coordinator-tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchApi(`/coordinator-tasks/${id}`, { method: 'DELETE' }),
  taskTypes: () => fetchApi('/coordinator-tasks/task-types'),
  defaultLineItem: (participantId, activityDate) => fetchApi(`/coordinator-tasks/default-line-item?${new URLSearchParams({ participant_id: participantId, activity_date: activityDate || '' }).toString()}`),
  createInvoice: (data) => fetchApi('/coordinator-tasks/create-invoice', { method: 'POST', body: JSON.stringify(data) }),
  listInvoices: () => fetchApi('/coordinator-tasks/task-invoices'),
  getInvoice: (id) => fetchApi(`/coordinator-tasks/task-invoices/${id}`),
  invoicePdfUrl: (id) => `${API}/coordinator-tasks/task-invoices/${id}/pdf`,
  updateInvoiceStatus: (id, status) => fetchApi(`/coordinator-tasks/task-invoices/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })
};

export const onboarding = {
  initialize: (participantId, providerOrganisationId) => fetchApi(`/onboarding/participants/${participantId}/initialize`, {
    method: 'POST',
    body: JSON.stringify({ provider_organisation_id: providerOrganisationId || null })
  }),
  get: (participantId) => fetchApi(`/onboarding/participants/${participantId}`),
  status: (participantId) => fetchApi(`/onboarding/participants/${participantId}/status`),
  updateIntakeFields: (participantId, fields) => fetchApi(`/onboarding/participants/${participantId}/intake-fields`, {
    method: 'PUT',
    body: JSON.stringify({ fields })
  }),
  saveIntake: (participantId, data) => fetchApi(`/onboarding/participants/${participantId}/intake-save`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  generateFormPack: (participantId) => fetchApi(`/onboarding/participants/${participantId}/generate-form-pack`, {
    method: 'POST'
  }),
  sendSignatures: (participantId) => fetchApi(`/onboarding/participants/${participantId}/send-signatures`, {
    method: 'POST'
  }),
  sendFormForSignature: (participantId, formInstanceId) => fetchApi(`/onboarding/participants/${participantId}/send-form/${formInstanceId}`, {
    method: 'POST'
  }),
  regenerate: (participantId) => fetchApi(`/onboarding/participants/${participantId}/regenerate`, {
    method: 'POST'
  }),
  signedArtifacts: (participantId) => fetchApi(`/onboarding/participants/${participantId}/signed-artifacts`),
  prefillSnapshot: (participantId, formId) => fetchApi(`/onboarding/participants/${participantId}/forms/${formId}/prefill-snapshot`),
  getFormDocumentUrl: (participantId, formId) => `${window.location.origin}${API}/onboarding/participants/${participantId}/forms/${formId}/document`,
  getFormDocumentBlob: async (participantId, formId) => {
    const res = await fetch(`${API}/onboarding/participants/${participantId}/forms/${formId}/document`, { credentials: 'include' });
    if (!res.ok) {
      const err = await res.text();
      let msg = 'Failed to load document';
      try {
        const j = JSON.parse(err);
        if (j.error) msg = j.error;
      } catch {
        if (err) msg = err;
      }
      throw new Error(msg);
    }
    return res.blob();
  },
  uploadFormDocument: async (participantId, formId, file) => {
    const form = new FormData();
    form.append('document', file);
    const res = await fetch(`${API}/onboarding/participants/${participantId}/forms/${formId}/document`, {
      method: 'PUT',
      body: form,
      credentials: 'include'
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text ? (() => { try { return JSON.parse(text); } catch { return null; } })()?.error || text : 'Upload failed');
    return text ? JSON.parse(text) : null;
  },
  deleteForm: (participantId, formInstanceId) => fetchApi(`/onboarding/participants/${participantId}/forms/${formInstanceId}`, { method: 'DELETE' }),
  evidenceBundle: (participantId) => fetchApi(`/onboarding/participants/${participantId}/evidence-bundle`),
  runRenewals: (participantId) => fetchApi(`/onboarding/participants/${participantId}/renewals/run`, {
    method: 'POST'
  }),
  providerCompliance: (organisationId) => fetchApi(`/onboarding/providers/${organisationId}/compliance`),
  providerSettings: (organisationId, data) => fetchApi(`/onboarding/providers/${organisationId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(data || {})
  }),
  providerTemplates: (organisationId) => fetchApi(`/onboarding/providers/${organisationId}/templates`)
};

export const forms = {
  context: () => fetchApi('/forms/context'),
  templates: (workflow) => fetchApi(`/forms/templates${workflow ? `?workflow=${encodeURIComponent(workflow)}` : ''}`),
  createTemplate: (data) => fetchApi('/forms/templates', { method: 'POST', body: JSON.stringify(data) }),
  updateTemplate: (id, data) => fetchApi(`/forms/templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  uploadTemplate: async (formTypeOrTemplateId, file, options = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (options.templateId) {
      form.append('template_id', options.templateId);
    } else {
      form.append('form_type', formTypeOrTemplateId);
    }
    const res = await fetch(`${API}/forms/templates/upload`, {
      method: 'POST',
      credentials: 'include',
      body: form
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Upload failed');
    }
    return text ? JSON.parse(text) : null;
  },
  policyFilesList: () => fetchApi('/forms/policy-files'),
  policyFilesUpload: async (file, displayName) => {
    const form = new FormData();
    form.append('file', file);
    if (displayName) form.append('display_name', displayName);
    const res = await fetch(`${API}/forms/policy-files`, { method: 'POST', credentials: 'include', body: form });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Upload failed');
    }
    return text ? JSON.parse(text) : null;
  },
  policyFilesDelete: (id) => fetchApi(`/forms/policy-files/${id}`, { method: 'DELETE' })
};
