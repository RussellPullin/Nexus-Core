import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { onboarding, participants, organisations, ndis, smartDefaults } from '../lib/api';
import AddressAutocomplete from '../components/AddressAutocomplete';
import { formatDate } from '../lib/dateUtils';

const LABEL_MAP = {
  name: 'Name',
  full_legal_name: 'Full legal name',
  preferred_name: 'Preferred name',
  date_of_birth: 'Date of birth',
  ndis_number: 'NDIS number',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  street_address: 'Street address',
  suburb_city: 'Suburb / City',
  state: 'State',
  postcode: 'Postcode',
  parent_guardian_phone: 'Parent/guardian phone',
  parent_guardian_email: 'Parent/guardian email',
  diagnosis: 'Diagnosis',
  preferred_contact_method: 'Preferred contact method',
  best_time_to_contact: 'Best time to contact',
  primary_contact_name: 'Primary contact name',
  primary_contact_relationship: 'Primary contact relationship',
  primary_contact_phone: 'Primary contact phone',
  primary_contact_email: 'Primary contact email',
  emergency_contact_name: 'Emergency contact name',
  emergency_contact_relationship: 'Emergency contact relationship',
  emergency_contact_phone: 'Emergency contact phone',
  preferred_start_date: 'Preferred start date',
  consent_email_sms: 'Consent to email/SMS',
  medical_conditions: 'Medical conditions',
  medications: 'Medications',
  allergies: 'Allergies',
  mobility_supports: 'Mobility supports',
  support_needs: 'Support needs',
  goals_and_outcomes: 'Goals and outcomes',
  additional_notes: 'Additional notes',
  service_schedule: 'Service schedule',
  funding_management_type: 'Funding management',
  plan_manager_details: 'Plan manager details',
  plan_start_date: 'Plan start date',
  plan_end_date: 'Plan end date',
  risks_at_home: 'Risks at home',
  triggers_stressors: 'Triggers / stressors',
  current_supports_strategies: 'Current supports',
  functional_assistance_needs: 'Functional assistance needs',
  living_arrangements: 'Living arrangements',
  mental_health_summary: 'Mental health summary',
  start_date: 'Plan start date',
  end_date: 'Plan end date'
};

function FormPreviewReadable({ snapshot }) {
  if (!snapshot) return <p style={{ color: '#64748b' }}>No preview data available.</p>;
  const { participant, plan, intake, template } = snapshot;
  const skipKeys = new Set(['id', 'template', 'mapping', 'generated_at', 'prefill_fields']);

  const renderSection = (title, data) => {
    if (!data || typeof data !== 'object') return null;
    const entries = Object.entries(data)
      .filter(([k, v]) => !skipKeys.has(k) && v != null && String(v).trim() !== '');
    if (entries.length === 0) return null;
    return (
      <div key={title} style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem', color: '#334155' }}>{title}</h4>
        <div style={{ display: 'grid', gap: '0.35rem', fontSize: '0.9rem' }}>
          {entries.map(([key, value]) => (
            <div key={key} style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '0.5rem', alignItems: 'baseline' }}>
              <span style={{ color: '#64748b', fontWeight: 500 }}>{LABEL_MAP[key] || key.replace(/_/g, ' ')}</span>
              <span style={{ wordBreak: 'break-word' }}>{String(value)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const sections = [renderSection('Participant', participant), renderSection('Plan', plan), renderSection('Intake / Service details', intake)].filter(Boolean);
  if (sections.length === 0) return <p style={{ color: '#64748b' }}>No preview data available.</p>;

  return (
    <div style={{ background: '#f8fafc', padding: '1.25rem', borderRadius: 8, maxWidth: 640 }}>
      {sections}
    </div>
  );
}

/** Parse hours per week from frequency string (e.g. "6 hrs/week", "2 hours per week"). Returns number or null. */
function parseHoursPerWeek(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (/as required|as needed|varies/i.test(s)) return null;
  const match = s.match(/(\d+(?:\.\d+)?)\s*(?:hrs?|hours?)(?:\s*\/\s*week|\s*per\s*week)?/i) || s.match(/(\d+(?:\.\d+)?)\s*(?:\/|\s*per\s*)\s*week/i);
  if (match) return parseFloat(match[1]);
  const numOnly = s.match(/^(\d+(?:\.\d+)?)\s*$/);
  return numOnly ? parseFloat(numOnly[1]) : null;
}

/** Parse numeric rate from string (e.g. "$62.50", "$62.50/hr", "$0.95/km"). */
function parseRateNumber(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/** Calculate budget: (rate * hoursPerWeek * periodWeeks) / ratio. ratio 1 = full, 2 = half, 3 = third, etc. */
function calcBudgetFromFrequency(rateNum, hoursPerWeek, periodWeeks, ratio = 1) {
  if (rateNum == null || rateNum <= 0 || hoursPerWeek == null || hoursPerWeek <= 0 || periodWeeks == null || periodWeeks <= 0) return null;
  const r = Math.max(1, parseInt(ratio, 10) || 1);
  const total = (rateNum * hoursPerWeek * periodWeeks) / r;
  if (!Number.isFinite(total)) return null;
  return `$${Math.round(total * 100) / 100}`;
}

const BUDGET_RATIO_OPTIONS = [
  { value: 1, label: '1:1' },
  { value: 2, label: '1:2' },
  { value: 3, label: '1:3' },
  { value: 4, label: '1:4' },
  { value: 5, label: '1:5' },
  { value: 6, label: '1:6' }
];

const BUDGET_PERIOD_OPTIONS = [
  { value: 52, label: '1 year' },
  { value: 26, label: '6 months' },
  { value: 13, label: '3 months' }
];

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

const emptyIntake = () => ({
  // Client details
  full_legal_name: '',
  preferred_name: '',
  date_of_birth: '',
  ndis_number: '',
  email: '',
  phone: '',
  preferred_contact_method: '',
  best_time_to_contact: '',
  address: '',
  street_address: '',
  suburb_city: '',
  state: '',
  postcode: '',
  // Primary contact
  primary_contact_name: '',
  primary_contact_relationship: '',
  primary_contact_phone: '',
  primary_contact_email: '',
  // Emergency contact
  emergency_contact_name: '',
  emergency_contact_relationship: '',
  emergency_contact_phone: '',
  // Service details
  preferred_start_date: '',
  consent_email_sms: '',
  medical_conditions: '',
  medications: '',
  allergies: '',
  mobility_supports: '',
  support_needs: '',
  goals_and_outcomes: '',
  additional_notes: '',
  service_schedule: '',
  // Service schedule rows – match Service Agreement boxes (description, hours, rate, ratio, budget)
  service_schedule_rows: [],
  // Support categories & NDIS (multi-select from 15 categories, management per service)
  services_required: [],
  ndia_managed_services: [],
  plan_managed_services: [],
  plan_start_date: '',
  plan_end_date: '',
  plan_manager_id: '',
  plan_manager_company_name: '',
  plan_manager_invoice_email: '',
  additional_invoice_emails: [],
  plan_manager_details: '',
  plan_budget_amount: '',
  risks_at_home: '',
  triggers_stressors: '',
  current_supports_strategies: '',
  functional_assistance_needs: '',
  living_arrangements: '',
  mental_health_summary: ''
});

export default function OnboardingPage() {
  const { id } = useParams();
  const [participant, setParticipant] = useState(null);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [intake, setIntake] = useState(emptyIntake());
  const [providerOrgId, setProviderOrgId] = useState('');
  const [previewFormId, setPreviewFormId] = useState(null);
  const [previewSnapshot, setPreviewSnapshot] = useState(null);
  const [documentPreviewUrl, setDocumentPreviewUrl] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [supportCategories, setSupportCategories] = useState(FALLBACK_SUPPORT_CATEGORIES);
  const [additionalEmailInput, setAdditionalEmailInput] = useState('');
  const [ndisLineItemsForSchedule, setNdisLineItemsForSchedule] = useState([]);
  const [scheduleTravelItems, setScheduleTravelItems] = useState({
    nonProviderKm: [],
    nonProviderTime: [],
    providerKm: [],
    km: [],
    time: []
  });

  useEffect(() => {
    organisations.list('', 'plan_manager').then(setOrgs).catch(() => []);
    ndis.supportCategories()
      .then((cats) => setSupportCategories(Array.isArray(cats) && cats.length > 0 ? cats : FALLBACK_SUPPORT_CATEGORIES))
      .catch(() => setSupportCategories(FALLBACK_SUPPORT_CATEGORIES));
  }, []);

  // Load NDIS line items for schedule dropdown (filtered by selected support categories; hourly items)
  useEffect(() => {
    const cats = intake.services_required || [];
    if (cats.length === 0) {
      ndis.list({ support_categories: '' })
        .then((items) => setNdisLineItemsForSchedule(Array.isArray(items) ? items.filter((i) => (i.unit || '').toLowerCase().includes('hour') || (i.unit || '').toLowerCase() === 'hr') : []))
        .catch(() => setNdisLineItemsForSchedule([]));
      return;
    }
    ndis.list({ support_categories: cats.join(',') })
      .then((items) => setNdisLineItemsForSchedule(Array.isArray(items) ? items.filter((i) => (i.unit || '').toLowerCase().includes('hour') || (i.unit || '').toLowerCase() === 'hr') : []))
      .catch(() => setNdisLineItemsForSchedule([]));
  }, [intake.services_required]);

  // Load travel items: non-provider km/time, provider km (provider time uses main line rate on add)
  useEffect(() => {
    const cats = intake.services_required || [];
    const travelCats = cats.filter((c) => c === '02' || c === '04' || c === '07');
    if (travelCats.length === 0) {
      setScheduleTravelItems({ nonProviderKm: [], nonProviderTime: [], providerKm: [], km: [], time: [] });
      return;
    }
    const has07 = travelCats.includes('07');
    const kmCats = travelCats.filter((c) => c === '02' || c === '04');
    const toFetch = [...new Set(has07 ? ['07', ...travelCats] : travelCats)];
    Promise.all(toFetch.map((cat) => ndis.travelItems(cat).catch(() => ({}))))
      .then((results) => {
        const merge = (key) => {
          const seen = new Set();
          const out = [];
          results.forEach((r) => {
            (r?.[key] || []).forEach((i) => { if (i?.id && !seen.has(i.id)) { seen.add(i.id); out.push(i); } });
          });
          return out;
        };
        let nonProviderKm = merge('non_provider_km').length ? merge('non_provider_km') : merge('km');
        const nonProviderTime = merge('non_provider_time').length ? merge('non_provider_time') : merge('time');
        const providerKm = merge('provider_km');
        if (nonProviderKm.length === 0 && kmCats.length > 0) {
          return ndis.list({ support_categories: kmCats.join(',') })
            .then((list) => {
              const u = (x) => (x || '').toString().toLowerCase();
              const kmFromList = (Array.isArray(list) ? list : []).filter(
                (i) => u(i.unit).includes('km') || u(i.unit) === 'kilometre' || u(i.description).includes('travel')
              );
              const existingIds = new Set(nonProviderKm.map((i) => i.id));
              kmFromList.forEach((i) => { if (i?.id && !existingIds.has(i.id)) { existingIds.add(i.id); nonProviderKm = [...nonProviderKm, i]; } });
              return { nonProviderKm, nonProviderTime, providerKm, km: nonProviderKm, time: nonProviderTime };
            })
            .catch(() => ({ nonProviderKm, nonProviderTime, providerKm, km: nonProviderKm, time: nonProviderTime }));
        }
        return { nonProviderKm, nonProviderTime, providerKm, km: nonProviderKm, time: nonProviderTime };
      })
      .then((merged) => setScheduleTravelItems({ ...merged }))
      .catch(() => setScheduleTravelItems({ nonProviderKm: [], nonProviderTime: [], providerKm: [], km: [], time: [] }));
  }, [intake.services_required]);

  // When support categories are chosen, pre-fill up to 5 schedule rows from smart defaults + auto-add travel by category (built-in memory)
  useEffect(() => {
    const cats = intake.services_required || [];
    if (cats.length === 0) return;
    const rows = intake.service_schedule_rows || [];
    const hasContent = rows.some((r) => (r.description || r.ndis_line_item_id || r.rate || '').toString().trim());
    if (hasContent) return;

    const travelCats = cats.filter((c) => c === '02' || c === '04' || c === '07');
    const wantTravel = travelCats.length > 0;
    const maxSupport = wantTravel ? 3 : 5;

    Promise.all(cats.map((cat) => smartDefaults.budgetLineItems(cat).catch(() => ({ items: [] }))))
      .then((results) => {
        const combined = [];
        const seen = new Set();
        results.forEach((res) => {
          (res?.items || []).forEach((i) => {
            if (i?.id && !seen.has(i.id)) {
              seen.add(i.id);
              combined.push(i);
            }
          });
        });
        const rateStr = (r) => (r != null && r !== '') ? String(r) : '';
        const newRows = combined.slice(0, maxSupport).map((item) => ({
          ndis_line_item_id: item.id || '',
          description: rateStr(item.description) || `${item.support_item_number || ''}`.trim(),
          hours: '',
          rate: item.rate != null ? `$${Number(item.rate).toFixed(2)}` : '',
          budget: '',
          ratio: 1,
          budget_period_weeks: 52
        }));

        if (!wantTravel) {
          setIntake((prev) => ({ ...prev, service_schedule_rows: newRows }));
          return;
        }

        const kmCat = cats.find((c) => c === '02' || c === '04');
        const promises = kmCat ? [ndis.travelItems(kmCat).then((t) => ({ km: t?.km || [] })).catch(() => ({ km: [] }))] : [];
        Promise.all(promises.length ? promises : [Promise.resolve({})]).then((parts) => {
          const kmItem = parts.find((p) => p.km?.length)?.km?.[0];
          if (kmCat && kmItem) {
            newRows.push({
              ndis_line_item_id: kmItem.id || '',
              description: rateStr(kmItem.description) || 'Travel with participant (km)',
              hours: 'As required',
              rate: kmItem.rate != null ? `$${Number(kmItem.rate).toFixed(2)}/km` : '',
              budget: '',
              ratio: 1,
              budget_period_weeks: 52
            });
          }
          const mainRow = newRows.find((r) => parseRateNumber(r.rate) != null && parseRateNumber(r.rate) > 0);
          if (mainRow && newRows.length < 5) {
            const mainRate = parseRateNumber(mainRow.rate);
            newRows.push({
              ndis_line_item_id: mainRow.ndis_line_item_id || '',
              description: 'Provider travel (time)',
              hours: 'As required',
              rate: mainRate != null ? `$${Number(mainRate).toFixed(2)}` : '',
              budget: '',
              ratio: 1,
              budget_period_weeks: 52
            });
          }
          setIntake((prev) => ({ ...prev, service_schedule_rows: newRows.slice(0, 5) }));
        }).catch(() => setIntake((prev) => ({ ...prev, service_schedule_rows: newRows })));
      })
      .catch(() => {});
  }, [intake.services_required]);

  const toggleServiceRequired = (catId) => {
    const current = intake.services_required || [];
    const next = current.includes(catId)
      ? current.filter((c) => c !== catId)
      : [...current, catId];
    const ndia = (intake.ndia_managed_services || []).filter((c) => c !== catId);
    const plan = (intake.plan_managed_services || []).filter((c) => c !== catId);
    setIntake({ ...intake, services_required: next, ndia_managed_services: ndia, plan_managed_services: plan });
  };
  const toggleNdiaManaged = (catId) => {
    const ndia = intake.ndia_managed_services || [];
    const plan = intake.plan_managed_services || [];
    const inNdia = ndia.includes(catId);
    const nextNdia = inNdia ? ndia.filter((c) => c !== catId) : [...ndia, catId];
    const nextPlan = inNdia ? plan : plan.filter((c) => c !== catId);
    setIntake({ ...intake, ndia_managed_services: nextNdia, plan_managed_services: nextPlan });
  };
  const togglePlanManaged = (catId) => {
    const ndia = intake.ndia_managed_services || [];
    const plan = intake.plan_managed_services || [];
    const inPlan = plan.includes(catId);
    const nextPlan = inPlan ? plan.filter((c) => c !== catId) : [...plan, catId];
    const nextNdia = inPlan ? ndia : ndia.filter((c) => c !== catId);
    setIntake({ ...intake, plan_managed_services: nextPlan, ndia_managed_services: nextNdia });
  };
  const toggleSelfManaged = (catId) => {
    const ndia = (intake.ndia_managed_services || []).filter((c) => c !== catId);
    const plan = (intake.plan_managed_services || []).filter((c) => c !== catId);
    setIntake({ ...intake, ndia_managed_services: ndia, plan_managed_services: plan });
  };

  const refresh = async () => {
    try {
      const [participantData, onboardingData] = await Promise.all([
        participants.get(id),
        onboarding.get(id).catch(() => null)
      ]);
      setParticipant(participantData);
      setProviderOrgId((prev) => prev || participantData?.plan_manager_id || '');
      if (onboardingData) {
        setState(onboardingData);
        const fields = onboardingData.intake_fields || {};
        const parseArray = (v) => {
          if (Array.isArray(v)) return v;
          if (typeof v === 'string') {
            try {
              const p = JSON.parse(v);
              return Array.isArray(p) ? p : [];
            } catch {
              return v ? [v] : [];
            }
          }
          return [];
        };
        const parseScheduleRows = (v) => {
          const norm = (r) => ({
            ndis_line_item_id: r.ndis_line_item_id ?? '',
            description: r.description ?? '',
            hours: r.hours ?? '',
            rate: r.rate ?? '',
            ratio: (r.ratio ?? '').toString().trim(),
            budget: r.budget ?? '',
            budget_period_weeks: typeof r.budget_period_weeks === 'number' ? r.budget_period_weeks : (parseInt(r.budget_period_weeks, 10) || 52)
          });
          if (Array.isArray(v)) return v.map(norm);
          if (typeof v === 'string') {
            try {
              const p = JSON.parse(v);
              return Array.isArray(p) ? p.map(norm) : [];
            } catch {
              return [];
            }
          }
          return [];
        };
        const normalizedFields = {
          ...fields,
          services_required: parseArray(fields.services_required),
          ndia_managed_services: parseArray(fields.ndia_managed_services),
          plan_managed_services: parseArray(fields.plan_managed_services),
          service_schedule_rows: parseScheduleRows(fields.service_schedule_rows)
        };
        const fromParticipant = participantData ? {
          full_legal_name: participantData.name,
          preferred_name: '',
          date_of_birth: participantData.date_of_birth?.slice(0, 10),
          ndis_number: participantData.ndis_number,
          email: participantData.email,
          phone: participantData.phone,
          address: participantData.address,
          primary_contact_phone: participantData.parent_guardian_phone,
          primary_contact_email: participantData.parent_guardian_email,
          plan_manager_id: participantData.plan_manager_id,
          services_required: parseArray(participantData.services_required),
          ndia_managed_services: parseArray(participantData.ndia_managed_services),
          plan_managed_services: parseArray(participantData.plan_managed_services)
        } : {};
        setIntake((prev) => ({ ...emptyIntake(), ...fromParticipant, ...prev, ...normalizedFields }));
      } else {
        setState(null);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [id]);

  // Prefill plan manager company name and invoice email from directory when participant has plan_manager_id
  useEffect(() => {
    if (!participant?.plan_manager_id || !orgs.length) return;
    const org = orgs.find((o) => o.id === participant.plan_manager_id);
    if (!org) return;
    setIntake((prev) => {
      if (prev.plan_manager_company_name && prev.plan_manager_invoice_email) return prev;
      return {
        ...prev,
        plan_manager_id: prev.plan_manager_id || participant.plan_manager_id,
        plan_manager_company_name: prev.plan_manager_company_name || org.name,
        plan_manager_invoice_email: prev.plan_manager_invoice_email || org.email || ''
      };
    });
  }, [participant?.plan_manager_id, orgs]);

  const handleInitialize = async () => {
    setWorking(true);
    try {
      await onboarding.initialize(id, providerOrgId || null);
      await refresh();
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const handleSaveIntake = async () => {
    setWorking(true);
    try {
      const participantData = {
        name: intake.full_legal_name || participant?.name,
        preferred_name: intake.preferred_name,
        date_of_birth: intake.date_of_birth || participant?.date_of_birth,
        ndis_number: intake.ndis_number || participant?.ndis_number,
        email: intake.email || participant?.email,
        phone: intake.phone || participant?.phone,
        address: intake.address || (intake.street_address ? [intake.street_address, intake.suburb_city, intake.state, intake.postcode].filter(Boolean).join(', ') : participant?.address),
        plan_manager_id: intake.plan_manager_id || participant?.plan_manager_id,
        services_required: intake.services_required,
        ndia_managed_services: intake.ndia_managed_services,
        plan_managed_services: intake.plan_managed_services
      };
      const contactsData = [
        {
          name: intake.primary_contact_name,
          relationship: intake.primary_contact_relationship,
          phone: intake.primary_contact_phone,
          email: intake.primary_contact_email,
          role: 'primary_guardian'
        },
        {
          name: intake.emergency_contact_name,
          relationship: intake.emergency_contact_relationship,
          phone: intake.emergency_contact_phone,
          role: 'emergency'
        }
      ].filter((c) => c.name || c.phone || c.email);
      const intakeData = {
        ...intake,
        services_required: intake.services_required,
        ndia_managed_services: intake.ndia_managed_services,
        plan_managed_services: intake.plan_managed_services
      };
      await onboarding.saveIntake(id, {
        participant: participantData,
        intake: intakeData,
        contacts: contactsData
      });
      await refresh();
      alert('Intake form saved. Participant profile updated.');
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const handleGenerateForms = async () => {
    setWorking(true);
    try {
      await onboarding.generateFormPack(id);
      await refresh();
      alert('Service Agreement and Support Plan generated from intake data.');
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const handleSendForm = async (formInstanceId) => {
    setWorking(true);
    try {
      await onboarding.sendFormForSignature(id, formInstanceId);
      await refresh();
      alert('Form sent for signature.');
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const handleViewDocument = async (formInstanceId, openInNewTab = true) => {
    setWorking(true);
    try {
      const blob = await onboarding.getFormDocumentBlob(id, formInstanceId);
      const url = URL.createObjectURL(blob);
      if (openInNewTab) {
        window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        setDocumentPreviewUrl(url);
      }
    } catch (err) {
      alert(err.message || 'Could not load document. Generate the form first, or add a template to data/forms/participant-packet/.');
    } finally {
      setWorking(false);
    }
  };

  const closeDocumentPreview = () => {
    if (documentPreviewUrl) URL.revokeObjectURL(documentPreviewUrl);
    setDocumentPreviewUrl(null);
  };


  const handleViewPreview = async (formInstanceId) => {
    try {
      const { snapshot } = await onboarding.prefillSnapshot(id, formInstanceId);
      setPreviewSnapshot(snapshot);
      setPreviewFormId(formInstanceId);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUploadRevised = async (formInstanceId, file) => {
    if (!file) return;
    setWorking(true);
    try {
      await onboarding.uploadFormDocument(id, formInstanceId, file);
      await refresh();
      alert('Document updated. You can now send for signature.');
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const handleDeleteForm = async (formInstanceId) => {
    if (!confirm('Delete this form? You can regenerate it from the intake data.')) return;
    setWorking(true);
    try {
      await onboarding.deleteForm(id, formInstanceId);
      await refresh();
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const signatureForms = state?.forms?.filter((f) => ['service_agreement', 'support_plan', 'privacy_consent'].includes(f.form_type)) || [];
  const hasIntakeData = intake.full_legal_name || intake.email || intake.phone || Object.values(intake).some((v) => v && String(v).trim());

  if (loading) return <div className="card"><p>Loading onboarding...</p></div>;

  return (
    <div>
      <div className="page-header">
        <h2>Participant Onboarding</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to={`/participants/${id}`} className="btn btn-secondary">Back to profile</Link>
          <button className="btn btn-secondary" onClick={refresh} disabled={working}>Refresh</button>
        </div>
      </div>

      <div className="card">
        <h3>{participant?.name || 'Participant'}</h3>

        {!state ? (
          <div>
            <p style={{ color: '#64748b' }}>Initialize onboarding to start the intake form.</p>
            <div className="form-group">
              <label>Provider Organisation (optional)</label>
              <input value={providerOrgId} onChange={(e) => setProviderOrgId(e.target.value)} placeholder="Defaults to participant plan manager" />
            </div>
            <button className="btn btn-primary" onClick={handleInitialize} disabled={working}>Initialize onboarding</button>
          </div>
        ) : (
          <>
            {/* Step 1: Intake form */}
            <h4>1. Intake Form</h4>
            <p style={{ color: '#64748b', marginBottom: '1rem' }}>Fill in the intake form. Save to update the participant profile. Service Agreement and Support Plan will be auto-filled from this data.</p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="form-group">
                <label>Full legal name *</label>
                <input value={intake.full_legal_name || participant?.name} onChange={(e) => setIntake({ ...intake, full_legal_name: e.target.value })} placeholder="Full legal name" />
              </div>
              <div className="form-group">
                <label>Preferred name</label>
                <input value={intake.preferred_name} onChange={(e) => setIntake({ ...intake, preferred_name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Date of birth</label>
                <input type="date" value={intake.date_of_birth || participant?.date_of_birth?.slice(0, 10)} onChange={(e) => setIntake({ ...intake, date_of_birth: e.target.value })} />
              </div>
              <div className="form-group">
                <label>NDIS number</label>
                <input value={intake.ndis_number || participant?.ndis_number} onChange={(e) => setIntake({ ...intake, ndis_number: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={intake.email || participant?.email} onChange={(e) => setIntake({ ...intake, email: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input value={intake.phone || participant?.phone} onChange={(e) => setIntake({ ...intake, phone: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Preferred contact method</label>
                <select value={intake.preferred_contact_method} onChange={(e) => setIntake({ ...intake, preferred_contact_method: e.target.value })}>
                  <option value="">Select...</option>
                  <option value="email">Email</option>
                  <option value="phone">Phone</option>
                  <option value="sms">SMS</option>
                </select>
              </div>
              <div className="form-group">
                <label>Best time to contact</label>
                <input value={intake.best_time_to_contact} onChange={(e) => setIntake({ ...intake, best_time_to_contact: e.target.value })} placeholder="e.g. mornings" />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Address</label>
                <AddressAutocomplete
                  value={intake.address || participant?.address}
                  onChange={(v) => setIntake({ ...intake, address: v })}
                  placeholder="Start typing an address..."
                />
              </div>
            </div>

            <h5 style={{ marginTop: '1.5rem' }}>Primary Contact / Guardian</h5>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="form-group">
                <label>Name</label>
                <input value={intake.primary_contact_name} onChange={(e) => setIntake({ ...intake, primary_contact_name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Relationship</label>
                <input value={intake.primary_contact_relationship} onChange={(e) => setIntake({ ...intake, primary_contact_relationship: e.target.value })} placeholder="e.g. Mother" />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input value={intake.primary_contact_phone} onChange={(e) => setIntake({ ...intake, primary_contact_phone: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={intake.primary_contact_email} onChange={(e) => setIntake({ ...intake, primary_contact_email: e.target.value })} />
              </div>
            </div>

            <h5 style={{ marginTop: '1.5rem' }}>Emergency Contact</h5>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="form-group">
                <label>Name</label>
                <input value={intake.emergency_contact_name} onChange={(e) => setIntake({ ...intake, emergency_contact_name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Relationship</label>
                <input value={intake.emergency_contact_relationship} onChange={(e) => setIntake({ ...intake, emergency_contact_relationship: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input value={intake.emergency_contact_phone} onChange={(e) => setIntake({ ...intake, emergency_contact_phone: e.target.value })} />
              </div>
            </div>

            <h5 style={{ marginTop: '1.5rem' }}>Service Details</h5>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="form-group">
                <label>Preferred start date</label>
                <input type="date" value={intake.preferred_start_date} onChange={(e) => setIntake({ ...intake, preferred_start_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Consent to contact via email/SMS</label>
                <select value={intake.consent_email_sms} onChange={(e) => setIntake({ ...intake, consent_email_sms: e.target.value })}>
                  <option value="">Select...</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Key medical conditions</label>
                <textarea rows={2} value={intake.medical_conditions} onChange={(e) => setIntake({ ...intake, medical_conditions: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Medications</label>
                <textarea rows={2} value={intake.medications} onChange={(e) => setIntake({ ...intake, medications: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Allergies/sensitivities</label>
                <textarea rows={2} value={intake.allergies} onChange={(e) => setIntake({ ...intake, allergies: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Mobility supports or equipment</label>
                <textarea rows={2} value={intake.mobility_supports} onChange={(e) => setIntake({ ...intake, mobility_supports: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Support needs (key areas)</label>
                <textarea rows={2} value={intake.support_needs} onChange={(e) => setIntake({ ...intake, support_needs: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Goals and outcomes</label>
                <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.5rem' }}>
                  These may differ from plan goals. Add participant goals from the NDIS plan separately on the participant profile.
                </p>
                <textarea rows={3} value={intake.goals_and_outcomes} onChange={(e) => setIntake({ ...intake, goals_and_outcomes: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Additional notes</label>
                <textarea rows={2} value={intake.additional_notes} onChange={(e) => setIntake({ ...intake, additional_notes: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Service schedule (matches Service Agreement – up to 5 lines)</label>
                <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.5rem' }}>
                  Choose a service from the dropdown (uses your NDIS line items). Select support categories below first to pre-fill services and to enable travel charges. Set hours/frequency (e.g. 6 hrs/week) and rate to auto-calculate budget. Use the Ratio dropdown (1:1 default; 1:2 = half, 1:3 = third) and Period (e.g. 1 year) per line, or edit the budget.
                </p>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <th style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>Service</th>
                        <th style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>Description</th>
                        <th style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>Hours / frequency</th>
                        <th style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>Rate</th>
                        <th style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>Ratio</th>
                        <th style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>Budget</th>
                        <th style={{ textAlign: 'left', padding: '0.5rem', fontWeight: 600 }}>Period</th>
                        <th style={{ width: 56 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {(intake.service_schedule_rows && intake.service_schedule_rows.length > 0 ? intake.service_schedule_rows : [{ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 }]).slice(0, 5).map((row, idx) => {
                        const periodWeeks = typeof row.budget_period_weeks === 'number' ? row.budget_period_weeks : (parseInt(row.budget_period_weeks, 10) || 52);
                        const ratio = Math.max(1, parseInt(row.ratio, 10) || 1);
                        const hoursNum = parseHoursPerWeek(row.hours);
                        const rateNum = parseRateNumber(row.rate);
                        const autoBudget = calcBudgetFromFrequency(rateNum, hoursNum, periodWeeks, ratio);
                        return (
                        <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '0.35rem' }}>
                            <select
                              style={{ width: '100%', minWidth: 160 }}
                              value={row.ndis_line_item_id || ''}
                              onChange={(e) => {
                                const id = e.target.value;
                                const item = ndisLineItemsForSchedule.find((i) => i.id === id);
                                const rows = [...(intake.service_schedule_rows || [])];
                                while (rows.length <= idx) rows.push({ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 });
                                rows[idx] = {
                                  ...rows[idx],
                                  ndis_line_item_id: id,
                                  description: item ? (item.description || item.support_item_number || '').trim() : rows[idx].description,
                                  rate: item != null && item.rate != null ? `$${Number(item.rate).toFixed(2)}` : rows[idx].rate
                                };
                                setIntake({ ...intake, service_schedule_rows: rows.slice(0, 5) });
                              }}
                            >
                              <option value="">Select service...</option>
                              {ndisLineItemsForSchedule.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.support_item_number || item.id} – {(item.description || '').slice(0, 50)}{(item.description || '').length > 50 ? '…' : ''}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: '0.35rem' }}>
                            <input
                              style={{ width: '100%', minWidth: 140 }}
                              value={row.description}
                              onChange={(e) => {
                                const rows = [...(intake.service_schedule_rows || [])];
                                while (rows.length <= idx) rows.push({ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 });
                                rows[idx] = { ...rows[idx], description: e.target.value };
                                setIntake({ ...intake, service_schedule_rows: rows.slice(0, 5) });
                              }}
                              placeholder="e.g. Support Coordination"
                            />
                          </td>
                          <td style={{ padding: '0.35rem' }}>
                            <input
                              style={{ width: '100%', minWidth: 100 }}
                              value={row.hours}
                              onChange={(e) => {
                                const newHours = e.target.value;
                                const rows = [...(intake.service_schedule_rows || [])];
                                while (rows.length <= idx) rows.push({ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 });
                                const r = { ...rows[idx], hours: newHours };
                                const pw = typeof r.budget_period_weeks === 'number' ? r.budget_period_weeks : (parseInt(r.budget_period_weeks, 10) || 52);
                                const rRatio = Math.max(1, parseInt(r.ratio, 10) || 1);
                                const calc = calcBudgetFromFrequency(parseRateNumber(r.rate), parseHoursPerWeek(newHours), pw, rRatio);
                                if (calc != null) r.budget = calc;
                                rows[idx] = r;
                                setIntake({ ...intake, service_schedule_rows: rows.slice(0, 5) });
                              }}
                              placeholder="e.g. 6 hrs/week"
                            />
                          </td>
                          <td style={{ padding: '0.35rem' }}>
                            <input
                              style={{ width: '100%', minWidth: 80 }}
                              value={row.rate}
                              onChange={(e) => {
                                const newRate = e.target.value;
                                const rows = [...(intake.service_schedule_rows || [])];
                                while (rows.length <= idx) rows.push({ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 });
                                const r = { ...rows[idx], rate: newRate };
                                const pw = typeof r.budget_period_weeks === 'number' ? r.budget_period_weeks : (parseInt(r.budget_period_weeks, 10) || 52);
                                const calc = calcBudgetFromFrequency(parseRateNumber(newRate), parseHoursPerWeek(r.hours), pw);
                                if (calc != null) r.budget = calc;
                                rows[idx] = r;
                                setIntake({ ...intake, service_schedule_rows: rows.slice(0, 5) });
                              }}
                              placeholder="e.g. $xx.xx"
                            />
                          </td>
                          <td style={{ padding: '0.35rem' }}>
                            <select
                              style={{ width: '100%', minWidth: 70 }}
                              value={ratio}
                              onChange={(e) => {
                                const newRatio = Math.max(1, parseInt(e.target.value, 10) || 1);
                                const rows = [...(intake.service_schedule_rows || [])];
                                while (rows.length <= idx) rows.push({ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 });
                                const r = { ...rows[idx], ratio: newRatio };
                                const pw = typeof r.budget_period_weeks === 'number' ? r.budget_period_weeks : (parseInt(r.budget_period_weeks, 10) || 52);
                                const calc = calcBudgetFromFrequency(parseRateNumber(r.rate), parseHoursPerWeek(r.hours), pw, newRatio);
                                if (calc != null) r.budget = calc;
                                rows[idx] = r;
                                setIntake({ ...intake, service_schedule_rows: rows.slice(0, 5) });
                              }}
                              title="1:1 = full price, 1:2 = half, 1:3 = third, etc."
                            >
                              {BUDGET_RATIO_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: '0.35rem' }}>
                            <input
                              style={{ width: '100%', minWidth: 90 }}
                              value={row.budget || (autoBudget ?? '')}
                              onChange={(e) => {
                                const rows = [...(intake.service_schedule_rows || [])];
                                while (rows.length <= idx) rows.push({ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 });
                                rows[idx] = { ...rows[idx], budget: e.target.value };
                                setIntake({ ...intake, service_schedule_rows: rows.slice(0, 5) });
                              }}
                              onBlur={() => {
                                if (!row.budget && autoBudget != null) {
                                  const rows = [...(intake.service_schedule_rows || [])];
                                  while (rows.length <= idx) rows.push({ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 });
                                  rows[idx] = { ...rows[idx], budget: autoBudget };
                                  setIntake({ ...intake, service_schedule_rows: rows.slice(0, 5) });
                                }
                              }}
                              placeholder="Auto when rate + frequency set"
                              title={autoBudget != null ? `Calculated for ${BUDGET_PERIOD_OPTIONS.find((o) => o.value === periodWeeks)?.label || periodWeeks + ' weeks'}. Edit to override.` : 'Set rate and hours/frequency to auto-calculate'}
                            />
                          </td>
                          <td style={{ padding: '0.35rem' }}>
                            <select
                              style={{ width: '100%', minWidth: 90 }}
                              value={periodWeeks}
                              onChange={(e) => {
                                const newPeriod = Number(e.target.value);
                                const rows = [...(intake.service_schedule_rows || [])];
                                while (rows.length <= idx) rows.push({ ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 });
                                const r = { ...rows[idx], budget_period_weeks: newPeriod };
                                const rRatio = Math.max(1, parseInt(r.ratio, 10) || 1);
                                const calc = calcBudgetFromFrequency(parseRateNumber(r.rate), parseHoursPerWeek(r.hours), newPeriod, rRatio);
                                if (calc != null) r.budget = calc;
                                rows[idx] = r;
                                setIntake({ ...intake, service_schedule_rows: rows.slice(0, 5) });
                              }}
                              title="Budget period for this line"
                            >
                              {BUDGET_PERIOD_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: '0.35rem' }}>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
                              onClick={() => {
                                const rows = (intake.service_schedule_rows || []).filter((_, i) => i !== idx);
                                setIntake({ ...intake, service_schedule_rows: rows });
                              }}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {((intake.service_schedule_rows || []).some((r) => (r.budget || '').toString().trim())) ? (
                  <p style={{ marginTop: '0.5rem', marginBottom: 0, fontWeight: 600, fontSize: '0.95rem' }}>
                    Total budget:{' '}
                    ${(function () {
                      const total = (intake.service_schedule_rows || []).reduce((sum, row) => {
                        const n = parseRateNumber((row.budget || '').toString().trim());
                        return sum + (Number.isFinite(n) ? n : 0);
                      }, 0);
                      return total > 0 ? total.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
                    }())}
                  </p>
                ) : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center' }}>
                  {(intake.service_schedule_rows || []).length < 5 && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setIntake({
                        ...intake,
                        service_schedule_rows: [...(intake.service_schedule_rows || []), { ndis_line_item_id: '', description: '', hours: '', rate: '', ratio: 1, budget: '', budget_period_weeks: 52 }].slice(0, 5)
                      })}
                    >
                      Add row
                    </button>
                  )}
                  {(intake.services_required || []).some((c) => c === '02' || c === '04' || c === '07') && (intake.service_schedule_rows || []).length < 5 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.85rem', marginRight: '0.25rem' }}>Add travel:</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.85rem' }}
                        onClick={() => {
                          const current = intake.service_schedule_rows || [];
                          const mainRow = current.find((r) => parseRateNumber(r.rate) != null && parseRateNumber(r.rate) > 0);
                          if (!mainRow) { alert('Add at least one support line with a rate first.'); return; }
                          if (current.length >= 5) return;
                          const mainRate = parseRateNumber(mainRow.rate);
                          setIntake({
                            ...intake,
                            service_schedule_rows: [...current, {
                              ndis_line_item_id: mainRow.ndis_line_item_id || '',
                              description: 'Provider travel (time)',
                              hours: 'As required',
                              rate: mainRate != null ? `$${Number(mainRate).toFixed(2)}` : '',
                              ratio: 1,
                              budget: '',
                              budget_period_weeks: 52
                            }].slice(0, 5)
                          });
                        }}
                      >
                        Provider travel (time)
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.85rem' }}
                        onClick={() => {
                          const current = intake.service_schedule_rows || [];
                          const item = (scheduleTravelItems.provider_km || scheduleTravelItems.providerKm || [])[0];
                          if (!item) {
                            alert('No provider travel (km) line item. Select category 02, 04 or 07 and import NDIS pricing with 799 km items.');
                            return;
                          }
                          if (current.length >= 5) return;
                          const rateStr = (r) => (r != null && r !== '') ? String(r) : '';
                          setIntake({
                            ...intake,
                            service_schedule_rows: [...current, {
                              ndis_line_item_id: item.id || '',
                              description: rateStr(item.description) || 'Provider travel (km)',
                              hours: 'As required',
                              rate: item.rate != null ? `$${Number(item.rate).toFixed(2)}/km` : '',
                              ratio: 1,
                              budget: '',
                              budget_period_weeks: 52
                            }].slice(0, 5)
                          });
                        }}
                      >
                        Provider travel (km)
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.85rem' }}
                        onClick={() => {
                          const current = intake.service_schedule_rows || [];
                          const mainRow = current.find((r) => parseRateNumber(r.rate) != null && parseRateNumber(r.rate) > 0);
                          const item = (scheduleTravelItems.nonProviderTime || scheduleTravelItems.time || [])[0];
                          if (!mainRow && !item) {
                            alert('Add at least one support line with a rate, or ensure Support Coordination (07) is selected with NDIS line items.');
                            return;
                          }
                          if (current.length >= 5) return;
                          const rateStr = (r) => (r != null && r !== '') ? String(r) : '';
                          const useRow = mainRow || { ndis_line_item_id: item?.id, rate: item?.rate };
                          const rate = mainRow ? parseRateNumber(mainRow.rate) : Number(item?.rate);
                          setIntake({
                            ...intake,
                            service_schedule_rows: [...current, {
                              ndis_line_item_id: useRow.ndis_line_item_id || '',
                              description: rateStr(item?.description) || 'Non-provider travel (time)',
                              hours: 'As required',
                              rate: rate != null && !Number.isNaN(rate) ? `$${Number(rate).toFixed(2)}` : '',
                              ratio: 1,
                              budget: '',
                              budget_period_weeks: 52
                            }].slice(0, 5)
                          });
                        }}
                      >
                        Non-provider travel (time)
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.85rem' }}
                        onClick={() => {
                          const current = intake.service_schedule_rows || [];
                          const k = (scheduleTravelItems.nonProviderKm || scheduleTravelItems.km || [])[0];
                          if (!k) {
                            alert('No non-provider travel (km) line item. Select category 02 or 04 and import NDIS pricing with km line items.');
                            return;
                          }
                          if (current.length >= 5) return;
                          const rateStr = (r) => (r != null && r !== '') ? String(r) : '';
                          setIntake({
                            ...intake,
                            service_schedule_rows: [...current, {
                              ndis_line_item_id: k.id || '',
                              description: rateStr(k.description) || 'Non-provider travel (km)',
                              hours: 'As required',
                              rate: k.rate != null ? `$${Number(k.rate).toFixed(2)}/km` : '',
                              ratio: 1,
                              budget: '',
                              budget_period_weeks: 52
                            }].slice(0, 5)
                          });
                        }}
                      >
                        Non-provider travel (km)
                      </button>
                    </div>
                  ) : null}
                </div>
                {(intake.services_required || []).some((c) => c === '02' || c === '04' || c === '07') ? (
                  <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.35rem' }}>
                    Add one travel line at a time: <strong>Provider travel (time)</strong> and <strong>Non-provider travel (time)</strong> use your first support line&apos;s hourly rate; <strong>Provider travel (km)</strong> uses NDIS 799 km items; <strong>Non-provider travel (km)</strong> uses travel-with-participant km items (02/04). Select the relevant support categories and import NDIS pricing first.
                  </p>
                ) : null}
              </div>
            </div>

            <h5 style={{ marginTop: '1.5rem' }}>Support Categories & NDIS Funding</h5>
            <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.5rem' }}>
              Select all services required. For each, tick how it is managed: NDIA, Plan, or Self.
            </p>
            <div className="services-with-management" style={{ marginBottom: '1rem' }}>
              {(supportCategories.length > 0 ? supportCategories : FALLBACK_SUPPORT_CATEGORIES).map((c) => {
                const required = (intake.services_required || []).includes(c.id);
                const ndia = (intake.ndia_managed_services || []).includes(c.id);
                const plan = (intake.plan_managed_services || []).includes(c.id);
                const self = required && !ndia && !plan;
                return (
                  <div key={c.id} className="service-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <label className="checkbox-label" style={{ flex: 1 }}>
                      <input type="checkbox" checked={required} onChange={() => toggleServiceRequired(c.id)} />
                      <span className="service-name">{c.id} – {c.name}</span>
                    </label>
                    {required && (
                      <div className="management-ticks" style={{ display: 'flex', gap: '0.75rem' }}>
                        <label className="checkbox-label">
                          <input type="checkbox" checked={ndia} onChange={() => toggleNdiaManaged(c.id)} />
                          <span>NDIA</span>
                        </label>
                        <label className="checkbox-label">
                          <input type="checkbox" checked={plan} onChange={() => togglePlanManaged(c.id)} />
                          <span>Plan</span>
                        </label>
                        <label className="checkbox-label">
                          <input type="checkbox" checked={self} onChange={() => toggleSelfManaged(c.id)} />
                          <span>Self</span>
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="form-group">
                <label>Plan start date</label>
                <input type="date" value={intake.plan_start_date} onChange={(e) => setIntake({ ...intake, plan_start_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Plan end date</label>
                <input type="date" value={intake.plan_end_date} onChange={(e) => setIntake({ ...intake, plan_end_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Plan budget / amount</label>
                <input type="text" value={intake.plan_budget_amount} onChange={(e) => setIntake({ ...intake, plan_budget_amount: e.target.value })} placeholder="e.g. total or Core/Capacity breakdown" />
              </div>
              <div className="form-group">
                <label>Plan manager (from Directory – plan managers only)</label>
                <select
                  value={intake.plan_manager_id || ''}
                  onChange={(e) => {
                    const orgId = e.target.value || '';
                    const org = orgs.find((o) => o.id === orgId);
                    setIntake({
                      ...intake,
                      plan_manager_id: orgId,
                      plan_manager_company_name: org?.name || '',
                      plan_manager_invoice_email: org?.email || ''
                    });
                  }}
                >
                  <option value="">Select from directory...</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Plan manager company name</label>
                <input value={intake.plan_manager_company_name} onChange={(e) => setIntake({ ...intake, plan_manager_company_name: e.target.value })} placeholder="Auto-filled when selected from directory" />
              </div>
              <div className="form-group">
                <label>Plan manager invoice email</label>
                <input type="email" value={intake.plan_manager_invoice_email} onChange={(e) => setIntake({ ...intake, plan_manager_invoice_email: e.target.value })} placeholder="For invoicing" />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Additional invoice emails (CC)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.5rem' }}>
                  {(intake.additional_invoice_emails || []).map((em, idx) => (
                    <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', background: '#e2e8f0', borderRadius: '4px', padding: '2px 8px', fontSize: '0.85rem' }}>
                      {em}
                      <button type="button" onClick={() => setIntake({ ...intake, additional_invoice_emails: intake.additional_invoice_emails.filter((_, i) => i !== idx) })} style={{ marginLeft: '4px', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '1rem', lineHeight: 1, color: '#64748b' }}>&times;</button>
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="email"
                    value={additionalEmailInput}
                    onChange={(e) => setAdditionalEmailInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        const val = additionalEmailInput.trim();
                        if (val && val.includes('@') && !(intake.additional_invoice_emails || []).includes(val)) {
                          setIntake({ ...intake, additional_invoice_emails: [...(intake.additional_invoice_emails || []), val] });
                          setAdditionalEmailInput('');
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
                      const val = additionalEmailInput.trim();
                      if (val && val.includes('@') && !(intake.additional_invoice_emails || []).includes(val)) {
                        setIntake({ ...intake, additional_invoice_emails: [...(intake.additional_invoice_emails || []), val] });
                        setAdditionalEmailInput('');
                      }
                    }}
                  >Add</button>
                </div>
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Plan manager details (optional)</label>
                <input value={intake.plan_manager_details} onChange={(e) => setIntake({ ...intake, plan_manager_details: e.target.value })} placeholder="Additional details" />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Risks at home (access, safety, hazards)</label>
                <textarea rows={2} value={intake.risks_at_home} onChange={(e) => setIntake({ ...intake, risks_at_home: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Known triggers or stressors</label>
                <textarea rows={2} value={intake.triggers_stressors} onChange={(e) => setIntake({ ...intake, triggers_stressors: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Current supports or strategies</label>
                <textarea rows={2} value={intake.current_supports_strategies} onChange={(e) => setIntake({ ...intake, current_supports_strategies: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Functional assistance needs (daily living areas)</label>
                <textarea rows={2} value={intake.functional_assistance_needs} onChange={(e) => setIntake({ ...intake, functional_assistance_needs: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Living arrangements (who do you live with)</label>
                <input value={intake.living_arrangements} onChange={(e) => setIntake({ ...intake, living_arrangements: e.target.value })} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Mental health summary</label>
                <textarea rows={2} value={intake.mental_health_summary} onChange={(e) => setIntake({ ...intake, mental_health_summary: e.target.value })} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem' }}>
              <button className="btn btn-primary" onClick={handleSaveIntake} disabled={working || !hasIntakeData}>
                Save intake form
              </button>
            </div>

            {/* Step 2: Service Agreement & Support Plan */}
            <h4 style={{ marginTop: '2rem' }}>2. Service Agreement, Support Plan & Privacy Consent</h4>
            <p style={{ color: '#64748b', marginBottom: '1rem' }}>Service Agreement and Support Plan are auto-filled from intake data. Privacy Consent uses the NDIS form template (filled with participant details). Generate, then send for signature one at a time.</p>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button className="btn btn-primary" onClick={handleGenerateForms} disabled={working || !hasIntakeData}>
                Generate forms from intake
              </button>
            </div>

            {signatureForms.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {signatureForms.map((f) => (
                    <tr key={f.id}>
                      <td>{f.display_name}</td>
                      <td>{f.status}</td>
                      <td style={{ display: 'flex', gap: '0.25rem' }}>
                        {['generated', 'draft'].includes(f.status) && (
                          <>
                            <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }} onClick={() => handleViewDocument(f.id, false)} title="View filled document in CRM">View document</button>
                            <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }} onClick={() => handleViewPreview(f.id)} title="View prefill data">View data</button>
                            <label className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem', margin: 0, cursor: 'pointer' }}>
                              Upload revised
                              <input type="file" accept=".pdf,.docx" style={{ display: 'none' }} onChange={(e) => { const file = e.target.files?.[0]; if (file) handleUploadRevised(f.id, file); e.target.value = ''; }} />
                            </label>
                            <button className="btn btn-primary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }} onClick={() => handleSendForm(f.id)} disabled={working}>Send for signature</button>
                            <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem', color: '#dc2626' }} onClick={() => handleDeleteForm(f.id)} disabled={working} title="Delete form (can regenerate)">Delete</button>
                          </>
                        )}
                        {f.status === 'signed' && <span style={{ color: 'green' }}>Signed {f.signed_at ? formatDate(f.signed_at) : ''}</span>}
                        {['sent', 'viewed'].includes(f.status) && <span style={{ color: '#64748b' }}>Awaiting signature</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Privacy consent is now in step 2 with other forms */}

            {/* Document preview modal - view PDF/Word in CRM */}
            {documentPreviewUrl && (
              <div className="modal-overlay" onClick={closeDocumentPreview}>
                <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '90vh', height: '80vh', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <h3>Document preview</h3>
                    <button className="btn btn-secondary" onClick={closeDocumentPreview}>Close</button>
                  </div>
                  <iframe src={documentPreviewUrl} title="Document" style={{ flex: 1, width: '100%', border: '1px solid #e2e8f0', borderRadius: 8 }} />
                </div>
              </div>
            )}

            {/* Form data preview modal (for viewing intake data) */}
            {previewSnapshot && (
              <div className="modal-overlay" onClick={() => setPreviewSnapshot(null)}>
                <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '90vh', overflow: 'auto' }}>
                  <h3>Form preview – {previewSnapshot?.template?.display_name || 'Auto-filled from intake'}</h3>
                  <FormPreviewReadable snapshot={previewSnapshot} />
                  <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-secondary" onClick={() => setPreviewSnapshot(null)}>Close</button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
