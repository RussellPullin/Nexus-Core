#!/usr/bin/env node
/**
 * Phase 5: Seed the master document library with a complete NDIS-aligned starter set.
 *
 * Creates `server/data/forms/templates/library/<slug>/manifest.json` and a placeholder
 * `template.html` for every document below. The next server boot (or a `POST
 * /api/document-library/sync`) registers them as masters; each new org's setup wizard
 * then clones them automatically via `seedOrgFromMasters`.
 *
 * Authors are expected to replace each `template.html` with their real `template.docx`
 * (and flip `engine` to `docxtemplater`) when their deidentified content is ready.
 *
 * Run:
 *   node server/scripts/seed-document-library.mjs
 *   node server/scripts/seed-document-library.mjs --force   # overwrite existing manifests
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libraryRoot = resolve(__dirname, '..', 'data', 'forms', 'templates', 'library');
const force = process.argv.includes('--force');

const COMMON_FOOTER_TOKENS = [
  'org.legal_name',
  'org.trading_name',
  'org.abn',
  'org.acn',
  'org.ndis_provider_number',
  'org.address',
  'org.email',
  'org.phone',
  'org.signatory.name',
  'org.signatory.role',
  'today_long'
];

/** @type {Array<{slug: string, display_name: string, category: string, form_type: string, blurb: string, extra_tokens?: string[], renewal_days?: number}>} */
const DOCUMENTS = [
  // ---- Policies (mandatory under NDIS Practice Standards) ----
  { slug: 'policy-privacy-and-dignity', display_name: 'Privacy & Dignity Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Outlines how participants\' privacy, dignity and confidentiality are protected.' },
  { slug: 'policy-incident-management', display_name: 'Incident Management Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Defines responsibilities for identifying, reporting and responding to incidents.' },
  { slug: 'policy-complaints-management', display_name: 'Complaints Management Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Sets out how complaints and feedback are received, acknowledged and resolved.' },
  { slug: 'policy-risk-management', display_name: 'Risk Management Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Framework for identifying, assessing and controlling organisational and participant risks.' },
  { slug: 'policy-whs', display_name: 'Work Health & Safety Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Defines the organisation\'s commitment to safe systems of work for staff and participants.' },
  { slug: 'policy-equal-opportunity', display_name: 'Equal Opportunity & Anti-Discrimination Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Confirms equal opportunity and prohibits discrimination, bullying and harassment.' },
  { slug: 'policy-code-of-conduct', display_name: 'NDIS Code of Conduct Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Adopts and operationalises the NDIS Code of Conduct.' },
  { slug: 'policy-conflict-of-interest', display_name: 'Conflict of Interest Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Defines how actual, perceived or potential conflicts of interest are managed.' },
  { slug: 'policy-continuous-improvement', display_name: 'Continuous Improvement Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Commits the organisation to feedback-driven improvement cycles.' },
  { slug: 'policy-restrictive-practices', display_name: 'Restrictive Practices Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Sets the framework for the use, authorisation and reporting of regulated restrictive practices.' },
  { slug: 'policy-medication-management', display_name: 'Medication Management Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Outlines safe medication storage, administration and recording.' },
  { slug: 'policy-infection-control', display_name: 'Infection Prevention & Control Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Sets baseline practices for infection prevention including outbreak management.' },
  { slug: 'policy-emergency-and-disaster', display_name: 'Emergency & Disaster Management Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Defines preparedness, response and recovery for emergencies and disasters.' },
  { slug: 'policy-information-management', display_name: 'Information Management Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Governs how participant and organisational information is collected, stored, accessed and destroyed.' },
  { slug: 'policy-worker-screening', display_name: 'Worker Screening Policy', category: 'policy', form_type: 'policy', renewal_days: 365,
    blurb: 'Ensures all workers in risk-assessed roles hold a current NDIS Worker Screening clearance.' },

  // ---- Procedures ----
  { slug: 'procedure-intake-and-onboarding', display_name: 'Participant Intake & Onboarding Procedure', category: 'procedure', form_type: 'procedure', renewal_days: 365,
    blurb: 'Step-by-step process from initial enquiry through to signed Service Agreement.' },
  { slug: 'procedure-service-delivery', display_name: 'Service Delivery Procedure', category: 'procedure', form_type: 'procedure', renewal_days: 365,
    blurb: 'Standard operating procedure for day-to-day service delivery.' },
  { slug: 'procedure-service-termination', display_name: 'Service Termination & Exit Procedure', category: 'procedure', form_type: 'procedure', renewal_days: 365,
    blurb: 'How service ceases — voluntary, mutual, or for cause — and how records and notice periods are managed.' },
  { slug: 'procedure-complaints-handling', display_name: 'Complaints Handling Procedure', category: 'procedure', form_type: 'procedure', renewal_days: 365,
    blurb: 'Operational steps for acknowledging, investigating and resolving complaints.' },
  { slug: 'procedure-incident-reporting', display_name: 'Incident Reporting & Investigation Procedure', category: 'procedure', form_type: 'procedure', renewal_days: 365,
    blurb: 'How to report, escalate and investigate reportable and non-reportable incidents.' },
  { slug: 'procedure-worker-recruitment', display_name: 'Worker Recruitment & Screening Procedure', category: 'procedure', form_type: 'procedure', renewal_days: 365,
    blurb: 'Recruitment, reference-checking and pre-employment screening process.' },
  { slug: 'procedure-worker-training', display_name: 'Worker Training & Supervision Procedure', category: 'procedure', form_type: 'procedure', renewal_days: 365,
    blurb: 'Induction, mandatory training, supervision and competency assessment.' },
  { slug: 'procedure-medication-administration', display_name: 'Medication Administration Procedure', category: 'procedure', form_type: 'procedure', renewal_days: 365,
    blurb: 'Step-by-step process for safely administering and recording medication.' },

  // ---- Registers ----
  { slug: 'register-risk', display_name: 'Risk Register', category: 'register', form_type: 'register', renewal_days: 90,
    blurb: 'Live record of identified risks, their controls and review dates.' },
  { slug: 'register-incident', display_name: 'Incident Register', category: 'register', form_type: 'register', renewal_days: 30,
    blurb: 'Chronological log of reportable and non-reportable incidents and their status.' },
  { slug: 'register-complaints', display_name: 'Complaints Register', category: 'register', form_type: 'register', renewal_days: 30,
    blurb: 'Tracks complaints, status, outcomes and lessons learned.' },
  { slug: 'register-training', display_name: 'Training Register', category: 'register', form_type: 'register', renewal_days: 30,
    blurb: 'Records mandatory and optional training completed by each worker.' },
  { slug: 'register-worker-compliance', display_name: 'Worker Compliance Register', category: 'register', form_type: 'register', renewal_days: 30,
    blurb: 'Tracks each worker\'s screening, qualifications, immunisations and expiries.' },
  { slug: 'register-restrictive-practices', display_name: 'Restrictive Practices Register', category: 'register', form_type: 'register', renewal_days: 30,
    blurb: 'Records each regulated restrictive practice use, authorisation and review.' },
  { slug: 'register-continuous-improvement', display_name: 'Continuous Improvement Register', category: 'register', form_type: 'register', renewal_days: 90,
    blurb: 'Log of improvement opportunities, actions taken and outcomes.' },
  { slug: 'register-assets', display_name: 'Asset Register', category: 'register', form_type: 'register', renewal_days: 180,
    blurb: 'Organisational asset list with location, value and service status.' },
  { slug: 'register-conflict-of-interest', display_name: 'Conflict of Interest Register', category: 'register', form_type: 'register', renewal_days: 180,
    blurb: 'Declared conflicts of interest with management strategies.' },
  { slug: 'register-vehicle-maintenance', display_name: 'Vehicle Maintenance Register', category: 'register', form_type: 'register', renewal_days: 90,
    blurb: 'Tracks each vehicle\'s servicing, inspection and registration status.' },
  { slug: 'register-hazard', display_name: 'Hazard Register', category: 'register', form_type: 'register', renewal_days: 90,
    blurb: 'Hazards identified by location and the controls in place.' },

  // ---- Contracts ----
  { slug: 'contract-employment', display_name: 'Employment Contract', category: 'contract', form_type: 'employment_contract', renewal_days: 0,
    blurb: 'Standard employment agreement template.', extra_tokens: ['staff.full_name', 'staff.role', 'staff.start_date', 'staff.hourly_rate'] },
  { slug: 'contract-subcontractor', display_name: 'Subcontractor / Independent Worker Agreement', category: 'contract', form_type: 'subcontractor_agreement', renewal_days: 365,
    blurb: 'Agreement template for engaging independent workers under an ABN.',
    extra_tokens: ['staff.full_name', 'staff.abn', 'staff.hourly_rate'] },
  { slug: 'contract-confidentiality', display_name: 'Confidentiality Agreement', category: 'contract', form_type: 'confidentiality_agreement', renewal_days: 0,
    blurb: 'Standalone confidentiality deed for contractors, visitors and observers.' },

  // ---- Forms ----
  { slug: 'form-incident-report', display_name: 'Incident Report Form', category: 'form', form_type: 'incident_report',
    blurb: 'Form completed by the worker at the time of an incident.',
    extra_tokens: ['participant.full_name'] },
  { slug: 'form-complaint', display_name: 'Complaint Form', category: 'form', form_type: 'complaint',
    blurb: 'Used by participants, advocates or staff to raise a complaint.',
    extra_tokens: ['participant.full_name'] },
  { slug: 'form-risk-assessment', display_name: 'Risk Assessment Form', category: 'form', form_type: 'risk_assessment',
    blurb: 'Per-participant or activity risk assessment template.',
    extra_tokens: ['participant.full_name'] },
  { slug: 'form-medication-chart', display_name: 'Medication Chart', category: 'form', form_type: 'medication_chart',
    blurb: 'Per-participant chart for prescribed and PRN medications.',
    extra_tokens: ['participant.full_name', 'participant.date_of_birth'] },
  { slug: 'form-progress-note', display_name: 'Daily Progress Note', category: 'form', form_type: 'progress_note',
    blurb: 'Shift-by-shift case note template used by support workers.',
    extra_tokens: ['participant.full_name', 'staff.full_name'] },
  { slug: 'form-restrictive-practice-authorisation', display_name: 'Restrictive Practice Authorisation', category: 'form', form_type: 'restrictive_practice_authorisation',
    blurb: 'Authorisation request for a regulated restrictive practice.',
    extra_tokens: ['participant.full_name'] },
  { slug: 'form-worker-reference-check', display_name: 'Worker Reference Check Form', category: 'form', form_type: 'reference_check',
    blurb: 'Structured reference-check questions for prospective workers.',
    extra_tokens: ['staff.full_name'] },
  { slug: 'form-police-check-consent', display_name: 'Police Check Consent Form', category: 'form', form_type: 'police_check_consent',
    blurb: 'Consent form for criminal history check (where required in addition to NDIS Worker Screening).',
    extra_tokens: ['staff.full_name'] },

  // ---- Guides ----
  { slug: 'guide-service-user-handbook', display_name: 'Service User Handbook', category: 'guide', form_type: 'handbook', renewal_days: 365,
    blurb: 'Plain-English handbook given to participants explaining services, rights, complaints and contacts.' },
  { slug: 'guide-worker-induction', display_name: 'Worker Induction Guide', category: 'guide', form_type: 'induction_guide', renewal_days: 365,
    blurb: 'Onboarding handbook for new workers, including code of conduct and mandatory training.',
    extra_tokens: ['staff.full_name'] },
  { slug: 'guide-quality-and-safeguards', display_name: 'Quality & Safeguards Overview', category: 'guide', form_type: 'quality_overview', renewal_days: 365,
    blurb: 'Summary of how the organisation meets the NDIS Practice Standards.' }
];

function buildHtmlTemplate(doc) {
  const renewalLine = doc.renewal_days
    ? `<p class="meta">Review cycle: every ${doc.renewal_days} day${doc.renewal_days === 1 ? '' : 's'}</p>`
    : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>{{org.trading_name}} — ${escapeHtml(doc.display_name)}</title>
<style>
  body { font-family: 'Helvetica', 'Arial', sans-serif; color: #111; max-width: 760px; margin: 2rem auto; padding: 1rem; }
  header { border-bottom: 4px solid {{org.branding.primary_color}}; padding-bottom: .75rem; margin-bottom: 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .35rem; color: {{org.branding.primary_color}}; }
  .meta { font-size: .8rem; color: #475569; margin: .1rem 0; }
  section { margin-top: 1rem; }
  h2 { font-size: 1.05rem; color: {{org.branding.accent_color}}; border-bottom: 1px solid #e5e7eb; padding-bottom: .25rem; }
  footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; font-size: .72rem; color: #475569; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(doc.display_name)}</h1>
    <p class="meta"><strong>{{org.trading_name}}</strong>{{#org.legal_name}} (trading as {{org.legal_name}}){{/org.legal_name}}</p>
    <p class="meta">ABN {{org.abn}}{{#org.ndis_provider_number}} · NDIS provider {{org.ndis_provider_number}}{{/org.ndis_provider_number}}</p>
    ${renewalLine}
    <p class="meta">Issued {{today_long}}</p>
  </header>

  <section>
    <h2>Purpose</h2>
    <p>${escapeHtml(doc.blurb)}</p>
  </section>

  <section>
    <h2>Scope</h2>
    <p>Applies to all workers, contractors and volunteers engaged by {{org.trading_name}}, and to every participant receiving services.</p>
  </section>

  <section>
    <h2>Policy / procedure body</h2>
    <p><em>[Replace this section with the deidentified content for this document.]</em></p>
  </section>

  <section>
    <h2>Responsibilities</h2>
    <p>Approved by {{org.signatory.name}} ({{org.signatory.role}}).</p>
  </section>

  <footer>
    {{org.trading_name}} · {{org.address}} · {{org.email}} · {{org.phone}}<br>
    {{org.branding.letterhead_footer_text}}
  </footer>
</body>
</html>`;
}

function buildManifest(doc) {
  const placeholders = [...COMMON_FOOTER_TOKENS];
  if (doc.extra_tokens) placeholders.push(...doc.extra_tokens);
  return {
    slug: doc.slug,
    display_name: doc.display_name,
    category: doc.category,
    form_type: doc.form_type,
    engine: 'html',
    version: '1.0.0',
    template_file: 'template.html',
    placeholders,
    renewal_days: doc.renewal_days || null
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function main() {
  if (!existsSync(libraryRoot)) {
    mkdirSync(libraryRoot, { recursive: true });
  }
  const summary = { created: 0, skipped: 0, total: DOCUMENTS.length };
  for (const doc of DOCUMENTS) {
    const dir = join(libraryRoot, doc.slug);
    const manifestPath = join(dir, 'manifest.json');
    const templatePath = join(dir, 'template.html');
    if (existsSync(manifestPath) && !force) {
      summary.skipped += 1;
      continue;
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(doc), null, 2)}\n`);
    writeFileSync(templatePath, buildHtmlTemplate(doc));
    summary.created += 1;
  }
  console.log(`[seed-document-library] root=${libraryRoot}`);
  console.log(`[seed-document-library] created=${summary.created} skipped=${summary.skipped} total=${summary.total}`);
  if (summary.skipped > 0 && !force) {
    console.log('[seed-document-library] tip: pass --force to overwrite existing manifests/templates.');
  }
}

main();
