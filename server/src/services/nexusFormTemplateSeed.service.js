/**
 * Seeds system-level form template masters once (SQLite); refreshes definition when revision changes.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  buildBrandingSlotsPayload,
  buildMasterInsertPayload,
  buildDefinitionPayload,
  buildPageLayoutPayload
} from '../data/serviceAgreementSpring2V3/buildMasterPayload.js';
import { SERVICE_AGREEMENT_TEMPLATE_KEY } from '../data/serviceAgreementSpring2V3/variableSchema.js';

function parseDefinitionRevision(definitionJson) {
  try {
    const def = typeof definitionJson === 'string' ? JSON.parse(definitionJson) : definitionJson;
    return def?.meta?.definitionRevision ?? 0;
  } catch {
    return 0;
  }
}

const GENERIC_MASTER_DEFINITIONS = [
  {
    template_key: 'privacy_consent_standard',
    template_type: 'privacy_consent',
    category: 'privacy_consent',
    title: 'Privacy Consent',
    description: 'Participant consent for collection, use, disclosure, privacy rights, and consent acknowledgement.',
    variable_slots: [
      { key: 'privacy_contact_email', label: 'Privacy contact email', default_value: '{{org_email}}' },
      { key: 'privacy_review_days', label: 'Consent review period (days)', default_value: '365' }
    ],
    sections: [
      { id: 'collection', title: 'Collection', locked: true, body_html: '<p>We collect personal and sensitive information needed to deliver NDIS supports, manage safety, meet legal obligations, and maintain accurate records.</p>' },
      { id: 'use', title: 'Use', locked: true, body_html: '<p>Your information is used to plan, deliver, review, and improve supports, communicate with you and your representatives, and administer services.</p>' },
      { id: 'disclosure', title: 'Disclosure', locked: false, body_html: '<p>Information may be shared with authorised representatives, plan managers, health professionals, the NDIA, and regulators where permitted or required.</p>' },
      { id: 'rights', title: 'Rights', locked: true, body_html: '<p>You may request access to your information, ask for corrections, withdraw consent where lawful, or contact us about privacy concerns at {{privacy_contact_email}}.</p>' },
      { id: 'consent', title: 'Consent', locked: true, body_html: '<p>By signing, you consent to the collection, use, and disclosure of information as described in this form.</p>' }
    ]
  },
  {
    template_key: 'participant_intake_standard',
    template_type: 'intake',
    category: 'intake',
    title: 'Participant Intake',
    description: 'Structured intake form for participant details, contacts, support needs, health information, and goals.',
    variable_slots: [
      { key: 'intake_review_period_days', label: 'Intake review period (days)', default_value: '365' },
      { key: 'intake_contact_email', label: 'Intake contact email', default_value: '{{org_email}}' }
    ],
    sections: [
      { id: 'personal_details', title: 'Personal Details', locked: true, body_html: '<p>Record participant name, preferred name, date of birth, NDIS number, contact details, and address.</p>' },
      { id: 'emergency_contacts', title: 'Emergency Contacts', locked: false, body_html: '<p>Record emergency contacts, relationship, phone, email, and preferred contact order.</p>' },
      { id: 'support_needs', title: 'Support Needs', locked: false, body_html: '<p>Describe daily support needs, communication preferences, routines, cultural considerations, and accessibility requirements.</p>' },
      { id: 'medical', title: 'Medical', locked: true, body_html: '<p>Capture allergies, medication considerations, diagnoses, mobility needs, seizure or choking risks, and other health alerts relevant to safe support.</p>' },
      { id: 'goals', title: 'Goals', locked: false, body_html: '<p>Capture participant goals, preferred outcomes, strengths, interests, and what good support looks like.</p>' }
    ]
  },
  {
    template_key: 'incident_report_standard',
    template_type: 'incident_report',
    category: 'incident_report',
    title: 'Incident Report',
    description: 'Incident report for recording event details, persons involved, immediate actions, and follow-up.',
    variable_slots: [
      { key: 'incident_notify_hours', label: 'Internal notification timeframe (hours)', default_value: '24' },
      { key: 'incident_manager_role', label: 'Incident manager role', default_value: 'Operations Manager' }
    ],
    sections: [
      { id: 'incident_details', title: 'Incident Details', locked: true, body_html: '<p>Record date, time, location, incident type, reportable incident status, and the staff member completing this report.</p>' },
      { id: 'persons_involved', title: 'Persons Involved', locked: true, body_html: '<p>Record participants, staff, witnesses, representatives, and external parties involved or notified.</p>' },
      { id: 'description', title: 'Description', locked: false, body_html: '<p>Describe what happened in factual, chronological language. Include observable details and avoid assumptions.</p>' },
      { id: 'immediate_actions', title: 'Immediate Actions', locked: true, body_html: '<p>Record first aid, emergency services, safeguarding steps, notifications, and actions taken to reduce immediate risk.</p>' },
      { id: 'follow_up', title: 'Follow-up', locked: false, body_html: '<p>Record follow-up actions, responsible person, due dates, debriefing, investigation outcomes, and preventative controls.</p>' }
    ]
  },
  {
    template_key: 'staff_contract_standard',
    template_type: 'staff_contract',
    category: 'staff_contract',
    title: 'Staff Contract',
    description: 'Staff contract covering parties, role, hours, remuneration, leave, and termination.',
    variable_slots: [
      { key: 'standard_hours_per_week', label: 'Standard hours per week', default_value: '38' },
      { key: 'termination_notice_weeks', label: 'Termination notice (weeks)', default_value: '4' },
      { key: 'pay_rate_label', label: 'Pay rate label', default_value: 'As specified in the employee profile' }
    ],
    sections: [
      { id: 'parties', title: 'Parties', locked: true, body_html: '<p>This agreement is between {{org_legal_name}} ABN {{org_abn}} and the staff member named in the employee record.</p>' },
      { id: 'role', title: 'Role', locked: false, body_html: '<p>The staff member is employed or engaged in the role recorded in Nexus Core and must perform duties consistent with that role.</p>' },
      { id: 'hours', title: 'Hours', locked: false, body_html: '<p>Ordinary hours, roster patterns, and availability expectations are agreed in writing and maintained in Nexus Core.</p>' },
      { id: 'remuneration', title: 'Remuneration', locked: true, body_html: '<p>Remuneration is {{pay_rate_label}} and paid in accordance with applicable legislation, industrial instruments, and organisation policy.</p>' },
      { id: 'leave', title: 'Leave', locked: true, body_html: '<p>Leave entitlements and requests are managed in accordance with applicable employment law and organisation policy.</p>' },
      { id: 'termination', title: 'Termination', locked: true, body_html: '<p>Either party may terminate by giving {{termination_notice_weeks}} weeks written notice unless a different lawful notice period applies.</p>' }
    ]
  },
  {
    template_key: 'activity_risk_assessment_standard',
    template_type: 'risk_assessment',
    category: 'risk_assessment',
    title: 'Activity Risk Assessment',
    description: 'Risk assessment for participant activities, hazards, controls, and emergency response planning.',
    variable_slots: [
      { key: 'risk_review_days', label: 'Risk review period (days)', default_value: '90' },
      { key: 'emergency_contact_instruction', label: 'Emergency instruction', default_value: 'Call 000 in an emergency and notify the office as soon as practicable.' }
    ],
    sections: [
      { id: 'activity', title: 'Activity', locked: false, body_html: '<p>Describe the activity, location, participants, staffing ratio, transport arrangements, and planned date or recurrence.</p>' },
      { id: 'hazards', title: 'Hazards', locked: true, body_html: '<p>Identify foreseeable hazards including environment, behaviour support, health, manual handling, transport, community access, and weather risks.</p>' },
      { id: 'controls', title: 'Controls', locked: false, body_html: '<p>List controls that reduce likelihood and consequence, including staff training, equipment, participant preferences, communication plans, and supervision.</p>' },
      { id: 'emergency', title: 'Emergency', locked: true, body_html: '<p>{{emergency_contact_instruction}} Record emergency contacts, nearest medical help, escalation steps, and post-incident reporting requirements.</p>' }
    ]
  }
];

function genericDefinition(master) {
  return {
    meta: {
      documentTitle: master.title,
      description: master.description,
      versionLabel: 'Version 1',
      definitionRevision: 1
    }
  };
}

function genericVariableSchema(master) {
  return {
    template_key: master.template_key,
    defaults: Object.fromEntries((master.variable_slots || []).map((slot) => [slot.key, slot.default_value || ''])),
    groups: [
      {
        id: 'template_variables',
        label: 'Template variables',
        keys: (master.variable_slots || []).map((slot) => slot.key),
        descriptions: Object.fromEntries((master.variable_slots || []).map((slot) => [slot.key, slot.label || slot.key]))
      }
    ]
  };
}

function seedGenericMasters(database) {
  const insert = database.prepare(
    `INSERT INTO nexus_form_template_masters (
       id, template_key, template_type, title, version_label, definition_json, variable_schema_json,
       branding_slots_json, variable_slots_json, sections_json, page_layout_json, category
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let seeded = 0;
  for (const master of GENERIC_MASTER_DEFINITIONS) {
    const existing = database
      .prepare('SELECT id FROM nexus_form_template_masters WHERE template_key = ?')
      .get(master.template_key);
    if (existing) continue;
    insert.run(
      uuidv4(),
      master.template_key,
      master.template_type,
      master.title,
      'Version 1',
      JSON.stringify(genericDefinition(master)),
      JSON.stringify(genericVariableSchema(master)),
      JSON.stringify(buildBrandingSlotsPayload()),
      JSON.stringify(master.variable_slots || []),
      JSON.stringify(master.sections || []),
      JSON.stringify(buildPageLayoutPayload()),
      master.category
    );
    seeded += 1;
  }
  return seeded;
}

/**
 * @param {import('better-sqlite3').Database} database
 */
export function seedNexusFormTemplateMastersIfNeeded(database) {
  const payload = buildMasterInsertPayload();
  const existing = database
    .prepare('SELECT id, definition_json FROM nexus_form_template_masters WHERE template_key = ?')
    .get(SERVICE_AGREEMENT_TEMPLATE_KEY);

  const targetRevision = buildDefinitionPayload().meta?.definitionRevision ?? 0;

  if (existing) {
    const currentRevision = parseDefinitionRevision(existing.definition_json);
    if (currentRevision < targetRevision) {
      database
        .prepare(
          `UPDATE nexus_form_template_masters
           SET title = ?,
               version_label = ?,
               definition_json = ?,
               variable_schema_json = ?,
               branding_slots_json = ?,
               variable_slots_json = ?,
               sections_json = ?,
               page_layout_json = ?,
               category = ?
           WHERE id = ?`
        )
        .run(
          payload.title,
          payload.version_label,
          payload.definition_json,
          payload.variable_schema_json,
          payload.branding_slots_json,
          payload.variable_slots_json,
          payload.sections_json,
          payload.page_layout_json,
          payload.category,
          existing.id
        );
      const genericSeeded = seedGenericMasters(database);
      return { seeded: false, refreshed: true, master_id: existing.id, generic_seeded: genericSeeded };
    }
    database
      .prepare(
        `UPDATE nexus_form_template_masters
         SET branding_slots_json = COALESCE(branding_slots_json, ?),
             variable_slots_json = COALESCE(variable_slots_json, ?),
             sections_json = COALESCE(sections_json, ?),
             page_layout_json = COALESCE(page_layout_json, ?),
             category = CASE WHEN category IS NULL OR category = 'custom' THEN ? ELSE category END
         WHERE id = ?`
      )
      .run(
        payload.branding_slots_json,
        payload.variable_slots_json,
        payload.sections_json,
        payload.page_layout_json,
        payload.category,
        existing.id
      );
    const genericSeeded = seedGenericMasters(database);
    return { seeded: false, refreshed: false, master_id: existing.id, generic_seeded: genericSeeded };
  }

  const id = uuidv4();
  database
    .prepare(
      `INSERT INTO nexus_form_template_masters (
         id, template_key, template_type, title, version_label, definition_json, variable_schema_json,
         branding_slots_json, variable_slots_json, sections_json, page_layout_json, category
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      payload.template_key,
      payload.template_type,
      payload.title,
      payload.version_label,
      payload.definition_json,
      payload.variable_schema_json,
      payload.branding_slots_json,
      payload.variable_slots_json,
      payload.sections_json,
      payload.page_layout_json,
      payload.category
    );
  const genericSeeded = seedGenericMasters(database);
  return { seeded: true, refreshed: false, master_id: id, generic_seeded: genericSeeded };
}
