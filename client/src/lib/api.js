import { getSupabaseBrowserClient } from './supabaseClient';

const API = '/api';

export const settings = {
  getBusiness: () => fetchApi('/settings/business'),
  updateBusiness: (data) => fetchApi('/settings/business', { method: 'PUT', body: JSON.stringify(data) }),
  getOrgTimezone: () => fetchApi('/settings/org-timezone'),
  /** Requires server env XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI */
  xeroConnect: () => fetchApi('/settings/xero/connect', { method: 'POST' }),
  xeroDisconnect: () => fetchApi('/settings/xero/disconnect', { method: 'POST' }),
  xeroTestInvoice: () => fetchApi('/settings/xero/test-invoice', { method: 'POST' }),
  dropboxSignConnect: () => fetchApi('/settings/dropbox-sign/connect', { method: 'POST' }),
  dropboxSignDisconnect: () => fetchApi('/settings/dropbox-sign/disconnect', { method: 'POST' }),
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

export const registers = {
  snapshot: () => fetchApi('/registers/snapshot')
};

export const admin = {
  coordinatorActivity: (params) => fetchApi(`/admin/coordinator-activity?${new URLSearchParams(params || {}).toString()}`),
  billableSummary: (params) => fetchApi(`/admin/billable-summary?${new URLSearchParams(params || {}).toString()}`),
  financialOverview: (params) => fetchApi(`/admin/financial-overview?${new URLSearchParams(params || {}).toString()}`),
  paySummary: () => fetchApi('/admin/pay-summary'),
  refreshRegisters: () => fetchApi('/integrations/microsoft-drive/refresh-registers', { method: 'POST' }),
  /** Multipart: file, optional default_participant_id, optional dry_run=1 (preview only). */
  importCaseNotesCsv: async (formData) => {
    const res = await fetch(`${API}/admin/case-notes-import`, {
      method: 'POST',
      credentials: 'include',
      body: formData
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || res.statusText);
    }
    return text ? JSON.parse(text) : null;
  }
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

/** Per-org Microsoft OneDrive document archive (admin OAuth). */
export const microsoftDrive = {
  status: () => fetchApi('/integrations/microsoft-drive/status'),
  disconnect: () => fetchApi('/integrations/microsoft-drive/disconnect', { method: 'POST' }),
  register: (params) =>
    fetchApi(`/integrations/microsoft-drive/register${params ? `?${new URLSearchParams(params)}` : ''}`),
  refreshRegisters: () => fetchApi('/integrations/microsoft-drive/refresh-registers', { method: 'POST' })
};

export const companyDocuments = {
  list: () => fetchApi('/company-documents'),
  updateSettings: (data) =>
    fetchApi('/company-documents/settings', { method: 'PATCH', body: JSON.stringify(data || {}) }),
  bulkUpload: async (files, options = {}) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    if (options.sync_to_onboarding != null) {
      form.append('sync_to_onboarding', String(options.sync_to_onboarding));
    }
    if (options.category) form.append('category', options.category);
    const res = await fetch(`${API}/company-documents/bulk-upload`, {
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
  bulkUploadZip: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/company-documents/bulk-upload-zip`, {
      method: 'POST',
      credentials: 'include',
      body: form
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'ZIP upload failed');
    }
    return text ? JSON.parse(text) : null;
  },
  update: (id, data) =>
    fetchApi(`/company-documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data || {}) }),
  delete: (id) => fetchApi(`/company-documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  fileUrl: (id) => `${API}/company-documents/${encodeURIComponent(id)}/file`,
  mirrorLibrary: () => fetchApi('/company-documents/mirror-library', { method: 'POST' }),
  syncOnboarding: () => fetchApi('/company-documents/sync-onboarding', { method: 'POST' }),
  bootstrap: () => fetchApi('/company-documents/bootstrap', { method: 'POST' }),
  updateOnedriveImportSettings: (data) =>
    fetchApi('/company-documents/onedrive-import/settings', { method: 'PATCH', body: JSON.stringify(data || {}) }),
  syncFromOnedrive: (data) =>
    fetchApi('/company-documents/onedrive-import/sync', { method: 'POST', body: JSON.stringify(data || {}) })
};

/** Org catalogue of activity (health & safety) risk assessment blank PDFs. */
export const activityRiskAssessments = {
  list: () => fetchApi('/activity-risk-assessments'),
  create: (activity_name) =>
    fetchApi('/activity-risk-assessments', { method: 'POST', body: JSON.stringify({ activity_name }) }),
  delete: (id) => fetchApi(`/activity-risk-assessments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  fileUrl: (id) => `${API}/activity-risk-assessments/${encodeURIComponent(id)}/file`,
  assignToParticipant: (templateId, participantId) =>
    fetchApi(`/activity-risk-assessments/${encodeURIComponent(templateId)}/assign`, {
      method: 'POST',
      body: JSON.stringify({ participant_id: participantId })
    })
};

export const auth = {
  me: () => fetchApi('/auth/me'),
  setActiveProduct: (active_product) =>
    fetchApi('/auth/active-product', { method: 'POST', body: JSON.stringify({ active_product }) }),
  login: (email, password) => fetchApi('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  registrationInfo: () => fetchApi('/auth/registration-info'),
  /** Local sign-up: `organization_name` is required (creates org for first user, or joins existing tenant by name). */
  register: (email, password, name, organization_name, products) =>
    fetchApi('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        name,
        organization_name: organization_name || undefined,
        ...(products && typeof products === 'object'
          ? {
              coordination_enabled: products.coordination_enabled,
              agency_enabled: products.agency_enabled
            }
          : {})
      })
    }),
  logout: () => fetchApi('/auth/logout', { method: 'POST' }),
  updateSettings: (data) => fetchApi('/auth/settings', { method: 'PUT', body: JSON.stringify(data) }),
  changePassword: (currentPassword, newPassword) => fetchApi('/auth/password', { method: 'PUT', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),
  testEmail: () => fetchApi('/auth/test-email', { method: 'POST' }),
  disconnectEmail: () => fetchApi('/email/oauth/disconnect', { method: 'POST' }),
  supabasePublicConfig: () =>
    fetch(`${API}/auth/supabase/public-config`, { credentials: 'include' }).then((r) => r.json()),
  supabaseSession: (access_token) =>
    fetchApi('/auth/supabase/session', { method: 'POST', body: JSON.stringify({ access_token }) }),
  supabaseRegisterOrg: (access_token, organization_name, products) =>
    fetchApi('/auth/supabase/register-org', {
      method: 'POST',
      body: JSON.stringify({
        access_token,
        organization_name,
        ...(products && typeof products === 'object'
          ? {
              coordination_enabled: products.coordination_enabled,
              agency_enabled: products.agency_enabled
            }
          : {})
      })
    }),
  supabaseInviteStaff: (email, full_name) =>
    fetchApi('/auth/supabase/invite-staff', { method: 'POST', body: JSON.stringify({ email, full_name: full_name || undefined }) }),
  getShifterOrgLink: () => fetchApi('/auth/supabase/shifter-org-link'),
  /**
   * Link Nexus org to Shifter. Pass nothing to match by Nexus organisation name, a string for Shifter name only,
   * or { shifter_org_name?, shifter_organization_id? } (UUID from Shifter Supabase → organizations.id).
   */
  linkShifterOrg: (arg) => {
    const body = {};
    if (arg != null && typeof arg === 'object' && !Array.isArray(arg)) {
      const name = String(arg.shifter_org_name ?? '').trim();
      const sid = String(arg.shifter_organization_id ?? '').trim();
      if (sid) body.shifter_organization_id = sid;
      if (name) body.shifter_org_name = name;
    } else if (arg != null && String(arg).trim()) {
      body.shifter_org_name = String(arg).trim();
    }
    return fetchApi('/auth/supabase/link-shifter-org', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },
  unlinkShifterOrg: () => fetchApi('/auth/supabase/unlink-shifter-org', { method: 'POST' })
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
  const runRequest = () => fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  let res = await runRequest();
  const isAuthPath = path.includes('/auth/');
  if (res.status === 401 && !isAuthPath) {
    const restored = await tryRestoreExpressSessionFromSupabase();
    if (restored) res = await runRequest();
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && !isAuthPath) {
      // Avoid hard reload loops (flash-then-disappear). Let AuthProvider/ProtectedRoute
      // handle redirect by clearing user state.
      try {
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('nexus:auth-required', { detail: { path } }));
        }
      } catch {
        // ignore
      }
    }
    const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    const msg = err?.error || text || res.statusText;
    const extra = err?.errorDetail || err?.detail;
    const msgStr = String(msg);
    const extraStr = extra != null ? String(extra) : '';
    const detail =
      extraStr && extraStr.trim() !== msgStr.trim() ? `\n\n${extraStr}` : '';
    const e = new Error(msgStr + detail);
    if (err?.code) e.code = err.code;
    if (err && typeof err === 'object') e.apiPayload = err;
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
  list: (search, includeArchived, includeOrgOrphans) => {
    const q = new URLSearchParams();
    if (search) q.set('search', search);
    if (includeArchived) q.set('include_archived', 'true');
    if (includeOrgOrphans) q.set('include_org_orphans', 'true');
    const qs = q.toString();
    return fetchApi(`/participants${qs ? `?${qs}` : ''}`);
  },
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
  parsePlan: async (id, file, useAi = true, ocrFirst = false) => {
    const form = new FormData();
    form.append('file', file);
    form.append('useAi', useAi ? 'true' : 'false');
    if (ocrFirst) form.append('ocrFirst', 'true');
    const res = await fetch(`${API}/participants/${id}/parse-plan`, { method: 'POST', body: form, credentials: 'include' });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Parse failed');
    }
    return text ? JSON.parse(text) : null;
  },
  parsePlanManagerStatement: async (participantId, planId, file, useAi = true, apply = false, ocrFirst = false) => {
    const form = new FormData();
    form.append('file', file);
    form.append('useAi', useAi ? 'true' : 'false');
    form.append('apply', apply ? 'true' : 'false');
    if (ocrFirst) form.append('ocrFirst', 'true');
    const res = await postMultipartWithSessionRetry(`/participants/${participantId}/plans/${planId}/parse-plan-manager-statement`, form);
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
  peekCsvHeaders: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await postMultipartWithSessionRetry('/participants/peek-csv-headers', form);
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Peek failed');
    }
    return text ? JSON.parse(text) : { headers: [] };
  },
  parseCsv: async (file, useLlm = false, options = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (useLlm) form.append('useLlm', 'true');
    if (useLlm && options.llmColumnMapping && typeof options.llmColumnMapping === 'object') {
      form.append('llm_column_mapping_json', JSON.stringify(options.llmColumnMapping));
    }
    const res = await postMultipartWithSessionRetry('/participants/parse-csv', form);
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Parse failed');
    }
    return text ? JSON.parse(text) : null;
  },
  importCsv: async (file, useLlm = false, opts = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (useLlm) form.append('useLlm', 'true');
    if (useLlm && opts.llmColumnMapping && typeof opts.llmColumnMapping === 'object') {
      form.append('llm_column_mapping_json', JSON.stringify(opts.llmColumnMapping));
    }
    if (opts.reassignDuplicatesToMyOrg) form.append('reassignDuplicatesToMyOrg', 'true');
    const res = await postMultipartWithSessionRetry('/participants/import-csv', form);
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Import failed');
    }
    return text ? JSON.parse(text) : null;
  },
  listServiceAgreements: (participantId) => fetchApi(`/participants/${participantId}/service-agreements`),
  preflightServiceAgreement: (participantId, body) =>
    fetchApi(`/participants/${participantId}/service-agreements/preflight`, {
      method: 'POST',
      body: JSON.stringify(body || {})
    }),
  generateServiceAgreement: (participantId, body) =>
    fetchApi(`/participants/${participantId}/service-agreements/generate`, {
      method: 'POST',
      body: JSON.stringify(body || {})
    })
};

export const formTemplates = {
  masters: () => fetchApi('/form-templates/masters'),
  master: (id) => fetchApi(`/form-templates/masters/${id}`),
  instances: () => fetchApi('/form-templates/instances'),
  cloneInstance: (data) => fetchApi('/form-templates/instances', { method: 'POST', body: JSON.stringify(data || {}) }),
  updateInstance: (id, data) => fetchApi(`/form-templates/instances/${id}`, { method: 'PATCH', body: JSON.stringify(data || {}) }),
  previewModel: (id) => fetchApi(`/form-templates/instances/${id}/preview-model`),
  uploadInstanceLogo: async (instanceId, file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/form-templates/instances/${instanceId}/logo`, {
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
  generatedPdfUrl: (documentId) => `${API}/generated-forms/${documentId}/pdf`,
  instanceLogoUrl: (instanceId) => `${API}/form-templates/instances/${encodeURIComponent(instanceId)}/logo`,
  previewPdfUrl: (instanceId) => `${API}/form-templates/instances/${encodeURIComponent(instanceId)}/preview.pdf`
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
  allContacts: (search) => fetchApi(`/organisations/contacts/all?${search ? `search=${encodeURIComponent(search)}` : ''}`),

  // Phase 1: org profile + branding pipeline
  getMyProfile: () => fetchApi('/organisations/me/profile'),
  updateMyProfile: (data) => fetchApi('/organisations/me/profile', { method: 'PUT', body: JSON.stringify(data) }),
  uploadMyLogo: async (file) => {
    const fd = new FormData();
    fd.append('logo', file);
    const res = await fetch(`${API}/organisations/me/logo`, {
      method: 'POST',
      credentials: 'include',
      body: fd
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || res.statusText);
    }
    return text ? JSON.parse(text) : {};
  },
  seedTemplates: () => fetchApi('/organisations/me/seed-templates', { method: 'POST' })
};

export const compliance = {
  practiceStandards: () => fetchApi('/compliance/practice-standards'),
  updateStandard: (id, body) => fetchApi(`/compliance/practice-standards/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body || {})
  })
};

export const bulkOps = {
  onboarding: ({ participant_ids = [], staff_ids = [] } = {}) =>
    fetchApi('/admin/bulk-onboarding', {
      method: 'POST',
      body: JSON.stringify({ participant_ids, staff_ids })
    })
};

export const automation = {
  tick: (orgId) => fetchApi('/automation/tick', { method: 'POST', body: JSON.stringify({ organisation_id: orgId || null }) }),
  dailyDigest: () => fetchApi('/automation/daily-digest')
};

export const intakePublic = {
  load: async (token) => {
    const res = await fetch(`${API}/intake/${encodeURIComponent(token)}`);
    const text = await res.text();
    if (!res.ok) {
      let err = null;
      try { err = JSON.parse(text); } catch { /* ignore */ }
      const e = new Error(err?.error || text || res.statusText);
      e.code = err?.code || 'INTAKE_ERROR';
      throw e;
    }
    return text ? JSON.parse(text) : {};
  },
  save: async (token, fields) => {
    const res = await fetch(`${API}/intake/${encodeURIComponent(token)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    return res.json();
  },
  submit: async (token, fields = {}) => {
    const res = await fetch(`${API}/intake/${encodeURIComponent(token)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    return res.json();
  }
};

export const documentLibrary = {
  listMasters: () => fetchApi('/document-library/masters'),
  sync: () => fetchApi('/document-library/sync', { method: 'POST' }),
  cloneAllToOrg: () => fetchApi('/document-library/clone-all-to-org', { method: 'POST' }),
  cloneMaster: (masterId) => fetchApi(`/document-library/masters/${masterId}/clone-to-org`, { method: 'POST' }),
  // Returns a URL safe to embed in <iframe src="…">.
  previewMasterUrl: (masterId, { participantId, staffId } = {}) => {
    const qs = new URLSearchParams();
    if (participantId) qs.set('participant_id', participantId);
    if (staffId) qs.set('staff_id', staffId);
    const q = qs.toString();
    return `${API}/document-library/masters/${encodeURIComponent(masterId)}/preview${q ? `?${q}` : ''}`;
  },
  renderMaster: (masterId, body = {}) => fetchApi(`/document-library/masters/${masterId}/render`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
};

export const staff = {
  /** @param {boolean} [includeArchived] @param {boolean} [allOrgs] Super admin: set true for every tenant (same DB). */
  list: (includeArchived, allOrgs) => {
    const p = new URLSearchParams();
    if (includeArchived) p.set('include_archived', 'true');
    if (allOrgs) p.set('all_orgs', 'true');
    const q = p.toString();
    return fetchApi(`/staff${q ? `?${q}` : ''}`);
  },
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
  startOnboarding: (staffId, body) => fetchApi(`/staff/${staffId}/start-onboarding`, { method: 'POST', body: JSON.stringify(body || {}) }),
  // Phase 3: one-click staff onboarding orchestrator (readiness + library clone + ensure row).
  onboardingRun: (staffId, providerOrganisationId) => fetchApi(`/staff/${staffId}/onboarding/run`, {
    method: 'POST',
    body: JSON.stringify({ provider_organisation_id: providerOrganisationId || null })
  }),
  onboardingRunStatus: (staffId) => fetchApi(`/staff/${staffId}/onboarding/status`),
  getIntakeForm: (staffId) => fetchApi(`/staff/${staffId}/intake-form`),
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
  importCsv: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/staff/import-csv`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Import failed');
    }
    return text ? JSON.parse(text) : null;
  },
  sendShifterInvites: (staff_ids) =>
    fetchApi('/staff/shifter-invites', { method: 'POST', body: JSON.stringify({ staff_ids }) }),
  /** Browser-only: downloads prefilled employment contract (PDF; from fillable PDF template or Word path + conversion when applicable). */
  downloadEmploymentContract: async (staffId) => {
    const res = await fetch(`${API}/staff/${staffId}/employment-contract`, { credentials: 'include' });
    if (!res.ok) {
      const text = await res.text();
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || res.statusText);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition');
    let filename = 'employment-contract.pdf';
    const m = cd && /filename="([^"]+)"/i.exec(cd);
    if (m) filename = m[1];
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
};

export const shifts = {
  list: (params) => fetchApi(`/shifts?${new URLSearchParams(params || {}).toString()}`),
  listByRecurringGroup: (groupId) => fetchApi(`/shifts?recurring_group_id=${encodeURIComponent(groupId)}`),
  get: (id) => fetchApi(`/shifts/${id}`),
  create: (data) => fetchApi('/shifts', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchApi(`/shifts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchApi(`/shifts/${id}`, { method: 'DELETE' }),
  hardDelete: (id) =>
    fetchApi(`/shifts/${encodeURIComponent(id)}/hard-delete`, {
      method: 'POST',
      body: JSON.stringify({ confirm: 'DELETE' })
    }),
  /** Block external shiftId from re-import (admin/delegate). */
  suppressShifterId: (shifterShiftId, nexusOrgId) =>
    fetchApi('/shifts/suppress-shifter-id', {
      method: 'POST',
      body: JSON.stringify({ shifter_shift_id: shifterShiftId, nexus_org_id: nexusOrgId || undefined })
    }),
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
  availabilityPreview: (data) =>
    fetchApi('/suggestions/availability-preview', { method: 'POST', body: JSON.stringify(data) }),
  submitFeedback: (data) => fetchApi('/feedback/suggestions', { method: 'POST', body: JSON.stringify(data) }),
  previewMapping: (data) => fetchApi('/imports/csv/preview-mapping', { method: 'POST', body: JSON.stringify(data) }),
  mappingFeedback: (data) => fetchApi('/imports/csv/mapping-feedback', { method: 'POST', body: JSON.stringify(data) }),
  getConfig: () => fetchApi('/learning/config'),
  updateConfig: (data) => fetchApi('/learning/config', { method: 'PUT', body: JSON.stringify(data) }),
  audit: (params) => fetchApi(`/learning/audit?${new URLSearchParams(params || {}).toString()}`),
  metrics: () => fetchApi('/learning/metrics')
};

export const reports = {
  staffAvailability: (start, end) =>
    fetchApi(`/reports/staff-availability?${new URLSearchParams({ start, end }).toString()}`)
};

export const billing = {
  draftBatch: (fromDate, toDate) => fetchApi(`/billing/draft-batch?from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`),
  adjustDraftTaskRate: (selectionId, unitPrice) =>
    fetchApi('/billing/adjust-draft-task-rate', {
      method: 'POST',
      body: JSON.stringify({ selection_id: selectionId, unit_price: unitPrice })
    }),
  createBatch: (data) => fetchApi('/billing/create-batch', { method: 'POST', body: JSON.stringify(data) }),
  list: () => fetchApi('/billing'),
  listBatches: () => fetchApi('/billing/batches'),
  sendBatch: (batchRef) =>
    fetchApi(`/billing/batches/${encodeURIComponent(batchRef)}/send`, { method: 'POST', body: JSON.stringify({}) }),
  recordBatchPayment: (batchRef, data) => fetchApi(`/billing/batches/${encodeURIComponent(batchRef)}/payments`, { method: 'POST', body: JSON.stringify(data) }),
  recordInvoicePayment: (invoiceId, data) =>
    fetchApi(`/billing/${encodeURIComponent(invoiceId)}/payments`, { method: 'POST', body: JSON.stringify(data) }),
  syncFromXero: (invoiceId) =>
    fetchApi(`/billing/${encodeURIComponent(invoiceId)}/sync-from-xero`, { method: 'POST', body: JSON.stringify({}) }),
  get: (id) => fetchApi(`/billing/${id}`),
  pdfUrl: (id) => `${API}/billing/${id}/pdf`,
  updateStatus: (id, status) => fetchApi(`/billing/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  rebuildLines: (id) => fetchApi(`/billing/${encodeURIComponent(id)}/rebuild-lines`, { method: 'POST', body: JSON.stringify({}) }),
  voidInvoice: (id, reason) =>
    fetchApi(`/billing/${encodeURIComponent(id)}/void`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {})
    }),
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

/** Pull shifts from Shifter Supabase (same org as your Nexus login). Requires SHIFTER_* on server. */
export const syncFromShifter = {
  run: () => fetchApi('/sync/from-shifter', { method: 'POST' })
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
  // Phase 2: one-click orchestrator (initialize + library clone + generate form pack).
  run: (participantId, providerOrganisationId) => fetchApi(`/onboarding/participants/${participantId}/onboarding/run`, {
    method: 'POST',
    body: JSON.stringify({ provider_organisation_id: providerOrganisationId || null })
  }),
  runStatus: (participantId) => fetchApi(`/onboarding/participants/${participantId}/onboarding/status`),
  // Phase 4: self-service intake tokens.
  issueIntakeToken: (participantId, body) => fetchApi(`/onboarding/participants/${participantId}/intake-token`, {
    method: 'POST',
    body: JSON.stringify(body || {})
  }),
  getIntakeToken: (participantId) => fetchApi(`/onboarding/participants/${participantId}/intake-token`),
  sendOnboardingPack: (participantId, body) =>
    fetchApi(`/onboarding/participants/${participantId}/send-onboarding-pack`, { method: 'POST', body: JSON.stringify(body || {}) }),
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
  getProviderSettings: (organisationId) => fetchApi(`/onboarding/providers/${organisationId}/settings`),
  providerSettings: (organisationId, data) => fetchApi(`/onboarding/providers/${organisationId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(data || {})
  }),
  providerTemplates: (organisationId) => fetchApi(`/onboarding/providers/${organisationId}/templates`)
};

export const forms = {
  context: () => fetchApi('/forms/context'),
  catalog: () => fetchApi('/forms/catalog'),
  /** Turn a catalog sample path into a browser URL (catalog paths already include /api/...). */
  sampleUrl: (relativePath) => {
    const p = String(relativePath || '').trim();
    if (!p) return API;
    if (p.startsWith('/api/') || p === '/api') return p;
    if (p.startsWith('api/')) return `/${p}`;
    return `${API}${p.startsWith('/') ? p : `/${p}`}`;
  },
  coreSamplePdfUrl: (formType, templateId) =>
    `${API}/forms/core-samples/${encodeURIComponent(formType)}.pdf${
      templateId ? `?template_id=${encodeURIComponent(templateId)}` : ''
    }`,
  templates: (workflow) => fetchApi(`/forms/templates${workflow ? `?workflow=${encodeURIComponent(workflow)}` : ''}`),
  createTemplate: (data) => fetchApi('/forms/templates', { method: 'POST', body: JSON.stringify(data) }),
  updateTemplate: (id, data) => fetchApi(`/forms/templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTemplate: (id) => fetchApi(`/forms/templates/${id}`, { method: 'DELETE' }),
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
  contractUploadAnalyze: async (templateId, file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/forms/templates/${templateId}/contract-upload-analyze`, {
      method: 'POST',
      credentials: 'include',
      body: form
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Analyze failed');
    }
    return text ? JSON.parse(text) : null;
  },
  /** Text/field extraction only (no save). Use with local Ollama to infer fields from document wording. */
  contractAnalyzePreview: async (templateId, file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/forms/templates/${templateId}/contract-analyze-preview`, {
      method: 'POST',
      credentials: 'include',
      body: form
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'Preview extract failed');
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
  policyFilesDelete: (id) => fetchApi(`/forms/policy-files/${id}`, { method: 'DELETE' }),
  onboardingDocumentPacks: () => fetchApi('/forms/onboarding-document-packs'),
  createOnboardingDocumentPack: (data) => fetchApi('/forms/onboarding-document-packs', { method: 'POST', body: JSON.stringify(data || {}) }),
  updateOnboardingDocumentPack: (packId, data) =>
    fetchApi(`/forms/onboarding-document-packs/${packId}`, { method: 'PATCH', body: JSON.stringify(data || {}) }),
  deleteOnboardingDocumentPack: (packId) => fetchApi(`/forms/onboarding-document-packs/${packId}`, { method: 'DELETE' }),
  setOnboardingDocumentPackItems: (packId, data) =>
    fetchApi(`/forms/onboarding-document-packs/${packId}/items`, { method: 'PUT', body: JSON.stringify(data || {}) }),
  patchOnboardingDocumentPackDefaults: (data) =>
    fetchApi('/forms/onboarding-document-packs-defaults', { method: 'PATCH', body: JSON.stringify(data || {}) }),
  templateDocumentUrl: (templateId) =>
    `${API}/forms/templates/${encodeURIComponent(templateId)}/document`,
  signerPreviewPdfUrl: (templateId) =>
    `${API}/forms/templates/${encodeURIComponent(templateId)}/signer-preview.pdf`,
  /** @deprecated Use signerPreviewPdfUrl */
  recipientPreviewPdfUrl: (templateId) =>
    `${API}/forms/templates/${encodeURIComponent(templateId)}/signer-preview.pdf`,
  /** @deprecated Use signerPreviewPdfUrl */
  templateOrgPreviewUrl: (templateId) =>
    `${API}/forms/templates/${encodeURIComponent(templateId)}/signer-preview.pdf`,
  mergePreviewRows: (templateId) => fetchApi(`/forms/templates/${encodeURIComponent(templateId)}/merge-preview-rows`),
  getSigningLayout: (templateId) => fetchApi(`/forms/templates/${encodeURIComponent(templateId)}/signing-layout`),
  saveSigningLayout: (templateId, signingLayout) =>
    fetchApi(`/forms/templates/${encodeURIComponent(templateId)}/signing-layout`, {
      method: 'PUT',
      body: JSON.stringify({ signing_layout: signingLayout })
    }),
  bulkUploadTemplates: async (files, options = {}) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    if (options.workflow) form.append('workflow', options.workflow);
    const res = await fetch(`${API}/forms/templates/bulk-upload`, {
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
  bulkUploadTemplatesZip: async (file, options = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (options.workflow) form.append('workflow', options.workflow);
    const res = await fetch(`${API}/forms/templates/bulk-upload-zip`, {
      method: 'POST',
      credentials: 'include',
      body: form
    });
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
      throw new Error(err?.error || text || 'ZIP upload failed');
    }
    return text ? JSON.parse(text) : null;
  }
};
