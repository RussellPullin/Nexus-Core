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

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Stable view id from an Excel sheet name (must match buildRegisterSnapshotForOrg). */
export function sheetKeyToViewId(sheetKey) {
  return String(sheetKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * All registers Nexus can populate. Orgs choose which appear in the live UI via org_register_settings.
 * incident_register uses form CRUD instead of inline cell editing even when marked editable.
 */
export const REGISTER_CATALOG = [
  { sheetKey: 'Staff Compliance Register', title: 'Staff Compliance', source: 'staff_compliance_documents', defaultVisible: true, defaultEditable: true, key_column_index: 0, date_column: 'Next expiry', status_column: 'Status' },
  { sheetKey: 'Incident register', title: 'Incidents', source: 'progress_notes_audit_events_manual_incidents', defaultVisible: true, defaultEditable: false, date_column: 'When', source_column: 'Source', manual_id_column: 'Manual ID', inline_edit: false },
  { sheetKey: 'Risk Assessment Register', title: 'Risk Assessments', source: 'participant_intake_clinical', defaultVisible: true, defaultEditable: true, key_column_index: 0 },
  { sheetKey: 'Participant Register', title: 'Participants', source: 'participants', defaultVisible: true, defaultEditable: true, key_column_index: 0, date_column: 'Plan end', status_column: 'Status' },
  { sheetKey: 'Staff Register', title: 'Staff', source: 'staff', defaultVisible: true, defaultEditable: true, key_column_index: 0, date_column: 'Last shift date', status_column: 'Status' },
  { sheetKey: 'Complaints', title: 'Complaints', source: 'case_notes', defaultVisible: false, defaultEditable: false, key_column_index: 0, date_column: 'Contact date' },
  { sheetKey: 'Document Register', title: 'Documents', source: 'onedrive_document_register', defaultVisible: false, defaultEditable: false, key_column_index: 0, date_column: 'Date recorded' },
  { sheetKey: 'Feedback and complaints', title: 'Feedback', source: 'case_notes', defaultVisible: false, defaultEditable: false, key_column_index: 0, date_column: 'Contact date' },
  { sheetKey: 'HR role register', title: 'HR Roles', source: 'staff', defaultVisible: false, defaultEditable: false, key_column_index: 0 },
  { sheetKey: 'Significant risk factor', title: 'Significant Risk', source: 'participant_intake_clinical', defaultVisible: false, defaultEditable: false, key_column_index: 0 },
  { sheetKey: 'Risk register', title: 'Risk Register', source: 'participant_documents', defaultVisible: false, defaultEditable: false, key_column_index: 0 },
  { sheetKey: 'Training and Development', title: 'Training', source: 'staff_compliance_documents', defaultVisible: false, defaultEditable: false, key_column_index: 0, date_column: 'Expiry', status_column: 'Status' },
  { sheetKey: 'Policy register', title: 'Policies', source: 'company_policy_files', defaultVisible: false, defaultEditable: false, key_column_index: 0, date_column: 'Effective date' },
  { sheetKey: 'Conflict of interest register', title: 'Conflict of Interest', source: null, defaultVisible: false, defaultEditable: false, key_column_index: 0, pending: true },
  { sheetKey: 'Collection and storage of Med', title: 'Medication Storage', source: null, defaultVisible: false, defaultEditable: false, key_column_index: 0, pending: true },
  { sheetKey: 'Continuous improvment', title: 'Continuous Improvement', source: null, defaultVisible: false, defaultEditable: false, key_column_index: 0, pending: true },
  { sheetKey: 'Emergency test register', title: 'Emergency Tests', source: null, defaultVisible: false, defaultEditable: false, key_column_index: 0, pending: true },
  { sheetKey: 'Waste removal Register', title: 'Waste Removal', source: null, defaultVisible: false, defaultEditable: false, key_column_index: 0, pending: true }
];

export const REGISTER_CATALOG_BY_VIEW_ID = Object.fromEntries(
  REGISTER_CATALOG.map((def) => [sheetKeyToViewId(def.sheetKey), def])
);

/** @deprecated Use isRegisterEditableForOrg — kept for OneDrive override map. */
export const EDITABLE_REGISTER_VIEWS = Object.fromEntries(
  REGISTER_CATALOG.filter((d) => d.defaultEditable && d.inline_edit !== false).map((d) => {
    const viewId = sheetKeyToViewId(d.sheetKey);
    return [viewId, { sheet_key: d.sheetKey, key_column_index: d.key_column_index ?? 0 }];
  })
);

const SHEET_KEY_TO_VIEW_ID = Object.fromEntries(REGISTER_CATALOG.map((d) => [d.sheetKey, sheetKeyToViewId(d.sheetKey)]));

function tableExistsLocal(name) {
  return tableExists(name);
}

/** Org preferences for which registers show in the live UI and allow inline edits. */
export function getOrgRegisterSettings(organizationId) {
  const defaults = Object.fromEntries(
    REGISTER_CATALOG.map((def) => {
      const viewId = sheetKeyToViewId(def.sheetKey);
      return [viewId, { visible: !!def.defaultVisible, editable: !!def.defaultEditable }];
    })
  );
  if (!tableExistsLocal('org_register_settings')) return defaults;
  const rows = db
    .prepare('SELECT view_id, visible, editable FROM org_register_settings WHERE org_id = ?')
    .all(organizationId);
  const merged = { ...defaults };
  for (const row of rows) {
    if (!REGISTER_CATALOG_BY_VIEW_ID[row.view_id]) continue;
    merged[row.view_id] = { visible: !!row.visible, editable: !!row.editable };
  }
  return merged;
}

export function isRegisterEditableForOrg(organizationId, viewId) {
  const def = REGISTER_CATALOG_BY_VIEW_ID[viewId];
  if (!def || def.inline_edit === false) return false;
  const settings = getOrgRegisterSettings(organizationId);
  return !!settings[viewId]?.editable;
}

export function saveOrgRegisterSettings(organizationId, items = []) {
  if (!tableExistsLocal('org_register_settings')) {
    throw new Error('Register settings are not available yet.');
  }
  const upsert = db.prepare(
    `INSERT INTO org_register_settings (org_id, view_id, visible, editable, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, view_id)
     DO UPDATE SET visible = excluded.visible, editable = excluded.editable, updated_at = datetime('now')`
  );
  const tx = db.transaction((rows) => {
    for (const item of rows) {
      const viewId = String(item.view_id || '').trim();
      if (!REGISTER_CATALOG_BY_VIEW_ID[viewId]) continue;
      upsert.run(organizationId, viewId, item.visible ? 1 : 0, item.editable ? 1 : 0);
    }
  });
  tx(items);
  return getOrgRegisterSettings(organizationId);
}

export function rowKeyForRegister(row, keyColIndex = 0) {
  return String(row?.[keyColIndex] ?? '').trim();
}

/**
 * Layer manual cell overrides on top of derived register rows. Returns new row arrays where an
 * override exists; untouched rows are returned by reference.
 */
export function applyCellOverrides(organizationId, viewId, rows, keyColIndex = 0) {
  if (!viewId || !tableExists('register_cell_overrides')) return rows;
  const overrides = db
    .prepare('SELECT row_key, col_index, value FROM register_cell_overrides WHERE org_id = ? AND view_id = ?')
    .all(organizationId, viewId);
  if (!overrides.length) return rows;
  const map = new Map();
  for (const o of overrides) map.set(`${o.row_key}::${o.col_index}`, o.value);
  return rows.map((row) => {
    const key = rowKeyForRegister(row, keyColIndex);
    if (!key) return row;
    let next = null;
    for (let c = 0; c < row.length; c += 1) {
      const override = map.get(`${key}::${c}`);
      if (override !== undefined) {
        if (!next) next = [...row];
        next[c] = override;
      }
    }
    return next || row;
  });
}

/** Apply overrides using the sheet name (for the OneDrive Excel export path). */
function applyOverridesForSheet(organizationId, sheetKey, rows) {
  const viewId = SHEET_KEY_TO_VIEW_ID[sheetKey];
  if (!viewId) return rows;
  const def = REGISTER_CATALOG_BY_VIEW_ID[viewId];
  const keyCol = def?.key_column_index ?? 0;
  return applyCellOverrides(organizationId, viewId, rows, keyCol);
}

function safeJson(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeDocType(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function docLabel(doc) {
  return doc?.display_name || doc?.document_type || doc?.filename || '';
}

function docDate(doc) {
  return fmtDate(doc?.expiry_date || doc?.uploaded_at || doc?.created_at);
}

function findLatestDoc(docs, match) {
  return [...docs]
    .filter((doc) => match(normalizeDocType(doc.document_type), doc))
    .sort((a, b) => {
      const da = new Date(a.expiry_date || a.uploaded_at || a.created_at || 0).getTime();
      const dbb = new Date(b.expiry_date || b.uploaded_at || b.created_at || 0).getTime();
      return dbb - da;
    })[0];
}

function complianceStatus(expiryDates, requiredMissing = []) {
  const validDates = expiryDates.map((d) => fmtDate(d)).filter(Boolean);
  if (requiredMissing.length || validDates.length === 0) return 'Missing';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const soon = new Date(today);
  soon.setDate(soon.getDate() + 60);
  const parsed = validDates.map((d) => new Date(d));
  if (parsed.some((d) => !Number.isNaN(d.getTime()) && d < today)) return 'Expired';
  if (parsed.some((d) => !Number.isNaN(d.getTime()) && d <= soon)) return 'Expiring Soon';
  return 'Current';
}

function earliestExpiry(expiryDates) {
  const sorted = expiryDates
    .map((d) => fmtDate(d))
    .filter(Boolean)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return sorted[0] || '';
}

function staffComplianceRows(organizationId) {
  const staffRows = db
    .prepare(
      `SELECT id, name, role, created_at, onboarding_status, archived_at
       FROM staff
       WHERE org_id = ?
       ORDER BY lower(name)`
    )
    .all(organizationId);
  const docs = db
    .prepare(
      `SELECT scd.*
       FROM staff_compliance_documents scd
       JOIN staff s ON s.id = scd.staff_id
       WHERE s.org_id = ?`
    )
    .all(organizationId);
  const byStaff = new Map();
  for (const doc of docs) {
    if (!byStaff.has(doc.staff_id)) byStaff.set(doc.staff_id, []);
    byStaff.get(doc.staff_id).push(doc);
  }

  return staffRows.map((s) => {
    const staffDocs = byStaff.get(s.id) || [];
    const wwcc = findLatestDoc(staffDocs, (t) => t.includes('wwcc') || t.includes('blue_card') || t.includes('yellow_card') || t.includes('working_with_children'));
    const firstAid = findLatestDoc(staffDocs, (t) => t.includes('first_aid') || t.includes('firstaid'));
    const police = findLatestDoc(staffDocs, (t) => t.includes('police'));
    const induction = findLatestDoc(staffDocs, (t) => t.includes('induction'));
    const knownIds = new Set([wwcc?.id, firstAid?.id, police?.id, induction?.id].filter(Boolean));
    const otherCerts = staffDocs
      .filter((doc) => !knownIds.has(doc.id))
      .map((doc) => `${docLabel(doc)}${doc.expiry_date ? ` exp ${fmtDate(doc.expiry_date)}` : ''}`)
      .filter(Boolean)
      .join('; ');
    const missing = [];
    if (!wwcc) missing.push('WWCC');
    if (!firstAid) missing.push('First Aid');
    if (!police) missing.push('Police Check');
    if (!induction) missing.push('Induction');
    const expiries = [wwcc?.expiry_date, firstAid?.expiry_date, ...staffDocs.map((doc) => doc.expiry_date)].filter(Boolean);
    const status = complianceStatus(expiries, missing);
    return [
      s.name || '',
      s.role || '',
      docLabel(wwcc),
      fmtDate(wwcc?.expiry_date),
      fmtDate(firstAid?.expiry_date),
      docDate(police),
      docDate(induction),
      otherCerts,
      status,
      earliestExpiry(expiries),
      missing.join(', ')
    ];
  });
}

function auditIncidentRows(organizationId) {
  const rows = db
    .prepare(
      `SELECT ae.id, ae.participant_id, ae.actor_id, ae.event_type, ae.entity_type, ae.entity_id, ae.new_value_json,
              ae.metadata_json, ae.created_at, p.name AS participant_name, u.name AS actor_name
       FROM audit_events ae
       LEFT JOIN participants p ON p.id = ae.participant_id
       LEFT JOIN users u ON u.id = ae.actor_id
       WHERE lower(ae.event_type) LIKE 'incident%'
         AND (
           p.provider_org_id = ?
           OR u.org_id = ?
         )
       ORDER BY datetime(ae.created_at) DESC`
    )
    .all(organizationId, organizationId);

  return rows.map((r) => {
    const meta = { ...safeJson(r.metadata_json), ...safeJson(r.new_value_json) };
    const shiftId = meta.shift_id || meta.shiftId || (String(r.entity_type || '').includes('shift') ? r.entity_id : '');
    return {
      key: `audit:${r.id}`,
      shift_id: shiftId || '',
      row: [
        fmtDate(meta.incident_date || meta.date || r.created_at),
        r.participant_name || meta.participant_name || '',
        meta.staff_name || '',
        meta.location || '',
        meta.description || meta.summary || r.event_type,
        meta.immediate_actions || '',
        meta.follow_up || '',
        meta.reported_by || r.actor_name || '',
        meta.reported_to || '',
        meta.outcome || '',
        'Audit',
        fmtDate(r.created_at),
        '',
        shiftId || ''
      ]
    };
  });
}

function manualIncidentRows(organizationId) {
  if (!tableExists('incident_register_entries')) return [];
  return db
    .prepare(
      `SELECT ire.*, p.name AS participant_name, s.name AS staff_name, u.name AS created_by_name
       FROM incident_register_entries ire
       LEFT JOIN participants p ON p.id = ire.participant_id
       LEFT JOIN staff s ON s.id = ire.staff_id
       LEFT JOIN users u ON u.id = ire.created_by
       WHERE ire.org_id = ?
         AND ire.deleted_at IS NULL
       ORDER BY datetime(COALESCE(ire.incident_date, ire.created_at)) DESC`
    )
    .all(organizationId)
    .map((r) => ({
      key: `manual:${r.id}`,
      shift_id: '',
      row: [
        fmtDate(r.incident_date),
        r.participant_name || '',
        r.staff_name || '',
        r.location || '',
        r.description || '',
        r.immediate_actions || '',
        r.follow_up || '',
        r.reported_by || r.created_by_name || '',
        r.reported_to || '',
        r.outcome || '',
        'Manual',
        fmtDate(r.created_at),
        r.id,
        ''
      ]
    }));
}

function incidentRows(organizationId) {
  const progressRows = dedupeIncidentProgressNotes(
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
  ).map((r) => {
    const when = `${fmtDate(r.support_date)}${r.start_time ? ` ${r.start_time}` : ''}`.trim();
    const narrative = incidentRegisterNarrative(r.incidents, r.session_details);
    return {
      key: `progress:${r.id}`,
      shift_id: r.shift_id || '',
      row: [
        when,
        r.participant_name || '',
        r.staff_name || '',
        '',
        narrative,
        r.session_details || '',
        '',
        r.staff_name || 'Nexus Core',
        '',
        '',
        'Shifter',
        fmtDate(r.created_at),
        '',
        r.shift_id || ''
      ]
    };
  });

  const combined = [...progressRows, ...auditIncidentRows(organizationId), ...manualIncidentRows(organizationId)];
  const seenShifts = new Set();
  const out = [];
  for (const item of combined) {
    const sid = String(item.shift_id || '').trim();
    if (sid) {
      if (seenShifts.has(sid)) continue;
      seenShifts.add(sid);
    }
    out.push(item.row);
  }
  return out.sort((a, b) => new Date(b[0] || b[11] || 0).getTime() - new Date(a[0] || a[11] || 0).getTime());
}

function riskAssessmentRows(organizationId) {
  if (RISK_ASSESSMENT_FIELD_KEYS.length === 0) return [];
  const participants = db
    .prepare(
      `SELECT p.id, p.name, po.id AS onboarding_id
       FROM participants p
       LEFT JOIN participant_onboarding po ON po.participant_id = p.id
       WHERE p.provider_org_id = ?
         AND (p.archived_at IS NULL OR p.archived_at = '')
       ORDER BY lower(p.name)`
    )
    .all(organizationId);
  const ids = participants.map((p) => p.onboarding_id).filter(Boolean);
  const fieldsByOnboarding = new Map();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT participant_onboarding_id, field_key, field_value
         FROM participant_intake_fields
         WHERE participant_onboarding_id IN (${placeholders})
           AND field_key IN (${RISK_ASSESSMENT_FIELD_KEYS.map(() => '?').join(', ')})`
      )
      .all(...ids, ...RISK_ASSESSMENT_FIELD_KEYS);
    for (const row of rows) {
      if (!fieldsByOnboarding.has(row.participant_onboarding_id)) fieldsByOnboarding.set(row.participant_onboarding_id, {});
      fieldsByOnboarding.get(row.participant_onboarding_id)[row.field_key] = row.field_value;
    }
  }
  return participants.map((p) => {
    const fields = fieldsByOnboarding.get(p.onboarding_id) || {};
    return [
      p.name || '',
      ...RISK_ASSESSMENT_FIELD_KEYS.map((key) => {
        const value = String(fields[key] ?? '').trim();
        return value || 'Not recorded';
      })
    ];
  });
}

function participantRegisterRows(organizationId) {
  return db
    .prepare(
      `WITH latest_plan AS (
         SELECT np.*,
                row_number() OVER (PARTITION BY np.participant_id ORDER BY date(np.end_date) DESC, date(np.start_date) DESC) AS rn
         FROM ndis_plans np
       ),
       last_shift AS (
         SELECT participant_id, MAX(date(start_time)) AS last_shift_date
         FROM shifts
         GROUP BY participant_id
       ),
       coordinator AS (
         SELECT up.participant_id, GROUP_CONCAT(u.name, ', ') AS coordinator_names
         FROM user_participants up
         JOIN users u ON u.id = up.user_id
         GROUP BY up.participant_id
       ),
       primary_contact AS (
         SELECT pc.participant_id,
                c.name || COALESCE(' ' || NULLIF(c.phone, ''), '') || COALESCE(' ' || NULLIF(c.email, ''), '') AS contact_text,
                row_number() OVER (PARTITION BY pc.participant_id ORDER BY pc.is_starred DESC, pc.created_at ASC) AS rn
         FROM participant_contacts pc
         JOIN contacts c ON c.id = pc.contact_id
       )
       SELECT p.name, p.ndis_number, lp.start_date, lp.end_date, pc.contact_text, c.coordinator_names,
              po.status AS onboarding_status, ls.last_shift_date, p.archived_at
       FROM participants p
       LEFT JOIN latest_plan lp ON lp.participant_id = p.id AND lp.rn = 1
       LEFT JOIN participant_onboarding po ON po.participant_id = p.id
       LEFT JOIN last_shift ls ON ls.participant_id = p.id
       LEFT JOIN coordinator c ON c.participant_id = p.id
       LEFT JOIN primary_contact pc ON pc.participant_id = p.id AND pc.rn = 1
       WHERE p.provider_org_id = ?
       ORDER BY lower(p.name)`
    )
    .all(organizationId)
    .map((r) => [
      r.name || '',
      r.ndis_number || '',
      fmtDate(r.start_date),
      fmtDate(r.end_date),
      r.contact_text || '',
      r.coordinator_names || '',
      r.onboarding_status || '',
      fmtDate(r.last_shift_date),
      r.archived_at ? 'Inactive' : 'Active'
    ]);
}

function staffRegisterRows(organizationId, complianceRows = null) {
  const complianceByName = new Map((complianceRows || staffComplianceRows(organizationId)).map((r) => [r[0], r[8]]));
  return db
    .prepare(
      `WITH last_shift AS (
         SELECT staff_id, MAX(date(start_time)) AS last_shift_date
         FROM shifts
         GROUP BY staff_id
       )
       SELECT s.name, s.role, s.created_at, s.onboarding_status, ls.last_shift_date, s.archived_at
       FROM staff s
       LEFT JOIN last_shift ls ON ls.staff_id = s.id
       WHERE s.org_id = ?
       ORDER BY lower(s.name)`
    )
    .all(organizationId)
    .map((r) => [
      r.name || '',
      r.role || '',
      fmtDate(r.created_at),
      r.onboarding_status || '',
      complianceByName.get(r.name) || 'Missing',
      fmtDate(r.last_shift_date),
      r.archived_at ? 'Inactive' : 'Active'
    ]);
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
export const REGISTER_UI_HEADERS = {
  'Staff Compliance Register': [
    'Staff',
    'Role',
    'WWCC number',
    'WWCC expiry',
    'First Aid expiry',
    'Police Check date',
    'Induction date',
    'Other certificates',
    'Status',
    'Next expiry',
    'Missing items'
  ],
  'Risk Assessment Register': [
    'Participant',
    ...PARTICIPANT_INTAKE_FIELD_DEFS.filter((d) => d.section === 'clinical').map((d) => d.label)
  ],
  'Participant Register': [
    'Name',
    'NDIS number',
    'Plan start',
    'Plan end',
    'Primary contact',
    'Coordinator assigned',
    'Onboarding status',
    'Last shift date',
    'Status'
  ],
  'Staff Register': ['Name', 'Role', 'Start date', 'Onboarding status', 'Compliance status', 'Last shift date', 'Status'],
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
  'Risk register': [
    'Hazard / activity',
    'Hazard 2',
    'Hazard 3',
    'Hazard 4',
    'Hazard 5',
    'Hazard 6',
    'Hazard 7',
    'Harm',
    'Harm (detail)',
    'Likelihood',
    'Likelihood 2',
    'Likelihood 3',
    'Risk level',
    'Risk level 2',
    'Risk level 3',
    'Risk level 4',
    'Risk level 5',
    'Controls',
    'Controls (detail)',
    'Source'
  ],
  'Incident register': [
    'When',
    'Participant',
    'Staff',
    'Location',
    'Description',
    'Immediate actions',
    'Follow-up',
    'Reported by',
    'Reported to',
    'Outcome',
    'Source',
    'Logged date',
    'Manual ID',
    'Shift ID'
  ]
};

/** Marker row in Registers.xlsx "Risk register" sheet for Nexus-appended participant activity rows. */
export const RISK_REGISTER_ACTIVITY_SECTION = 'Activity risk assessments (Nexus Core)';

function parseActivityRiskDocMeta(metadataJson) {
  if (!metadataJson) return {};
  try {
    return JSON.parse(metadataJson);
  } catch {
    return {};
  }
}

/**
 * Rows appended to the org Risk register (participant activity health & safety assessments).
 */
export function buildActivityRiskRegisterRows(organizationId) {
  const docs = db
    .prepare(
      `SELECT pd.id, pd.filename, pd.created_at, pd.metadata_json, p.name AS participant_name
       FROM participant_documents pd
       JOIN participants p ON p.id = pd.participant_id
       WHERE p.provider_org_id = ?
         AND pd.category = 'Risk assessment'
       ORDER BY datetime(pd.created_at) DESC`
    )
    .all(organizationId);

  return docs.map((doc) => {
    const meta = parseActivityRiskDocMeta(doc.metadata_json);
    const activity = String(meta.activity_name || 'Activity').trim() || 'Activity';
    const participant = doc.participant_name || '';
    const hazard = `${activity} — ${participant}`.trim();
    const harm = `Health & safety activity risk assessment on file (${doc.filename || 'PDF'}). Complete the assessment in the participant Risk assessments folder.`;
    const assigned = fmtDate(doc.created_at);
    const controls = `Assessment assigned ${assigned}. Managed in Nexus Core / OneDrive. Document ID: ${doc.id}`;
    return [
      hazard,
      hazard,
      hazard,
      hazard,
      hazard,
      hazard,
      hazard,
      harm,
      harm,
      'See assessment',
      'See assessment',
      'See assessment',
      'See assessment',
      'See assessment',
      'See assessment',
      'See assessment',
      'See assessment',
      controls,
      controls,
      'Nexus Core (activity risk assessment)'
    ];
  });
}

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

  const staffCompliance = applyOverridesForSheet(organizationId, 'Staff Compliance Register', staffComplianceRows(organizationId));
  const incidentRegisterRows = incidentRows(organizationId);
  const riskRegisterRows = applyOverridesForSheet(organizationId, 'Risk Assessment Register', riskAssessmentRows(organizationId));
  const participantRows = applyOverridesForSheet(organizationId, 'Participant Register', participantRegisterRows(organizationId));
  const staffRows = applyOverridesForSheet(organizationId, 'Staff Register', staffRegisterRows(organizationId, staffCompliance));

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

  const trainingRows = staffCompliance.map((r) => [
    `${r[0]} compliance summary`,
    `Compliance evidence for ${r[0]}`,
    'Internal',
    '',
    'Nexus Core',
    r[9] || '',
    '',
    '',
    r[8] || '',
    r[9] || '',
    r[10] || '',
    r[7] || '',
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

  const activityRiskRegisterRows = buildActivityRiskRegisterRows(organizationId);

  return {
    'Staff Compliance Register': staffCompliance,
    'Risk Assessment Register': riskRegisterRows,
    'Participant Register': participantRows,
    'Staff Register': staffRows,
    Complaints: complaintsRows,
    'Document Register': docRows,
    'Feedback and complaints': feedbackRows,
    'HR role register': hrRoleRows,
    'Significant risk factor': sigRiskRows,
    'Risk register': activityRiskRegisterRows,
    'Training and Development': trainingRows,
    'Policy register': policyRows,
    'Incident register': incidentRegisterRows
  };
}

const REGISTER_DISPLAY_ORDER = REGISTER_CATALOG;

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

function withinNextDays(dateValue, days) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + days);
  return d >= today && d <= end;
}

function isSameMonth(dateValue, ref = new Date()) {
  const d = new Date(dateValue);
  return !Number.isNaN(d.getTime()) && d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}

function buildRegisterSummary(views) {
  const byId = new Map(views.map((v) => [v.id, v]));
  const staffCompliance = byId.get('staff_compliance_register')?.rows || [];
  const incidents = byId.get('incident_register')?.rows || [];
  const risk = byId.get('risk_assessment_register')?.rows || [];
  const participants = byId.get('participant_register')?.rows || [];
  return {
    staff_expiring_certs_60_days: staffCompliance.filter((r) => r[8] === 'Expiring Soon').length,
    incidents_this_month: incidents.filter((r) => isSameMonth(r[0] || r[11])).length,
    participants_missing_risk_assessment: risk.filter((r) => r.slice(1).every((v) => v === 'Not recorded')).length,
    participants_plan_expiring_60_days: participants.filter((r) => withinNextDays(r[3], 60)).length
  };
}

function viewMetadataFromCatalog(def, viewId, orgSettings) {
  const meta = {
    date_column: def.date_column || null,
    status_column: def.status_column || null,
    source_column: def.source_column || null,
    manual_id_column: def.manual_id_column || null,
    key_column_index: def.key_column_index ?? 0
  };
  if (def.inline_edit !== false && orgSettings[viewId]?.editable) {
    meta.editable = true;
  }
  return meta;
}

/**
 * JSON payload for GET /api/registers/snapshot — same underlying rows as OneDrive template sync.
 */
export function buildRegisterSnapshotForOrg(organizationId) {
  const sheetData = buildTemplateDataBySheet(organizationId);
  const orgSettings = getOrgRegisterSettings(organizationId);
  const generatedAt = new Date().toISOString();
  const views = [];
  const catalog = [];

  for (const def of REGISTER_CATALOG) {
    const pendingNote = def.pending ? PENDING_REGISTER_DATA_SOURCES[def.sheetKey] : null;
    const rawRows = sheetData[def.sheetKey] || [];
    let rows = normalizeRows(rawRows);
    const id = sheetKeyToViewId(def.sheetKey);
    const keyCol = def.key_column_index ?? 0;
    if (isRegisterEditableForOrg(organizationId, id)) {
      rows = applyCellOverrides(organizationId, id, rows, keyCol);
    }
    const columns = headersForSheet(def.sheetKey, rows);
    const setting = orgSettings[id] || { visible: false, editable: false };
    const view = {
      id,
      sheet_key: def.sheetKey,
      title: def.title,
      data_source: def.source,
      populated_from_nexus: !pendingNote && !!def.source,
      roadmap_note: pendingNote || null,
      row_count: rows.length,
      columns,
      rows,
      ...viewMetadataFromCatalog(def, id, orgSettings)
    };
    catalog.push({
      id,
      title: def.title,
      sheet_key: def.sheetKey,
      populated_from_nexus: view.populated_from_nexus,
      roadmap_note: view.roadmap_note,
      row_count: rows.length,
      visible: !!setting.visible,
      editable: !!setting.editable,
      supports_inline_edit: def.inline_edit !== false
    });
    if (setting.visible) views.push(view);
  }

  return {
    generated_at: generatedAt,
    organisation_id: organizationId,
    summary: buildRegisterSummary(views),
    views,
    register_catalog: catalog,
    hint:
      'Rows mirror what is pushed to OneDrive Register/*.xlsx when connected. Extend registerSnapshots.service.js when new Nexus features supply register data.'
  };
}
