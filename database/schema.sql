-- NDIS Shift Scheduling App - Database Schema
-- SQLite

-- Users (admin login; roster email via OAuth Gmail/Microsoft + Azure relay)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'support_coordinator' CHECK (role IN ('admin', 'support_coordinator', 'delegate')),
  org_id TEXT,
  auth_uid TEXT,
  smtp_email TEXT,
  smtp_password_encrypted TEXT,
  azure_function_url TEXT,
  azure_api_key_encrypted TEXT,
  email_provider TEXT,
  email_connected_address TEXT,
  email_oauth_access_encrypted TEXT,
  email_oauth_refresh_encrypted TEXT,
  email_token_expires_at INTEGER,
  email_reconnect_required INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Organisations (plan managers, providers, allied health)
CREATE TABLE IF NOT EXISTS organisations (
  id TEXT PRIMARY KEY,
  owner_org_id TEXT,
  name TEXT NOT NULL,
  type TEXT,
  abn TEXT,
  ndis_reg_number TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  website TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Contacts (reusable, linked to organisations)
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  organisation_id TEXT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organisation_id) REFERENCES organisations(id)
);

-- Participants (clients)
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ndis_number TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  date_of_birth TEXT,
  provider_org_id TEXT,
  plan_manager_id TEXT,
  remoteness TEXT DEFAULT 'standard',
  notes TEXT,
  parent_guardian_phone TEXT,
  parent_guardian_email TEXT,
  diagnosis TEXT,
  services_required TEXT,
  management_type TEXT DEFAULT 'self',
  ndia_managed_services TEXT,
  plan_managed_services TEXT,
  invoice_emails TEXT,
  invoice_includes_gst INTEGER DEFAULT 0,
  default_ndis_line_item_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_org_id) REFERENCES organisations(id),
  FOREIGN KEY (plan_manager_id) REFERENCES organisations(id),
  FOREIGN KEY (default_ndis_line_item_id) REFERENCES ndis_line_items(id)
);

-- NDIS Plans
CREATE TABLE IF NOT EXISTS ndis_plans (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_pace INTEGER DEFAULT 0,
  fund_release_schedule TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
);

-- Plan Budgets (category = support_category 01-15, amount = budget for that category)
CREATE TABLE IF NOT EXISTS plan_budgets (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT,
  management_type TEXT DEFAULT 'self',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (plan_id) REFERENCES ndis_plans(id) ON DELETE CASCADE
);

-- Budget Line Items: which NDIS charges can be used against this budget (for hours/shifts calculation)
CREATE TABLE IF NOT EXISTS budget_line_items (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  ndis_line_item_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (budget_id) REFERENCES plan_budgets(id) ON DELETE CASCADE,
  FOREIGN KEY (ndis_line_item_id) REFERENCES ndis_line_items(id) ON DELETE CASCADE,
  UNIQUE(budget_id, ndis_line_item_id)
);

-- Implementations
CREATE TABLE IF NOT EXISTS implementations (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  description TEXT,
  provider_type TEXT,
  provider_id TEXT,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'active',
  implemented_date TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (plan_id) REFERENCES ndis_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (budget_id) REFERENCES plan_budgets(id) ON DELETE CASCADE
);

-- Participant Contacts (junction with relationship)
CREATE TABLE IF NOT EXISTS participant_contacts (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  relationship TEXT,
  consent_to_share INTEGER DEFAULT 0,
  is_starred INTEGER DEFAULT 0,
  additional_details TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

-- Participant Goals (plan_id links to ndis_plans; archived_at set when new plan added)
CREATE TABLE IF NOT EXISTS participant_goals (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  plan_id TEXT,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  target_date TEXT,
  archived_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES ndis_plans(id) ON DELETE CASCADE
);

-- Participant Documents
CREATE TABLE IF NOT EXISTS participant_documents (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  category TEXT,
  file_path TEXT NOT NULL,
  onedrive_item_id TEXT,
  onedrive_web_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
);

-- Case Notes / Check-ins
CREATE TABLE IF NOT EXISTS case_notes (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  contact_type TEXT NOT NULL,
  notes TEXT,
  contact_date TEXT NOT NULL,
  goal_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES participant_goals(id)
);

-- Staff
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  notify_email INTEGER DEFAULT 1,
  notify_sms INTEGER DEFAULT 0,
  calendar_provider TEXT,
  calendar_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_org_id ON staff(org_id);
CREATE INDEX IF NOT EXISTS idx_organisations_owner_org ON organisations(owner_org_id);

-- User-participants: assigns support coordinators to participants (admin manages)
CREATE TABLE IF NOT EXISTS user_participants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, participant_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_participants_user ON user_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_user_participants_participant ON user_participants(participant_id);

-- Delegate grants: admin grants full permissions to delegate (can be time-limited)
CREATE TABLE IF NOT EXISTS delegate_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  full_control INTEGER DEFAULT 1,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_delegate_grants_user ON delegate_grants(user_id);

-- NDIS Support Categories (01-15, maps first 2 digits of line items)
CREATE TABLE IF NOT EXISTS ndis_support_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- Seed the 15 support categories
INSERT OR IGNORE INTO ndis_support_categories (id, name) VALUES
  ('01', 'Assistance with Daily Life'),
  ('02', 'Transport'),
  ('03', 'Consumables'),
  ('04', 'Assistance with Social, Economic and Community Participation'),
  ('05', 'Assistive Technology'),
  ('06', 'Home Modifications and SDA'),
  ('07', 'Support Coordination'),
  ('08', 'Improved Living Arrangements'),
  ('09', 'Increased Social and Community Participation'),
  ('10', 'Finding and Keeping a Job'),
  ('11', 'Improved Relationships'),
  ('12', 'Improved Health and Wellbeing'),
  ('13', 'Improved Learning'),
  ('14', 'Improved Life Choices'),
  ('15', 'Improved Daily Living Skills');

-- NDIS Line Items (pricing schedule)
CREATE TABLE IF NOT EXISTS ndis_line_items (
  id TEXT PRIMARY KEY,
  support_item_number TEXT NOT NULL,
  support_category TEXT,
  description TEXT NOT NULL,
  rate REAL NOT NULL,
  rate_remote REAL,
  rate_very_remote REAL,
  rate_type TEXT DEFAULT 'weekday',
  time_band TEXT DEFAULT 'daytime',
  unit TEXT DEFAULT 'hour',
  category TEXT,
  registration_group_number TEXT,
  effective_from TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Index created by migration when support_category column exists (for older DBs)

-- Shifts
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT DEFAULT 'scheduled',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);

-- Shift Line Items (NDIS items linked to shift)
CREATE TABLE IF NOT EXISTS shift_line_items (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL,
  ndis_line_item_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  claim_type TEXT DEFAULT 'standard',
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
  FOREIGN KEY (ndis_line_item_id) REFERENCES ndis_line_items(id)
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE
);

-- Progress Notes (evidence of actual delivery; links to shifts for invoicing/payroll)
CREATE TABLE IF NOT EXISTS progress_notes (
  id TEXT PRIMARY KEY,
  shift_id TEXT,
  participant_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  support_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  duration_hours REAL,
  travel_km REAL,
  travel_time_min INTEGER,
  mood TEXT,
  session_details TEXT,
  incidents TEXT,
  source TEXT DEFAULT 'progress_notes_app',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_progress_notes_shift ON progress_notes(shift_id);
CREATE INDEX IF NOT EXISTS idx_progress_notes_participant ON progress_notes(participant_id);
CREATE INDEX IF NOT EXISTS idx_progress_notes_staff ON progress_notes(staff_id);
CREATE INDEX IF NOT EXISTS idx_progress_notes_support_date ON progress_notes(support_date);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_participants_ndis ON participants(ndis_number);
CREATE INDEX IF NOT EXISTS idx_participants_plan_manager ON participants(plan_manager_id);
CREATE INDEX IF NOT EXISTS idx_ndis_plans_participant ON ndis_plans(participant_id);
CREATE INDEX IF NOT EXISTS idx_shifts_participant ON shifts(participant_id);
CREATE INDEX IF NOT EXISTS idx_shifts_staff ON shifts(staff_id);
CREATE INDEX IF NOT EXISTS idx_shifts_start ON shifts(start_time);
CREATE INDEX IF NOT EXISTS idx_shift_line_items_shift ON shift_line_items(shift_id);
CREATE INDEX IF NOT EXISTS idx_budget_line_items_budget ON budget_line_items(budget_id);

-- Provider onboarding profile (per organisation/provider)
CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL UNIQUE,
  onboarding_enabled INTEGER DEFAULT 0,
  onboarding_pilot INTEGER DEFAULT 0,
  default_renewal_days INTEGER DEFAULT 365,
  signature_mode TEXT DEFAULT 'hybrid', -- hybrid | packet | separate
  adobe_template_set_id TEXT,
  config_json TEXT, -- provider-specific rules/mappings
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE
);

-- Template registry
CREATE TABLE IF NOT EXISTS form_templates (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL,
  form_type TEXT NOT NULL, -- service_agreement | intake_form | support_plan | privacy_consent | custom
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  required_signer_role TEXT, -- participant | guardian | provider_representative
  renewal_days INTEGER, -- override provider default
  legal_basis TEXT,
  adobe_template_id TEXT,
  mapping_json TEXT, -- field mapping rules for prefill
  workflow TEXT DEFAULT 'participant_onboarding', -- participant_onboarding | staff_onboarding
  template_filename TEXT, -- for custom forms: filename under templates/custom/
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider_profile_id, form_type, version),
  FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
);

-- Required forms per provider (allows cohort/service-based policy)
CREATE TABLE IF NOT EXISTS provider_required_forms (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL,
  form_template_id TEXT NOT NULL,
  service_category TEXT,
  participant_cohort TEXT,
  is_required INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider_profile_id, form_template_id, service_category, participant_cohort),
  FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (form_template_id) REFERENCES form_templates(id) ON DELETE CASCADE
);

-- Onboarding workflow state per participant
CREATE TABLE IF NOT EXISTS participant_onboarding (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL UNIQUE,
  provider_profile_id TEXT NOT NULL,
  status TEXT DEFAULT 'draft', -- draft | in_progress | awaiting_signature | complete | blocked | archived
  current_stage TEXT DEFAULT 'participant_details', -- participant_details | intake | schedule | review | signature | complete
  started_at TEXT,
  completed_at TEXT,
  last_activity_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
);

-- Captures extra intake fields not in participant core model
CREATE TABLE IF NOT EXISTS participant_intake_fields (
  id TEXT PRIMARY KEY,
  participant_onboarding_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  field_value TEXT,
  source TEXT DEFAULT 'user', -- user | imported | derived
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(participant_onboarding_id, field_key),
  FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE CASCADE
);

-- One generated form instance per participant/template/version
CREATE TABLE IF NOT EXISTS participant_form_instances (
  id TEXT PRIMARY KEY,
  participant_onboarding_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  form_template_id TEXT NOT NULL,
  status TEXT DEFAULT 'draft', -- draft | generated | sent | viewed | signed | declined | expired | superseded | error
  version INTEGER DEFAULT 1,
  due_at TEXT,
  generated_at TEXT,
  sent_at TEXT,
  viewed_at TEXT,
  signed_at TEXT,
  expired_at TEXT,
  superseded_at TEXT,
  source_snapshot_json TEXT, -- deterministic prefill snapshot for audit
  draft_document_path TEXT,
  signed_document_path TEXT,
  certificate_document_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (form_template_id) REFERENCES form_templates(id) ON DELETE CASCADE
);

-- Signature packets / envelopes (Adobe Sign agreements)
CREATE TABLE IF NOT EXISTS signature_envelopes (
  id TEXT PRIMARY KEY,
  participant_onboarding_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  packet_mode TEXT DEFAULT 'hybrid', -- hybrid | packet | separate
  provider_name TEXT DEFAULT 'adobe_sign',
  external_envelope_id TEXT, -- Adobe agreement id
  status TEXT DEFAULT 'draft', -- draft | sent | viewed | signed | declined | cancelled | expired | error
  packet_reasoning TEXT, -- why bundled/split for compliance
  sent_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
);

-- Which form instances are included in each signature envelope
CREATE TABLE IF NOT EXISTS envelope_form_instances (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  form_instance_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(envelope_id, form_instance_id),
  FOREIGN KEY (envelope_id) REFERENCES signature_envelopes(id) ON DELETE CASCADE,
  FOREIGN KEY (form_instance_id) REFERENCES participant_form_instances(id) ON DELETE CASCADE
);

-- Raw signature lifecycle events
CREATE TABLE IF NOT EXISTS signature_events (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  form_instance_id TEXT,
  provider_name TEXT DEFAULT 'adobe_sign',
  external_event_id TEXT,
  event_type TEXT NOT NULL, -- agreement_sent | agreement_viewed | agreement_signed | agreement_declined | webhook_error
  event_timestamp TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (envelope_id) REFERENCES signature_envelopes(id) ON DELETE CASCADE,
  FOREIGN KEY (form_instance_id) REFERENCES participant_form_instances(id) ON DELETE SET NULL
);

-- Immutable audit events for onboarding/compliance
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  participant_id TEXT,
  participant_onboarding_id TEXT,
  actor_type TEXT DEFAULT 'system', -- system | user | webhook
  actor_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT, -- onboarding | form_instance | envelope | template | provider_profile
  entity_id TEXT,
  old_value_json TEXT,
  new_value_json TEXT,
  metadata_json TEXT,
  source_ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE SET NULL,
  FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE SET NULL
);

-- Renewal tasks for expiring/outdated forms
CREATE TABLE IF NOT EXISTS onboarding_renewal_tasks (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  participant_onboarding_id TEXT NOT NULL,
  form_instance_id TEXT,
  form_template_id TEXT,
  due_at TEXT NOT NULL,
  reason TEXT NOT NULL, -- expires_soon | template_updated | policy_change | manual
  status TEXT DEFAULT 'pending', -- pending | generated | completed | dismissed
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE CASCADE,
  FOREIGN KEY (form_instance_id) REFERENCES participant_form_instances(id) ON DELETE SET NULL,
  FOREIGN KEY (form_template_id) REFERENCES form_templates(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_profiles_org ON provider_profiles(organisation_id);
CREATE INDEX IF NOT EXISTS idx_form_templates_provider ON form_templates(provider_profile_id);
CREATE INDEX IF NOT EXISTS idx_provider_required_forms_provider ON provider_required_forms(provider_profile_id);
CREATE INDEX IF NOT EXISTS idx_participant_onboarding_participant ON participant_onboarding(participant_id);
CREATE INDEX IF NOT EXISTS idx_participant_form_instances_onboarding ON participant_form_instances(participant_onboarding_id);
CREATE INDEX IF NOT EXISTS idx_participant_form_instances_status ON participant_form_instances(status);
CREATE INDEX IF NOT EXISTS idx_signature_envelopes_onboarding ON signature_envelopes(participant_onboarding_id);
CREATE INDEX IF NOT EXISTS idx_signature_events_envelope ON signature_events(envelope_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_participant ON audit_events(participant_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_onboarding_renewal_tasks_due ON onboarding_renewal_tasks(due_at);

-- Staff onboarding (care support worker platform)
-- staff table extended via migrations: role, employment_type, hourly_rate, onboarding_status, onboarding_token, onboarding_token_expires_at, manager_id, abn, address, date_of_birth, emergency_contact_name, emergency_contact_phone, availability_json

CREATE TABLE IF NOT EXISTS staff_sensitive_data (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL UNIQUE,
  tfn_encrypted TEXT,
  bank_bsb TEXT,
  bank_account_encrypted TEXT,
  super_fund_name TEXT,
  super_member_number TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS staff_onboarding (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL UNIQUE,
  provider_profile_id TEXT,
  status TEXT DEFAULT 'draft',
  current_step INTEGER DEFAULT 1,
  started_at TEXT,
  completed_at TEXT,
  last_activity_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS staff_intake_fields (
  id TEXT PRIMARY KEY,
  staff_onboarding_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  field_value TEXT,
  source TEXT DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(staff_onboarding_id, field_key),
  FOREIGN KEY (staff_onboarding_id) REFERENCES staff_onboarding(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS staff_compliance_documents (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  onedrive_item_id TEXT,
  onedrive_web_url TEXT,
  expiry_date TEXT,
  status TEXT DEFAULT 'valid',
  uploaded_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS company_policy_files (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT,
  display_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS staff_policy_acknowledgements (
  id TEXT PRIMARY KEY,
  staff_onboarding_id TEXT NOT NULL,
  policy_file_id TEXT,
  acknowledged_at TEXT DEFAULT (datetime('now')),
  signature_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (staff_onboarding_id) REFERENCES staff_onboarding(id) ON DELETE CASCADE,
  FOREIGN KEY (policy_file_id) REFERENCES company_policy_files(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS staff_certification_reminders (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  reminder_type TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS staff_renewal_tokens (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_staff_onboarding_staff ON staff_onboarding(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_intake_fields_onboarding ON staff_intake_fields(staff_onboarding_id);
CREATE INDEX IF NOT EXISTS idx_staff_compliance_documents_staff ON staff_compliance_documents(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_compliance_documents_expiry ON staff_compliance_documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_company_policy_files_provider ON company_policy_files(provider_profile_id);
CREATE INDEX IF NOT EXISTS idx_staff_certification_reminders_staff ON staff_certification_reminders(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_renewal_tokens_token ON staff_renewal_tokens(token);

-- Per-organisation Microsoft OneDrive (delegated OAuth); files under "Nexus Core" in the connected user's drive
CREATE TABLE IF NOT EXISTS organization_onedrive_link (
  organization_id TEXT PRIMARY KEY,
  graph_user_id TEXT NOT NULL,
  azure_tenant_id TEXT,
  refresh_token_encrypted TEXT,
  access_token_encrypted TEXT,
  token_expires_at INTEGER,
  nexus_core_folder_id TEXT,
  connected_at TEXT,
  connected_by_user_id TEXT,
  FOREIGN KEY (organization_id) REFERENCES organisations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS onedrive_document_register (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  category TEXT,
  filename TEXT,
  graph_item_id TEXT,
  web_url TEXT,
  mime_type TEXT,
  created_at TEXT,
  notes TEXT,
  FOREIGN KEY (organization_id) REFERENCES organisations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_onedrive_register_org ON onedrive_document_register(organization_id);
CREATE INDEX IF NOT EXISTS idx_onedrive_register_entity ON onedrive_document_register(entity_type, entity_id);
