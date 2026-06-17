import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { backToPreviousListPath, participantProfileBackLabel } from '../lib/listViewUrl.js';
import { useProductPathPrefix } from '../lib/useProductPathPrefix.js';
import { PRODUCT_AGENCY } from '@nexus-shared/tenantProduct.js';
import { participants, organisations, ndis, smartDefaults, onboarding, formTemplates } from '../lib/api';
import { NEXUS_CORE_SIGN_COMING_SOON_TITLE, useDropboxSignEnabled } from '../lib/featureFlags.js';
import CopyableField from '../components/CopyableField';
import ActivityRiskAssessmentAssign from '../components/ActivityRiskAssessmentAssign';
import AddressAutocomplete from '../components/AddressAutocomplete';
import { formatDate, toInputDate } from '../lib/dateUtils';
import { normalizeFundReleaseSchedule, splitAnnualAmount, splitAnnualHours } from '../lib/fundReleaseSchedule.js';

const FREQUENCY_TO_PERIODS = {
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
  random: 1,
  annual: 1
};

const ALLOC_FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'random', 'annual'];

// Preferred estimate rates (weekday daytime / typical professional rates) used for budget-hour estimates.
const CATEGORY_PREFERRED_ESTIMATE_RATES = {
  '01': 70.23,
  '02': 58.03,
  '03': 59.06,
  '04': 70.23,
  '05': 193.99,
  '07': 193.99,
  '08': 70.23,
  '09': 70.23,
  '10': 70.23,
  '11': 193.99,
  '12': 193.99,
  '13': 193.99,
  '14': 193.99,
  '15': 193.99
};

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

const ALLOCATION_SERVICE_PRESETS = [
  'Support work',
  'Occupational therapy',
  'Psychology',
  'Physiotherapy',
  'Speech therapy',
  'Support coordination'
];

/* Teal / sage palette for budget colour-coding */
const BUDGET_COLORWAYS = [
  { cardBg: '#f0f7f7', headerBg: '#d4eae8', border: '#4a9b8e', text: '#1a3d38', muted: '#5a7a76' },
  { cardBg: '#f2f6f2', headerBg: '#e0e8e0', border: '#7a8b7a', text: '#2d3d2d', muted: '#5a6a5a' },
  { cardBg: '#eefaf5', headerBg: '#c8e6dc', border: '#5aab9a', text: '#1a3d35', muted: '#4a7a70' },
  { cardBg: '#f4f6f4', headerBg: '#d4e0d4', border: '#8a9a8a', text: '#2a3a2a', muted: '#5a6a5a' },
  { cardBg: '#e8f5f2', headerBg: '#b8d8d0', border: '#3d8a7c', text: '#15302a', muted: '#4a7068' },
  { cardBg: '#f0f4f0', headerBg: '#d8e4d8', border: '#6a7a6a', text: '#253525', muted: '#556555' },
  { cardBg: '#ecf5f3', headerBg: '#c0e0d8', border: '#5a9a8e', text: '#1a3530', muted: '#4a7068' },
  { cardBg: '#f0f2f0', headerBg: '#dce4dc', border: '#7a8b7a', text: '#2d3d2d', muted: '#5a6a5a' }
];

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

/** Normalise DB/API value to a list of valid emails (same idea as server batch send). */
function parseInvoiceEmailsField(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((e) => String(e).trim()).filter((e) => e.includes('@'));
  }
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) {
        return p.map((e) => String(e).trim()).filter((e) => e.includes('@'));
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

/**
 * Mirrors server `resolveInvoiceEmailsForXero`: explicit list, else plan manager org email, else participant email.
 */
function resolveInvoiceRecipientsForDisplay(p) {
  const explicit = parseInvoiceEmailsField(p?.invoice_emails);
  if (explicit.length > 0) {
    return { kind: 'explicit', emails: explicit, note: null };
  }
  const mt = String(p?.management_type || 'self').toLowerCase();
  const pm = String(p?.plan_manager_email || '').trim();
  if (mt === 'plan' && pm.includes('@')) {
    return { kind: 'fallback', emails: [pm], note: 'from plan manager organisation' };
  }
  const pe = String(p?.email || '').trim();
  if (mt === 'self' && pe.includes('@')) {
    return { kind: 'fallback', emails: [pe], note: 'from participant contact email' };
  }
  return { kind: 'none', emails: [], note: null };
}

/** Link from budget utilisation “Invoiced” amounts to Financial → Invoices for this participant (paid / outstanding). */
function ParticipantInvoicedFinancialLink({ participantId, participantName, amount, children }) {
  const pathPrefix = useProductPathPrefix();
  const n = Number(amount) || 0;
  if (n <= 0) return children;
  const q = new URLSearchParams({ tab: 'invoices', participant: String(participantId) });
  if (participantName) q.set('participant_name', participantName);
  return (
    <Link
      to={`${pathPrefix}/financial?${q.toString()}`}
      title="Open Financial → Invoices: batch totals, paid, and outstanding"
      style={{
        color: 'var(--primary, #2563eb)',
        fontWeight: 600,
        textDecoration: 'underline',
        textUnderlineOffset: '2px'
      }}
    >
      {children}
    </Link>
  );
}

export default function ParticipantProfile() {
  const { id, productSurface } = useParams();
  const pathPrefix = useProductPathPrefix();
  const isAgencyShell = productSurface === PRODUCT_AGENCY;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [editForm, setEditForm] = useState(null);
  const [allContacts, setAllContacts] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState(null);
  const [editingBudget, setEditingBudget] = useState(null);
  const [supportCategories, setSupportCategories] = useState([]);
  const [budgetForm, setBudgetForm] = useState({ support_category: '', amount: '', line_item_ids: [], shift_length_hours: 1 });
  const [ndisItemsForCategory, setNdisItemsForCategory] = useState([]);
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [showCaseNoteModal, setShowCaseNoteModal] = useState(false);
  const [planForm, setPlanForm] = useState({ start_date: '', end_date: '', is_pace: false });
  const [goalForm, setGoalForm] = useState({ description: '', status: 'active', target_date: '' });
  const [caseNoteForm, setCaseNoteForm] = useState({ contact_type: 'phone', notes: '', contact_date: new Date().toISOString().slice(0, 10) });
  const [budgetUtilization, setBudgetUtilization] = useState(null);
  const [planBreakdownParsed, setPlanBreakdownParsed] = useState(null);
  const [planBreakdownLoading, setPlanBreakdownLoading] = useState(false);
  const [planBreakdownApplyForm, setPlanBreakdownApplyForm] = useState({ start_date: '', end_date: '', is_pace: false });
  const [planUploadForceOcr, setPlanUploadForceOcr] = useState(false);
  const [planStatementPlanId, setPlanStatementPlanId] = useState('');
  const [planStatementParsed, setPlanStatementParsed] = useState(null);
  const [planStatementLoading, setPlanStatementLoading] = useState(false);
  const [planStatementUseAi, setPlanStatementUseAi] = useState(true);
  const [planStatementOcr, setPlanStatementOcr] = useState(false);
  const [showAllocationModal, setShowAllocationModal] = useState(false);
  const [allocationForm, setAllocationForm] = useState({ source: null, budget_id: '', budget_index: null, budget_name: '', budget_category: '', budget_amount: 0, provider_id: '', new_provider_name: '', ndis_line_item_id: '', hours_per_week: '', amount: '', frequency: 'weekly', service_name_choice: '', service_name_custom: '', service_name: '', description: '', scenario_shift_hours: 3 });
  const [editingAllocation, setEditingAllocation] = useState(null);
  const [showBudgetConfigModal, setShowBudgetConfigModal] = useState(false);
  const [budgetConfigForm, setBudgetConfigForm] = useState({ source: null, budgetIndex: null, budgetId: null, planId: null, category: '', categoryName: '', totalAmount: 0 });
  const [onboardingState, setOnboardingState] = useState(null);
  // Phase 2 — one-click orchestrator UI state.
  const [onboardingReadiness, setOnboardingReadiness] = useState(null);
  const [orchestratorBusy, setOrchestratorBusy] = useState(false);
  const [orchestratorResult, setOrchestratorResult] = useState(null);
  const [orchestratorError, setOrchestratorError] = useState('');
  // Phase 4 — intake-link UI state.
  const [intakeIssuing, setIntakeIssuing] = useState(false);
  const [intakeLinkResult, setIntakeLinkResult] = useState(null);
  const [intakeLinkError, setIntakeLinkError] = useState('');
  const [showIntakeSendPanel, setShowIntakeSendPanel] = useState(false);
  const [intakeSendToMode, setIntakeSendToMode] = useState('participant'); // 'participant' | 'other'
  const [intakeSendToEmail, setIntakeSendToEmail] = useState('');
  const [intakeSendToNote, setIntakeSendToNote] = useState('');
  const [expandedBudgetCards, setExpandedBudgetCards] = useState({});
  const [allNdisItems, setAllNdisItems] = useState([]);
  const [copiedGoalKey, setCopiedGoalKey] = useState(null);
  const [invoiceEmailInput, setInvoiceEmailInput] = useState('');
  const [saTemplates, setSaTemplates] = useState([]);
  const [saSelectedTemplate, setSaSelectedTemplate] = useState('');
  const [saAgreements, setSaAgreements] = useState([]);
  const [saLoading, setSaLoading] = useState(false);
  const [saSaving, setSaSaving] = useState(false);
  const [saMessage, setSaMessage] = useState('');
  const [saOverrides, setSaOverrides] = useState({
    agreement_date: '',
    scheduled_review_date: '',
    monitoring_worker_frequency: '',
    other_provider_consultation_frequency: '',
    communication_preferences: '',
    services: [
      { description: '', rate: '', hours: '' },
      { description: '', rate: '', hours: '' },
      { description: '', rate: '', hours: '' },
      { description: '', rate: '', hours: '' },
      { description: '', rate: '', hours: '' }
    ]
  });
  const [saGaps, setSaGaps] = useState(null);
  const [saPreflightLoading, setSaPreflightLoading] = useState(false);
  const [saSignBusy, setSaSignBusy] = useState(false);
  const signEnabled = useDropboxSignEnabled();
  const [saScrollTarget, setSaScrollTarget] = useState(null);

  const saInstanceOverridesPayload = useMemo(() => {
    const o = saOverrides;
    const instance_overrides = {};
    if (o.agreement_date) instance_overrides.agreement_date = o.agreement_date;
    if (o.scheduled_review_date) instance_overrides.scheduled_review_date = o.scheduled_review_date;
    if (o.monitoring_worker_frequency?.trim()) instance_overrides.monitoring_worker_frequency = o.monitoring_worker_frequency.trim();
    if (o.other_provider_consultation_frequency?.trim()) {
      instance_overrides.other_provider_consultation_frequency = o.other_provider_consultation_frequency.trim();
    }
    if (o.communication_preferences?.trim()) instance_overrides.communication_preferences = o.communication_preferences.trim();
    const services = (Array.isArray(o.services) ? o.services : [])
      .map((s) => ({
        description: String(s?.description || '').trim(),
        rate: Number(s?.rate) || 0,
        hours: Number(s?.hours) || 0
      }))
      .filter((s) => s.description || s.rate || s.hours);
    if (services.length > 0) instance_overrides.services = services;
    return instance_overrides;
  }, [saOverrides]);

  const saServicesTotals = useMemo(() => {
    const list = Array.isArray(saOverrides.services) ? saOverrides.services : [];
    const lines = list.map((s) => {
      const rate = Number(s?.rate) || 0;
      const hours = Number(s?.hours) || 0;
      return Math.round(rate * hours * 100) / 100;
    });
    const total = Math.round(lines.reduce((a, b) => a + b, 0) * 100) / 100;
    const completeRows = list.filter((s) => {
      const rate = Number(s?.rate) || 0;
      const hours = Number(s?.hours) || 0;
      return String(s?.description || '').trim() && rate > 0 && hours > 0;
    }).length;
    return { lines, total, completeRows };
  }, [saOverrides.services]);

  const saPreSendChecklist = useMemo(() => {
    const fmtDob = data?.date_of_birth ? formatDate(String(data.date_of_birth).slice(0, 10)) : '';
    return [
      { key: 'name', label: 'Full name', value: data?.name },
      { key: 'address', label: 'Address', value: data?.address },
      { key: 'phone', label: 'Phone', value: data?.phone || data?.mobile },
      { key: 'email', label: 'Participant email (signing step 2)', value: data?.email },
      { key: 'ndis_number', label: 'NDIS number', value: data?.ndis_number },
      { key: 'dob', label: 'Date of birth', value: fmtDob },
      { key: 'agreement_date', label: 'Agreement date', value: saOverrides.agreement_date },
      { key: 'review_date', label: 'Scheduled review date', value: saOverrides.scheduled_review_date },
      {
        key: 'services',
        label: 'Services & quote (at least one line)',
        value: saServicesTotals.completeRows > 0
          ? `${saServicesTotals.completeRows} line${saServicesTotals.completeRows === 1 ? '' : 's'} · Total $${saServicesTotals.total.toFixed(2)}`
          : ''
      }
    ];
  }, [
    data?.name,
    data?.address,
    data?.phone,
    data?.mobile,
    data?.email,
    data?.ndis_number,
    data?.date_of_birth,
    saOverrides.agreement_date,
    saOverrides.scheduled_review_date,
    saServicesTotals.completeRows,
    saServicesTotals.total
  ]);

  const saChecklistMissing = saPreSendChecklist.filter((r) => !String(r.value || '').trim());
  const saReadyToSend = saChecklistMissing.length === 0;

  const navigateToGapFix = useCallback(
    (gap) => {
      const fix = gap?.fix;
      if (!fix || !data) return;
      if (fix.kind === 'participant_profile') {
        setTab(fix.tab || 'overview');
        if (fix.open_edit) {
          setEditForm({ ...data, invoice_emails: parseInvoiceEmailsField(data.invoice_emails) });
          setInvoiceEmailInput('');
        }
        if (fix.anchor_id) setSaScrollTarget(fix.anchor_id);
        return;
      }
      if (fix.kind === 'forms') {
        navigate(`${pathPrefix}/forms`);
        return;
      }
      if (fix.kind === 'settings') {
        const q = new URLSearchParams({ expand: fix.section || 'company' });
        navigate(`${pathPrefix}/settings?${q.toString()}`);
        return;
      }
      if (fix.kind === 'agreements_tab') {
        setTab('agreements');
        if (fix.anchor_id) setSaScrollTarget(fix.anchor_id);
      }
    },
    [data, navigate, pathPrefix]
  );

  useEffect(() => {
    if (tab !== 'agreements') {
      setSaGaps(null);
      setSaPreflightLoading(false);
      return;
    }
    if (!id || !saSelectedTemplate || !data) {
      setSaGaps(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSaPreflightLoading(true);
      participants
        .preflightServiceAgreement(id, {
          org_template_id: saSelectedTemplate,
          instance_overrides: saInstanceOverridesPayload
        })
        .then((res) => {
          if (!cancelled) setSaGaps(res);
        })
        .catch(() => {
          if (!cancelled) setSaGaps(null);
        })
        .finally(() => {
          if (!cancelled) setSaPreflightLoading(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, id, saSelectedTemplate, saInstanceOverridesPayload, data]);

  useEffect(() => {
    if (!saScrollTarget) return undefined;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(saScrollTarget);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'box-shadow 0.25s ease';
        el.style.boxShadow = '0 0 0 3px rgba(234, 179, 8, 0.95)';
        window.setTimeout(() => {
          el.style.boxShadow = '';
        }, 2400);
      }
      setSaScrollTarget(null);
    }, 200);
    return () => clearTimeout(timer);
  }, [saScrollTarget, tab, editForm]);

  const copyGoalLine = async (key, text) => {
    if (!String(text || '').trim()) return;
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopiedGoalKey(key);
    window.setTimeout(() => {
      setCopiedGoalKey((k) => (k === key ? null : k));
    }, 1600);
  };

  const formatManagementTypeLabel = (value) => {
    const v = String(value || '').toLowerCase();
    if (v === 'plan') return 'Plan-managed';
    if (v === 'ndia') return 'NDIA-managed';
    return 'Self-managed';
  };

  useEffect(() => {
    setPlanStatementParsed(null);
  }, [id]);

  useEffect(() => {
    if (!data?.plans?.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const cur = data.plans.find((p) => p.start_date <= today && p.end_date >= today) || data.plans[0];
    setPlanStatementPlanId((prev) => (prev && data.plans.some((p) => p.id === prev) ? prev : cur?.id || ''));
  }, [data?.plans]);

  const load = async () => {
    setLoading(true);
    try {
      const d = await participants.get(id);
      setData(d);
      onboarding.status(id).then(setOnboardingState).catch(() => setOnboardingState(null));
      onboarding
        .runStatus(id)
        .then((r) => setOnboardingReadiness(r?.readiness || null))
        .catch(() => setOnboardingReadiness(null));
      participants.budgetUtilization(id).then(setBudgetUtilization).catch(() => setBudgetUtilization(null));
      // Don't set editForm here - only set when user clicks Edit
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleArchive = async () => {
    if (!confirm(`Archive ${data?.name}? They will be hidden from the list but can be restored.`)) return;
    try {
      await participants.archive(id);
      navigate(backToPreviousListPath(searchParams, pathPrefix));
    } catch (err) {
      alert(err.message || 'Could not archive participant.');
    }
  };

  const handleUnarchive = async () => {
    try {
      await participants.unarchive(id);
      load();
    } catch (err) {
      alert(err.message || 'Could not restore participant.');
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Permanently delete ${data?.name}? This cannot be undone. All plans, goals, documents, shifts and related data will be removed.`)) return;
    try {
      await participants.delete(id);
      navigate(backToPreviousListPath(searchParams, pathPrefix));
    } catch (err) {
      alert(err.message || 'Could not delete participant.');
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  useEffect(() => {
    if (tab !== 'agreements' || !id) return;
    let cancelled = false;
    setSaLoading(true);
    Promise.all([formTemplates.instances(), participants.listServiceAgreements(id)])
      .then(([ti, list]) => {
        if (cancelled) return;
        const inst = ti.instances || [];
        setSaTemplates(inst);
        setSaAgreements(list.items || []);
        const svc = inst.find((x) => x.template_key === 'service_agreement_standard_v3');
        setSaSelectedTemplate((prev) => prev || svc?.id || '');
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, id]);

  useEffect(() => {
    organisations.allContacts().then(setAllContacts).catch(() => {});
  }, []);

  useEffect(() => {
    organisations.list('', 'plan_manager').then(setOrgs).catch(() => []);
  }, []);

  useEffect(() => {
    ndis.supportCategories()
      .then((cats) => setSupportCategories(Array.isArray(cats) && cats.length > 0 ? cats : FALLBACK_SUPPORT_CATEGORIES))
      .catch(() => setSupportCategories(FALLBACK_SUPPORT_CATEGORIES));
  }, []);

  useEffect(() => {
    if (!budgetForm.support_category) {
      setNdisItemsForCategory([]);
      return;
    }
    const cat = budgetForm.support_category;
    ndis.list({ support_categories: cat, support_category: cat })
      .then((items) => setNdisItemsForCategory(Array.isArray(items) ? items : []))
      .catch(() => setNdisItemsForCategory([]));
  }, [budgetForm.support_category]);

  const hasLoadedNdisForEditRef = useRef(false);
  useEffect(() => {
    if (editForm && !hasLoadedNdisForEditRef.current) {
      hasLoadedNdisForEditRef.current = true;
      ndis.list({}).then((items) => setAllNdisItems(Array.isArray(items) ? items : [])).catch(() => setAllNdisItems([]));
    }
    if (!editForm) hasLoadedNdisForEditRef.current = false;
  }, [editForm]);

  // Pre-select learned line items when adding a new budget (personalisation – improves over time)
  useEffect(() => {
    if (!budgetForm.support_category || !ndisItemsForCategory.length || editingBudget) return;
    smartDefaults.budgetLineItems(budgetForm.support_category)
      .then((res) => {
        if (res?.suggested_ids?.length) {
          const availableIds = new Set(ndisItemsForCategory.map((i) => i.id));
          const toSelect = res.suggested_ids.filter((id) => availableIds.has(id));
          setBudgetForm((prev) => {
            if (toSelect.length > 0 && (!prev.line_item_ids || prev.line_item_ids.length === 0)) {
              return { ...prev, line_item_ids: toSelect };
            }
            return prev;
          });
        }
      })
      .catch(() => {});
  }, [budgetForm.support_category, ndisItemsForCategory, editingBudget]);

  const [ndisItemsForAllocation, setNdisItemsForAllocation] = useState([]);
  const [ndisItemsForConfig, setNdisItemsForConfig] = useState([]);
  useEffect(() => {
    if (!showAllocationModal || !allocationForm.budget_category) {
      setNdisItemsForAllocation([]);
      return;
    }
    const cat = allocationForm.budget_category;
    ndis.list({ support_categories: cat, support_category: cat })
      .then((items) => setNdisItemsForAllocation(Array.isArray(items) ? items : []))
      .catch(() => setNdisItemsForAllocation([]));
  }, [showAllocationModal, allocationForm.budget_category]);
  useEffect(() => {
    if (!showBudgetConfigModal || !budgetConfigForm.category) {
      setNdisItemsForConfig([]);
      return;
    }
    const cat = budgetConfigForm.category;
    ndis.list({ support_categories: cat, support_category: cat })
      .then((items) => setNdisItemsForConfig(Array.isArray(items) ? items : []))
      .catch(() => setNdisItemsForConfig([]));
  }, [showBudgetConfigModal, budgetConfigForm.category]);

  // Auto-fill apply form dates from parsed plan dates (PDF)
  useEffect(() => {
    const pd = planBreakdownParsed?.plan_dates;
    if (!pd?.start_date && !pd?.end_date) return;
    const toYmd = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : (toInputDate(d) || d || '');
    setPlanBreakdownApplyForm(prev => ({
      ...prev,
      start_date: toYmd(pd.start_date) || prev.start_date,
      end_date: toYmd(pd.end_date) || prev.end_date
    }));
  }, [planBreakdownParsed]);

  function getEffectiveRate(item, remoteness) {
    if (!item) return 0;
    const r = remoteness || 'standard';
    if (r === 'remote' && item.rate_remote != null) return parseFloat(item.rate_remote) || 0;
    if (r === 'very_remote' && item.rate_very_remote != null) return parseFloat(item.rate_very_remote) || 0;
    return parseFloat(item.rate) || 0;
  }

  function getBudgetPrimaryRate(budget, remoteness) {
    const category = String(budget?.category || '').padStart(2, '0');
    const preferredRate = toNumber(CATEGORY_PREFERRED_ESTIMATE_RATES[category]);
    const lineItems = Array.isArray(budget?.line_items) ? budget.line_items : [];
    const hourlyItems = lineItems.filter((item) => {
      const unit = String(item?.unit || 'hr').toLowerCase();
      return unit.includes('hr') || unit.includes('hour');
    });
    if (hourlyItems.length === 0) return preferredRate;
    if (preferredRate > 0) {
      const exactOrClosest = hourlyItems.reduce((best, item) => {
        const itemRate = getEffectiveRate(item, remoteness);
        if (itemRate <= 0) return best;
        if (!best) return item;
        const bestRate = getEffectiveRate(best, remoteness);
        return Math.abs(itemRate - preferredRate) < Math.abs(bestRate - preferredRate) ? item : best;
      }, null);
      if (exactOrClosest) return getEffectiveRate(exactOrClosest, remoteness);
    }
    return getEffectiveRate(hourlyItems[0], remoteness);
  }

  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  function getAllocationAnnualCost(alloc, fallbackRate = 0) {
    const amount = toNumber(alloc?.amount);
    if (amount > 0) return amount;
    const hours = toNumber(alloc?.hours_per_week ?? alloc?.hours);
    const frequency = alloc?.frequency || 'weekly';
    const periods = FREQUENCY_TO_PERIODS[frequency] || 52;
    const rate = toNumber(alloc?.line_item_rate ?? alloc?.rate ?? fallbackRate);
    if (hours > 0 && rate > 0) return hours * periods * rate;
    return 0;
  }

  function getAllocationAnnualHours(alloc, fallbackRate = 0) {
    const hours = toNumber(alloc?.hours_per_week ?? alloc?.hours);
    const frequency = alloc?.frequency || 'weekly';
    const periods = FREQUENCY_TO_PERIODS[frequency] || 52;
    if (hours > 0) return hours * periods;
    const amount = toNumber(alloc?.amount);
    const rate = toNumber(alloc?.line_item_rate ?? alloc?.rate ?? fallbackRate);
    if (amount > 0 && rate > 0) return amount / rate;
    return 0;
  }

  function getUtilizationTone(percent) {
    if (percent >= 90) return { bg: '#fef2f2', border: '#fecaca', badge: 'badge-danger' };
    if (percent >= 70) return { bg: '#fffbeb', border: '#fde68a', badge: 'badge-warning' };
    return { bg: '#f0fdf4', border: '#bbf7d0', badge: 'badge-success' };
  }

  function getBudgetColorway(seed) {
    const key = String(seed || '');
    if (!key) return BUDGET_COLORWAYS[0];
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return BUDGET_COLORWAYS[Math.abs(hash) % BUDGET_COLORWAYS.length];
  }

  function getServiceNameFields(rawName) {
    const name = String(rawName || '').trim();
    if (!name) {
      return { service_name_choice: '', service_name_custom: '', service_name: '' };
    }
    if (ALLOCATION_SERVICE_PRESETS.includes(name)) {
      return { service_name_choice: name, service_name_custom: '', service_name: name };
    }
    return { service_name_choice: '__custom__', service_name_custom: name, service_name: name };
  }

  const handleAddBudget = async (e) => {
    e.preventDefault();
    if (!editingPlanId || !budgetForm.support_category || !budgetForm.amount) return;
    try {
      const cat = supportCategories.find(c => c.id === budgetForm.support_category);
      await participants.addBudget(id, editingPlanId, {
        name: cat?.name || `Category ${budgetForm.support_category}`,
        amount: parseFloat(budgetForm.amount),
        category: budgetForm.support_category,
        line_item_ids: budgetForm.line_item_ids || []
      });
      setShowBudgetModal(false);
      setEditingPlanId(null);
      setEditingBudget(null);
      setBudgetForm({ support_category: '', amount: '', line_item_ids: [], shift_length_hours: 1 });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUpdateBudget = async (e) => {
    e.preventDefault();
    if (!editingPlanId || !editingBudget || !budgetForm.support_category || !budgetForm.amount) return;
    try {
      const cat = supportCategories.find(c => c.id === budgetForm.support_category);
      await participants.updateBudget(id, editingPlanId, editingBudget.id, {
        name: cat?.name || `Category ${budgetForm.support_category}`,
        amount: parseFloat(budgetForm.amount),
        category: budgetForm.support_category,
        line_item_ids: budgetForm.line_item_ids || []
      });
      setShowBudgetModal(false);
      setEditingPlanId(null);
      setEditingBudget(null);
      setBudgetForm({ support_category: '', amount: '', line_item_ids: [], shift_length_hours: 1 });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteBudget = async (planId, budgetId) => {
    if (!confirm('Remove this category budget?')) return;
    try {
      await participants.deleteBudget(id, planId, budgetId);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeletePlan = async (planId) => {
    if (!confirm('Remove this plan and all its budgets? This cannot be undone.')) return;
    try {
      await participants.deletePlan(id, planId);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleRefreshPlanFunding = async (plan) => {
    if (!plan?.id) return;
    if (!confirm('Create a new plan from today using remaining funding, and end this plan yesterday?')) return;
    try {
      const result = await participants.refreshPlanAvailableFunding(id, plan.id);
      const updatedCount = Array.isArray(result?.budgets) ? result.budgets.length : 0;
      alert(`Funding refreshed. Created a new plan from ${result?.new_plan_start_date || 'today'} with ${updatedCount} category budget${updatedCount === 1 ? '' : 's'}.`);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handlePlanStatementUpload = async (e, apply) => {
    const file = e.target.files?.[0];
    if (!file || !planStatementPlanId) return;
    setPlanStatementLoading(true);
    setPlanStatementParsed(null);
    try {
      const result = await participants.parsePlanManagerStatement(id, planStatementPlanId, file, planStatementUseAi, apply, planStatementOcr);
      setPlanStatementParsed(result);
      if (apply) {
        await load();
        participants.budgetUtilization(id).then(setBudgetUtilization).catch(() => {});
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setPlanStatementLoading(false);
      e.target.value = '';
    }
  };

  const handlePlanFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPlanBreakdownLoading(true);
    setPlanBreakdownParsed(null);
    try {
      const result = await participants.parsePlan(id, file, true, planUploadForceOcr);
      setPlanBreakdownParsed({
        ...result,
        goals: Array.isArray(result?.goals) ? result.goals : [],
        fund_release_schedule: result?.fund_release_schedule ?? null
      });
      const pd = result?.plan_dates;
      setPlanBreakdownApplyForm({
        start_date: pd?.start_date || planForm.start_date || '',
        end_date: pd?.end_date || planForm.end_date || '',
        is_pace: planForm.is_pace || false
      });
    } catch (err) {
      alert(err.message);
    } finally {
      setPlanBreakdownLoading(false);
      e.target.value = '';
    }
  };

  const handleAddParsedGoal = () => {
    setPlanBreakdownParsed((prev) => {
      if (!prev) return prev;
      const goals = Array.isArray(prev.goals) ? prev.goals : [];
      return { ...prev, goals: [...goals, ''] };
    });
  };

  const handleChangeParsedGoal = (index, value) => {
    setPlanBreakdownParsed((prev) => {
      if (!prev) return prev;
      const goals = Array.isArray(prev.goals) ? [...prev.goals] : [];
      goals[index] = value;
      return { ...prev, goals };
    });
  };

  const handleRemoveParsedGoal = (index) => {
    setPlanBreakdownParsed((prev) => {
      if (!prev) return prev;
      const goals = Array.isArray(prev.goals) ? prev.goals.filter((_, i) => i !== index) : [];
      return { ...prev, goals };
    });
  };

  const handleAddAllocation = (budget, source, budgetIndex) => {
    setEditingAllocation(null);
    setAllocationForm({ source: source || 'applied', budget_id: budget.id || '', budget_index: budgetIndex ?? null, budget_name: supportCategories.find(c => c.id === budget.category)?.name || budget.name, budget_category: budget.category || '', budget_amount: Number(budget.amount) || 0, provider_id: '', new_provider_name: '', ndis_line_item_id: '', hours_per_week: '', amount: '', frequency: 'weekly', ...getServiceNameFields(''), description: '', scenario_shift_hours: 3 });
    setShowAllocationModal(true);
  };

  const handleEditAllocation = (alloc, budget) => {
    setEditingAllocation(alloc);
    const serviceSeed = alloc.service_name || alloc.description || '';
    setAllocationForm({ source: 'applied', budget_id: budget.id, budget_index: null, budget_name: supportCategories.find(c => c.id === budget.category)?.name || budget.name, budget_category: budget.category || '', budget_amount: Number(budget.amount) || 0, provider_id: String(alloc.provider_id || ''), new_provider_name: '', ndis_line_item_id: String(alloc.ndis_line_item_id || ''), hours_per_week: alloc.hours_per_week ?? '', amount: alloc.amount ?? '', frequency: ALLOC_FREQUENCIES.includes(alloc.frequency) ? alloc.frequency : 'weekly', ...getServiceNameFields(serviceSeed), description: alloc.description || '', scenario_shift_hours: 3 });
    setShowAllocationModal(true);
  };

  const handleSaveAllocation = async (e) => {
    e.preventDefault();
    let providerId = allocationForm.provider_id;
    const isNewProvider = providerId === '__new__';
    const newName = (allocationForm.new_provider_name || '').trim();
    if (isNewProvider) {
      if (!newName) {
        alert('Enter the new provider name.');
        return;
      }
      try {
        const created = await organisations.create({ name: newName });
        providerId = created?.id || created;
        setOrgs(prev => [...prev.filter(o => o.id !== providerId), { id: providerId, name: created?.name || newName }]);
      } catch (err) {
        alert(err.message);
        return;
      }
    } else if (!providerId) {
      alert('Select or add a provider.');
      return;
    }
    const selectedLineItem = ndisItemsForAllocation.find((item) => String(item.id) === String(allocationForm.ndis_line_item_id));
    const selectedRate = getEffectiveRate(selectedLineItem, data?.remoteness);
    const serviceName = (allocationForm.service_name || '').trim();
    const calculatedAmount = getAllocationAnnualCost({
      hours_per_week: allocationForm.hours_per_week,
      frequency: allocationForm.frequency,
      amount: allocationForm.amount,
      line_item_rate: selectedRate
    });
    if (allocationForm.source === 'parsed' && allocationForm.budget_index != null) {
      const alloc = {
        provider_id: providerId,
        provider_name: newName || orgs.find(o => o.id === providerId)?.name || '',
        service_name: serviceName || null,
        description: serviceName || allocationForm.description || null,
        ndis_line_item_id: allocationForm.ndis_line_item_id || null,
        hours: allocationForm.hours_per_week ? parseFloat(allocationForm.hours_per_week) : null,
        frequency: allocationForm.frequency || 'weekly',
        amount: allocationForm.amount ? parseFloat(allocationForm.amount) : calculatedAmount
      };
      const updated = [...planBreakdownParsed.budgets];
      const b = updated[allocationForm.budget_index];
      updated[allocationForm.budget_index] = { ...b, allocations: [...(b.allocations || []), alloc] };
      setPlanBreakdownParsed({ ...planBreakdownParsed, budgets: updated });
      setShowAllocationModal(false);
      setEditingAllocation(null);
      return;
    }
    const plan = data.plans?.find(p => p.budgets?.some(b => b.id === allocationForm.budget_id));
    if (!plan) return;
    try {
      const payload = {
        provider_type: 'organisation',
        provider_id: providerId,
        hours_per_week: allocationForm.hours_per_week ? parseFloat(allocationForm.hours_per_week) : null,
        amount: allocationForm.amount ? parseFloat(allocationForm.amount) : calculatedAmount,
        ndis_line_item_id: allocationForm.ndis_line_item_id || null,
        frequency: allocationForm.frequency || 'weekly',
        description: serviceName || allocationForm.description || null
      };
      if (editingAllocation) {
        await participants.updateImplementation(id, plan.id, editingAllocation.id, payload);
      } else {
        await participants.addImplementation(id, plan.id, { budget_id: allocationForm.budget_id, ...payload });
      }
      setShowAllocationModal(false);
      setEditingAllocation(null);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteAllocation = async (planId, implId) => {
    if (!confirm('Remove this provider allocation?')) return;
    try {
      await participants.deleteImplementation(id, planId, implId);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const removeParsedAllocation = (budgetIndex, allocIndex) => {
    if (!confirm('Remove this allocation?')) return;
    const updated = [...planBreakdownParsed.budgets];
    const b = updated[budgetIndex];
    updated[budgetIndex] = { ...b, allocations: (b.allocations || []).filter((_, i) => i !== allocIndex) };
    setPlanBreakdownParsed({ ...planBreakdownParsed, budgets: updated });
  };

  const handleEqualQuarterlySchedule = () => {
    setPlanBreakdownParsed((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        fund_release_schedule: {
          pattern: 'equal_periods',
          period_months: 3,
          releases: [
            { scheduled_date: null, proportion: 0.25, amount: null, label: 'Release 1' },
            { scheduled_date: null, proportion: 0.25, amount: null, label: 'Release 2' },
            { scheduled_date: null, proportion: 0.25, amount: null, label: 'Release 3' },
            { scheduled_date: null, proportion: 0.25, amount: null, label: 'Release 4' }
          ],
          evidence_quote: '',
          confidence: 'medium'
        }
      };
    });
  };

  const handleClearFundReleaseSchedule = () => {
    setPlanBreakdownParsed((prev) => (prev ? { ...prev, fund_release_schedule: null } : prev));
  };

  const handleAddFundReleaseRow = () => {
    setPlanBreakdownParsed((prev) => {
      if (!prev) return prev;
      const cur = prev.fund_release_schedule;
      const releases = Array.isArray(cur?.releases) ? [...cur.releases] : [];
      releases.push({ scheduled_date: null, proportion: 0, amount: null, label: `Release ${releases.length + 1}` });
      return {
        ...prev,
        fund_release_schedule: {
          pattern: cur?.pattern || 'explicit_proportions',
          period_months: cur?.period_months ?? null,
          releases,
          evidence_quote: cur?.evidence_quote || '',
          confidence: cur?.confidence || 'medium'
        }
      };
    });
  };

  const handleUpdateFundReleaseRow = (index, patch) => {
    setPlanBreakdownParsed((prev) => {
      if (!prev?.fund_release_schedule) return prev;
      const cur = prev.fund_release_schedule;
      const releases = (cur.releases || []).map((r, i) => (i === index ? { ...r, ...patch } : r));
      return { ...prev, fund_release_schedule: { ...cur, releases } };
    });
  };

  const handleRemoveFundReleaseRow = (index) => {
    setPlanBreakdownParsed((prev) => {
      if (!prev?.fund_release_schedule?.releases) return prev;
      const cur = prev.fund_release_schedule;
      const releases = cur.releases.filter((_, i) => i !== index);
      return { ...prev, fund_release_schedule: { ...cur, releases } };
    });
  };

  const handleFundReleasePeriodMonths = (value) => {
    const n = value === '' ? null : Number(value);
    setPlanBreakdownParsed((prev) => {
      if (!prev) return prev;
      const cur = prev.fund_release_schedule;
      if (!cur) {
        return {
          ...prev,
          fund_release_schedule: {
            pattern: 'unknown',
            period_months: n,
            releases: [],
            evidence_quote: '',
            confidence: 'low'
          }
        };
      }
      return { ...prev, fund_release_schedule: { ...cur, period_months: n } };
    });
  };

  const toggleBudgetCard = (planId, budgetId) => {
    const key = `${planId}:${budgetId}`;
    setExpandedBudgetCards((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const openBudgetConfig = (source, budget, indexOrId, planId) => {
    const cat = budget.category || '';
    const name = supportCategories.find(c => c.id === cat)?.name || budget.name;
    const amt = Number(budget.amount) || 0;
    setBudgetConfigForm({
      source,
      budgetIndex: source === 'parsed' ? indexOrId : null,
      budgetId: source === 'applied' ? indexOrId : null,
      planId: source === 'applied' ? planId : null,
      category: cat,
      categoryName: name,
      totalAmount: amt
    });
    setShowBudgetConfigModal(true);
  };

  const getConfigBudget = () => {
    if (budgetConfigForm.source === 'parsed' && budgetConfigForm.budgetIndex != null) {
      return planBreakdownParsed?.budgets?.[budgetConfigForm.budgetIndex];
    }
    if (budgetConfigForm.source === 'applied' && budgetConfigForm.budgetId && budgetConfigForm.planId) {
      return data?.plans?.find(p => p.id === budgetConfigForm.planId)?.budgets?.find(b => b.id === budgetConfigForm.budgetId);
    }
    return null;
  };

  const handleApplyPlanBreakdown = async (e) => {
    e.preventDefault();
    if (!planBreakdownParsed?.budgets?.length || !planBreakdownApplyForm.start_date || !planBreakdownApplyForm.end_date) {
      alert('Enter plan dates and ensure budgets were parsed.');
      return;
    }
    try {
      const applyResult = await participants.applyPlanBreakdown(id, {
        start_date: planBreakdownApplyForm.start_date,
        end_date: planBreakdownApplyForm.end_date,
        is_pace: planBreakdownApplyForm.is_pace,
        fund_release_schedule: planBreakdownParsed.fund_release_schedule || null,
        goals: (planBreakdownParsed.goals || []).map((g) => String(g || '').trim()).filter(Boolean),
        budgets: planBreakdownParsed.budgets.map(b => ({
          category: b.category,
          name: b.name,
          amount: b.amount,
          management_type: b.management_type || 'self',
          line_item_ids: [...new Set([...(b.line_item_ids || []), ...(b.allocations || []).map(a => a.ndis_line_item_id).filter(Boolean)])],
          allocations: (b.allocations || []).map(a => ({
            provider_id: a.provider_id,
            service_name: a.service_name || a.description || null,
            ndis_line_item_id: a.ndis_line_item_id || null,
            hours: a.hours ?? a.hours_per_week ?? null,
            hours_per_week: a.hours ?? a.hours_per_week ?? null,
            frequency: a.frequency || 'weekly',
            amount: a.amount ?? 0
          }))
        }))
      });
      const budgetsCreated = Number(applyResult?.budgets_created) || 0;
      const goalsAdded = Number(applyResult?.goals_added) || 0;
      alert(`Plan created. ${budgetsCreated} budget${budgetsCreated === 1 ? '' : 's'} created. ${goalsAdded} goal${goalsAdded === 1 ? '' : 's'} added.`);
      setPlanBreakdownParsed(null);
      await load();
      if (goalsAdded > 0) setTab('goals');
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    try {
      const inv = Array.isArray(editForm.invoice_emails) ? editForm.invoice_emails : parseInvoiceEmailsField(editForm.invoice_emails);
      await participants.update(id, { ...editForm, invoice_emails: inv });
      load();
      setEditForm(null);
      setInvoiceEmailInput('');
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAddPlan = async (e) => {
    e.preventDefault();
    try {
      await participants.addPlan(id, planForm);
      setShowPlanModal(false);
      setPlanForm({ start_date: '', end_date: '', is_pace: false });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAddGoal = async (e) => {
    e.preventDefault();
    try {
      await participants.addGoal(id, goalForm);
      setShowGoalModal(false);
      setGoalForm({ description: '', status: 'active', target_date: '' });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAddCaseNote = async (e) => {
    e.preventDefault();
    try {
      await participants.addCaseNote(id, caseNoteForm);
      setShowCaseNoteModal(false);
      setCaseNoteForm({ contact_type: 'phone', notes: '', contact_date: new Date().toISOString().slice(0, 10) });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  // Phase 4: issue a public self-service intake link and (when configured) email it.
  const handleSendIntakeLink = async () => {
    setIntakeIssuing(true);
    setIntakeLinkError('');
    setIntakeLinkResult(null);
    try {
      const body = {};
      if (intakeSendToMode === 'other') {
        const emailVal = intakeSendToEmail.trim();
        if (!emailVal) { setIntakeLinkError('Enter an email address to send to.'); setIntakeIssuing(false); return; }
        body.send_to_email = emailVal;
        if (intakeSendToNote.trim()) body.send_to_note = intakeSendToNote.trim();
      }
      const res = await onboarding.issueIntakeToken(id, body);
      setIntakeLinkResult(res);
      setShowIntakeSendPanel(false);
    } catch (err) {
      setIntakeLinkError(err.message || 'Failed to issue intake link');
    } finally {
      setIntakeIssuing(false);
    }
  };

  // Phase 2: one-click orchestrator handler. Calls the new /onboarding/run endpoint and
  // refreshes the inline state so the user sees per-step results without a page reload.
  const handleRunOnboarding = async () => {
    setOrchestratorBusy(true);
    setOrchestratorError('');
    try {
      const result = await onboarding.run(id);
      setOrchestratorResult(result);
      try {
        const fresh = await onboarding.status(id);
        setOnboardingState(fresh);
      } catch {
        /* keep previous state */
      }
      try {
        const rs = await onboarding.runStatus(id);
        setOnboardingReadiness(rs?.readiness || null);
      } catch {
        /* keep previous readiness */
      }
    } catch (err) {
      // 409 responses include structured payload via fetchApi error message.
      setOrchestratorError(err?.message || 'Onboarding run failed');
    } finally {
      setOrchestratorBusy(false);
    }
  };

  const handleAddContact = async (contactId, relationship) => {
    try {
      await participants.addContact(id, { contact_id: contactId, relationship });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleStarContact = async (pcId, isStarred) => {
    const pc = data.contacts.find(c => c.id === pcId);
    if (!pc) return;
    try {
      await participants.updateContact(id, pcId, { ...pc, is_starred: !isStarred });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  if (loading || !data) return <div className="card"><p>Loading...</p></div>;

  const starredContacts = data.contacts?.filter(c => c.is_starred) || [];
  const invoiceRec = resolveInvoiceRecipientsForDisplay(data);

  return (
    <div>
      <div className="page-header">
        <h2>
          {data.name}
          {data.archived_at && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', fontWeight: 'normal', color: '#64748b' }}>(archived)</span>}
        </h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <Link to={backToPreviousListPath(searchParams, pathPrefix)} className="btn btn-secondary">{participantProfileBackLabel(searchParams)}</Link>
          {data.archived_at ? (
            <button type="button" className="btn btn-secondary" onClick={handleUnarchive}>Restore</button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={handleArchive} title="Hide from list (can restore)">Archive</button>
          )}
          <button type="button" className="btn btn-danger" onClick={handleDelete} title="Permanently delete">Delete</button>
        </div>
      </div>

      {editForm ? (
        <div className="card">
          <h3>Edit Profile</h3>
          <form onSubmit={handleSaveProfile}>
            <div id="sa-gap-key-information">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div className="form-group" id="sa-gap-edit-name">
                  <label>Name</label>
                  <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>NDIS Number</label>
                  <input value={editForm.ndis_number || ''} onChange={(e) => setEditForm({ ...editForm, ndis_number: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label>Management Type</label>
                <div className="management-type-options">
                  <label className="checkbox-label">
                    <input type="radio" name="management_type" checked={(editForm.management_type || 'self') === 'self'} onChange={() => setEditForm({ ...editForm, management_type: 'self', plan_manager_id: '' })} />
                    <span>Self-managed</span>
                  </label>
                  <label className="checkbox-label">
                    <input type="radio" name="management_type" checked={(editForm.management_type || 'self') === 'plan'} onChange={() => setEditForm({ ...editForm, management_type: 'plan' })} />
                    <span>Plan-managed</span>
                  </label>
                  <label className="checkbox-label">
                    <input type="radio" name="management_type" checked={(editForm.management_type || 'self') === 'ndia'} onChange={() => setEditForm({ ...editForm, management_type: 'ndia', plan_manager_id: '' })} />
                    <span>NDIA-managed</span>
                  </label>
                </div>
              </div>
              {(editForm.management_type || 'self') === 'plan' && (
                <div className="form-group">
                  <label>Plan Manager (optional – can leave blank; org email is used for invoices if no list below)</label>
                  <select value={editForm.plan_manager_id || ''} onChange={(e) => setEditForm({ ...editForm, plan_manager_id: e.target.value || '' })}>
                    <option value="">Select plan manager...</option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }} id="sa-gap-participant-details">
              <div className="form-group">
                <label>Email (optional – for self‑managed, used for invoices if no “Invoice email(s)” below)</label>
                <input type="email" value={editForm.email || ''} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} placeholder="Leave blank if not needed" />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input value={editForm.phone || ''} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
              </div>
            </div>
            <div className="form-group">
              <label>
                Invoice email(s) — where financial batch PDFs and Xero contact email go
              </label>
              <small style={{ display: 'block', color: '#64748b', marginBottom: '0.4rem' }}>
                First in the list is the primary; additional addresses are CCed when you send a batch. If you leave this empty, Nexus
                uses the plan manager organisation’s email (plan‑managed) or the participant email above (self‑managed). For
                NDIA‑managed, add at least one address to send by email, or use your NDIA export/claim process instead.
              </small>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.5rem' }}>
                {(Array.isArray(editForm.invoice_emails) ? editForm.invoice_emails : parseInvoiceEmailsField(editForm.invoice_emails)).map((em, idx) => (
                  <span
                    key={`${em}-${idx}`}
                    style={{ display: 'inline-flex', alignItems: 'center', background: '#e2e8f0', borderRadius: '4px', padding: '2px 8px', fontSize: '0.85rem' }}
                  >
                    {em}
                    <button
                      type="button"
                      onClick={() => {
                        const cur = Array.isArray(editForm.invoice_emails) ? editForm.invoice_emails : parseInvoiceEmailsField(editForm.invoice_emails);
                        setEditForm({ ...editForm, invoice_emails: cur.filter((_, i) => i !== idx) });
                      }}
                      style={{ marginLeft: '4px', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '1rem', lineHeight: 1, color: '#64748b' }}
                    >
                      &times;
                    </button>
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
                      const cur = Array.isArray(editForm.invoice_emails) ? editForm.invoice_emails : parseInvoiceEmailsField(editForm.invoice_emails);
                      if (val && val.includes('@') && !cur.includes(val)) {
                        setEditForm({ ...editForm, invoice_emails: [...cur, val] });
                        setInvoiceEmailInput('');
                      }
                    }
                  }}
                  placeholder="Type email, Enter to add"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    const val = invoiceEmailInput.trim();
                    const cur = Array.isArray(editForm.invoice_emails) ? editForm.invoice_emails : parseInvoiceEmailsField(editForm.invoice_emails);
                    if (val && val.includes('@') && !cur.includes(val)) {
                      setEditForm({ ...editForm, invoice_emails: [...cur, val] });
                      setInvoiceEmailInput('');
                    }
                  }}
                >
                  Add
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label>Parent/Guardian Phone (optional – leave blank if not needed)</label>
                <input value={editForm.parent_guardian_phone || ''} onChange={(e) => setEditForm({ ...editForm, parent_guardian_phone: e.target.value })} placeholder="Leave blank if not needed" />
              </div>
              <div className="form-group">
                <label>Parent/Guardian Email (optional – leave blank if not needed)</label>
                <input type="email" value={editForm.parent_guardian_email || ''} onChange={(e) => setEditForm({ ...editForm, parent_guardian_email: e.target.value })} placeholder="Leave blank if not needed" />
              </div>
            </div>
            <div className="form-group" id="sa-gap-address">
              <label>Address</label>
              <AddressAutocomplete value={editForm.address || ''} onChange={(v) => setEditForm({ ...editForm, address: v })} placeholder="Start typing an address..." />
            </div>
            <div className="form-group">
              <label>Diagnosis</label>
              <textarea value={editForm.diagnosis || ''} onChange={(e) => setEditForm({ ...editForm, diagnosis: e.target.value })} rows={2} />
            </div>
            <div className="form-group">
              <label>Pricing Region (Remoteness)</label>
              <select value={editForm.remoteness || 'standard'} onChange={(e) => setEditForm({ ...editForm, remoteness: e.target.value })}>
                <option value="standard">Standard (Non-Remote)</option>
                <option value="remote">Remote</option>
                <option value="very_remote">Very Remote</option>
              </select>
            </div>
            <div className="form-group">
              <label>Default Price Item</label>
              <select value={editForm.default_ndis_line_item_id || ''} onChange={(e) => setEditForm({ ...editForm, default_ndis_line_item_id: e.target.value || null })}>
                <option value="">None</option>
                {allNdisItems.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.support_item_number} – {n.description?.slice(0, 50)}
                    {n.description?.length > 50 ? '…' : ''} (${n.rate?.toFixed(2)}/{n.unit || 'hr'})
                  </option>
                ))}
              </select>
              <small style={{ color: '#64748b' }}>Pre-selected when adding charges to shifts for this participant</small>
            </div>
            <div className="form-group">
              <label>Default Billing Category</label>
              <select value={editForm.default_billing_category || ''} onChange={(e) => setEditForm({ ...editForm, default_billing_category: e.target.value || null })}>
                <option value="">None (use org default 04)</option>
                {(supportCategories.length > 0 ? supportCategories : FALLBACK_SUPPORT_CATEGORIES).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} – {c.name}
                  </option>
                ))}
              </select>
              <small style={{ color: '#64748b' }}>Shifts for this client are billed under this category by default.</small>
            </div>
            <div className="form-group">
              <label className="checkbox-label" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!editForm.invoice_includes_gst}
                  onChange={(e) => setEditForm({ ...editForm, invoice_includes_gst: e.target.checked ? 1 : 0 })}
                  style={{ marginTop: '0.2rem' }}
                />
                <span>
                  <strong>Include GST on invoices</strong>
                  <small style={{ display: 'block', color: '#64748b', fontWeight: 'normal' }}>
                    When checked, PDF invoices add 10% GST to line totals for this participant. Leave unchecked for GST-free NDIS-style invoices (default).
                  </small>
                </span>
              </label>
            </div>
            <div className="form-group">
              <label>Services Required (tick NDIA or Plan managed per service)</label>
              <div className="services-with-management">
                {(supportCategories.length > 0 ? supportCategories : FALLBACK_SUPPORT_CATEGORIES).map((c) => {
                  const servicesList = typeof editForm.services_required === 'string'
                    ? (() => { try { return JSON.parse(editForm.services_required || '[]'); } catch { return []; } })()
                    : (editForm.services_required || []);
                  const ndiaList = typeof editForm.ndia_managed_services === 'string'
                    ? (() => { try { return JSON.parse(editForm.ndia_managed_services || '[]'); } catch { return []; } })()
                    : (editForm.ndia_managed_services || []);
                  const planList = typeof editForm.plan_managed_services === 'string'
                    ? (() => { try { return JSON.parse(editForm.plan_managed_services || '[]'); } catch { return []; } })()
                    : (editForm.plan_managed_services || []);
                  const required = Array.isArray(servicesList) && servicesList.includes(c.id);
                  const ndia = Array.isArray(ndiaList) && ndiaList.includes(c.id);
                  const plan = Array.isArray(planList) && planList.includes(c.id);
                  return (
                    <div key={c.id} className="service-row">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={required}
                          onChange={() => {
                            const current = Array.isArray(servicesList) ? servicesList : [];
                            const next = required ? current.filter((x) => x !== c.id) : [...current, c.id];
                            const nextNdia = ndiaList.filter((x) => x !== c.id);
                            const nextPlan = planList.filter((x) => x !== c.id);
                            setEditForm({ ...editForm, services_required: next, ndia_managed_services: nextNdia, plan_managed_services: nextPlan });
                          }}
                        />
                        <span className="service-name">{c.id} – {c.name}</span>
                      </label>
                      {required && (
                        <div className="management-ticks">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={ndia}
                              onChange={() => {
                                const nextNdia = ndia ? ndiaList.filter((x) => x !== c.id) : [...ndiaList, c.id];
                                const nextPlan = ndia ? planList : planList.filter((x) => x !== c.id);
                                setEditForm({ ...editForm, ndia_managed_services: nextNdia, plan_managed_services: nextPlan });
                              }}
                            />
                            <span>NDIA</span>
                          </label>
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={plan}
                              onChange={() => {
                                const nextPlan = plan ? planList.filter((x) => x !== c.id) : [...planList, c.id];
                                const nextNdia = plan ? ndiaList : ndiaList.filter((x) => x !== c.id);
                                setEditForm({ ...editForm, plan_managed_services: nextPlan, ndia_managed_services: nextNdia });
                              }}
                            />
                            <span>Plan</span>
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="submit" className="btn btn-primary">Save</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setEditForm(null); setInvoiceEmailInput(''); }}>Cancel</button>
            </div>
          </form>
        </div>
      ) : (
        <>
          {/* Astalty-style card layout */}
          <div className="profile-cards">
            {/* Key Information card */}
            <div className="profile-card">
              <div className="profile-card-header">
                <h3 className="profile-card-title">Key Information</h3>
              </div>
              <CopyableField label="NDIS Number" value={data.ndis_number} />
              <CopyableField label="Management Type" value={data.management_type === 'plan' ? 'Plan-managed' : data.management_type === 'ndia' ? 'NDIA-managed' : 'Self-managed'} showCopy={false} />
              <CopyableField label="Pricing Region" value={data.remoteness === 'remote' ? 'Remote' : data.remoteness === 'very_remote' ? 'Very Remote' : 'Standard'} showCopy={false} />
              <CopyableField
                label="Invoice GST"
                value={data.invoice_includes_gst ? '10% GST on invoice totals' : 'GST-free (default)'}
                showCopy={false}
              />
              {(data.management_type === 'plan' || data.plan_manager_name) && (
                <CopyableField label="Plan Manager" value={data.plan_manager_name} />
              )}
              {data.management_type === 'plan' && data.plan_manager_email && (invoiceRec.kind === 'explicit' || invoiceRec.kind === 'none') && (
                <CopyableField
                  label="Plan manager organisation email"
                  value={data.plan_manager_email}
                />
              )}
              {invoiceRec.kind === 'explicit' && invoiceRec.emails.length > 0 && (
                <div className="copyable-field" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.35rem' }}>
                  <span className="copyable-field-label">Invoice email(s) — financial batch + email send</span>
                  {invoiceRec.emails.map((em, i) => (
                    <CopyableField key={`${em}-${i}`} label={i === 0 ? 'Primary' : 'Also (CC)'} value={em} />
                  ))}
                  <small style={{ color: '#64748b', lineHeight: 1.4 }}>
                    First address is the main recipient when you send a batch; Xero uses it for the contact when a new contact is created.
                    Connect email under Settings to send from Nexus.
                  </small>
                </div>
              )}
              {invoiceRec.kind === 'fallback' && invoiceRec.emails.length > 0 && (
                <div className="copyable-field" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.35rem' }}>
                  <span className="copyable-field-label">Invoice email(s) — using fallback</span>
                  <CopyableField label="Primary (only)" value={invoiceRec.emails[0]} />
                  <small style={{ color: '#64748b', lineHeight: 1.4 }}>
                    None listed under “Invoice email(s)”. Nexus is using the {invoiceRec.note}. Add explicit invoice addresses in
                    Edit to change this and add CCs.
                  </small>
                </div>
              )}
              {invoiceRec.kind === 'none' && (data.management_type || 'self') === 'ndia' && (
                <div className="copyable-field" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem' }}>
                  <span className="copyable-field-label">Invoices (NDIA-managed)</span>
                  <small style={{ color: '#64748b', lineHeight: 1.4, display: 'block' }}>
                    Set invoice email(s) in Edit to send financial batch PDFs by email. NDIA plan billing often uses the
                    Invoices / export workflow; connect email in Settings to send.
                  </small>
                </div>
              )}
              {invoiceRec.kind === 'none' && (data.management_type || 'self') !== 'ndia' && (
                <div className="copyable-field" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem' }}>
                  <span className="copyable-field-label">Invoice email(s)</span>
                  <span className="copyable-field-value" style={{ color: '#b45309' }}>
                    No address resolved — add invoice email(s) in Edit, or
                    {data.management_type === 'plan' ? ' set the plan manager organisation’s email' : ' add the participant email (self-managed)'}.
                  </span>
                </div>
              )}
              {data.plans?.length > 0 && (() => {
                const current = data.plans.find(p => new Date(p.end_date) >= new Date());
                return current ? (
                  <CopyableField label="Current Plan" value={`${formatDate(current.start_date)} – ${formatDate(current.end_date)}`} showCopy={false} />
                ) : null;
              })()}
              {data.default_line_item_number && (
                <CopyableField label="Default Price Item" value={`${data.default_line_item_number} – ${data.default_line_item_description?.slice(0, 40) || ''}${data.default_line_item_description?.length > 40 ? '…' : ''}`} showCopy={false} />
              )}
            </div>

            {/* Participant Details card */}
            <div className="profile-card">
              <div className="profile-card-header">
                <h3 className="profile-card-title">Participant Details</h3>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setEditForm({ ...data, invoice_emails: parseInvoiceEmailsField(data.invoice_emails) });
                    setInvoiceEmailInput('');
                  }}
                >
                  Edit
                </button>
              </div>
              <CopyableField label="Email" value={data.email} />
              <CopyableField label="Phone" value={data.phone} />
              {(data.parent_guardian_phone || data.parent_guardian_email) && (
                <>
                  <CopyableField label="Parent/Guardian Phone" value={data.parent_guardian_phone} />
                  <CopyableField label="Parent/Guardian Email" value={data.parent_guardian_email} />
                </>
              )}
              {data.diagnosis && (
                <CopyableField label="Primary Diagnosis" value={data.diagnosis} showCopy={true} />
              )}
            </div>

            {/* Address card - full width */}
            <div className="profile-card profile-card-full">
              <div className="profile-card-header">
                <h3 className="profile-card-title">Address</h3>
              </div>
              <CopyableField label="Address" value={data.address} />
            </div>

            {/* Services card - full width if has services */}
            {(() => {
              const sr = data.services_required;
              const list = typeof sr === 'string' ? (() => { try { return JSON.parse(sr || '[]'); } catch { return []; } })() : (sr || []);
              const ndia = data.ndia_managed_services;
              const ndiaList = typeof ndia === 'string' ? (() => { try { return JSON.parse(ndia || '[]'); } catch { return []; } })() : (ndia || []);
              const plan = data.plan_managed_services;
              const planList = typeof plan === 'string' ? (() => { try { return JSON.parse(plan || '[]'); } catch { return []; } })() : (plan || []);
              const hasServices = (Array.isArray(list) && list.length > 0) || (Array.isArray(ndiaList) && ndiaList.length > 0) || (Array.isArray(planList) && planList.length > 0);
              if (!hasServices) return null;
              const cats = supportCategories.length > 0 ? supportCategories : FALLBACK_SUPPORT_CATEGORIES;
              const names = Array.isArray(list) ? list.map((id) => cats.find((c) => c.id === id)?.name || id).join(', ') : '';
              const ndiaNames = Array.isArray(ndiaList) ? ndiaList.map((id) => cats.find((c) => c.id === id)?.name || id).join(', ') : '';
              const planNames = Array.isArray(planList) ? planList.map((id) => cats.find((c) => c.id === id)?.name || id).join(', ') : '';
              return (
                <div className="profile-card profile-card-full">
                  <div className="profile-card-header">
                    <h3 className="profile-card-title">Services</h3>
                  </div>
                  {Array.isArray(list) && list.length > 0 && (
                    <CopyableField label="Services Required" value={names} showCopy={false} />
                  )}
                  {Array.isArray(ndiaList) && ndiaList.length > 0 && (
                    <CopyableField label="NDIA-managed" value={ndiaNames} showCopy={false} />
                  )}
                  {Array.isArray(planList) && planList.length > 0 && (
                    <CopyableField label="Plan-managed" value={planNames} showCopy={false} />
                  )}
                </div>
              );
            })()}

            <div className="profile-card profile-card-full">
              <div className="profile-card-header">
                <h3 className="profile-card-title">Onboarding</h3>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleRunOnboarding}
                    disabled={orchestratorBusy || onboardingReadiness?.ready === false}
                    title={
                      onboardingReadiness?.ready === false
                        ? onboardingReadiness?.reason
                        : 'Initialise onboarding, ensure templates are cloned, and generate every required form'
                    }
                  >
                    {orchestratorBusy ? 'Running…' : 'Run onboarding'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => { setShowIntakeSendPanel((v) => !v); setIntakeLinkResult(null); setIntakeLinkError(''); }}
                    title="Send the participant a private link so they can fill in their own intake details"
                  >
                    Send self-intake link
                  </button>
                  <Link to={`${pathPrefix}/onboarding/${id}`} className="btn btn-secondary">Open onboarding</Link>
                </div>
              </div>

              {/* ── Send-to panel ── */}
              {showIntakeSendPanel && (
                <div style={{ marginBottom: '0.75rem', padding: '0.9rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                  <p style={{ margin: '0 0 0.6rem', fontWeight: 600, fontSize: '0.9rem', color: '#1e293b' }}>Send intake form to:</p>
                  <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem', fontSize: '0.9rem', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="intakeSendTo"
                      checked={intakeSendToMode === 'participant'}
                      onChange={() => setIntakeSendToMode('participant')}
                    />
                    Participant's email on file
                    {participant?.email ? (
                      <span style={{ color: '#475569', fontSize: '0.85rem' }}>({participant.email})</span>
                    ) : (
                      <span style={{ color: '#b91c1c', fontSize: '0.85rem' }}>(no email on file)</span>
                    )}
                  </label>
                  <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.6rem', fontSize: '0.9rem', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="intakeSendTo"
                      checked={intakeSendToMode === 'other'}
                      onChange={() => setIntakeSendToMode('other')}
                    />
                    Another email address (guardian, family, coordinator)
                  </label>
                  {intakeSendToMode === 'other' && (
                    <div style={{ display: 'grid', gap: '0.5rem', marginBottom: '0.6rem', paddingLeft: '1.5rem' }}>
                      <input
                        type="email"
                        className="form-input"
                        placeholder="Email address"
                        value={intakeSendToEmail}
                        onChange={(e) => setIntakeSendToEmail(e.target.value)}
                        style={{ maxWidth: 320 }}
                      />
                      <input
                        type="text"
                        className="form-input"
                        placeholder="Who is this? e.g. Parent: Jane Smith (optional)"
                        value={intakeSendToNote}
                        onChange={(e) => setIntakeSendToNote(e.target.value)}
                        style={{ maxWidth: 320 }}
                      />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleSendIntakeLink}
                      disabled={intakeIssuing}
                    >
                      {intakeIssuing ? 'Sending…' : 'Send intake link'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setShowIntakeSendPanel(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {intakeLinkResult && (
                <div style={{ padding: '0.5rem 0.75rem', border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534', borderRadius: 6, marginBottom: '0.5rem', fontSize: '0.85rem' }}>
                  {intakeLinkResult.email_sent
                    ? <>Intake link emailed to {intakeLinkResult.send_to_email || 'participant'}. Expires {new Date(intakeLinkResult.expires_at).toLocaleDateString('en-AU')}. </>
                    : <>Intake link generated (email not sent). Expires {new Date(intakeLinkResult.expires_at).toLocaleDateString('en-AU')}. </>}
                  <a href={intakeLinkResult.url} target="_blank" rel="noreferrer">Copy / open link</a>
                  {intakeLinkResult.email_error && (
                    <div style={{ marginTop: '.25rem', color: '#991b1b' }}>Email failed: {intakeLinkResult.email_error}</div>
                  )}
                </div>
              )}
              {intakeLinkError && (
                <div style={{ padding: '0.5rem 0.75rem', border: '1px solid #fecaca', background: '#fee2e2', color: '#991b1b', borderRadius: 6, marginBottom: '0.5rem', fontSize: '0.85rem' }}>
                  {intakeLinkError}
                </div>
              )}
              {onboardingReadiness?.ready === false && (
                <div
                  style={{
                    padding: '0.5rem 0.75rem',
                    border: '1px solid #fcd34d',
                    background: '#fef3c7',
                    color: '#78350f',
                    borderRadius: 6,
                    marginBottom: '0.5rem',
                    fontSize: '0.85rem'
                  }}
                >
                  <strong>Not ready:</strong> {onboardingReadiness.reason}
                  {onboardingReadiness.code === 'NO_POLICY_PDFS' || onboardingReadiness.code === 'NO_DOCUMENT_PACK' ? (
                    <>
                      {' '}
                      <Link to={`${pathPrefix}/forms`}>Open Forms to fix</Link>.
                    </>
                  ) : null}
                </div>
              )}
              {orchestratorError && (
                <div style={{ padding: '0.5rem 0.75rem', border: '1px solid #fecaca', background: '#fee2e2', color: '#991b1b', borderRadius: 6, marginBottom: '0.5rem', fontSize: '0.85rem' }}>
                  {orchestratorError}
                </div>
              )}
              {orchestratorResult?.steps?.length > 0 && (
                <details style={{ marginBottom: '0.5rem' }}>
                  <summary style={{ cursor: 'pointer', fontSize: '0.88rem', color: '#334155' }}>
                    Last run — {orchestratorResult.completed_steps}/{orchestratorResult.total_steps} steps OK · next: {orchestratorResult.next_action}
                  </summary>
                  <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', fontSize: '0.85rem' }}>
                    {orchestratorResult.steps.map((s) => (
                      <li key={s.name} style={{ color: s.ok ? '#15803d' : '#b91c1c' }}>
                        {s.ok ? '✓' : '✗'} {s.name}
                        {s.skipped ? ' (skipped)' : ''}
                        {s.error ? ` — ${s.error}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {onboardingState ? (
                <div style={{ display: 'grid', gap: '0.35rem' }}>
                  <div><strong>Status:</strong> {onboardingState.status}</div>
                  <div><strong>Stage:</strong> {onboardingState.current_stage}</div>
                  <div>
                    <strong>Forms:</strong> {onboardingState.form_status_summary?.signed || 0} signed / {onboardingState.form_status_summary?.total || 0} total
                    {` (${onboardingState.form_status_summary?.pending || 0} pending)`}
                  </div>
                </div>
              ) : (
                <p style={{ color: '#64748b' }}>Onboarding has not been initialised yet — click "Run onboarding" to do it in one step.</p>
              )}
            </div>
          </div>
        </>
      )}

      {starredContacts.length > 0 && (
        <div className="card">
          <h3>Starred Contacts</h3>
          <div className="starred-contacts-grid">
            {starredContacts.map((c) => (
              <div key={c.id} className="starred-contact-card">
                <strong>{c.contact_name || c.name}</strong>
                <span className="starred-contact-relationship">{c.relationship}</span>
                <CopyableField label="Contact" value={c.contact_phone || c.contact_email} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="tabs">
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`tab ${tab === 'plans' ? 'active' : ''}`} onClick={() => setTab('plans')}>NDIS Plans & Budget</button>
        <button className={`tab ${tab === 'contacts' ? 'active' : ''}`} onClick={() => setTab('contacts')}>Contacts</button>
        <button className={`tab ${tab === 'goals' ? 'active' : ''}`} onClick={() => setTab('goals')}>Goals</button>
        <button className={`tab ${tab === 'documents' ? 'active' : ''}`} onClick={() => setTab('documents')}>Documents</button>
        <button className={`tab ${tab === 'agreements' ? 'active' : ''}`} onClick={() => setTab('agreements')}>Agreements</button>
        <button className={`tab ${tab === 'casenotes' ? 'active' : ''}`} onClick={() => setTab('casenotes')}>Case Notes</button>
        <button className={`tab ${tab === 'shifts' ? 'active' : ''}`} onClick={() => setTab('shifts')}>Shifts</button>
      </div>

      {tab === 'overview' && (
        <div className="card">
          <h3>Budget Breakdown & Utilisation</h3>
          {budgetUtilization?.plan && budgetUtilization?.budgets?.length > 0 ? (
            <div>
              <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '1rem' }}>
                Current plan: {formatDate(budgetUtilization.plan.start_date)} – {formatDate(budgetUtilization.plan.end_date)}
              </p>
              {(() => {
                const totals = budgetUtilization.budgets.reduce((acc, b) => {
                  const invoiced = Number(b.invoiced ?? b.used) || 0;
                  const pending = Number(b.pending_invoice) || 0;
                  acc.amount += Number(b.amount) || 0;
                  acc.invoiced += invoiced;
                  acc.pending_invoice += pending;
                  acc.remaining += Number(b.remaining) || 0;
                  return acc;
                }, { amount: 0, invoiced: 0, pending_invoice: 0, remaining: 0 });
                const totalPercent = totals.amount > 0 ? Math.round((totals.invoiced / totals.amount) * 100) : 0;
                return (
                  <table style={{ width: '100%', fontSize: '0.92rem', marginBottom: '1rem' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>Category</th>
                        <th style={{ textAlign: 'right' }}>Budget</th>
                        <th style={{ textAlign: 'right' }}>Invoiced</th>
                        <th style={{ textAlign: 'right' }}>Pending</th>
                        <th style={{ textAlign: 'right' }}>Remaining</th>
                        <th style={{ textAlign: 'right' }}>Utilisation</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0', borderBottom: '1px solid #e2e8f0' }}>
                        <td><strong>Plan total</strong></td>
                        <td style={{ textAlign: 'right' }}><strong>${totals.amount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</strong></td>
                        <td style={{ textAlign: 'right' }}>
                          <strong>
                            <ParticipantInvoicedFinancialLink participantId={id} participantName={data?.name} amount={totals.invoiced}>
                              ${totals.invoiced.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                            </ParticipantInvoicedFinancialLink>
                          </strong>
                        </td>
                        <td style={{ textAlign: 'right' }}><strong>${totals.pending_invoice.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</strong></td>
                        <td style={{ textAlign: 'right' }}><strong>${totals.remaining.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</strong></td>
                        <td style={{ textAlign: 'right' }}>
                          <span className={`badge ${totalPercent >= 90 ? 'badge-danger' : totalPercent >= 70 ? 'badge-warning' : 'badge-success'}`}>
                            {totalPercent}% invoiced
                          </span>
                        </td>
                      </tr>
                      {budgetUtilization.budgets.map((b) => {
                        const invoiced = Number(b.invoiced ?? b.used) || 0;
                        const pending = Number(b.pending_invoice) || 0;
                        return (
                          <tr key={b.id}>
                            <td>
                              <span style={{ color: '#64748b', marginRight: '0.35rem' }}>↳</span>
                              <strong>{b.category || '—'}</strong> {supportCategories.find(c => c.id === b.category)?.name || b.name}
                            </td>
                            <td style={{ textAlign: 'right' }}>${Number(b.amount).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</td>
                            <td style={{ textAlign: 'right' }}>
                              <ParticipantInvoicedFinancialLink participantId={id} participantName={data?.name} amount={invoiced}>
                                ${invoiced.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </ParticipantInvoicedFinancialLink>
                            </td>
                            <td style={{ textAlign: 'right' }}>${pending.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</td>
                            <td style={{ textAlign: 'right' }}>${Number(b.remaining).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</td>
                            <td style={{ textAlign: 'right' }}>
                              <span className={`badge ${b.percent_used >= 90 ? 'badge-danger' : b.percent_used >= 70 ? 'badge-warning' : 'badge-success'}`}>
                                {b.percent_used}% invoiced
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}
              <p style={{ marginTop: '0.75rem', fontSize: '0.82rem', color: '#64748b', lineHeight: 1.45 }}>
                <strong>Invoiced</strong> sums amounts on Financial batch invoices (non-void) in this plan period, matched to each budget&apos;s NDIS line items.
                {' '}
                When an invoiced total is above zero, click it to open <strong>Financial → Invoices</strong> for this participant and see paid vs outstanding on each batch (and shift) invoice.
                {' '}
                <strong>Pending</strong> is support recorded (shifts and billable coordinator tasks) that is not yet on a batch invoice.
              </p>
              <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: '#64748b' }}>
                <button type="button" className="btn btn-secondary" style={{ fontSize: '0.85rem' }} onClick={() => setTab('plans')}>
                  Manage plans & budgets →
                </button>
              </p>
            </div>
          ) : (
            <p style={{ color: '#64748b' }}>
              No current plan with budgets. Add a plan and budget categories in the <button type="button" className="btn btn-secondary" style={{ fontSize: '0.85rem' }} onClick={() => setTab('plans')}>NDIS Plans & Budget</button> tab.
            </p>
          )}
        </div>
      )}

      {tab === 'plans' && (
        <div className="card" id="sa-gap-plans">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h3>NDIS Plans</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', color: '#475569', marginRight: '0.25rem' }}>
                <input
                  type="checkbox"
                  checked={planUploadForceOcr}
                  onChange={(e) => setPlanUploadForceOcr(e.target.checked)}
                  disabled={planBreakdownLoading}
                />
                Scanned PDF — full-page OCR
              </label>
              <label className="btn btn-primary" style={{ marginBottom: 0, cursor: 'pointer' }}>
                {planBreakdownLoading ? 'Parsing…' : 'Upload plan (PDF)'}
                <input type="file" accept=".pdf,application/pdf" onChange={handlePlanFileUpload} disabled={planBreakdownLoading} style={{ display: 'none' }} />
              </label>
              <button className="btn btn-secondary" onClick={() => setShowPlanModal(true)}>Add plan manually</button>
            </div>
          </div>
          <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '1rem' }}>
            Upload the participant&apos;s NDIS plan as a PDF. Text is read from the file; if the plan is a scan or has little selectable text, the server rasterizes pages and runs OCR (requires poppler on the server). Check &quot;Scanned PDF&quot; to always run OCR on every page. Budgets and goals use deterministic rules; local AI is optional when available.
          </p>

          <div style={{ marginBottom: '1.25rem', padding: '1rem', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fafafa' }}>
            <h4 style={{ margin: '0 0 0.5rem 0' }}>Plan manager statement</h4>
            <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.75rem', lineHeight: 1.45 }}>
              Monthly plan-manager statements show remaining funding by category and spending by provider. Use the same PDF text pipeline as plan upload (optional full-page OCR). Preview parses only; Parse &amp; apply sets each category budget to the <strong>remaining</strong> amount from the statement and records matched providers&apos; spend on coordinator allocations (stored on each allocation&apos;s details). Providers on the statement with no matching allocation still appear under the category. Trends estimate daily burn from the statement period and project when funds may run out.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.65rem' }}>
              <label style={{ fontSize: '0.82rem', color: '#475569' }}>
                Plan:
                <select
                  value={planStatementPlanId}
                  onChange={(e) => setPlanStatementPlanId(e.target.value)}
                  style={{ marginLeft: '0.35rem', padding: '0.25rem 0.4rem', maxWidth: 280 }}
                >
                  {(data?.plans || []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {formatDate(p.start_date)} – {formatDate(p.end_date)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', color: '#475569' }}>
                <input type="checkbox" checked={planStatementUseAi} onChange={(e) => setPlanStatementUseAi(e.target.checked)} disabled={planStatementLoading} />
                Local AI (recommended)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', color: '#475569' }}>
                <input type="checkbox" checked={planStatementOcr} onChange={(e) => setPlanStatementOcr(e.target.checked)} disabled={planStatementLoading} />
                Force OCR
              </label>
              <label className="btn btn-secondary" style={{ marginBottom: 0, cursor: planStatementLoading || !planStatementPlanId ? 'not-allowed' : 'pointer', opacity: planStatementLoading || !planStatementPlanId ? 0.6 : 1 }}>
                {planStatementLoading ? 'Working…' : 'Preview statement'}
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  disabled={planStatementLoading || !planStatementPlanId}
                  onChange={(e) => handlePlanStatementUpload(e, false)}
                  style={{ display: 'none' }}
                />
              </label>
              <label className="btn btn-primary" style={{ marginBottom: 0, cursor: planStatementLoading || !planStatementPlanId ? 'not-allowed' : 'pointer', opacity: planStatementLoading || !planStatementPlanId ? 0.6 : 1 }}>
                Parse &amp; apply
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  disabled={planStatementLoading || !planStatementPlanId}
                  onChange={(e) => handlePlanStatementUpload(e, true)}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
            {planStatementParsed && (
              <div style={{ marginTop: '0.75rem', fontSize: '0.82rem' }}>
                {planStatementParsed.ocr_used && (
                  <div style={{ color: '#166534', marginBottom: '0.35rem' }}>OCR was used — verify dollar amounts against the original PDF.</div>
                )}
                {planStatementParsed.validation_warning && (
                  <div style={{ padding: '0.5rem', background: '#fef3c7', color: '#92400e', borderRadius: 6, marginBottom: '0.5rem' }}>
                    {planStatementParsed.validation_warning}
                  </div>
                )}
                {planStatementParsed.apply_result && (
                  <div style={{ marginBottom: '0.5rem', color: '#475569' }}>
                    Apply: {planStatementParsed.apply_result.budgets_updated} budget(s) updated, {planStatementParsed.apply_result.implementations_updated} allocation(s) tagged with statement spend.
                  </div>
                )}
                {planStatementParsed.merged?.plan_total?.from_statement && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '0.5rem' }}>
                    {planStatementParsed.merged.plan_total.from_statement.remaining != null && (
                      <span><strong>Plan total remaining (statement):</strong> ${Number(planStatementParsed.merged.plan_total.from_statement.remaining).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>
                    )}
                    {planStatementParsed.merged.plan_total.from_statement.spent != null && (
                      <span><strong>Plan total spent (statement):</strong> ${Number(planStatementParsed.merged.plan_total.from_statement.spent).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>
                    )}
                  </div>
                )}
                {planStatementParsed.merged?.plan_total?.trends?.projected_plan_depletion_date && (
                  <div style={{ marginBottom: '0.5rem', color: '#334155' }}>
                    <strong>Plan-wide trend:</strong> ~${Number(planStatementParsed.merged.plan_total.trends.avg_daily_spend_plan_to_date || 0).toFixed(2)}/day to date → if spending continues, remaining funds may last until{' '}
                    {formatDate(planStatementParsed.merged.plan_total.trends.projected_plan_depletion_date)} (indicative).
                  </div>
                )}
                {planStatementParsed.merged?.funding_release?.from_statement && (
                  <div style={{ marginBottom: '0.5rem', padding: '0.5rem', background: '#f1f5f9', borderRadius: 6 }}>
                    <strong>Funding release (statement):</strong>{' '}
                    {planStatementParsed.merged.funding_release.from_statement.label || 'Current period'}
                    {planStatementParsed.merged.funding_release.from_statement.remaining != null && (
                      <> — remaining ${Number(planStatementParsed.merged.funding_release.from_statement.remaining).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</>
                    )}
                    {planStatementParsed.merged.funding_release.trends?.projected_release_depletion_date && (
                      <span style={{ marginLeft: '0.5rem' }}>
                        (trend: ~${Number(planStatementParsed.merged.funding_release.trends.avg_daily_spend || 0).toFixed(2)}/day in period → ~{formatDate(planStatementParsed.merged.funding_release.trends.projected_release_depletion_date)})
                      </span>
                    )}
                  </div>
                )}
                {(planStatementParsed.merged?.rows || []).length > 0 && (
                  <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem' }}>
                    {planStatementParsed.merged.rows.map((row) => (
                      <div key={row.category} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.6rem 0.75rem', background: '#fff' }}>
                        <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                          {row.category} — {row.category_label}
                          {row.local_budget_name && <span style={{ fontWeight: 400, color: '#64748b' }}> ({row.local_budget_name})</span>}
                        </div>
                        <div style={{ fontSize: '0.78rem', color: '#475569', marginBottom: '0.35rem' }}>
                          Statement: remaining{' '}
                          {row.statement_remaining != null ? `$${Number(row.statement_remaining).toLocaleString('en-AU', { minimumFractionDigits: 2 })}` : '—'}
                          {' · '}spent{' '}
                          {row.statement_spent != null ? `$${Number(row.statement_spent).toLocaleString('en-AU', { minimumFractionDigits: 2 })}` : '—'}
                          {row.local_amount_before != null && (
                            <span> · local budget before apply: ${Number(row.local_amount_before).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>
                          )}
                        </div>
                        {row.trends?.projected_depletion_date && row.statement_remaining != null && (
                          <div style={{ fontSize: '0.76rem', color: '#64748b', marginBottom: '0.35rem' }}>
                            Trend: ~${Number(row.trends.avg_daily_spend_statement_period || 0).toFixed(2)}/day (statement period) → remaining may last until {formatDate(row.trends.projected_depletion_date)} (indicative).
                          </div>
                        )}
                        {(row.provider_rows || []).length > 0 && (
                          <div style={{ marginTop: '0.35rem' }}>
                            <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#94a3b8' }}>Providers (matched to allocations)</div>
                            <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                              {row.provider_rows.map((pr) => (
                                <li key={`${row.category}-${pr.allocation_id}`} style={{ marginBottom: '0.15rem' }}>
                                  {pr.provider_name || pr.provider_statement_name}: statement spend ${Number(pr.statement_spend).toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                  {pr.coordinator_annual_allocation != null && (
                                    <span style={{ color: '#64748b' }}> · coordinator allocation ${Number(pr.coordinator_annual_allocation).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {(row.providers_not_matched_to_allocations || []).length > 0 && (
                          <div style={{ marginTop: '0.35rem' }}>
                            <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#94a3b8' }}>Statement providers (no allocation match)</div>
                            <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                              {row.providers_not_matched_to_allocations.map((u) => (
                                <li key={u.name}>
                                  {u.name}: ${Number(u.spent).toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {planBreakdownParsed && planBreakdownParsed.budgets?.length > 0 && (
            <div style={{ border: '1px solid #22c55e', borderRadius: 8, padding: '1rem', marginBottom: '1rem', background: '#f0fdf4' }}>
              <div style={{ marginBottom: '1rem', padding: '0.5rem', background: '#dcfce7', borderRadius: 6, fontSize: '0.95rem', display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
                {(planBreakdownParsed.plan_dates?.start_date || planBreakdownParsed.plan_dates?.end_date) && (
                  <span><strong>Plan period:</strong> {formatDate(planBreakdownParsed.plan_dates.start_date)} – {formatDate(planBreakdownParsed.plan_dates.end_date)}</span>
                )}
                {planBreakdownParsed.total_plan_budget != null && (
                  <span><strong>Plan total (from document):</strong> ${planBreakdownParsed.total_plan_budget.toLocaleString()}</span>
                )}
                <span><strong>Breakdown total:</strong> ${planBreakdownParsed.budgets.reduce((s, b) => s + (b.amount || 0), 0).toLocaleString()}</span>
                {planBreakdownParsed.ocr_used && (
                  <span style={{ color: '#166534' }}><strong>OCR:</strong> full-page text extraction (verify figures)</span>
                )}
              </div>
              {(() => {
                const sum = planBreakdownParsed.budgets.reduce((s, b) => s + (b.amount || 0), 0);
                const total = planBreakdownParsed.total_plan_budget;
                const mismatch = total != null && total > 0 && Math.abs(sum - total) / total > 0.01;
                const msg = planBreakdownParsed.validation_warning || (mismatch ? `Budget total ($${sum.toLocaleString()}) does not match plan total ($${total.toLocaleString()}). Check for missing or incorrect categories.` : null);
                return msg ? (
                  <div style={{ marginBottom: '1rem', padding: '0.5rem', background: '#fef3c7', color: '#92400e', borderRadius: 6, fontSize: '0.9rem' }}>
                    {msg}
                  </div>
                ) : null;
              })()}
              {(() => {
                const reasons = (planBreakdownParsed.budgets || [])
                  .filter((b) => b.validation_status === 'needs_review' && b.validation_reason)
                  .map((b) => `${b.category}: ${b.validation_reason}`);
                return reasons.length > 0 ? (
                  <div style={{ marginBottom: '1rem', padding: '0.5rem', background: '#fef3c7', color: '#92400e', borderRadius: 6, fontSize: '0.85rem' }}>
                    <strong>Needs review:</strong> {reasons.join(' | ')}
                  </div>
                ) : null;
              })()}
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem', marginBottom: '0.9rem', background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <h4 style={{ margin: 0 }}>Plan goals (participant goals section)</h4>
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={handleAddParsedGoal}>
                    + Add goal
                  </button>
                </div>
                <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.35rem 0 0.6rem 0' }}>
                  The participant goals section of an NDIS plan (statement of goals, your goals, etc.) is separate from the funding and budget breakdown. Text parsed here is taken from that goals section. When you apply the plan, these are stored on the participant Goals tab only—they are not attached to individual category budgets.
                </p>
                {(planBreakdownParsed.goals || []).length > 0 ? (
                  <div style={{ display: 'grid', gap: '0.45rem' }}>
                    {(planBreakdownParsed.goals || []).map((goal, idx) => (
                      <div key={`parsed-goal-${idx}`} style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                        <textarea
                          value={goal}
                          onChange={(e) => handleChangeParsedGoal(idx, e.target.value)}
                          rows={2}
                          placeholder="Goal description"
                          style={{ flex: 1, minHeight: 58 }}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', flexShrink: 0 }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ fontSize: '0.72rem', padding: '0.08rem 0.35rem' }}
                            title="Copy goal text for email or documents"
                            onClick={() => copyGoalLine(`parsed-${idx}`, goal)}
                          >
                            {copiedGoalKey === `parsed-${idx}` ? 'Copied' : 'Copy'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ fontSize: '0.72rem', padding: '0.08rem 0.3rem' }}
                            onClick={() => handleRemoveParsedGoal(idx)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: '0.82rem', color: '#64748b' }}>
                    No goals found in this file. You can add goals manually here before applying.
                  </p>
                )}
              </div>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem', marginBottom: '0.9rem', background: '#fff' }}>
                <h4 style={{ margin: '0 0 0.35rem 0' }}>Fund release schedule (optional)</h4>
                <p style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: '0.5rem' }}>
                  Map plan-wide instalments (e.g. quarterly). Budgets and allocations show estimated dollars and hours per release. Dates may be derived from plan start + period when not on the document.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem' }}>
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.12rem 0.4rem' }} onClick={handleEqualQuarterlySchedule}>
                    4 equal quarterly (25% each)
                  </button>
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.12rem 0.4rem' }} onClick={handleAddFundReleaseRow}>
                    + Add release
                  </button>
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.12rem 0.4rem' }} onClick={handleClearFundReleaseSchedule}>
                    Clear schedule
                  </button>
                </div>
                <div className="form-group" style={{ marginBottom: '0.5rem' }}>
                  <label style={{ fontSize: '0.8rem' }}>Period (months) for derived dates</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="e.g. 3 for quarterly"
                    value={planBreakdownParsed.fund_release_schedule?.period_months ?? ''}
                    onChange={(e) => handleFundReleasePeriodMonths(e.target.value)}
                    style={{ width: 120, padding: '0.25rem' }}
                  />
                </div>
                {planBreakdownParsed.fund_release_schedule?.releases?.length > 0 && (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: '0.78rem', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>
                          <th style={{ padding: '0.25rem' }}>Label</th>
                          <th style={{ padding: '0.25rem' }}>Date</th>
                          <th style={{ padding: '0.25rem' }}>Share</th>
                          <th style={{ padding: '0.25rem' }} />
                        </tr>
                      </thead>
                      <tbody>
                        {(planBreakdownParsed.fund_release_schedule.releases || []).map((row, ri) => (
                          <tr key={`fr-${ri}`} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '0.25rem' }}>
                              <input
                                value={row.label || ''}
                                onChange={(e) => handleUpdateFundReleaseRow(ri, { label: e.target.value })}
                                style={{ width: '100%', maxWidth: 120, padding: '0.15rem' }}
                              />
                            </td>
                            <td style={{ padding: '0.25rem' }}>
                              <input
                                type="date"
                                value={row.scheduled_date && /^\d{4}-\d{2}-\d{2}$/.test(row.scheduled_date) ? row.scheduled_date : ''}
                                onChange={(e) => handleUpdateFundReleaseRow(ri, { scheduled_date: e.target.value || null })}
                                style={{ padding: '0.15rem' }}
                              />
                            </td>
                            <td style={{ padding: '0.25rem' }}>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                max="1"
                                value={row.proportion != null ? row.proportion : ''}
                                onChange={(e) => handleUpdateFundReleaseRow(ri, { proportion: e.target.value === '' ? null : parseFloat(e.target.value) })}
                                style={{ width: 72, padding: '0.15rem' }}
                              />
                            </td>
                            <td style={{ padding: '0.25rem' }}>
                              <button type="button" className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.05rem 0.25rem' }} onClick={() => handleRemoveFundReleaseRow(ri)}>Remove</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {(() => {
                  const schS = planBreakdownApplyForm.start_date || planBreakdownParsed.plan_dates?.start_date || '';
                  const schE = planBreakdownApplyForm.end_date || planBreakdownParsed.plan_dates?.end_date || '';
                  const n = normalizeFundReleaseSchedule(planBreakdownParsed.fund_release_schedule, schS, schE);
                  if (!n.releases.length) return null;
                  const total = planBreakdownParsed.total_plan_budget;
                  return (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.76rem', color: '#475569' }}>
                      {n.derived && <div style={{ marginBottom: '0.25rem', color: '#b45309' }}>Derived dates from plan start + period</div>}
                      {n.warnings?.length > 0 && <div style={{ marginBottom: '0.25rem' }}>{n.warnings.join(' ')}</div>}
                      <strong>Preview (normalized)</strong>
                      <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                        {n.releases.map((r, idx) => (
                          <li key={`nprev-${idx}`}>
                            {r.label}: {r.date ? formatDate(r.date) : '—'} — {(r.proportion * 100).toFixed(1)}%
                            {total != null && Number.isFinite(total) ? ` (~$${(total * r.proportion).toLocaleString('en-AU', { minimumFractionDigits: 2 })})` : ''}
                            {r.derived_date ? ' (derived)' : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
              </div>
              <h4 style={{ margin: '0 0 0.5rem 0' }}>Parsed breakdown – {planBreakdownParsed.budgets.length} categories</h4>
              <p style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '0.75rem' }}>
                Click a category to configure provider allocations. Total budget stays fixed; assign rate, hours and frequency to each provider.
              </p>
              <p style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: '0.75rem' }}>
                Core funding (categories 01-04) hours use weekday daytime default rates when exact rates are unavailable.
              </p>
              {(() => {
                const scheduleStart = planBreakdownApplyForm.start_date || planBreakdownParsed.plan_dates?.start_date || '';
                const scheduleEnd = planBreakdownApplyForm.end_date || planBreakdownParsed.plan_dates?.end_date || '';
                const scheduleNorm = normalizeFundReleaseSchedule(planBreakdownParsed.fund_release_schedule, scheduleStart, scheduleEnd);
                return (
              <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1rem' }}>
                {planBreakdownParsed.budgets.map((b, i) => {
                  const allocs = b.allocations || [];
                  const narrative = b.support_narrative?.trim();
                  const budgetAmount = Number.isFinite(Number(b.amount)) ? Number(b.amount) : 0;
                  const budgetName = supportCategories.find(c => c.id === b.category)?.name || b.name;
                  const primaryRate = toNumber(b.primary_rate);
                  const budgetHours = primaryRate > 0 ? budgetAmount / primaryRate : null;
                  const allocatedAmount = allocs.reduce((sum, a) => sum + getAllocationAnnualCost(a, primaryRate), 0);
                  const allocatedHours = allocs.reduce((sum, a) => sum + getAllocationAnnualHours(a, primaryRate), 0);
                  const remainingAmount = budgetAmount - allocatedAmount;
                  const remainingHours = budgetHours != null ? Math.max(0, budgetHours - allocatedHours) : null;
                  const percentUsed = budgetAmount > 0 ? Math.round((allocatedAmount / budgetAmount) * 100) : 0;
                  const tone = getUtilizationTone(percentUsed);
                  const colorway = getBudgetColorway(`parsed:${b.id || i}:${b.category || ''}:${budgetName || ''}`);
                  return (
                    <div key={`budget-${i}`} style={{ border: `1px solid ${colorway.border}`, borderRadius: 10, overflow: 'hidden', background: colorway.cardBg }}>
                      <div style={{ padding: '0.65rem 0.75rem', background: colorway.headerBg, borderBottom: `1px solid ${colorway.border}`, display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', color: colorway.text }}>
                            <strong style={{ color: colorway.text }}>{b.category}</strong>
                            <strong style={{ color: colorway.text }}>{budgetName}</strong>
                            {b.validation_status === 'needs_review' && (
                              <span title={b.validation_reason || 'Requires manual review'} style={{ fontSize: '0.7rem', background: '#fef3c7', color: '#92400e', padding: '2px 6px', borderRadius: 4 }}>
                                Needs review
                              </span>
                            )}
                            {b.validation_status === 'verified' && (
                              <span title="Validated by deterministic parsing and checks" style={{ fontSize: '0.7rem', background: '#dcfce7', color: '#166534', padding: '2px 6px', borderRadius: 4 }}>
                                Verified
                              </span>
                            )}
                            {b.auto_budgeted && (
                              <span title="Detected as Stated support/item and auto-budgeted from plan text" style={{ fontSize: '0.7rem', background: '#e0f2fe', color: '#075985', padding: '2px 6px', borderRadius: 4 }}>
                                Auto-budgeted
                              </span>
                            )}
                            <span className={`badge ${tone.badge}`}>{percentUsed}% used</span>
                            {allocs.length > 0 && (
                              <span style={{ fontSize: '0.8rem', color: colorway.muted }}>{allocs.length} provider{allocs.length !== 1 ? 's' : ''}</span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: colorway.muted, marginTop: '0.2rem' }}>
                            {formatManagementTypeLabel(b.management_type)}
                          </div>
                          {narrative && (
                            <div style={{ fontSize: '0.78rem', color: colorway.muted, marginTop: '0.2rem', lineHeight: 1.3 }} title={narrative}>
                              {narrative.length > 140 ? `${narrative.slice(0, 140)}…` : narrative}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: '0.35rem' }}>
                          <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }} onClick={() => openBudgetConfig('parsed', b, i, null)}>
                            Configure
                          </button>
                        </div>
                      </div>
                      <div style={{ padding: '0.65rem 0.75rem' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.5rem', marginBottom: '0.55rem' }}>
                          <div style={{ border: `1px solid ${colorway.border}`, borderRadius: 8, padding: '0.45rem', background: '#f8faf9' }}>
                            <div style={{ fontSize: '0.76rem', color: colorway.muted }}>Budget</div>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={budgetAmount}
                              onChange={(e) => {
                                const amt = parseFloat(e.target.value) || 0;
                                const updated = [...planBreakdownParsed.budgets];
                                updated[i] = { ...b, amount: amt };
                                setPlanBreakdownParsed({ ...planBreakdownParsed, budgets: updated });
                              }}
                              style={{ width: 110, padding: '0.2rem', marginTop: '0.2rem' }}
                            />
                            <div style={{ fontSize: '0.78rem', color: colorway.muted, marginTop: '0.15rem' }}>{budgetHours != null ? `~${budgetHours.toFixed(1)} hrs` : '—'}</div>
                          </div>
                          <div style={{ border: `1px solid ${colorway.border}`, borderRadius: 8, padding: '0.45rem', background: '#f8faf9' }}>
                            <div style={{ fontSize: '0.76rem', color: colorway.muted }}>Allocated</div>
                            <div style={{ fontWeight: 600 }}>${allocatedAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</div>
                            <div style={{ fontSize: '0.78rem', color: colorway.muted }}>{allocatedHours > 0 ? `~${allocatedHours.toFixed(1)} hrs` : '—'}</div>
                          </div>
                          <div style={{ border: `1px solid ${colorway.border}`, borderRadius: 8, padding: '0.45rem', background: '#f8faf9' }}>
                            <div style={{ fontSize: '0.76rem', color: colorway.muted }}>Remaining</div>
                            <div style={{ fontWeight: 700, color: remainingAmount < 0 ? '#b91c1c' : colorway.text }}>
                              ${remainingAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                            </div>
                            <div style={{ fontSize: '0.78rem', color: colorway.muted }}>{remainingHours != null ? `~${remainingHours.toFixed(1)} hrs` : '—'}</div>
                          </div>
                        </div>
                        {scheduleNorm.releases.length > 0 && (
                          <div style={{ marginTop: '0.45rem', padding: '0.4rem', background: '#f8fafc', borderRadius: 6, fontSize: '0.72rem', color: colorway.muted }}>
                            <div style={{ fontWeight: 600, marginBottom: '0.2rem', color: colorway.text }}>Per fund release (this category)</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                              {scheduleNorm.releases.map((r, ri) => (
                                <span key={`pb-${i}-${ri}`} style={{ border: `1px solid ${colorway.border}`, borderRadius: 4, padding: '0.15rem 0.3rem' }}>
                                  {r.date ? formatDate(r.date) : `#${ri + 1}`}: ${(budgetAmount * r.proportion).toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                  {primaryRate > 0 ? ` (~${(budgetAmount * r.proportion / primaryRate).toFixed(1)} hrs)` : ''}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {allocs.length > 0 ? (
                          <div style={{ display: 'grid', gap: '0.4rem' }}>
                            {allocs.map((a, idx) => {
                              const allocAmount = getAllocationAnnualCost(a, primaryRate);
                              const allocHours = getAllocationAnnualHours(a, primaryRate);
                              const providerName = a.provider_name || orgs.find((o) => String(o.id) === String(a.provider_id))?.name || 'Provider';
                              const serviceName = a.service_name || a.description || 'Unspecified service';
                              return (
                                <div key={`alloc-${i}-${idx}`} style={{ border: `1px solid ${colorway.border}`, borderRadius: 8, padding: '0.45rem', background: '#fff' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                                    <div>
                                      <div style={{ fontSize: '0.78rem', color: colorway.muted }}>↳ {serviceName}</div>
                                      <div style={{ fontWeight: 600 }}>{providerName}</div>
                                      <div style={{ fontSize: '0.78rem', color: colorway.muted }}>
                                        {(a.hours_per_week ?? a.hours) ? `${a.hours_per_week ?? a.hours} hrs` : 'Amount-based'}{a.frequency ? ` / ${a.frequency}` : ''}
                                      </div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                      <div style={{ fontWeight: 600 }}>${allocAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</div>
                                      <div style={{ fontSize: '0.78rem', color: colorway.muted }}>{allocHours > 0 ? `~${allocHours.toFixed(1)} hrs` : '—'}</div>
                                      {scheduleNorm.releases.length > 0 && allocAmount > 0 && (() => {
                                        const hourParts = allocHours > 0 ? splitAnnualHours(allocHours, scheduleNorm.releases) : [];
                                        return (
                                        <div style={{ marginTop: '0.25rem', fontSize: '0.68rem', color: colorway.muted, textAlign: 'left' }}>
                                          {splitAnnualAmount(allocAmount, scheduleNorm.releases).map((p, pi) => (
                                            <div key={`pa-${idx}-${pi}`}>
                                              R{pi + 1}: ${p.amount_portion.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                              {hourParts[pi] ? ` (~${hourParts[pi].hours_portion} hrs)` : ''}
                                            </div>
                                          ))}
                                        </div>
                                        );
                                      })()}
                                      <button type="button" className="btn btn-secondary" style={{ marginTop: '0.2rem', fontSize: '0.72rem', padding: '0.05rem 0.3rem' }} onClick={() => removeParsedAllocation(i, idx)}>
                                        Remove
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.82rem', color: '#64748b' }}>No providers allocated yet.</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
                );
              })()}
              <form onSubmit={handleApplyPlanBreakdown}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end', marginBottom: '0.5rem' }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>Start date</label>
                    <input type="date" value={planBreakdownApplyForm.start_date} onChange={(e) => setPlanBreakdownApplyForm({ ...planBreakdownApplyForm, start_date: e.target.value })} required />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>End date</label>
                    <input type="date" value={planBreakdownApplyForm.end_date} onChange={(e) => setPlanBreakdownApplyForm({ ...planBreakdownApplyForm, end_date: e.target.value })} required />
                  </div>
                  <label className="checkbox-label" style={{ marginBottom: 0, paddingBottom: '0.5rem' }}>
                    <input type="checkbox" checked={planBreakdownApplyForm.is_pace} onChange={(e) => setPlanBreakdownApplyForm({ ...planBreakdownApplyForm, is_pace: e.target.checked })} />
                    <span>PACE plan</span>
                  </label>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="submit" className="btn btn-primary">Apply – create plan & budgets</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setPlanBreakdownParsed(null)}>Cancel</button>
                </div>
              </form>
            </div>
          )}
          {data.plans?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {data.plans.map((p) => {
                const planScheduleNorm = normalizeFundReleaseSchedule(p.fund_release_schedule, p.start_date, p.end_date);
                return (
                <div key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div>
                      <strong>{formatDate(p.start_date)} – {formatDate(p.end_date)}</strong>
                      <span style={{ marginLeft: '0.5rem' }}>{p.is_pace ? 'PACE' : 'Legacy'}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.75rem', padding: '0.1rem 0.3rem' }}
                        onClick={() => handleRefreshPlanFunding(p)}
                        title="Create a new plan from today with remaining budgets"
                      >
                        Refresh to available funding
                      </button>
                      <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '0.1rem 0.3rem' }} onClick={() => handleDeletePlan(p.id)} title="Remove this plan and all budgets">Remove plan</button>
                    </div>
                  </div>
                  {planScheduleNorm.releases.length > 0 && (
                    <div style={{ fontSize: '0.76rem', color: '#475569', marginBottom: '0.55rem', padding: '0.4rem 0.55rem', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                      <strong>Fund releases</strong>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.25rem' }}>
                        {planScheduleNorm.releases.map((r, ri) => (
                          <span key={`prs-${p.id}-${ri}`} style={{ border: '1px solid #cbd5e1', borderRadius: 4, padding: '0.1rem 0.35rem' }}>
                            {r.date ? formatDate(r.date) : `#${ri + 1}`}: {(r.proportion * 100).toFixed(1)}%
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '0.75rem' }}>
                    {isAgencyShell
                      ? 'Support category budgets — funds your organisation bills from (participant-wide coordination lives in Nexus Coordination).'
                      : 'Support categories & budgets (used when linking shifts to line items)'}
                  </div>
                  {p.budgets?.length ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.65rem', marginBottom: '0.5rem' }}>
                      {p.budgets.map((b) => {
                        const lineItems = b.line_items || [];
                        const remoteness = data?.remoteness || 'standard';
                        const primaryRate = getBudgetPrimaryRate(b, remoteness);
                        const budgetAmount = Number(b.amount || 0);
                        const budgetHours = primaryRate > 0 ? budgetAmount / primaryRate : null;
                        const allocatedTotal = (b.allocations || []).reduce((sum, a) => sum + getAllocationAnnualCost(a, primaryRate), 0);
                        const allocatedHours = (b.allocations || []).reduce((sum, a) => sum + getAllocationAnnualHours(a, primaryRate), 0);
                        const unallocatedTotal = budgetAmount - allocatedTotal;
                        const unallocatedHours = budgetHours != null ? Math.max(0, budgetHours - allocatedHours) : null;
                        const percentUsed = budgetAmount > 0 ? Math.round((allocatedTotal / budgetAmount) * 100) : 0;
                        const tone = getUtilizationTone(percentUsed);
                        const budgetName = supportCategories.find(c => c.id === b.category)?.name || b.name;
                        const allocations = b.allocations || [];
                        const budgetKey = `${p.id}:${b.id}`;
                        const isExpanded = !!expandedBudgetCards[budgetKey];
                        const previewAllocations = allocations.slice(0, 2);
                        const colorway = getBudgetColorway(`applied:${p.id}:${b.id}:${b.category || ''}:${budgetName || ''}`);
                        return (
                          <div key={b.id} style={{ border: `1px solid ${colorway.border}`, borderRadius: 10, overflow: 'hidden', background: colorway.cardBg }}>
                            <div style={{ background: colorway.headerBg, padding: '0.5rem 0.55rem', borderBottom: `1px solid ${colorway.border}` }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.4rem' }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: '0.72rem', color: colorway.muted }}>{b.category || '—'}</div>
                                  <div style={{ fontWeight: 700, fontSize: '0.85rem', color: colorway.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{budgetName}</div>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
                                  <span className={`badge ${tone.badge}`} style={{ fontSize: '0.68rem' }}>{percentUsed}%</span>
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ fontSize: '0.68rem', padding: '0.08rem 0.28rem' }}
                                    onClick={() => toggleBudgetCard(p.id, b.id)}
                                  >
                                    {isExpanded ? 'Less' : 'More'}
                                  </button>
                                </div>
                              </div>
                              <div style={{ marginTop: '0.3rem', display: 'grid', gridTemplateColumns: isAgencyShell ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: '0.3rem' }}>
                                <div style={{ border: `1px solid ${colorway.border}`, borderRadius: 6, padding: '0.22rem', background: '#f8faf9' }}>
                                  <div style={{ fontSize: '0.65rem', color: colorway.muted }}>{isAgencyShell ? 'Category budget' : 'Budget'}</div>
                                  <div style={{ fontSize: '0.74rem', fontWeight: 700 }}>${budgetAmount.toLocaleString('en-AU', { maximumFractionDigits: 0 })}</div>
                                </div>
                                {!isAgencyShell && (
                                  <>
                                <div style={{ border: `1px solid ${colorway.border}`, borderRadius: 6, padding: '0.22rem', background: '#f8faf9' }}>
                                  <div style={{ fontSize: '0.65rem', color: colorway.muted }}>Allocated</div>
                                  <div style={{ fontSize: '0.74rem', fontWeight: 700 }}>${allocatedTotal.toLocaleString('en-AU', { maximumFractionDigits: 0 })}</div>
                                </div>
                                <div style={{ border: `1px solid ${colorway.border}`, borderRadius: 6, padding: '0.22rem', background: '#f8faf9' }}>
                                  <div style={{ fontSize: '0.65rem', color: colorway.muted }}>Left</div>
                                  <div style={{ fontSize: '0.74rem', fontWeight: 700, color: unallocatedTotal < 0 ? '#b91c1c' : colorway.text }}>${unallocatedTotal.toLocaleString('en-AU', { maximumFractionDigits: 0 })}</div>
                                </div>
                                  </>
                                )}
                              </div>
                              {planScheduleNorm.releases.length > 0 && (
                                <div style={{ marginTop: '0.28rem', fontSize: '0.65rem', color: colorway.muted, display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                  {planScheduleNorm.releases.map((r, ri) => (
                                    <span key={`br-${b.id}-${ri}`} style={{ border: `1px solid ${colorway.border}`, borderRadius: 4, padding: '0.06rem 0.28rem' }}>
                                      {r.date ? formatDate(r.date) : `#${ri + 1}`}: ${(budgetAmount * r.proportion).toLocaleString('en-AU', { maximumFractionDigits: 0 })}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                            {!isAgencyShell && (
                            <div style={{ padding: '0.45rem 0.55rem' }}>
                              <div style={{ border: `1px solid ${colorway.border}`, borderRadius: 8, padding: '0.35rem', background: '#f8faf9' }}>
                                <div style={{ fontSize: '0.68rem', color: colorway.muted, marginBottom: '0.22rem' }}>Allocations ({allocations.length})</div>
                                {previewAllocations.length > 0 ? (
                                  <div style={{ display: 'grid', gap: '0.22rem' }}>
                                    {previewAllocations.map((a) => {
                                      const allocAmount = getAllocationAnnualCost(a, primaryRate);
                                      const serviceName = a.service_name || a.description || 'Unspecified service';
                                      const providerName = a.provider_name || orgs.find((o) => String(o.id) === String(a.provider_id))?.name || 'Provider';
                                      return (
                                        <div key={`preview-${a.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.35rem', fontSize: '0.72rem' }}>
                                          <span style={{ color: colorway.text, minWidth: 0 }}>
                                            <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{serviceName}</span>
                                            <span style={{ display: 'block', fontSize: '0.66rem', color: colorway.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{providerName}</span>
                                          </span>
                                          <span style={{ color: colorway.text, fontWeight: 600 }}>${allocAmount.toLocaleString('en-AU', { maximumFractionDigits: 0 })}</span>
                                        </div>
                                      );
                                    })}
                                    {allocations.length > previewAllocations.length && (
                                      <div style={{ fontSize: '0.68rem', color: colorway.muted }}>+{allocations.length - previewAllocations.length} more</div>
                                    )}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: '0.72rem', color: colorway.muted }}>No providers yet.</div>
                                )}
                              </div>
                            </div>
                            )}
                            {isExpanded && !isAgencyShell && (
                              <div style={{ padding: '0.5rem 0.55rem', borderTop: `1px solid ${colorway.border}`, background: '#fff' }}>
                                <div style={{ display: 'flex', gap: '0.28rem', flexWrap: 'wrap', marginBottom: '0.45rem' }}>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.08rem 0.3rem' }} onClick={() => openBudgetConfig('applied', b, b.id, p.id)}>Configure</button>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.08rem 0.3rem' }} onClick={() => { setEditingPlanId(p.id); setEditingBudget(b); setBudgetForm({ support_category: b.category || '', amount: String(b.amount), line_item_ids: (b.line_items || []).map(li => li.ndis_line_item_id), shift_length_hours: 1 }); setShowBudgetModal(true); }}>Edit</button>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.08rem 0.3rem' }} onClick={() => handleAddAllocation(b)}>Add provider</button>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.08rem 0.3rem' }} onClick={() => handleDeleteBudget(p.id, b.id)}>Remove</button>
                                </div>
                                <div style={{ fontSize: '0.74rem', color: '#64748b', marginBottom: '0.4rem' }}>
                                  {lineItems.length > 0
                                    ? `Charges: ${lineItems.map(li => `${li.support_item_number} ($${getEffectiveRate(li, remoteness).toFixed(2)}/${li.unit || 'hr'})`).join(', ')}`
                                    : 'No line items linked'}
                                </div>
                                <div style={{ display: 'grid', gap: '0.32rem', marginBottom: '0.42rem' }}>
                                  <div style={{ fontSize: '0.74rem', color: '#64748b' }}>{formatManagementTypeLabel(b.management_type)}</div>
                                  <div style={{ fontSize: '0.74rem', color: '#64748b' }}>Estimated hrs: budget {budgetHours != null ? budgetHours.toFixed(1) : '—'} / allocated {allocatedHours > 0 ? allocatedHours.toFixed(1) : '—'} / remaining {unallocatedHours != null ? unallocatedHours.toFixed(1) : '—'}</div>
                                </div>
                                {allocations.length > 0 ? (
                                  <div style={{ display: 'grid', gap: '0.35rem' }}>
                                    {allocations.map((a) => {
                                    const allocAmount = getAllocationAnnualCost(a, primaryRate);
                                    const allocHours = getAllocationAnnualHours(a, primaryRate);
                                    const serviceName = a.service_name || a.description || 'Unspecified service';
                                    return (
                                      <div key={a.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.4rem', background: '#fff' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                                          <div>
                                            <div style={{ fontSize: '0.74rem', color: '#64748b' }}>↳ {serviceName}</div>
                                            <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>{a.provider_name || 'Provider'}</div>
                                            <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                                              {(a.hours_per_week ?? a.hours) ? `${a.hours_per_week ?? a.hours} hrs` : 'Amount-based'}{(a.hours_per_week ?? a.hours) && a.frequency ? '/' : ''}{a.frequency || ''}
                                              {a.support_item_number ? ` • ${a.support_item_number}` : ''}
                                            </div>
                                          </div>
                                          <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>${allocAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</div>
                                            <div style={{ fontSize: '0.74rem', color: '#64748b' }}>{allocHours > 0 ? `~${allocHours.toFixed(1)} hrs` : '—'}</div>
                                            {planScheduleNorm.releases.length > 0 && allocAmount > 0 && (() => {
                                              const hourParts = allocHours > 0 ? splitAnnualHours(allocHours, planScheduleNorm.releases) : [];
                                              return (
                                                <div style={{ marginTop: '0.2rem', fontSize: '0.65rem', color: '#64748b', textAlign: 'left' }}>
                                                  {splitAnnualAmount(allocAmount, planScheduleNorm.releases).map((ap, pi) => (
                                                    <div key={`ar-${a.id}-${pi}`}>
                                                      R{pi + 1}: ${ap.amount_portion.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                                      {hourParts[pi] ? ` (~${hourParts[pi].hours_portion} hrs)` : ''}
                                                    </div>
                                                  ))}
                                                </div>
                                              );
                                            })()}
                                            <div style={{ marginTop: '0.2rem' }}>
                                              <button type="button" className="btn btn-secondary" style={{ fontSize: '0.68rem', padding: '0.05rem 0.24rem' }} onClick={() => handleEditAllocation(a, b)}>Edit</button>
                                              <button type="button" className="btn btn-secondary" style={{ marginLeft: '0.2rem', fontSize: '0.68rem', padding: '0.05rem 0.24rem' }} onClick={() => handleDeleteAllocation(p.id, a.id)}>Remove</button>
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div style={{ fontSize: '0.74rem', color: '#64748b' }}>No providers allocated yet.</div>
                              )}
                              </div>
                            )}
                            {isExpanded && isAgencyShell && (
                              <div style={{ padding: '0.5rem 0.55rem', borderTop: `1px solid ${colorway.border}`, background: '#fff' }}>
                                <div style={{ display: 'flex', gap: '0.28rem', flexWrap: 'wrap', marginBottom: '0.45rem' }}>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.08rem 0.3rem' }} onClick={() => openBudgetConfig('applied', b, b.id, p.id)}>Configure</button>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.08rem 0.3rem' }} onClick={() => { setEditingPlanId(p.id); setEditingBudget(b); setBudgetForm({ support_category: b.category || '', amount: String(b.amount), line_item_ids: (b.line_items || []).map(li => li.ndis_line_item_id), shift_length_hours: 1 }); setShowBudgetModal(true); }}>Edit budget</button>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.08rem 0.3rem' }} onClick={() => handleDeleteBudget(p.id, b.id)}>Remove</button>
                                </div>
                                <p style={{ margin: 0, fontSize: '0.78rem', color: '#64748b' }}>
                                  Provider allocations and detailed splits are managed in <strong>Nexus Coordination</strong>. Here you use this category total as your billing envelope.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.9rem', color: '#64748b' }}>No categories yet. Add support categories and budgets below.</p>
                  )}
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.85rem' }} onClick={() => { setEditingPlanId(p.id); setEditingBudget(null); setBudgetForm({ support_category: '', amount: '', line_item_ids: [], shift_length_hours: 1 }); setShowBudgetModal(true); }}>
                    + Add category & budget
                  </button>
                </div>
                );
              })}
            </div>
          ) : (
            <p className="empty-state">No plans. <button className="btn btn-primary" onClick={() => setShowPlanModal(true)}>Add plan</button></p>
          )}
          {showBudgetModal && (
            <div className="modal-overlay" onClick={() => { setShowBudgetModal(false); setEditingPlanId(null); setEditingBudget(null); }}>
              <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
                <h3>{editingBudget ? 'Edit' : 'Add'} support category & budget</h3>
                <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '1rem' }}>
                  Select an NDIS support category, set the budget, and choose which charges (line items) will be used. This lets you see how many hours or shifts the budget can cover.
                </p>
                <form onSubmit={editingBudget ? handleUpdateBudget : handleAddBudget}>
                  <div className="form-group">
                    <label>Support category</label>
                    <select value={budgetForm.support_category} onChange={(e) => setBudgetForm({ ...budgetForm, support_category: e.target.value, line_item_ids: [] })} required disabled={!!editingBudget}>
                      <option value="">Select...</option>
                      {supportCategories.filter(c => !editingPlanId || !data.plans?.find(pl => pl.id === editingPlanId)?.budgets?.some(b => b.category === c.id && b.id !== editingBudget?.id)).map((c) => (
                        <option key={c.id} value={c.id}>{c.id} – {c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Budget amount ($)</label>
                    <input type="number" step="0.01" min="0" value={budgetForm.amount} onChange={(e) => setBudgetForm({ ...budgetForm, amount: e.target.value })} required placeholder="e.g. 5000" />
                  </div>
                  <div className="form-group">
                    <label>Charges to use (NDIS line items)</label>
                    <p style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '0.5rem' }}>Select which line items can be claimed against this budget. Used to calculate hours/shifts. Pre-selections are based on your past usage—the system learns your preferences over time.</p>
                    {budgetForm.support_category && ndisItemsForCategory.length > 0 ? (
                      <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.5rem' }}>
                        {ndisItemsForCategory.map((item) => {
                          const rate = getEffectiveRate(item, data?.remoteness);
                          const checked = (budgetForm.line_item_ids || []).includes(item.id);
                          return (
                            <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem', cursor: 'pointer' }}>
                              <input type="checkbox" checked={checked} onChange={(e) => {
                                const ids = budgetForm.line_item_ids || [];
                                const next = e.target.checked ? [...ids, item.id] : ids.filter(x => x !== item.id);
                                setBudgetForm({ ...budgetForm, line_item_ids: next });
                              }} />
                              <span style={{ fontSize: '0.9rem' }}>{item.support_item_number} – {item.description} (${rate.toFixed(2)}/{item.unit || 'hr'})</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : budgetForm.support_category ? (
                      <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>No line items in this category. Import NDIS pricing first.</p>
                    ) : (
                      <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Select a category to see available charges.</p>
                    )}
                  </div>
                  <div className="form-group">
                    <label>Shift length (hours) – for capacity estimate</label>
                    <input type="number" step="0.25" min="0.25" value={budgetForm.shift_length_hours} onChange={(e) => setBudgetForm({ ...budgetForm, shift_length_hours: parseFloat(e.target.value) || 1 })} style={{ width: 80 }} />
                  </div>
                  {(() => {
                    const amt = parseFloat(budgetForm.amount);
                    const ids = budgetForm.line_item_ids || [];
                    const shiftLen = Math.max(0.25, parseFloat(budgetForm.shift_length_hours) || 1);
                    const selectedItems = ndisItemsForCategory.filter(n => ids.includes(n.id));
                    const calc = selectedItems.length > 0 && amt > 0 ? selectedItems.map(it => {
                      const r = getEffectiveRate(it, data?.remoteness);
                      const hrs = r > 0 ? amt / r : null;
                      const shifts = hrs != null ? hrs / shiftLen : null;
                      return { item: it, rate: r, hours: hrs, shifts };
                    }) : [];
                    return calc.length > 0 && (
                      <div style={{ background: '#f8fafc', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
                        <strong>Capacity estimate</strong>
                        <ul style={{ margin: '0.35rem 0 0 0', paddingLeft: '1.25rem' }}>
                          {calc.map(({ item, rate, hours, shifts }) => (
                            <li key={item.id}>{item.support_item_number} - {(item.description || item.name || 'Unnamed line item')} @ ${rate.toFixed(2)}/{item.unit || 'hr'}: ~{hours?.toFixed(1)} hrs → ~{shifts?.toFixed(1)} shifts ({shiftLen}h each)</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                    <button type="submit" className="btn btn-primary">{editingBudget ? 'Save' : 'Add'}</button>
                    <button type="button" className="btn btn-secondary" onClick={() => { setShowBudgetModal(false); setEditingPlanId(null); setEditingBudget(null); }}>Cancel</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'contacts' && (
        <div className="card">
          <h3>Contacts</h3>
          {data.contacts?.length ? (
            <table>
              <thead>
                <tr><th>Name</th><th>Relationship</th><th>Contact</th><th>Consent</th><th></th></tr>
              </thead>
              <tbody>
                {data.contacts.map((c) => (
                  <tr key={c.id}>
                    <td>{c.contact_name || c.name} {c.is_starred ? '★' : ''}</td>
                    <td>{c.relationship || '-'}</td>
                    <td><CopyableField label="" value={c.contact_email || c.contact_phone} compact /></td>
                    <td>{c.consent_to_share ? 'Yes' : 'No'}</td>
                    <td>
                      <button className="btn btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => handleStarContact(c.id, c.is_starred)}>
                        {c.is_starred ? 'Unstar' : 'Star'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No contacts. Add contacts from the Directory, then link them here.</p>
          )}
          <div className="form-group" style={{ marginTop: '1rem' }}>
            <label>Link existing contact</label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
              <select id="link-contact-select" style={{ flex: 2 }}>
                <option value="">Select contact...</option>
                {allContacts.filter(c => !data.contacts?.some(pc => pc.contact_id === c.id)).map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.org_name || 'No org'})</option>
                ))}
              </select>
              <input type="text" id="link-relationship" placeholder="Relationship" style={{ width: 120 }} />
              <button type="button" className="btn btn-primary" onClick={() => {
                const sel = document.getElementById('link-contact-select');
                const rel = document.getElementById('link-relationship');
                const contactId = sel?.value;
                if (contactId) {
                  handleAddContact(contactId, rel?.value || '');
                  sel.value = '';
                  if (rel) rel.value = '';
                }
              }}>Add</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'goals' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <h3>Goals</h3>
            <button className="btn btn-primary" onClick={() => setShowGoalModal(true)}>Add Goal</button>
          </div>
          {data.goals?.length ? (
            <table>
              <thead>
                <tr><th>Description</th><th style={{ width: 92 }}>Copy</th><th>Status</th><th>Target Date</th></tr>
              </thead>
              <tbody>
                {data.goals.map((g) => (
                  <tr key={g.id}>
                    <td>{g.description}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.78rem', padding: '0.2rem 0.5rem' }}
                        title="Copy goal text for email or documents"
                        onClick={() => copyGoalLine(`saved-${g.id}`, g.description)}
                      >
                        {copiedGoalKey === `saved-${g.id}` ? 'Copied' : 'Copy'}
                      </button>
                    </td>
                    <td>{g.status}</td>
                    <td>{g.target_date ? formatDate(g.target_date) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty-state">No goals. <button className="btn btn-primary" onClick={() => setShowGoalModal(true)}>Add goal</button></p>
          )}
        </div>
      )}

      {tab === 'documents' && (
        <div className="card">
          <h3>Documents</h3>
          {data.documents?.length ? (
            <>
              {data.documents.filter((d) => d.category === 'Expense Receipt').length > 0 && (
                <div style={{ marginBottom: '1.5rem' }}>
                  <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Expense Receipts</h4>
                  <table>
                    <thead>
                      <tr><th>Description</th><th>Date</th><th></th></tr>
                    </thead>
                    <tbody>
                      {data.documents.filter((d) => d.category === 'Expense Receipt').map((d) => (
                        <tr key={d.id}>
                          <td>{d.receipt_description || d.filename}</td>
                          <td>{d.created_at ? formatDate(d.created_at.slice(0, 10)) : '-'}</td>
                          <td>
                            <a href={`/api/participants/${id}/documents/${d.id}/file`} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ fontSize: '0.8rem' }}>View</a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>All Documents</h4>
              <table>
                <thead>
                  <tr><th>Filename</th><th>Category</th><th></th></tr>
                </thead>
                <tbody>
                  {data.documents.map((d) => (
                    <tr key={d.id}>
                      <td>{d.filename}</td>
                      <td>{d.category || '-'}</td>
                      <td>
                        <a href={`/api/participants/${id}/documents/${d.id}/file`} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ fontSize: '0.8rem' }}>View</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p>No documents. Use the upload form to add documents.</p>
          )}
          <ActivityRiskAssessmentAssign participantId={id} onAssigned={load} />
          <DocumentUpload participantId={id} onUpload={load} />
        </div>
      )}

      {tab === 'agreements' && (
        <div className="card">
          <h3>Service Agreement</h3>
          <p style={{ color: '#64748b', fontSize: '0.92rem', marginBottom: '1rem' }}>
            Generate a PDF from your organisation’s cloned template. Data is snapshotted at generation time. Ensure your org admin has set up the template under{' '}
            <Link to={`${pathPrefix}/forms`}>Forms → Services Agreement template</Link>.
          </p>
          {saMessage && (
            <div
              style={{
                marginBottom: '0.75rem',
                padding: '0.5rem 0.75rem',
                borderRadius: 6,
                background: saMessage.includes('failed') || saMessage.includes('Choose') ? '#fef2f2' : '#f0fdf4',
                color: saMessage.includes('failed') || saMessage.includes('Choose') ? '#991b1b' : '#166534'
              }}
            >
              {saMessage}
            </div>
          )}
          {saLoading ? (
            <p>Loading templates…</p>
          ) : (
            <>
              <div className="form-group">
                <label>Organisation template</label>
                <select
                  className="form-input"
                  style={{ maxWidth: 420 }}
                  value={saSelectedTemplate}
                  onChange={(e) => setSaSelectedTemplate(e.target.value)}
                >
                  <option value="">— Select —</option>
                  {saTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label || t.master_title || t.template_key}
                    </option>
                  ))}
                </select>
              </div>
              {saSelectedTemplate && (saPreflightLoading || (saGaps?.gaps?.length ?? 0) > 0) ? (
                <div
                  style={{
                    marginBottom: '1rem',
                    padding: '0.85rem 1rem',
                    borderRadius: 8,
                    border: '1px solid #e2e8f0',
                    background: '#fffbeb'
                  }}
                >
                  {saPreflightLoading ? (
                    <p style={{ margin: 0, color: '#92400e', fontSize: '0.92rem' }}>Checking agreement fields…</p>
                  ) : (
                    <>
                      {(saGaps?.blocking_count ?? 0) > 0 ? (
                        <div style={{ marginBottom: (saGaps?.warning_count ?? 0) > 0 ? '0.85rem' : 0 }}>
                          <p style={{ margin: '0 0 0.5rem 0', fontWeight: 700, color: '#991b1b' }}>
                            Required before PDF: {saGaps.blocking_count} missing field{saGaps.blocking_count === 1 ? '' : 's'}
                          </p>
                          <ul style={{ margin: 0, paddingLeft: '1.25rem', color: '#450a0a', fontSize: '0.9rem', lineHeight: 1.45 }}>
                            {(saGaps.gaps || [])
                              .filter((g) => g.severity === 'blocking')
                              .map((g) => (
                                <li key={g.id} style={{ marginBottom: '0.35rem' }}>
                                  <strong>{g.title}</strong>
                                  {g.section ? (
                                    <span style={{ color: '#64748b' }}>
                                      {' '}
                                      ({g.section})
                                    </span>
                                  ) : null}
                                  {g.fix ? (
                                    <div style={{ marginTop: '0.25rem' }}>
                                      <button type="button" className="btn btn-secondary" style={{ fontSize: '0.82rem', padding: '0.2rem 0.55rem' }} onClick={() => navigateToGapFix(g)}>
                                        Go to fix
                                      </button>
                                    </div>
                                  ) : null}
                                </li>
                              ))}
                          </ul>
                        </div>
                      ) : null}
                      {(saGaps?.warning_count ?? 0) > 0 ? (
                        <div>
                          <p style={{ margin: '0 0 0.5rem 0', fontWeight: 600, color: '#92400e' }}>
                            May appear empty in the PDF: {saGaps.warning_count} optional field{saGaps.warning_count === 1 ? '' : 's'}
                          </p>
                          <ul style={{ margin: 0, paddingLeft: '1.25rem', color: '#78350f', fontSize: '0.88rem', lineHeight: 1.45 }}>
                            {(saGaps.gaps || [])
                              .filter((g) => g.severity === 'warning')
                              .map((g) => (
                                <li key={g.id} style={{ marginBottom: '0.35rem' }}>
                                  <strong>{g.title}</strong>
                                  {g.section ? (
                                    <span style={{ color: '#64748b' }}>
                                      {' '}
                                      ({g.section})
                                    </span>
                                  ) : null}
                                  {g.fix ? (
                                    <div style={{ marginTop: '0.25rem' }}>
                                      <button type="button" className="btn btn-secondary" style={{ fontSize: '0.82rem', padding: '0.2rem 0.55rem' }} onClick={() => navigateToGapFix(g)}>
                                        Go to fix
                                      </button>
                                    </div>
                                  ) : null}
                                </li>
                              ))}
                          </ul>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
              <div
                style={{
                  marginBottom: '1rem',
                  padding: '0.85rem 1rem',
                  borderRadius: 8,
                  border: `1px solid ${saReadyToSend ? '#bbf7d0' : '#fde68a'}`,
                  background: saReadyToSend ? '#f0fdf4' : '#fffbeb'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <strong style={{ color: '#0f172a' }}>Pre-send checklist (complete in Nexus before signing)</strong>
                  <span style={{ fontSize: '0.82rem', color: saReadyToSend ? '#15803d' : '#b45309' }}>
                    {saReadyToSend
                      ? 'Ready to send for signatures'
                      : `${saChecklistMissing.length} item${saChecklistMissing.length === 1 ? '' : 's'} remaining`}
                  </span>
                </div>
                <p style={{ margin: '0 0 0.65rem 0', fontSize: '0.84rem', color: '#475569' }}>
                  All agreement details are finalised here in Nexus Core. Once everything below is ticked, click <strong>Sign with Nexus Core</strong> — the signed PDF is sent first to the organisation admin (Default signatory under <Link to="/settings">Settings → Business</Link>), then auto-forwarded to the participant. Both only need to add a signature, printed name, and date — no other fields to fill.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.4rem' }}>
                  {saPreSendChecklist.map((row) => {
                    const ok = !!String(row.value || '').trim();
                    return (
                      <div
                        key={row.key}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.5rem',
                          fontSize: '0.86rem',
                          color: ok ? '#0f172a' : '#991b1b'
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            display: 'inline-block',
                            width: 16,
                            textAlign: 'center',
                            fontWeight: 700,
                            color: ok ? '#15803d' : '#b91c1c'
                          }}
                        >
                          {ok ? '✓' : '✗'}
                        </span>
                        <span style={{ flex: 1 }}>
                          <span style={{ display: 'block', fontWeight: 600 }}>{row.label}</span>
                          <span style={{ color: ok ? '#334155' : '#b91c1c' }}>
                            {ok
                              ? row.value
                              : row.key === 'services'
                                ? 'Add at least one line below (description + hours + rate)'
                                : ['agreement_date', 'review_date'].includes(row.key)
                                  ? 'Set the date below'
                                  : 'Missing — open Edit'}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
                {!saReadyToSend && saChecklistMissing.some((r) => !['agreement_date', 'review_date', 'services'].includes(r.key)) ? (
                  <div style={{ marginTop: '0.65rem' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: '0.82rem', padding: '0.25rem 0.6rem' }}
                      onClick={() => {
                        if (data) {
                          setEditForm({ ...data, invoice_emails: parseInvoiceEmailsField(data.invoice_emails) });
                        }
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      Edit participant details
                    </button>
                  </div>
                ) : null}
              </div>
              <div id="sa-gap-agreements-fields" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                <div className="form-group">
                  <label>Agreement date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={saOverrides.agreement_date}
                    onChange={(e) => setSaOverrides((o) => ({ ...o, agreement_date: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Scheduled review date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={saOverrides.scheduled_review_date}
                    onChange={(e) => setSaOverrides((o) => ({ ...o, scheduled_review_date: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Monitoring frequency (this participant)</label>
                  <input
                    className="form-input"
                    value={saOverrides.monitoring_worker_frequency}
                    onChange={(e) => setSaOverrides((o) => ({ ...o, monitoring_worker_frequency: e.target.value }))}
                    placeholder="Defaults from template if blank"
                  />
                </div>
                <div className="form-group">
                  <label>Other provider consultation</label>
                  <input
                    className="form-input"
                    value={saOverrides.other_provider_consultation_frequency}
                    onChange={(e) => setSaOverrides((o) => ({ ...o, other_provider_consultation_frequency: e.target.value }))}
                  />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Communication preferences</label>
                  <input
                    className="form-input"
                    value={saOverrides.communication_preferences}
                    onChange={(e) => setSaOverrides((o) => ({ ...o, communication_preferences: e.target.value }))}
                  />
                </div>
              </div>
              <div
                style={{
                  marginBottom: '1rem',
                  padding: '0.85rem 1rem',
                  borderRadius: 8,
                  border: '1px solid #e2e8f0',
                  background: '#ffffff'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <strong style={{ color: '#0f172a' }}>Services & quote (up to 5 NDIS line items)</strong>
                  <span style={{ fontSize: '0.85rem', color: '#0f172a' }}>
                    Total quote: <strong>${saServicesTotals.total.toFixed(2)}</strong>
                  </span>
                </div>
                <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.84rem', color: '#475569' }}>
                  Enter the NDIS supports you're quoting for this plan. Line total = hours × rate. Grand total prints on the agreement. Leave a row blank to skip it. If you leave all rows blank, the schedule is loaded from the participant's plan implementations.
                </p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                    <thead>
                      <tr style={{ background: '#f1f5f9' }}>
                        <th style={{ padding: '0.4rem', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>#</th>
                        <th style={{ padding: '0.4rem', textAlign: 'left', borderBottom: '1px solid #e2e8f0', minWidth: 260 }}>
                          NDIS line item / description
                        </th>
                        <th style={{ padding: '0.4rem', textAlign: 'right', borderBottom: '1px solid #e2e8f0', width: 110 }}>Hours</th>
                        <th style={{ padding: '0.4rem', textAlign: 'right', borderBottom: '1px solid #e2e8f0', width: 130 }}>Rate ($/hr)</th>
                        <th style={{ padding: '0.4rem', textAlign: 'right', borderBottom: '1px solid #e2e8f0', width: 130 }}>Line total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(saOverrides.services || []).map((row, i) => (
                        <tr key={i}>
                          <td style={{ padding: '0.35rem', color: '#64748b', borderBottom: '1px solid #f1f5f9' }}>{i + 1}</td>
                          <td style={{ padding: '0.35rem', borderBottom: '1px solid #f1f5f9' }}>
                            <input
                              className="form-input"
                              value={row.description}
                              placeholder="e.g. 01_011_0107_1_1 — Assistance with daily personal activities"
                              onChange={(e) => {
                                const v = e.target.value;
                                setSaOverrides((o) => {
                                  const next = [...(o.services || [])];
                                  next[i] = { ...(next[i] || {}), description: v };
                                  return { ...o, services: next };
                                });
                              }}
                            />
                          </td>
                          <td style={{ padding: '0.35rem', borderBottom: '1px solid #f1f5f9' }}>
                            <input
                              className="form-input"
                              type="number"
                              min="0"
                              step="0.25"
                              style={{ textAlign: 'right' }}
                              value={row.hours}
                              onChange={(e) => {
                                const v = e.target.value;
                                setSaOverrides((o) => {
                                  const next = [...(o.services || [])];
                                  next[i] = { ...(next[i] || {}), hours: v };
                                  return { ...o, services: next };
                                });
                              }}
                            />
                          </td>
                          <td style={{ padding: '0.35rem', borderBottom: '1px solid #f1f5f9' }}>
                            <input
                              className="form-input"
                              type="number"
                              min="0"
                              step="0.01"
                              style={{ textAlign: 'right' }}
                              value={row.rate}
                              onChange={(e) => {
                                const v = e.target.value;
                                setSaOverrides((o) => {
                                  const next = [...(o.services || [])];
                                  next[i] = { ...(next[i] || {}), rate: v };
                                  return { ...o, services: next };
                                });
                              }}
                            />
                          </td>
                          <td
                            style={{
                              padding: '0.35rem',
                              textAlign: 'right',
                              borderBottom: '1px solid #f1f5f9',
                              fontVariantNumeric: 'tabular-nums',
                              color: saServicesTotals.lines[i] > 0 ? '#0f172a' : '#94a3b8'
                            }}
                          >
                            ${(saServicesTotals.lines[i] || 0).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={4} style={{ padding: '0.5rem 0.35rem', textAlign: 'right', fontWeight: 700 }}>
                          Total quote
                        </td>
                        <td
                          style={{
                            padding: '0.5rem 0.35rem',
                            textAlign: 'right',
                            fontWeight: 700,
                            fontVariantNumeric: 'tabular-nums'
                          }}
                        >
                          ${saServicesTotals.total.toFixed(2)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                title={
                  (saGaps?.blocking_count ?? 0) > 0
                    ? 'Complete required fields listed above (or use Go to fix).'
                    : undefined
                }
                disabled={
                  saSaving ||
                  !saSelectedTemplate ||
                  saPreflightLoading ||
                  (saGaps?.blocking_count ?? 0) > 0
                }
                onClick={async () => {
                  if (!saSelectedTemplate) {
                    setSaMessage('Choose a template. Clone one under Settings → Form templates if none appear.');
                    return;
                  }
                  setSaSaving(true);
                  setSaMessage('');
                  try {
                    const r = await participants.generateServiceAgreement(id, {
                      org_template_id: saSelectedTemplate,
                      instance_overrides: saInstanceOverridesPayload
                    });
                    setSaMessage('Generated. Download opened in a new tab; the file is saved under Documents and to OneDrive when connected.');
                    window.open(formTemplates.generatedPdfUrl(r.id), '_blank', 'noopener,noreferrer');
                    const list = await participants.listServiceAgreements(id);
                    const items = list.items || [];
                    if (r.form_instance_id && items.length) {
                      const idx = items.findIndex((x) => x.id === r.id);
                      if (idx >= 0) items[idx] = { ...items[idx], form_instance_id: r.form_instance_id };
                    }
                    setSaAgreements(items);
                  } catch (e) {
                    const payload = e.apiPayload;
                    if (payload?.gaps) {
                      setSaGaps({
                        gaps: payload.gaps,
                        blocking_count: payload.blocking_count ?? 0,
                        warning_count: payload.warning_count ?? 0,
                        can_generate: (payload.blocking_count ?? 0) === 0
                      });
                    }
                    setSaMessage(e.message || 'Generation failed');
                  } finally {
                    setSaSaving(false);
                  }
                }}
              >
                {saSaving ? 'Generating…' : 'Generate PDF'}
              </button>

              <h4 style={{ marginTop: '1.5rem' }}>Generated agreements</h4>
              <p style={{ fontSize: '0.85rem', color: '#64748b', margin: '0 0 0.75rem' }}>
                Download to review the full pre-filled agreement, or click <strong>Sign with Nexus Core</strong> to send it for signatures.
                The Sign button is enabled only once the pre-send checklist above is complete. The PDF goes first to the organisation default signatory, then to the participant — both only sign, no editing in Dropbox Sign.
                Set the default signatory under <Link to="/settings">Settings → Business</Link>, enable signing under Forms → Onboarding settings, and connect Dropbox Sign in Settings.
              </p>
              {saAgreements.length === 0 ? (
                <p className="empty-state">None yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Template</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {saAgreements.map((g) => (
                      <tr key={g.id}>
                        <td>{g.generated_at ? formatDate(g.generated_at.slice(0, 10)) : '—'}</td>
                        <td>{g.template_label || '—'}</td>
                        <td>{g.status || '—'}</td>
                        <td>
                          <a className="btn btn-secondary" style={{ fontSize: '0.8rem' }} href={formTemplates.generatedPdfUrl(g.id)} target="_blank" rel="noopener noreferrer">
                            Download to sign
                          </a>
                          <button
                            type="button"
                            className="btn btn-primary"
                            style={{ fontSize: '0.8rem', marginLeft: 6 }}
                            disabled={
                              saSignBusy ||
                              !signEnabled ||
                              !g.form_instance_id ||
                              !['generated', 'draft'].includes(g.status) ||
                              !saReadyToSend
                            }
                            title={
                              !signEnabled
                                ? NEXUS_CORE_SIGN_COMING_SOON_TITLE
                                : !g.form_instance_id
                                  ? 'Generate the agreement first'
                                  : !data?.email?.trim()
                                    ? 'Add participant email in Edit (use your email for a self-test)'
                                    : !saReadyToSend
                                      ? `Complete the pre-send checklist first: ${saChecklistMissing.map((m) => m.label).join(', ')}`
                                      : 'Send this agreement for signature via Dropbox Sign'
                            }
                            onClick={async () => {
                              if (!g.form_instance_id) return;
                              if (!data?.email?.trim()) {
                                setSaMessage('Add a participant email in Edit before sending for signature.');
                                return;
                              }
                              if (
                                !confirm(
                                  `Send the service agreement to ${data.email.trim()} for signature via Dropbox Sign?`
                                )
                              ) {
                                return;
                              }
                              setSaSignBusy(true);
                              setSaMessage('');
                              try {
                                await onboarding.sendFormForSignature(id, g.form_instance_id);
                                setSaMessage(`Sent for signature to ${data.email.trim()}. Check that inbox.`);
                                const list = await participants.listServiceAgreements(id);
                                setSaAgreements(list.items || []);
                              } catch (e) {
                                setSaMessage(e.message || 'Could not send for signature');
                              } finally {
                                setSaSignBusy(false);
                              }
                            }}
                          >
                            {saSignBusy ? 'Sending…' : 'Sign with Nexus Core'}
                          </button>
                          {g.onedrive_web_url ? (
                            <a
                              href={g.onedrive_web_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn btn-secondary"
                              style={{ fontSize: '0.8rem', marginLeft: 6 }}
                            >
                              OneDrive
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'casenotes' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <h3>Case Notes</h3>
            <button className="btn btn-primary" onClick={() => setShowCaseNoteModal(true)}>Add Case Note</button>
          </div>
          {data.case_notes?.length ? (
            <table>
              <thead>
                <tr><th>Date</th><th>Type</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {data.case_notes.map((n) => (
                  <tr key={n.id}>
                    <td>{formatDate(n.contact_date)}</td>
                    <td>{n.contact_type === 'support_shift' ? 'Support shift (session)' : n.contact_type}</td>
                    <td>{n.notes || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty-state">No case notes. <button className="btn btn-primary" onClick={() => setShowCaseNoteModal(true)}>Add note</button></p>
          )}
        </div>
      )}

      {tab === 'shifts' && (
        <div className="card">
          <h3>Shifts</h3>
          {data.shifts?.length ? (
            <table>
              <thead>
                <tr><th>Date</th><th>Time</th><th>Staff</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {data.shifts.map((s) => (
                  <tr key={s.id}>
                    <td>{formatDate(s.start_time)}</td>
                    <td>{new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {new Date(s.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{s.staff_name}</td>
                    <td><span className={`badge badge-${s.status}`}>{s.status}</span></td>
                    <td><Link to={`${pathPrefix}/shifts?shift=${s.id}`} className="btn btn-secondary" style={{ fontSize: '0.8rem' }}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No shifts. <Link to="/shifts">Schedule a shift</Link></p>
          )}
        </div>
      )}

      {showPlanModal && (
        <div className="modal-overlay" onClick={() => setShowPlanModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add NDIS Plan</h3>
            <form onSubmit={handleAddPlan}>
              <div className="form-group">
                <label>Start Date</label>
                <input type="date" value={planForm.start_date} onChange={(e) => setPlanForm({ ...planForm, start_date: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>End Date</label>
                <input type="date" value={planForm.end_date} onChange={(e) => setPlanForm({ ...planForm, end_date: e.target.value })} required />
              </div>
              <div className="form-group">
                <label><input type="checkbox" checked={planForm.is_pace} onChange={(e) => setPlanForm({ ...planForm, is_pace: e.target.checked })} /> PACE plan</label>
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowPlanModal(false)}>Cancel</button>
            </form>
          </div>
        </div>
      )}

      {showGoalModal && (
        <div className="modal-overlay" onClick={() => setShowGoalModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Goal</h3>
            <form onSubmit={handleAddGoal}>
              <div className="form-group">
                <label>Description</label>
                <textarea value={goalForm.description} onChange={(e) => setGoalForm({ ...goalForm, description: e.target.value })} required rows={3} />
              </div>
              <div className="form-group">
                <label>Status</label>
                <select value={goalForm.status} onChange={(e) => setGoalForm({ ...goalForm, status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                </select>
              </div>
              <div className="form-group">
                <label>Target Date</label>
                <input type="date" value={goalForm.target_date} onChange={(e) => setGoalForm({ ...goalForm, target_date: e.target.value })} />
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowGoalModal(false)}>Cancel</button>
            </form>
          </div>
        </div>
      )}

      {showCaseNoteModal && (
        <div className="modal-overlay" onClick={() => setShowCaseNoteModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Case Note</h3>
            <form onSubmit={handleAddCaseNote}>
              <div className="form-group">
                <label>Contact Type</label>
                <select value={caseNoteForm.contact_type} onChange={(e) => setCaseNoteForm({ ...caseNoteForm, contact_type: e.target.value })}>
                  <option value="phone">Phone</option>
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                  <option value="face-to-face">Face-to-face</option>
                </select>
              </div>
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={caseNoteForm.contact_date} onChange={(e) => setCaseNoteForm({ ...caseNoteForm, contact_date: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea value={caseNoteForm.notes} onChange={(e) => setCaseNoteForm({ ...caseNoteForm, notes: e.target.value })} rows={3} />
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCaseNoteModal(false)}>Cancel</button>
            </form>
          </div>
        </div>
      )}

      {showAllocationModal && (
        <div className="modal-overlay" onClick={() => { setShowAllocationModal(false); setEditingAllocation(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3>{editingAllocation ? 'Edit' : 'Assign'} funding to provider</h3>
            <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '1rem' }}>
              {allocationForm.budget_name} – assign rate, hours and frequency to a provider (e.g. 10 hrs/week at $70.23/hr).
            </p>
            <form onSubmit={handleSaveAllocation}>
              {(() => {
                const isParsed = allocationForm.source === 'parsed';
                const parentBudget = isParsed
                  ? planBreakdownParsed?.budgets?.[allocationForm.budget_index]
                  : data?.plans?.flatMap((p) => p.budgets || []).find((b) => b.id === allocationForm.budget_id);
                const budgetAmount = Number(parentBudget?.amount ?? allocationForm.budget_amount ?? 0) || 0;
                const existingAllocations = (parentBudget?.allocations || []).filter((a) => !editingAllocation || a.id !== editingAllocation.id);
                const existingAnnual = existingAllocations.reduce((sum, a) => sum + getAllocationAnnualCost(a), 0);
                const selectedLineItem = ndisItemsForAllocation.find((item) => String(item.id) === String(allocationForm.ndis_line_item_id));
                const selectedRate = getEffectiveRate(selectedLineItem, data?.remoteness);
                const draftAnnual = getAllocationAnnualCost({
                  hours_per_week: allocationForm.hours_per_week,
                  frequency: allocationForm.frequency,
                  amount: allocationForm.amount,
                  line_item_rate: selectedRate
                });
                const draftAnnualHours = getAllocationAnnualHours({
                  hours_per_week: allocationForm.hours_per_week,
                  frequency: allocationForm.frequency,
                  amount: allocationForm.amount,
                  line_item_rate: selectedRate
                });
                const planForSchedule = !isParsed
                  ? data?.plans?.find((pl) => (pl.budgets || []).some((bb) => bb.id === allocationForm.budget_id))
                  : null;
                const schStart = isParsed
                  ? (planBreakdownApplyForm.start_date || planBreakdownParsed?.plan_dates?.start_date || '')
                  : (planForSchedule?.start_date || '');
                const schEnd = isParsed
                  ? (planBreakdownApplyForm.end_date || planBreakdownParsed?.plan_dates?.end_date || '')
                  : (planForSchedule?.end_date || '');
                const scheduleNormModal = normalizeFundReleaseSchedule(
                  isParsed ? planBreakdownParsed?.fund_release_schedule : planForSchedule?.fund_release_schedule,
                  schStart,
                  schEnd
                );
                const totalWithDraft = existingAnnual + draftAnnual;
                const remainingAfterDraft = budgetAmount - totalWithDraft;
                const scenarioShiftHours = Math.max(0, toNumber(allocationForm.scenario_shift_hours));
                const scenarioCost = selectedRate > 0 ? scenarioShiftHours * selectedRate * (FREQUENCY_TO_PERIODS[allocationForm.frequency] || 52) : 0;
                const canFitScenario = scenarioShiftHours === 0 || (scenarioCost > 0 && remainingAfterDraft >= scenarioCost);
                const periodLabel = ['random', 'annual'].includes(allocationForm.frequency) ? 'plan year' : allocationForm.frequency;
                return (
                  <div style={{ marginBottom: '0.75rem', padding: '0.65rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.85rem' }}>
                    <div><strong>Live budget impact</strong></div>
                    <div style={{ marginTop: '0.25rem' }}>
                      This assignment is calculated as rate x hours x frequency.
                    </div>
                    <div>
                      Estimated assignment cost ${draftAnnual.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                    </div>
                    <div style={{ marginTop: '0.2rem', color: '#64748b' }}>
                      Budget ${budgetAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })} • already allocated ${existingAnnual.toLocaleString('en-AU', { minimumFractionDigits: 2 })} • remaining ${remainingAfterDraft.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                    </div>
                    {scheduleNormModal.releases.length > 0 && draftAnnual > 0 && (() => {
                      const hourParts = draftAnnualHours > 0 ? splitAnnualHours(draftAnnualHours, scheduleNormModal.releases) : [];
                      return (
                        <div style={{ marginTop: '0.45rem', paddingTop: '0.45rem', borderTop: '1px solid #e2e8f0' }}>
                          <strong>Per fund release (plan schedule)</strong>
                          <div style={{ marginTop: '0.2rem', fontSize: '0.8rem', color: '#64748b' }}>
                            {splitAnnualAmount(draftAnnual, scheduleNormModal.releases).map((ap, pi) => (
                              <div key={`mod-rel-${pi}`}>
                                R{pi + 1}: ${ap.amount_portion.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                {hourParts[pi] ? ` (~${hourParts[pi].hours_portion} hrs)` : ''}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', marginTop: '0.45rem' }}>
                      <span>Test extra shift:</span>
                      <input
                        type="number"
                        step="0.25"
                        min="0"
                        value={allocationForm.scenario_shift_hours}
                        onChange={(e) => setAllocationForm({ ...allocationForm, scenario_shift_hours: e.target.value })}
                        style={{ width: 70, padding: '0.2rem' }}
                      />
                      <span>hours / {periodLabel}</span>
                    </div>
                    <div style={{ marginTop: '0.25rem', color: scenarioShiftHours > 0 && !selectedRate ? '#b45309' : canFitScenario ? '#166534' : '#b91c1c' }}>
                      {scenarioShiftHours > 0 && !selectedRate
                        ? 'Select a line item rate to estimate if this extra shift fits.'
                        : canFitScenario
                          ? `Yes - this extra shift fits (about $${scenarioCost.toLocaleString('en-AU', { minimumFractionDigits: 2 })}).`
                          : `No - this extra shift needs about $${scenarioCost.toLocaleString('en-AU', { minimumFractionDigits: 2 })}.`}
                    </div>
                  </div>
                );
              })()}
              <div className="form-group">
                <label>Provider (organisation)</label>
                <select value={String(allocationForm.provider_id || '')} onChange={(e) => setAllocationForm({ ...allocationForm, provider_id: e.target.value, new_provider_name: e.target.value === '__new__' ? allocationForm.new_provider_name : '' })}>
                  <option value="">Select provider...</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={String(o.id)}>{o.name}</option>
                  ))}
                  <option value="__new__">+ Add new provider</option>
                </select>
                {allocationForm.provider_id === '__new__' && (
                  <input
                    type="text"
                    value={allocationForm.new_provider_name}
                    onChange={(e) => setAllocationForm({ ...allocationForm, new_provider_name: e.target.value })}
                    placeholder="Enter new provider name"
                    style={{ marginTop: '0.5rem', width: '100%', padding: '0.5rem' }}
                    autoFocus
                  />
                )}
              </div>
              <div className="form-group">
                <label>Rate (line item)</label>
                <select value={String(allocationForm.ndis_line_item_id || '')} onChange={(e) => setAllocationForm({ ...allocationForm, ndis_line_item_id: e.target.value })}>
                  <option value="">Select rate...</option>
                  {ndisItemsForAllocation.filter(i => ['hr', 'hour', 'hours'].includes((i.unit || 'hr').toLowerCase()) && parseFloat(i.rate) > 0).map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {item.support_item_number} - {(item.description || item.name || 'Unnamed line item')} - ${getEffectiveRate(item, data?.remoteness).toFixed(2)}/hr
                    </option>
                  ))}
                </select>
                {showAllocationModal && allocationForm.budget_category && ndisItemsForAllocation.length === 0 && (
                  <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: '0.25rem' }}>No line items for this category. Import NDIS pricing in Settings → NDIS.</p>
                )}
              </div>
              <div className="form-group">
                <label>{['random', 'annual'].includes(allocationForm.frequency) ? 'Total hours (plan year)' : 'Hours (e.g. 10)'}</label>
                <input type="number" step="0.25" min="0" value={allocationForm.hours_per_week} onChange={(e) => setAllocationForm({ ...allocationForm, hours_per_week: e.target.value })} placeholder="Optional" />
              </div>
              <div className="form-group">
                <label>Frequency</label>
                <select value={allocationForm.frequency} onChange={(e) => setAllocationForm({ ...allocationForm, frequency: e.target.value })}>
                  <option value="weekly">Weekly</option>
                  <option value="fortnightly">Fortnightly</option>
                  <option value="monthly">Monthly</option>
                  <option value="annual">Plan year (total hours once)</option>
                  <option value="random">Random (use total hours)</option>
                </select>
              </div>
              <div className="form-group">
                <label>Service name</label>
                <select
                  value={allocationForm.service_name_choice || ''}
                  onChange={(e) => {
                    const choice = e.target.value;
                    setAllocationForm((prev) => ({
                      ...prev,
                      service_name_choice: choice,
                      service_name: choice === '__custom__' ? (prev.service_name_custom || '').trim() : choice,
                      service_name_custom: choice === '__custom__' ? prev.service_name_custom : ''
                    }));
                  }}
                >
                  <option value="">Select service...</option>
                  {ALLOCATION_SERVICE_PRESETS.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                  <option value="__custom__">Custom...</option>
                </select>
                {allocationForm.service_name_choice === '__custom__' && (
                  <input
                    type="text"
                    value={allocationForm.service_name_custom}
                    onChange={(e) => setAllocationForm((prev) => ({ ...prev, service_name_custom: e.target.value, service_name: e.target.value.trim() }))}
                    placeholder="Enter service name"
                    style={{ marginTop: '0.5rem', width: '100%', padding: '0.5rem' }}
                  />
                )}
              </div>
              <div className="form-group">
                <label>Amount ($) – optional</label>
                <input type="number" step="0.01" min="0" value={allocationForm.amount} onChange={(e) => setAllocationForm({ ...allocationForm, amount: e.target.value })} placeholder="Optional" />
              </div>
              <div className="form-group">
                <label>Notes (optional)</label>
                <input type="text" value={allocationForm.description} onChange={(e) => setAllocationForm({ ...allocationForm, description: e.target.value })} placeholder="e.g. Support worker" />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="submit" className="btn btn-primary" disabled={(allocationForm.provider_id !== '__new__' && !allocationForm.provider_id) || (allocationForm.provider_id === '__new__' && !allocationForm.new_provider_name?.trim()) || (!allocationForm.hours_per_week && !allocationForm.amount)}>{editingAllocation ? 'Save' : 'Assign'}</button>
                <button type="button" className="btn btn-secondary" onClick={() => { setShowAllocationModal(false); setEditingAllocation(null); }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showBudgetConfigModal && (() => {
        const configBudget = getConfigBudget();
        const allocations = configBudget?.allocations || [];
        const isParsed = budgetConfigForm.source === 'parsed';
        const allocatedTotal = allocations.reduce((sum, a) => sum + getAllocationAnnualCost(a), 0);
        const totalAmount = Number(budgetConfigForm.totalAmount || 0);
        const unallocatedTotal = totalAmount - allocatedTotal;
        const percentUsed = totalAmount > 0 ? Math.round((allocatedTotal / totalAmount) * 100) : 0;
        const colorway = getBudgetColorway(`config:${budgetConfigForm.planId || ''}:${budgetConfigForm.budgetId || ''}:${budgetConfigForm.category || ''}:${budgetConfigForm.categoryName || ''}`);
        const configPlan = isParsed ? null : data?.plans?.find((pl) => pl.id === budgetConfigForm.planId);
        const cfgStart = isParsed
          ? (planBreakdownApplyForm.start_date || planBreakdownParsed?.plan_dates?.start_date || '')
          : (configPlan?.start_date || '');
        const cfgEnd = isParsed
          ? (planBreakdownApplyForm.end_date || planBreakdownParsed?.plan_dates?.end_date || '')
          : (configPlan?.end_date || '');
        const configScheduleNorm = normalizeFundReleaseSchedule(
          isParsed ? planBreakdownParsed?.fund_release_schedule : configPlan?.fund_release_schedule,
          cfgStart,
          cfgEnd
        );
        return (
          <div className="modal-overlay" onClick={() => setShowBudgetConfigModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <h3>Configure {budgetConfigForm.categoryName || 'budget'}</h3>
              <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '1rem' }}>
                Total budget: <strong>${totalAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</strong>. Allocate to one or more providers.
              </p>
              {configScheduleNorm.releases.length > 0 && (
                <div style={{ marginBottom: '1rem', padding: '0.45rem 0.55rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: '0.78rem', color: '#475569' }}>
                  <strong>Fund releases</strong> (this plan)
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.25rem' }}>
                    {configScheduleNorm.releases.map((r, ri) => (
                      <span key={`cfg-fr-${ri}`} style={{ border: '1px solid #cbd5e1', borderRadius: 4, padding: '0.08rem 0.3rem' }}>
                        {r.date ? formatDate(r.date) : `#${ri + 1}`}: {(r.proportion * 100).toFixed(1)}% → ${(totalAmount * r.proportion).toLocaleString('en-AU', { minimumFractionDigits: 2 })} of this category
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginBottom: '1rem', border: `1px solid ${colorway.border}`, borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ background: colorway.headerBg, padding: '0.6rem 0.75rem', borderBottom: `1px solid ${colorway.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <strong style={{ color: colorway.text }}>{budgetConfigForm.category || '—'}</strong>
                      <strong style={{ color: colorway.text }}>{budgetConfigForm.categoryName || 'Budget'}</strong>
                      <span className={`badge ${getUtilizationTone(percentUsed).badge}`}>{percentUsed}% used</span>
                      {allocations.length > 0 && (
                        <span style={{ fontSize: '0.8rem', color: colorway.muted }}>{allocations.length} provider{allocations.length !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                    <div style={{ marginTop: '0.2rem', color: colorway.muted, fontSize: '0.82rem' }}>
                      Allocated ${allocatedTotal.toLocaleString('en-AU', { minimumFractionDigits: 2 })} / Remaining ${unallocatedTotal.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                    </div>
                    {['01', '02', '03', '04'].includes(String(budgetConfigForm.category || '').padStart(2, '0')) && (
                      <div style={{ marginTop: '0.2rem', color: colorway.muted, fontSize: '0.78rem' }}>
                        Core funding hours are estimated using weekday daytime default rates when exact rates are unavailable.
                      </div>
                    )}
                  </div>
                  <div style={{ fontWeight: 700 }}>${totalAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</div>
                </div>
                <div style={{ padding: '0.6rem 0.75rem', display: 'grid', gap: '0.45rem' }}>
                  {allocations.length > 0 ? allocations.map((a, idx) => {
                    const lineItem = isParsed ? ndisItemsForConfig.find((n) => n.id === a.ndis_line_item_id) : null;
                    const rate = a.line_item_rate ?? a.rate ?? (lineItem ? getEffectiveRate(lineItem, data?.remoteness) : 0);
                    const itemNum = a.support_item_number || lineItem?.support_item_number;
                    const hoursValue = a.hours_per_week ?? a.hours;
                    const freq = a.frequency || '';
                    const annual = getAllocationAnnualCost(a, rate);
                    const annualHrs = getAllocationAnnualHours(a, rate);
                    const serviceName = a.service_name || a.description || 'Unspecified service';
                    return (
                      <div key={a.id || idx} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.45rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ fontSize: '0.78rem', color: '#64748b' }}>↳ {serviceName}</div>
                            <div style={{ fontWeight: 600 }}>{a.provider_name || 'Provider'}</div>
                            <div style={{ color: '#64748b', marginTop: '0.2rem', fontSize: '0.8rem' }}>
                              {hoursValue ? `${hoursValue} hrs` : 'Amount-based'}{hoursValue && freq ? ` / ${freq}` : ''}
                              {itemNum ? ` • ${itemNum}` : ''}{rate ? ` @ $${Number(rate).toFixed(2)}/hr` : ''}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontWeight: 600 }}>${Number(annual || 0).toLocaleString('en-AU', { minimumFractionDigits: 2 })}</div>
                            {configScheduleNorm.releases.length > 0 && annual > 0 && (() => {
                              const hp = annualHrs > 0 ? splitAnnualHours(annualHrs, configScheduleNorm.releases) : [];
                              return (
                                <div style={{ marginTop: '0.2rem', fontSize: '0.72rem', color: '#64748b', textAlign: 'left' }}>
                                  {splitAnnualAmount(annual, configScheduleNorm.releases).map((ap, pi) => (
                                    <div key={`cfg-a-${idx}-${pi}`}>
                                      R{pi + 1}: ${ap.amount_portion.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                      {hp[pi] ? ` (~${hp[pi].hours_portion} hrs)` : ''}
                                    </div>
                                  ))}
                                </div>
                              );
                            })()}
                            <div style={{ marginTop: '0.2rem' }}>
                              {isParsed ? (
                                <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem' }} onClick={() => removeParsedAllocation(budgetConfigForm.budgetIndex, idx)}>Remove</button>
                              ) : (
                                <>
                                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.75rem' }} onClick={() => { setShowBudgetConfigModal(false); handleEditAllocation(a, configBudget); }}>Edit</button>
                                  <button type="button" className="btn btn-secondary" style={{ marginLeft: '0.25rem', fontSize: '0.75rem' }} onClick={() => budgetConfigForm.planId && handleDeleteAllocation(budgetConfigForm.planId, a.id)}>Remove</button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }) : (
                    <div style={{ color: '#64748b', fontSize: '0.85rem' }}>No allocations yet. Add one to allocate this budget to providers.</div>
                  )}
                </div>
              </div>
              {configBudget && (
                <button type="button" className="btn btn-primary" style={{ marginBottom: '1rem' }} onClick={() => { setShowBudgetConfigModal(false); handleAddAllocation(configBudget, budgetConfigForm.source, budgetConfigForm.budgetIndex); }}>+ Add allocation</button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setShowBudgetConfigModal(false)}>Close</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function DocumentUpload({ participantId, onUpload }) {
  const [file, setFile] = useState(null);
  const [category, setCategory] = useState('');
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (category) form.append('category', category);
      const res = await fetch(`/api/participants/${participantId}/documents`, { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');
      setFile(null);
      setCategory('');
      onUpload();
    } catch (err) {
      alert(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleUpload} style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>File</label>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0])} />
      </div>
      <div className="form-group" style={{ marginBottom: 0, width: 150 }}>
        <label>Category</label>
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Service Agreement" />
      </div>
      <button type="submit" className="btn btn-primary" disabled={!file || uploading}>{uploading ? 'Uploading...' : 'Upload'}</button>
    </form>
  );
}
