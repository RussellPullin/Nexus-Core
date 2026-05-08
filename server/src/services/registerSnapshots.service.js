/**
 * Single source for register row data: OneDrive Excel sync and in-app Registers UI.
 * When adding a Nexus feature with register-relevant data, extend buildTemplateDataBySheet
 * and add matching UI column labels in REGISTER_UI_HEADERS.
 */

import { db } from '../db/index.js';

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

  const incidentRows = db
    .prepare(
      `SELECT pn.id, pn.support_date, pn.start_time, pn.incidents, pn.session_details, pn.created_at,
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
    .map((r, i) => {
      const when = `${fmtDate(r.support_date)}${r.start_time ? ` ${r.start_time}` : ''}`.trim();
      const persons = `${r.participant_name || ''}${r.participant_email ? ` (${r.participant_email})` : ''}`;
      return [
        i + 1,
        i + 1,
        when,
        persons,
        'Y',
        r.staff_name || '',
        r.incidents || '',
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

  const sigRiskRows = db
    .prepare(
      `SELECT id, name, address, phone, email
       FROM participants
       WHERE provider_org_id = ?
       ORDER BY name`
    )
    .all(organizationId)
    .map((p) => [
      p.name || '',
      p.name || '',
      p.name || '',
      p.name || '',
      p.name || '',
      p.address || '',
      `${p.phone || ''} ${p.email || ''}`.trim(),
      `${p.phone || ''} ${p.email || ''}`.trim(),
      `${p.phone || ''} ${p.email || ''}`.trim(),
      `${p.phone || ''} ${p.email || ''}`.trim(),
      `${p.phone || ''} ${p.email || ''}`.trim(),
      'Refer participant profile and risk details in Nexus Core',
      'Refer participant profile and risk details in Nexus Core',
      '',
      '',
      '',
      '',
      '',
      'Managed in Nexus Core'
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
  { sheetKey: 'Significant risk factor', title: 'Significant risk factors (participant summary)', source: 'participant_profiles' },
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
