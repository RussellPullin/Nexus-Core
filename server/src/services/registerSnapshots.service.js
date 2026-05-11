/**
 * Single source for register row data: OneDrive Excel sync and in-app Registers UI.
 * When adding a Nexus feature with register-relevant data, extend buildTemplateDataBySheet
 * and add matching UI column labels in REGISTER_UI_HEADERS.
 * Incident register: shift-level incident ticket Yes only, one row per shift. Significant risk: clinical intake fields.
 */

import { db } from '../db/index.js';
import { PARTICIPANT_INTAKE_FIELD_DEFS } from '../../../shared/onboardingFieldRegistry.js';

/** Intake keys stored under participant onboarding — clinical section = risk assessment capture. */
const RISK_ASSESSMENT_FIELD_KEYS = PARTICIPANT_INTAKE_FIELD_DEFS.filter((d) => d.section === 'clinical').map((d) => d.key);

const RISK_ASSESSMENT_FIELD_LABEL = Object.fromEntries(
  PARTICIPANT_INTAKE_FIELD_DEFS.filter((d) => d.section === 'clinical').map((d) => [d.key, d.label])
);

export function fmtDate(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(v);
  }
}

function cellStr(v) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return String(v);
}

/**
 * Shifter stores the shift-level incident ticket as Yes/No in progress_notes.incidents.
 * The incident register lists only rows where the ticket is Yes (not "No" or narrative-only).
 */
export function isIncidentTicketYes(incidents) {
  const raw = String(incidents ?? '').trim();
  if (!raw) return false;
  const firstLine = raw.split(/\r?\n/)[0].trim();
  const firstToken = firstLine.split(/[\s,:;–—-]+/)[0].toLowerCase();
  return firstToken === 'yes' || firstToken === 'y';
}

/** Text for the Incident column: detail after "Yes", or session notes when the field is only the flag. */
function incidentRegisterNarrative(incidents, sessionDetails) {
  const raw = String(incidents ?? '').trim();
  const sess = String(sessionDetails ?? '').trim();
  if (!raw) return sess;
  const lines = raw.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? '';
  const rest = lines.slice(1).join('\n').trim();
  const firstToken = firstLine.split(/[\s,:;–—-]+/)[0].toLowerCase();
  if (firstToken === 'yes' || firstToken === 'y') {
    if (rest) return rest;
    return sess || firstLine;
  }
  return raw;
}

/**
 * One incident register row per shift that reported an incident (Yes): latest matching progress note only.
 * Notes without shift_id are still listed (one row each), keyed by progress note id.
 */
function dedupeIncidentProgressNotes(rows) {
  const sorted = [...rows].sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta;
  });
  const seen = new Set();
  const out = [];
  for (const r of sorted) {
    const sid = r.shift_id != null && String(r.shift_id).trim() !== '' ? String(r.shift_id).trim() : '';
    const key = sid ? `shift:${sid}` : `note:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function buildRiskAssessmentNarrative(fieldMap) {
  const parts = [];
  for (const key of RISK_ASSESSMENT_FIELD_KEYS) {
    const val = String(fieldMap[key] ?? '').trim();
    if (!val) continue;
    const label = RISK_ASSESSMENT_FIELD_LABEL[key] || key;
    parts.push(`${label}: ${val}`);
  }
  return parts.join('\n\n');
}

function truncateForCell(s, maxLen) {
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

/** Human-readable columns for in-app tables (pad with "Column n" if row wider). */
const REGISTER_UI_HEADERS = {
  Complaints: [
    '#',
    'Ref',
    'ID',
    'Contact date',
    'Date recorded',
    'Contact type',
    'Formal complaint',
    'Contact details',
    'Person details',
    'Participant',
    'Notes',
    'Notes (detail)',
    'Summary',
    '—',
    'Resolved date',
    '—',
    'Source',
    'Flags',
    '—',
    'Recorded by'
  ],
  'Document Register': [
    'Document label',
    'Title',
    'Reference',
    'Revision',
    'Recorded by',
    'Owner',
    'Date recorded',
    'Date reviewed',
    'Notes'
  ],
  'Feedback and complaints': [
    'Contact date',
    'Date recorded',
    'Type',
    'Contact / participant',
    'Feedback notes',
    'Detail',
    'Summary',
    '—',
    '—',
    'Follow-up date',
    '—',
    'Source',
    '—',
    'Recorded by'
  ],
  'HR role register': [
    'Role',
    'Col2',
    'Col3',
    'Col4',
    'Row label',
    'R6',
    'R7',
    'R8',
    'R9',
    'R10',
    'R11',
    'Note 1',
    'Note 2',
    'Note 3',
    'Note 4',
    'Note 5',
    'Note 6',
    'Note 7',
    'Effective from',
    'Review date',
    'Owner 1',
    'Owner 2',
    'Owner 3',
    'Owner 4'
  ],
  'Significant risk factor': [
    'Participant',
    'Name 2',
    'Name 3',
    'Name 4',
    'Name 5',
    'Address',
    'Contact 1',
    'Contact 2',
    'Contact 3',
    'Contact 4',
    'Contact 5',
    'Risk notes',
    'Detail',
    '—',
    '—',
    '—',
    '—',
    '—',
    'Managed in'
  ],
  'Training and Development': [
    'Training / certificate',
    'Description',
    'Provider',
    '—',
    'Recorded by',
    'Expiry',
    'Uploaded',
    '—',
    'Status',
    'Review date',
    '—',
    '—',
    '—'
  ],
  'Policy register': ['Policy name', 'Title', 'Reference', 'Version', 'Owner', 'Reviewer', 'Effective date', 'Notes'],
  'Incident register': [
    '#',
    'Ref',
    'When',
    'Participant / persons',
    'Notifiable',
    'Staff',
    'Incident',
    'Further action',
    'Session / actions',
    'Source',
    '—',
    '—',
    '—',
    '—',
    'Logged date',
    'Logged by',
    '—',
    '—',
    '—'
  ]
};

/** Sheets that appear in the template but have no Nexus data pipeline yet — show placeholder in UI. */
export const PENDING_REGISTER_DATA_SOURCES = {
  'Conflict of interest register':
    'Will auto-fill when conflict-of-interest declarations are stored in Nexus (feature pending).',
  'Collection and storage of Med':
    'Will auto-fill when medication storage records are captured in Nexus (feature pending).',
  'Continuous improvment':
    'Will auto-fill when continuous improvement actions are tracked in Nexus (feature pending).',
  'Emergency test register':
    'Will auto-fill when emergency drill / test records are captured in Nexus (feature pending).',
  'Waste removal Register': 'Will auto-fill when waste disposal logs are captured in Nexus (feature pending).'
};

/**
 * Row data keyed by Excel sheet name (must match Registers.xlsx worksheet names for OneDrive export).
 */
export function buildTemplateDataBySheet(organizationId) {
  const byIdParticipant = new Map(
    db
      .prepare('SELECT id, name, phone, email, address, management_type FROM participants WHERE provider_org_id = ?')
      .all(organizationId)
      .map((p) => [p.id, p])
  );
  const byIdStaff = new Map(
    db.prepare('SELECT id, name, role, email FROM staff WHERE org_id = ?').all(organizationId).map((s) => [s.id, s])
  );

  const docRows = db
    .prepare(
      `SELECT entity_type, entity_id, category, filename, created_at
       FROM onedrive_document_register
       WHERE organization_id = ?
       ORDER BY datetime(created_at) DESC`
    )
    .all(organizationId)
    .map((r) => {
      const name =
        r.entity_type === 'participant'
          ? byIdParticipant.get(r.entity_id)?.name || 'Participant'
          : r.entity_type === 'staff'
            ? byIdStaff.get(r.entity_id)?.name || 'Staff'
            : 'General';
      const label = `${name} - ${r.category || 'Other'} - ${r.filename}`;
      return [label, label, label, 1, 'Nexus Core', 'Nexus Core', fmtDate(r.created_at), fmtDate(r.created_at), ''];
    });

  const incidentRows = dedupeIncidentProgressNotes(
    db
      .prepare(
        `SELECT pn.id, pn.shift_id, pn.support_date, pn.start_time, pn.incidents, pn.session_details, pn.created_at,
                p.name AS participant_name, p.email AS participant_email, s.name AS staff_name
         FROM progress_notes pn
         JOIN participants p ON p.id = pn.participant_id
         LEFT JOIN staff s ON s.id = pn.staff_id
         WHERE p.provider_org_id = ?
           AND pn.incidents IS NOT NULL
           AND trim(pn.incidents) <> ''
         ORDER BY datetime(pn.created_at) DESC`
      )
      .all(organizationId)
      .filter((r) => isIncidentTicketYes(r.incidents))
  ).map((r, i) => {
      const when = `${fmtDate(r.support_date)}${r.start_time ? ` ${r.start_time}` : ''}`.trim();
      const persons = `${r.participant_name || ''}${r.participant_email ? ` (${r.participant_email})` : ''}`;
      const narrative = incidentRegisterNarrative(r.incidents, r.session_details);
      return [
        i + 1,
        i + 1,
        when,
        persons,
        'N',
        r.staff_name || '',
        narrative,
        'N',
        r.session_details || '',
        'Logged from Nexus progress notes',
        '',
        '',
        '',
        '',
        '',
        fmtDate(r.created_at),
        r.staff_name || 'Nexus Core',
        '',
        '',
        ''
      ];
    });

  const riskKeyPlaceholders = RISK_ASSESSMENT_FIELD_KEYS.map(() => '?').join(', ');
  const sigRiskRows = (() => {
    if (RISK_ASSESSMENT_FIELD_KEYS.length === 0) return [];
    const riskRows = db
      .prepare(
        `WITH latest AS (
           SELECT po.id AS onboarding_id,
                  po.participant_id,
                  p.name AS participant_name,
                  p.address AS participant_address,
                  p.phone AS participant_phone,
                  p.email AS participant_email,
                  p.parent_guardian_phone,
                  p.parent_guardian_email,
                  row_number() OVER (
                    PARTITION BY po.participant_id
                    ORDER BY datetime(COALESCE(po.last_activity_at, po.updated_at, po.created_at)) DESC,
                             po.id DESC
                  ) AS rn
           FROM participant_onboarding po
           JOIN participants p ON p.id = po.participant_id AND p.provider_org_id = ?
           JOIN provider_profiles pp ON pp.id = po.provider_profile_id AND pp.organisation_id = p.provider_org_id
         )
         SELECT l.onboarding_id,
                l.participant_id,
                l.participant_name,
                l.participant_address,
                l.participant_phone,
                l.participant_email,
                l.parent_guardian_phone,
                l.parent_guardian_email,
                pif.field_key,
                pif.field_value
         FROM latest l
         JOIN participant_intake_fields pif ON pif.participant_onboarding_id = l.onboarding_id
         WHERE l.rn = 1
           AND pif.field_key IN (${riskKeyPlaceholders})
           AND trim(COALESCE(pif.field_value, '')) <> ''`
      )
      .all(organizationId, ...RISK_ASSESSMENT_FIELD_KEYS);

    const byOnboarding = new Map();
    for (const row of riskRows) {
      const obId = row.onboarding_id;
      if (!byOnboarding.has(obId)) {
        byOnboarding.set(obId, {
          participant_name: row.participant_name,
          participant_address: row.participant_address,
          participant_phone: row.participant_phone,
          participant_email: row.participant_email,
          parent_guardian_phone: row.parent_guardian_phone,
          parent_guardian_email: row.parent_guardian_email,
          fields: {}
        });
      }
      byOnboarding.get(obId).fields[row.field_key] = row.field_value;
    }

    const out = [];
    for (const meta of byOnboarding.values()) {
      const narrative = buildRiskAssessmentNarrative(meta.fields);
      if (!narrative.trim()) continue;
      const name = meta.participant_name || '';
      const contact1 = `${meta.participant_phone || ''} ${meta.participant_email || ''}`.trim();
      const contact2 = `${meta.parent_guardian_phone || ''} ${meta.parent_guardian_email || ''}`.trim();
      out.push([
        name,
        name,
        name,
        name,
        name,
        meta.participant_address || '',
        contact1,
        contact2,
        '',
        '',
        '',
        truncateForCell(narrative, 480),
        narrative,
        '',
        '',
        '',
        '',
        '',
        'Nexus Core (participant intake risk assessment)'
      ]);
    }
    out.sort((a, b) => String(a[0] || '').localeCompare(String(b[0] || ''), undefined, { sensitivity: 'base' }));
    return out;
  })();

  const trainingRows = db
    .prepare(
      `SELECT scd.document_type, scd.uploaded_at, scd.expiry_date, scd.status, s.name AS staff_name
       FROM staff_compliance_documents scd
       JOIN staff s ON s.id = scd.staff_id
       WHERE s.org_id = ?
       ORDER BY datetime(scd.uploaded_at) DESC`
    )
    .all(organizationId)
    .map((r) => [
      `${r.document_type} (${r.staff_name})`,
      `Compliance evidence for ${r.staff_name}`,
      'Internal',
      '',
      'Nexus Core',
      fmtDate(r.expiry_date),
      fmtDate(r.uploaded_at),
      '',
      r.status || '',
      fmtDate(r.expiry_date),
      '',
      '',
      ''
    ]);

  const hrRoleRows = Array.from(
    new Set(
      db
        .prepare("SELECT COALESCE(NULLIF(trim(role), ''), 'Staff') AS role_name FROM staff WHERE org_id = ?")
        .all(organizationId)
        .map((r) => r.role_name)
    )
  ).map((role) => [
    role,
    role,
    role,
    role,
    'Direct support role',
    'Direct support role',
    'Direct support role',
    'Direct support role',
    'Direct support role',
    'Direct support role',
    'Direct support role',
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    `Role managed in Nexus Core (${role})`,
    fmtDate(new Date().toISOString()),
    fmtDate(new Date().toISOString()),
    'Nexus Core',
    'Nexus Core',
    'Nexus Core',
    'Nexus Core'
  ]);

  const policyRows = db
    .prepare(
      `SELECT cpf.display_name, cpf.created_at
       FROM company_policy_files cpf
       JOIN provider_profiles pp ON pp.id = cpf.provider_profile_id
       WHERE pp.organisation_id = ?
       ORDER BY datetime(cpf.created_at) DESC`
    )
    .all(organizationId)
    .map((r) => [
      r.display_name,
      r.display_name,
      r.display_name,
      1,
      'Nexus Core',
      'Nexus Core',
      fmtDate(r.created_at),
      ''
    ]);

  const complaintsRows = db
    .prepare(
      `SELECT cn.id, cn.contact_date, cn.contact_type, cn.notes, p.name, p.phone, p.email
       FROM case_notes cn
       JOIN participants p ON p.id = cn.participant_id
       WHERE p.provider_org_id = ?
         AND (lower(coalesce(cn.contact_type,'')) LIKE '%complaint%' OR lower(coalesce(cn.notes,'')) LIKE '%complaint%')
       ORDER BY datetime(cn.created_at) DESC`
    )
    .all(organizationId)
    .map((r, i) => [
      i + 1,
      i + 1,
      i + 1,
      fmtDate(r.contact_date),
      fmtDate(r.contact_date),
      r.contact_type || '',
      'Y',
      `${r.name || ''} ${r.phone || ''} ${r.email || ''}`.trim(),
      `${r.name || ''} ${r.phone || ''} ${r.email || ''}`.trim(),
      `${r.name || ''} ${r.phone || ''} ${r.email || ''}`.trim(),
      r.notes || '',
      r.notes || '',
      r.notes || '',
      '',
      fmtDate(r.contact_date),
      '',
      'Logged from Nexus case notes',
      'Y',
      '',
      'Nexus Core'
    ]);

  const feedbackRows = db
    .prepare(
      `SELECT cn.contact_date, cn.contact_type, cn.notes, p.name, p.phone, p.email
       FROM case_notes cn
       JOIN participants p ON p.id = cn.participant_id
       WHERE p.provider_org_id = ?
         AND (lower(coalesce(cn.contact_type,'')) LIKE '%feedback%' OR lower(coalesce(cn.contact_type,'')) LIKE '%compliment%' OR lower(coalesce(cn.notes,'')) LIKE '%feedback%' OR lower(coalesce(cn.notes,'')) LIKE '%compliment%')
       ORDER BY datetime(cn.created_at) DESC`
    )
    .all(organizationId)
    .map((r) => [
      fmtDate(r.contact_date),
      fmtDate(r.contact_date),
      r.contact_type || '',
      `${r.name || ''} ${r.phone || ''} ${r.email || ''}`.trim(),
      r.notes || '',
      r.notes || '',
      r.notes || '',
      '',
      '',
      fmtDate(r.contact_date),
      '',
      'Logged from Nexus case notes',
      '',
      'Nexus Core'
    ]);

  return {
    Complaints: complaintsRows,
    'Document Register': docRows,
    'Feedback and complaints': feedbackRows,
    'HR role register': hrRoleRows,
    'Significant risk factor': sigRiskRows,
    'Training and Development': trainingRows,
    'Policy register': policyRows,
    'Incident register': incidentRows
  };
}

const REGISTER_DISPLAY_ORDER = [
  { sheetKey: 'Document Register', title: 'Document register', source: 'documents_synced' },
  { sheetKey: 'Policy register', title: 'Policy register', source: 'company_policy_files' },
  { sheetKey: 'HR role register', title: 'HR role register', source: 'staff_roles' },
  { sheetKey: 'Training and Development', title: 'Training & compliance', source: 'staff_compliance_documents' },
  { sheetKey: 'Incident register', title: 'Incident register', source: 'progress_notes_incidents' },
  { sheetKey: 'Complaints', title: 'Complaints', source: 'case_notes_complaints' },
  { sheetKey: 'Feedback and complaints', title: 'Feedback & compliments', source: 'case_notes_feedback' },
  {
    sheetKey: 'Significant risk factor',
    title: 'Significant risk factors (intake risk assessment)',
    source: 'participant_intake_clinical'
  },
  { sheetKey: 'Conflict of interest register', title: 'Conflict of interest register', source: null },
  { sheetKey: 'Emergency test register', title: 'Emergency test register', source: null },
  { sheetKey: 'Collection and storage of Med', title: 'Collection & storage of medication', source: null },
  { sheetKey: 'Continuous improvment', title: 'Continuous improvement', source: null },
  { sheetKey: 'Waste removal Register', title: 'Waste removal register', source: null }
];

function headersForSheet(sheetKey, rows) {
  const base = REGISTER_UI_HEADERS[sheetKey] || [];
  let w = base.length;
  for (const r of rows) w = Math.max(w, r.length);
  const out = [];
  for (let i = 0; i < w; i++) {
    out.push(base[i] || `Column ${i + 1}`);
  }
  return out;
}

function normalizeRows(rows) {
  return rows.map((r) => r.map(cellStr));
}

/**
 * JSON payload for GET /api/registers/snapshot — same underlying rows as OneDrive template sync.
 */
export function buildRegisterSnapshotForOrg(organizationId) {
  const sheetData = buildTemplateDataBySheet(organizationId);
  const generatedAt = new Date().toISOString();
  const views = [];

  for (const def of REGISTER_DISPLAY_ORDER) {
    const pendingNote = PENDING_REGISTER_DATA_SOURCES[def.sheetKey];
    const rawRows = sheetData[def.sheetKey] || [];
    const rows = normalizeRows(rawRows);
    const columns = headersForSheet(def.sheetKey, rows);
    views.push({
      id: def.sheetKey.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      sheet_key: def.sheetKey,
      title: def.title,
      data_source: def.source,
      populated_from_nexus: !pendingNote,
      roadmap_note: pendingNote || null,
      row_count: rows.length,
      columns,
      rows
    });
  }

  return {
    generated_at: generatedAt,
    organisation_id: organizationId,
    views,
    hint:
      'Rows mirror what is pushed to OneDrive Register/*.xlsx when connected. Extend registerSnapshots.service.js when new Nexus features supply register data.'
  };
}
