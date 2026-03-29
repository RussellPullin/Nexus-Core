import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { participantInvoiceIncludesGst, roundMoney, gstBreakdownFromSubtotal } from '../lib/invoiceGst.js';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve paths relative to project root (parent of server/) so DB works regardless of cwd
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

const dbPath = resolve(projectRoot, process.env.DATABASE_PATH || 'data/schedule.db');
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}
export const db = new Database(dbPath);

// Initialize schema
const schemaPath = join(projectRoot, 'database', 'schema.sql');
try {
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
} catch (err) {
  console.warn('Could not load schema:', err.message);
}

// Parse rate_type from description for migration backfill
function parseRateTypeFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return null;
  const d = desc.toLowerCase();
  if (d.includes('saturday') || d.includes('sat ')) return 'saturday';
  if (d.includes('sunday') || d.includes('sun ')) return 'sunday';
  if (d.includes('public holiday') || d.includes(' ph ') || d.includes('public hol')) return 'public_holiday';
  return null; // weekday is default
}

// Parse time_band from description for migration backfill (daytime, evening, night)
function parseTimeBandFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return null;
  const d = desc.toLowerCase();
  if (d.includes('evening')) return 'evening';
  if (d.includes('night') || d.includes('night-time') || d.includes('nighttime')) return 'night';
  if (d.includes('daytime') || d.includes('day time')) return 'daytime';
  return null; // default to daytime when matching
}

// Migrations for existing databases
try {
  const ndisCols = db.prepare("PRAGMA table_info(ndis_line_items)").all();
  const hasRateRemote = ndisCols.some(c => c.name === 'rate_remote');
  if (!hasRateRemote) {
    db.exec('ALTER TABLE ndis_line_items ADD COLUMN rate_remote REAL');
    db.exec('ALTER TABLE ndis_line_items ADD COLUMN rate_very_remote REAL');
  }
  const partCols = db.prepare("PRAGMA table_info(participants)").all();
  const hasRemoteness = partCols.some(c => c.name === 'remoteness');
  if (!hasRemoteness) {
    db.exec("ALTER TABLE participants ADD COLUMN remoteness TEXT DEFAULT 'standard'");
  }
  const addParticipantCol = (col, def) => {
    if (!partCols.some(c => c.name === col)) {
      try {
        db.exec(`ALTER TABLE participants ADD COLUMN ${col} ${def}`);
      } catch (e) {
        if (!e.message?.includes('duplicate column')) console.warn(`participants.${col} migration:`, e.message);
      }
    }
  };
  addParticipantCol('parent_guardian_phone', 'TEXT');
  addParticipantCol('parent_guardian_email', 'TEXT');
  addParticipantCol('diagnosis', 'TEXT');
  addParticipantCol('services_required', 'TEXT');
  addParticipantCol('management_type', "TEXT DEFAULT 'self'");
  addParticipantCol('ndia_managed_services', 'TEXT');
  addParticipantCol('plan_managed_services', 'TEXT');
  addParticipantCol('invoice_emails', 'TEXT');
  addParticipantCol('archived_at', 'TEXT');
  addParticipantCol('default_ndis_line_item_id', 'TEXT');
  addParticipantCol('invoice_includes_gst', 'INTEGER DEFAULT 0');
  const hasRegGroup = ndisCols.some(c => c.name === 'registration_group_number');
  if (!hasRegGroup) {
    db.exec('ALTER TABLE ndis_line_items ADD COLUMN registration_group_number TEXT');
  }
  const hasSupportCategory = ndisCols.some(c => c.name === 'support_category');
  if (!hasSupportCategory) {
    try {
      db.exec('ALTER TABLE ndis_line_items ADD COLUMN support_category TEXT');
      const items = db.prepare('SELECT id, support_item_number FROM ndis_line_items').all();
      const updateStmt = db.prepare('UPDATE ndis_line_items SET support_category = ? WHERE id = ?');
      for (const item of items) {
        const prefix = item.support_item_number && item.support_item_number.includes('_')
          ? item.support_item_number.split('_')[0]
          : (item.support_item_number || '').slice(0, 2);
        if (prefix && /^\d{2}$/.test(prefix)) {
          updateStmt.run(prefix, item.id);
        }
      }
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('support_category migration:', e.message);
    }
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_ndis_line_items_support_category ON ndis_line_items(support_category)');
  } catch (e) {
    if (!e.message?.includes('no such column')) console.warn('support_category index:', e.message);
  }
  // ndis_line_items.rate_type (weekday, saturday, sunday, public_holiday) for day-of-week alignment
  const hasRateType = ndisCols.some(c => c.name === 'rate_type');
  if (!hasRateType) {
    try {
      db.exec("ALTER TABLE ndis_line_items ADD COLUMN rate_type TEXT DEFAULT 'weekday'");
      const updateStmt = db.prepare('UPDATE ndis_line_items SET rate_type = ? WHERE id = ?');
      const items = db.prepare('SELECT id, description FROM ndis_line_items').all();
      for (const item of items) {
        const rt = parseRateTypeFromDescription(item.description);
        if (rt) updateStmt.run(rt, item.id);
      }
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('rate_type migration:', e.message);
    }
  }
  // ndis_line_items.time_band (daytime, evening, night) for time-of-day alignment
  const ndisColsAfter = db.prepare("PRAGMA table_info(ndis_line_items)").all();
  const hasTimeBand = ndisColsAfter.some(c => c.name === 'time_band');
  if (!hasTimeBand) {
    try {
      db.exec("ALTER TABLE ndis_line_items ADD COLUMN time_band TEXT DEFAULT 'daytime'");
      const updateStmt = db.prepare('UPDATE ndis_line_items SET time_band = ? WHERE id = ?');
      const items = db.prepare('SELECT id, description FROM ndis_line_items').all();
      for (const item of items) {
        const tb = parseTimeBandFromDescription(item.description);
        if (tb) updateStmt.run(tb, item.id);
      }
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('time_band migration:', e.message);
    }
  }
  // implementations: hours_per_week, ndis_line_item_id, frequency for per-provider config
  try {
    const implCols = db.prepare("PRAGMA table_info(implementations)").all();
    if (!implCols.some(c => c.name === 'hours_per_week')) {
      db.exec('ALTER TABLE implementations ADD COLUMN hours_per_week REAL');
    }
    if (!implCols.some(c => c.name === 'ndis_line_item_id')) {
      db.exec('ALTER TABLE implementations ADD COLUMN ndis_line_item_id TEXT');
    }
    if (!implCols.some(c => c.name === 'frequency')) {
      db.exec('ALTER TABLE implementations ADD COLUMN frequency TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('implementations migration:', e.message);
  }
  // shift_line_items.claim_type (Standard, Provider Travel, Non-Face-to-Face)
  const sliCols = db.prepare("PRAGMA table_info(shift_line_items)").all();
  if (!sliCols.some(c => c.name === 'claim_type')) {
    try {
      db.exec('ALTER TABLE shift_line_items ADD COLUMN claim_type TEXT DEFAULT \'standard\'');
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('shift_line_items.claim_type migration:', e.message);
    }
  }
  // shifts.roster_sent_at: when roster/ICS was last sent; null = not sent or moved since
  const shiftCols = db.prepare("PRAGMA table_info(shifts)").all();
  if (!shiftCols.some(c => c.name === 'roster_sent_at')) {
    try {
      db.exec('ALTER TABLE shifts ADD COLUMN roster_sent_at TEXT');
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('shifts.roster_sent_at migration:', e.message);
    }
  }
  if (!shiftCols.some(c => c.name === 'recurring_group_id')) {
    try {
      db.exec('ALTER TABLE shifts ADD COLUMN recurring_group_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_shifts_recurring_group ON shifts(recurring_group_id)');
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('shifts.recurring_group_id migration:', e.message);
    }
  }
  if (!shiftCols.some(c => c.name === 'expenses')) {
    try {
      db.exec('ALTER TABLE shifts ADD COLUMN expenses REAL DEFAULT 0');
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('shifts.expenses migration:', e.message);
    }
  }
  if (!shiftCols.some(c => c.name === 'shifter_shift_id')) {
    try {
      db.exec('ALTER TABLE shifts ADD COLUMN shifter_shift_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_shifts_shifter_shift_id ON shifts(shifter_shift_id)');
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('shifts.shifter_shift_id migration:', e.message);
    }
  }
  // plan_budgets: hours_planned and frequency for SC configuration (e.g. 10 hrs/week)
  try {
    const pbCols = db.prepare("PRAGMA table_info(plan_budgets)").all();
    if (!pbCols.some(c => c.name === 'hours_planned')) {
      db.exec('ALTER TABLE plan_budgets ADD COLUMN hours_planned REAL');
    }
    if (!pbCols.some(c => c.name === 'frequency')) {
      db.exec('ALTER TABLE plan_budgets ADD COLUMN frequency TEXT');
    }
    if (!pbCols.some(c => c.name === 'management_type')) {
      db.exec("ALTER TABLE plan_budgets ADD COLUMN management_type TEXT DEFAULT 'self'");
      db.exec(`
        UPDATE plan_budgets
        SET management_type = COALESCE(
          (
            SELECT p.management_type
            FROM ndis_plans np
            JOIN participants p ON p.id = np.participant_id
            WHERE np.id = plan_budgets.plan_id
          ),
          'self'
        )
      `);
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('plan_budgets hours_planned/frequency/management_type migration:', e.message);
  }
  try {
    const npCols = db.prepare('PRAGMA table_info(ndis_plans)').all();
    if (!npCols.some((c) => c.name === 'fund_release_schedule')) {
      db.exec('ALTER TABLE ndis_plans ADD COLUMN fund_release_schedule TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('ndis_plans.fund_release_schedule migration:', e.message);
  }
  // budget_line_items: link budgets to NDIS charges for hours/shifts calculation
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS budget_line_items (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL,
        ndis_line_item_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (budget_id) REFERENCES plan_budgets(id) ON DELETE CASCADE,
        FOREIGN KEY (ndis_line_item_id) REFERENCES ndis_line_items(id) ON DELETE CASCADE,
        UNIQUE(budget_id, ndis_line_item_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_budget_line_items_budget ON budget_line_items(budget_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('budget_line_items migration:', e.message);
  }
  // shift_patterns: learned popular shift structures for LLM/suggestions
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shift_patterns (
        id TEXT PRIMARY KEY,
        participant_id TEXT,
        line_item_signature TEXT NOT NULL,
        duration_hours REAL,
        use_count INTEGER DEFAULT 1,
        last_used TEXT DEFAULT (datetime('now')),
        sample_line_items TEXT,
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_shift_patterns_participant ON shift_patterns(participant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_shift_patterns_last_used ON shift_patterns(last_used)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('shift_patterns migration:', e.message);
  }
  // Ensure ndis_support_categories exists and is populated
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ndis_support_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
    const count = db.prepare('SELECT COUNT(*) as c FROM ndis_support_categories').get();
    if (count.c === 0) {
      const cats = [
        ['01', 'Assistance with Daily Life'], ['02', 'Transport'], ['03', 'Consumables'],
        ['04', 'Assistance with Social, Economic and Community Participation'],
        ['05', 'Assistive Technology'], ['06', 'Home Modifications and SDA'],
        ['07', 'Support Coordination'], ['08', 'Improved Living Arrangements'],
        ['09', 'Increased Social and Community Participation'], ['10', 'Finding and Keeping a Job'],
        ['11', 'Improved Relationships'], ['12', 'Improved Health and Wellbeing'],
        ['13', 'Improved Learning'], ['14', 'Improved Life Choices'], ['15', 'Improved Daily Living Skills']
      ];
      const ins = db.prepare('INSERT INTO ndis_support_categories (id, name) VALUES (?, ?)');
      cats.forEach(([id, name]) => ins.run(id, name));
    }
  } catch (e) {
    console.warn('ndis_support_categories init:', e.message);
  }
  // Quotable NDIS line items (no set price; user agrees with participant). Add if missing.
  try {
    const slesItem = db.prepare('SELECT id FROM ndis_line_items WHERE support_item_number = ?').get('10_021_0102_5_3');
    if (!slesItem) {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO ndis_line_items (id, support_item_number, support_category, description, rate, rate_type, time_band, unit, category, registration_group_number)
        VALUES (?, '10_021_0102_5_3', '10', 'School Leaver Employment Support', 0, 'weekday', 'daytime', 'week', 'Finding and Keeping a Job', '0102')
      `).run(id);
    }
  } catch (e) {
    console.warn('NDIS quotable line item (SLES) seed:', e.message);
  }
  // usage_preferences: learned user preferences for personalization (LLM layer)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_preferences (
        id TEXT PRIMARY KEY,
        preference_type TEXT NOT NULL,
        context_key TEXT NOT NULL,
        preference_value TEXT NOT NULL,
        use_count INTEGER DEFAULT 1,
        last_used TEXT DEFAULT (datetime('now')),
        metadata TEXT,
        UNIQUE(preference_type, context_key, preference_value)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_usage_preferences_type ON usage_preferences(preference_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_usage_preferences_context ON usage_preferences(context_key)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('usage_preferences migration:', e.message);
  }
  // users: admin login, per-user SMTP or Resend API for roster sending
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT,
        smtp_email TEXT,
        smtp_password_encrypted TEXT,
        resend_api_key_encrypted TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    const userCols = db.prepare("PRAGMA table_info(users)").all();
    if (!userCols.some(c => c.name === 'resend_api_key_encrypted')) {
      db.exec('ALTER TABLE users ADD COLUMN resend_api_key_encrypted TEXT');
    }
    if (!userCols.some(c => c.name === 'azure_function_url')) {
      db.exec('ALTER TABLE users ADD COLUMN azure_function_url TEXT');
    }
    if (!userCols.some(c => c.name === 'azure_api_key_encrypted')) {
      db.exec('ALTER TABLE users ADD COLUMN azure_api_key_encrypted TEXT');
    }
    if (!userCols.some(c => c.name === 'email_provider')) {
      db.exec('ALTER TABLE users ADD COLUMN email_provider TEXT');
    }
    if (!userCols.some(c => c.name === 'email_connected_address')) {
      db.exec('ALTER TABLE users ADD COLUMN email_connected_address TEXT');
    }
    if (!userCols.some(c => c.name === 'email_oauth_access_encrypted')) {
      db.exec('ALTER TABLE users ADD COLUMN email_oauth_access_encrypted TEXT');
    }
    if (!userCols.some(c => c.name === 'email_oauth_refresh_encrypted')) {
      db.exec('ALTER TABLE users ADD COLUMN email_oauth_refresh_encrypted TEXT');
    }
    if (!userCols.some(c => c.name === 'email_token_expires_at')) {
      db.exec('ALTER TABLE users ADD COLUMN email_token_expires_at INTEGER');
    }
    if (!userCols.some(c => c.name === 'email_reconnect_required')) {
      db.exec('ALTER TABLE users ADD COLUMN email_reconnect_required INTEGER DEFAULT 0');
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('users migration:', e.message);
  }

  // progress_notes: evidence of actual delivery, links to shifts for invoicing/payroll
  try {
    db.exec(`
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
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_progress_notes_shift ON progress_notes(shift_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_progress_notes_participant ON progress_notes(participant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_progress_notes_staff ON progress_notes(staff_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_progress_notes_support_date ON progress_notes(support_date)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('progress_notes migration:', e.message);
  }

  // app_shifts: shifts from Progress Notes App webhook when participant/staff not matched
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_shifts (
        shift_id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        staff_name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        start_time TEXT,
        finish_time TEXT,
        duration TEXT,
        travel_km REAL,
        travel_time_minutes INTEGER,
        expenses REAL DEFAULT 0,
        incidents TEXT,
        mood TEXT,
        session_details TEXT,
        goals_worked_towards TEXT,
        medication_checks TEXT,
        source_org_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_app_shifts_date ON app_shifts(date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_app_shifts_client_name ON app_shifts(client_name)');
    const appShiftCols = db.prepare("PRAGMA table_info(app_shifts)").all();
    if (!appShiftCols.some((c) => c.name === 'expenses')) {
      try {
        db.exec('ALTER TABLE app_shifts ADD COLUMN expenses REAL DEFAULT 0');
      } catch (e) {
        if (!e.message?.includes('duplicate column')) console.warn('app_shifts.expenses migration:', e.message);
      }
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('app_shifts migration:', e.message);
  }

  // participant_documents: onboarding/signature linkage metadata
  try {
    const docCols = db.prepare("PRAGMA table_info(participant_documents)").all();
    const addDocCol = (name, def) => {
      if (!docCols.some((c) => c.name === name)) {
        db.exec(`ALTER TABLE participant_documents ADD COLUMN ${name} ${def}`);
      }
    };
    addDocCol('source_type', "TEXT DEFAULT 'manual_upload'");
    addDocCol('source_id', 'TEXT');
    addDocCol('document_status', "TEXT DEFAULT 'active'");
    addDocCol('expires_at', 'TEXT');
    addDocCol('superseded_at', 'TEXT');
    addDocCol('metadata_json', 'TEXT');
    addDocCol('shift_id', 'TEXT');
    addDocCol('receipt_description', 'TEXT');
    addDocCol('onedrive_item_id', 'TEXT');
    addDocCol('onedrive_web_url', 'TEXT');
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('participant_documents onboarding migration:', e.message);
  }

  // participant_goals: plan_id and archived_at for plan-linked goals (goals removed when plan deleted, archived when new plan added)
  try {
    const goalCols = db.prepare("PRAGMA table_info(participant_goals)").all();
    const addGoalCol = (name, def) => {
      if (!goalCols.some((c) => c.name === name)) {
        db.exec(`ALTER TABLE participant_goals ADD COLUMN ${name} ${def}`);
      }
    };
    addGoalCol('plan_id', 'TEXT');
    addGoalCol('archived_at', 'TEXT');
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('participant_goals plan_id/archived_at migration:', e.message);
  }

  // Provider onboarding config and template registry
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL UNIQUE,
        onboarding_enabled INTEGER DEFAULT 0,
        onboarding_pilot INTEGER DEFAULT 0,
        default_renewal_days INTEGER DEFAULT 365,
        signature_mode TEXT DEFAULT 'hybrid',
        adobe_template_set_id TEXT,
        config_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_provider_profiles_org ON provider_profiles(organisation_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('provider_profiles migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS form_templates (
        id TEXT PRIMARY KEY,
        provider_profile_id TEXT NOT NULL,
        form_type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        version TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        required_signer_role TEXT,
        renewal_days INTEGER,
        legal_basis TEXT,
        adobe_template_id TEXT,
        mapping_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(provider_profile_id, form_type, version),
        FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_form_templates_provider ON form_templates(provider_profile_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('form_templates migration:', e.message);
  }
  try {
    const ftCols = db.prepare('PRAGMA table_info(form_templates)').all();
    if (!ftCols.some((c) => c.name === 'workflow')) {
      db.exec("ALTER TABLE form_templates ADD COLUMN workflow TEXT DEFAULT 'participant_onboarding'");
      db.exec("UPDATE form_templates SET workflow = 'participant_onboarding' WHERE workflow IS NULL");
    }
    if (!ftCols.some((c) => c.name === 'template_filename')) {
      db.exec('ALTER TABLE form_templates ADD COLUMN template_filename TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('form_templates workflow/template_filename migration:', e.message);
  }

  try {
    db.exec(`
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
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_provider_required_forms_provider ON provider_required_forms(provider_profile_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('provider_required_forms migration:', e.message);
  }

  // Onboarding state, intake, form instances, signature, audit, renewal
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS participant_onboarding (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL UNIQUE,
        provider_profile_id TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        current_stage TEXT DEFAULT 'participant_details',
        started_at TEXT,
        completed_at TEXT,
        last_activity_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
        FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_participant_onboarding_participant ON participant_onboarding(participant_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('participant_onboarding migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS participant_intake_fields (
        id TEXT PRIMARY KEY,
        participant_onboarding_id TEXT NOT NULL,
        field_key TEXT NOT NULL,
        field_value TEXT,
        source TEXT DEFAULT 'user',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(participant_onboarding_id, field_key),
        FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE CASCADE
      )
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('participant_intake_fields migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS participant_form_instances (
        id TEXT PRIMARY KEY,
        participant_onboarding_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        form_template_id TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        version INTEGER DEFAULT 1,
        due_at TEXT,
        generated_at TEXT,
        sent_at TEXT,
        viewed_at TEXT,
        signed_at TEXT,
        expired_at TEXT,
        superseded_at TEXT,
        source_snapshot_json TEXT,
        draft_document_path TEXT,
        signed_document_path TEXT,
        certificate_document_path TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
        FOREIGN KEY (form_template_id) REFERENCES form_templates(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_participant_form_instances_onboarding ON participant_form_instances(participant_onboarding_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_participant_form_instances_status ON participant_form_instances(status)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('participant_form_instances migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS signature_envelopes (
        id TEXT PRIMARY KEY,
        participant_onboarding_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        packet_mode TEXT DEFAULT 'hybrid',
        provider_name TEXT DEFAULT 'adobe_sign',
        external_envelope_id TEXT,
        status TEXT DEFAULT 'draft',
        packet_reasoning TEXT,
        sent_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_signature_envelopes_onboarding ON signature_envelopes(participant_onboarding_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('signature_envelopes migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS envelope_form_instances (
        id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL,
        form_instance_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(envelope_id, form_instance_id),
        FOREIGN KEY (envelope_id) REFERENCES signature_envelopes(id) ON DELETE CASCADE,
        FOREIGN KEY (form_instance_id) REFERENCES participant_form_instances(id) ON DELETE CASCADE
      )
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('envelope_form_instances migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS signature_events (
        id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL,
        form_instance_id TEXT,
        provider_name TEXT DEFAULT 'adobe_sign',
        external_event_id TEXT,
        event_type TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (envelope_id) REFERENCES signature_envelopes(id) ON DELETE CASCADE,
        FOREIGN KEY (form_instance_id) REFERENCES participant_form_instances(id) ON DELETE SET NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_signature_events_envelope ON signature_events(envelope_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('signature_events migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        participant_id TEXT,
        participant_onboarding_id TEXT,
        actor_type TEXT DEFAULT 'system',
        actor_id TEXT,
        event_type TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        old_value_json TEXT,
        new_value_json TEXT,
        metadata_json TEXT,
        source_ip TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE SET NULL,
        FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE SET NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_events_participant ON audit_events(participant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('audit_events migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_renewal_tasks (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        participant_onboarding_id TEXT NOT NULL,
        form_instance_id TEXT,
        form_template_id TEXT,
        due_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_onboarding_id) REFERENCES participant_onboarding(id) ON DELETE CASCADE,
        FOREIGN KEY (form_instance_id) REFERENCES participant_form_instances(id) ON DELETE SET NULL,
        FOREIGN KEY (form_template_id) REFERENCES form_templates(id) ON DELETE SET NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_renewal_tasks_due ON onboarding_renewal_tasks(due_at)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('onboarding_renewal_tasks migration:', e.message);
  }

  // Task invoices: invoices built from coordinator tasks (not shifts)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_invoices (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        invoice_number TEXT NOT NULL,
        support_date_from TEXT NOT NULL,
        support_date_to TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_task_invoices_participant ON task_invoices(participant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_task_invoices_staff ON task_invoices(staff_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('task_invoices migration:', e.message);
  }

  // Support coordinator tasks (activities): emails, meetings, etc. with evidence and billing
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_tasks (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        description TEXT,
        evidence_text TEXT,
        activity_date TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        bill_interval_minutes INTEGER,
        includes_travel INTEGER DEFAULT 0,
        travel_km REAL,
        travel_time_min INTEGER,
        ndis_line_item_id TEXT,
        quantity REAL,
        unit_price REAL,
        task_invoice_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
        FOREIGN KEY (ndis_line_item_id) REFERENCES ndis_line_items(id),
        FOREIGN KEY (task_invoice_id) REFERENCES task_invoices(id) ON DELETE SET NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_participant ON coordinator_tasks(participant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_staff ON coordinator_tasks(staff_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_activity_date ON coordinator_tasks(activity_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_invoice ON coordinator_tasks(task_invoice_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('coordinator_tasks migration:', e.message);
  }

  // Coordinator cases: parent cases for tracking multi-step work (OT onboarding, change of situation, etc.)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_cases (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'on_hold')),
        due_date TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_cases_participant ON coordinator_cases(participant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_cases_status ON coordinator_cases(status)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('coordinator_cases migration:', e.message);
  }

  // Coordinator case tasks: sub-tasks within a case
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_case_tasks (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
        due_date TEXT,
        completed_at TEXT,
        sort_order INTEGER DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (case_id) REFERENCES coordinator_cases(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_case_tasks_case ON coordinator_case_tasks(case_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('coordinator_case_tasks migration:', e.message);
  }

  // Billing invoices: unified per-participant invoices (tasks + shifts) from batch runs
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoices (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        invoice_number TEXT NOT NULL,
        period_from TEXT NOT NULL,
        period_to TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoice_line_items (
        id TEXT PRIMARY KEY,
        billing_invoice_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_task_id TEXT,
        source_shift_id TEXT,
        source_shift_line_item_id TEXT,
        ndis_line_item_id TEXT,
        support_item_number TEXT,
        description TEXT,
        quantity REAL NOT NULL,
        unit_price REAL NOT NULL,
        unit TEXT DEFAULT 'hour',
        line_date TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (billing_invoice_id) REFERENCES billing_invoices(id) ON DELETE CASCADE,
        FOREIGN KEY (source_task_id) REFERENCES coordinator_tasks(id),
        FOREIGN KEY (source_shift_id) REFERENCES shifts(id),
        FOREIGN KEY (ndis_line_item_id) REFERENCES ndis_line_items(id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_billing_invoices_participant ON billing_invoices(participant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_billing_invoice_line_items_invoice ON billing_invoice_line_items(billing_invoice_id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS billing_batch_payments (
        id TEXT PRIMARY KEY,
        batch_ref TEXT NOT NULL,
        amount REAL NOT NULL,
        paid_at TEXT DEFAULT (date('now')),
        note TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_billing_batch_payments_batch_ref ON billing_batch_payments(batch_ref)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoice_payments (
        id TEXT PRIMARY KEY,
        billing_invoice_id TEXT NOT NULL,
        amount REAL NOT NULL,
        paid_at TEXT DEFAULT (date('now')),
        note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (billing_invoice_id) REFERENCES billing_invoices(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_billing_invoice_payments_invoice ON billing_invoice_payments(billing_invoice_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('billing_invoices migration:', e.message);
  }

  // Move legacy batch-level payments into per-invoice rows (proportional to invoice totals incl. GST), then clear legacy table.
  try {
    const legacyCount = db.prepare('SELECT COUNT(*) as c FROM billing_batch_payments').get()?.c ?? 0;
    if (legacyCount > 0) {
      const groups = db.prepare('SELECT batch_ref, SUM(amount) as total FROM billing_batch_payments GROUP BY batch_ref').all();
      const insertPay = db.prepare(`
        INSERT INTO billing_invoice_payments (id, billing_invoice_id, amount, paid_at, note)
        VALUES (?, ?, ?, date('now'), ?)
      `);
      const lineSum = db.prepare(`
        SELECT COALESCE(SUM(quantity * unit_price), 0) as s FROM billing_invoice_line_items WHERE billing_invoice_id = ?
      `);
      const delBatch = db.prepare('DELETE FROM billing_batch_payments WHERE batch_ref = ?');
      const run = db.transaction(() => {
        for (const g of groups) {
          const batchRef = String(g.batch_ref);
          const paidPool = roundMoney(Number(g.total) || 0);
          if (paidPool <= 0) continue;
          const invRows = db.prepare(`
            SELECT bi.id, p.invoice_includes_gst
            FROM billing_invoices bi
            JOIN participants p ON p.id = bi.participant_id
            WHERE bi.invoice_number LIKE ?
          `).all(`BINV-${batchRef}-%`);
          const totals = [];
          for (const inv of invRows) {
            const sub = lineSum.get(inv.id)?.s ?? 0;
            const subtotal = roundMoney(sub);
            const { total_incl_gst: tincl } = gstBreakdownFromSubtotal(
              subtotal,
              participantInvoiceIncludesGst(inv.invoice_includes_gst)
            );
            if (tincl > 0) totals.push({ id: inv.id, total: tincl });
          }
          const sumT = totals.reduce((acc, x) => acc + x.total, 0);
          if (sumT <= 0) continue;
          let remaining = paidPool;
          totals.forEach((t, idx) => {
            let alloc;
            if (idx === totals.length - 1) alloc = roundMoney(remaining);
            else {
              alloc = roundMoney(paidPool * (t.total / sumT));
              remaining = roundMoney(remaining - alloc);
            }
            if (alloc > 0.001) {
              insertPay.run(randomUUID(), t.id, alloc, 'Migrated from batch payment');
            }
          });
          delBatch.run(batchRef);
        }
      });
      run();
      console.info('[db] Migrated billing_batch_payments into billing_invoice_payments (where batch invoices matched BINV-*)');
    }
  } catch (e) {
    if (!e.message?.includes('no such table')) console.warn('billing_invoice_payments migration from batch:', e.message);
  }

  try {
    const ctCols = db.prepare("PRAGMA table_info(coordinator_tasks)").all();
    if (!ctCols.some(c => c.name === 'billing_invoice_id')) {
      db.exec('ALTER TABLE coordinator_tasks ADD COLUMN billing_invoice_id TEXT REFERENCES billing_invoices(id) ON DELETE SET NULL');
    }
    if (!ctCols.some(c => c.name === 'case_id')) {
      db.exec('ALTER TABLE coordinator_tasks ADD COLUMN case_id TEXT REFERENCES coordinator_cases(id) ON DELETE SET NULL');
    }
    if (!ctCols.some(c => c.name === 'case_task_id')) {
      db.exec('ALTER TABLE coordinator_tasks ADD COLUMN case_task_id TEXT REFERENCES coordinator_case_tasks(id) ON DELETE SET NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_case_task ON coordinator_tasks(case_task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_case ON coordinator_tasks(case_id)');
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('coordinator_tasks migration:', e.message);
  }

  try {
    const bilCols = db.prepare("PRAGMA table_info(billing_invoice_line_items)").all();
    if (!bilCols.some(c => c.name === 'source_task_ids')) {
      db.exec('ALTER TABLE billing_invoice_line_items ADD COLUMN source_task_ids TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('billing_invoice_line_items.source_task_ids migration:', e.message);
  }

  try {
    const biXeroCols = db.prepare('PRAGMA table_info(billing_invoices)').all();
    if (!biXeroCols.some((c) => c.name === 'xero_invoice_id')) {
      db.exec('ALTER TABLE billing_invoices ADD COLUMN xero_invoice_id TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('billing_invoices.xero_invoice_id migration:', e.message);
  }

  try {
    const shiftCols = db.prepare("PRAGMA table_info(shifts)").all();
    if (!shiftCols.some(c => c.name === 'billing_invoice_id')) {
      db.exec('ALTER TABLE shifts ADD COLUMN billing_invoice_id TEXT REFERENCES billing_invoices(id) ON DELETE SET NULL');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('shifts.billing_invoice_id migration:', e.message);
  }

  // ── Learning Layer tables ──────────────────────────────────────────────────

  // learning_events: append-only event stream capturing user behaviour
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        event_type TEXT NOT NULL,
        participant_id TEXT,
        staff_id TEXT,
        shift_id TEXT,
        day_of_week INTEGER,
        time_bucket TEXT,
        duration_minutes INTEGER,
        shift_type TEXT,
        service_category TEXT,
        funding_type TEXT,
        field_name TEXT,
        old_value TEXT,
        new_value TEXT,
        suggestion_id TEXT,
        confidence REAL,
        metadata_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_le_type ON learning_events(event_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_le_participant ON learning_events(participant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_le_created ON learning_events(created_at)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('learning_events migration:', e.message);
  }

  // learning_aggregates: pre-computed feature store with recency weighting
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS learning_aggregates (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT,
        feature_key TEXT NOT NULL,
        feature_value TEXT NOT NULL,
        count INTEGER DEFAULT 1,
        recency_score REAL DEFAULT 1.0,
        last_seen TEXT,
        metadata_json TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(scope, scope_id, feature_key, feature_value)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_la_scope ON learning_aggregates(scope, scope_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_la_key ON learning_aggregates(feature_key)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('learning_aggregates migration:', e.message);
  }

  // suggestion_history: immutable audit trail for every suggestion shown
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS suggestion_history (
        id TEXT PRIMARY KEY,
        suggestion_type TEXT NOT NULL,
        participant_id TEXT,
        staff_id TEXT,
        shift_id TEXT,
        suggested_value TEXT NOT NULL,
        confidence REAL,
        explanation TEXT,
        outcome TEXT DEFAULT 'pending',
        rejection_reason TEXT,
        dont_suggest_again INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sh_type ON suggestion_history(suggestion_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sh_outcome ON suggestion_history(outcome)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sh_created ON suggestion_history(created_at)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('suggestion_history migration:', e.message);
  }

  // csv_mapping_memory: learned CSV column-to-field mappings
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS csv_mapping_memory (
        id TEXT PRIMARY KEY,
        import_type TEXT NOT NULL,
        header_text TEXT NOT NULL,
        mapped_field TEXT NOT NULL,
        use_count INTEGER DEFAULT 1,
        correction_count INTEGER DEFAULT 0,
        last_used TEXT DEFAULT (datetime('now')),
        UNIQUE(import_type, header_text, mapped_field)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_cmm_type ON csv_mapping_memory(import_type)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('csv_mapping_memory migration:', e.message);
  }

  // learning_config: governance key-value store
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS learning_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    const defaults = [
      ['learning_enabled', 'true'],
      ['per_user_learning', 'true'],
      ['event_retention_days', '730'],
      ['suggestion_confidence_threshold', '0.3'],
      ['csv_mapping_auto_threshold', '0.9']
    ];
    const ins = db.prepare('INSERT OR IGNORE INTO learning_config (key, value) VALUES (?, ?)');
    for (const [k, v] of defaults) ins.run(k, v);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('learning_config migration:', e.message);
  }

  // business_settings: company details for invoices (logo, ABN, NDIS provider, payment)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS business_settings (
        id TEXT PRIMARY KEY DEFAULT 'default',
        org_id TEXT,
        company_name TEXT,
        company_abn TEXT,
        company_acn TEXT,
        ndis_provider_number TEXT,
        company_email TEXT,
        company_address TEXT,
        company_phone TEXT,
        logo_path TEXT,
        account_name TEXT,
        bsb TEXT,
        account_number TEXT,
        payment_terms_days INTEGER DEFAULT 7,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.prepare("INSERT OR IGNORE INTO business_settings (id) VALUES ('default')").run();
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('business_settings migration:', e.message);
  }
  try {
    let businessCols = db.prepare("PRAGMA table_info(business_settings)").all();
    if (!businessCols.some((c) => c.name === 'org_id')) {
      db.exec('ALTER TABLE business_settings ADD COLUMN org_id TEXT');
    }
    // Non-partial UNIQUE on org_id: required for INSERT ... ON CONFLICT(org_id). Partial unique indexes are not valid UPSERT conflict targets in SQLite.
    try {
      const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='business_settings_org_unique'`).get();
      if (idx?.sql && /\bWHERE\b/i.test(idx.sql)) {
        db.exec('DROP INDEX business_settings_org_unique');
      }
    } catch (e) {
      console.warn('business_settings_org_unique migration (drop partial):', e.message);
    }
    try {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS business_settings_org_unique ON business_settings(org_id)');
    } catch (e) {
      console.warn('business_settings_org_unique index:', e.message);
    }
    if (!businessCols.some((c) => c.name === 'accounting_provider')) {
      db.exec('ALTER TABLE business_settings ADD COLUMN accounting_provider TEXT');
    }
    for (const col of ['xero_client_id', 'xero_client_secret', 'xero_redirect_uri', 'xero_refresh_token', 'xero_tenant_id', 'xero_tenant_name']) {
      businessCols = db.prepare("PRAGMA table_info(business_settings)").all();
      if (!businessCols.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE business_settings ADD COLUMN ${col} TEXT`);
      }
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('business_settings xero migration:', e.message);
  }

  // Tie legacy id='default' to the sole CRM tenant so SELECT ... WHERE org_id = ? finds it (startup only; avoids runtime fallback that leaked default into other orgs).
  try {
    const def = db.prepare(`SELECT org_id AS o FROM business_settings WHERE id = 'default'`).get();
    if (def && def.o == null) {
      const distinctRow = db
        .prepare(`SELECT COUNT(DISTINCT org_id) AS c FROM users WHERE org_id IS NOT NULL`)
        .get();
      if (distinctRow?.c === 1) {
        const one = db.prepare(`SELECT org_id FROM users WHERE org_id IS NOT NULL LIMIT 1`).get();
        if (one?.org_id) {
          const taken = db.prepare(`SELECT 1 AS x FROM business_settings WHERE org_id = ?`).get(one.org_id);
          if (!taken) {
            db.prepare(`UPDATE business_settings SET org_id = ? WHERE id = 'default' AND org_id IS NULL`).run(one.org_id);
          }
        }
      }
    }
  } catch (e) {
    if (!e.message?.includes('no such table')) console.warn('business_settings default org_id backfill:', e.message);
  }

  // ── End Learning Layer tables ─────────────────────────────────────────────

  // staff.archived_at for soft archive
  try {
    const staffCols = db.prepare("PRAGMA table_info(staff)").all();
    if (!staffCols.some(c => c.name === 'org_id')) {
      db.exec('ALTER TABLE staff ADD COLUMN org_id TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_org_id ON staff(org_id)');
    if (!staffCols.some(c => c.name === 'archived_at')) {
      db.exec('ALTER TABLE staff ADD COLUMN archived_at TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('staff.archived_at migration:', e.message);
  }

  // Staff onboarding: role, employment_type, hourly_rate, onboarding_status, token, manager_id, etc.
  try {
    const addStaffCol = (col, def) => {
      const staffCols = db.prepare("PRAGMA table_info(staff)").all();
      if (!staffCols.some(c => c.name === col)) {
        try {
          db.exec(`ALTER TABLE staff ADD COLUMN ${col} ${def}`);
        } catch (e) {
          if (!e.message?.includes('duplicate column')) console.warn(`staff.${col} migration:`, e.message);
        }
      }
    };
    addStaffCol('role', 'TEXT');
    addStaffCol('employment_type', 'TEXT');
    addStaffCol('hourly_rate', 'REAL');
    addStaffCol('onboarding_status', 'TEXT');
    addStaffCol('onboarding_token', 'TEXT');
    addStaffCol('onboarding_token_expires_at', 'TEXT');
    addStaffCol('manager_id', 'TEXT REFERENCES staff(id)');
    addStaffCol('abn', 'TEXT');
    addStaffCol('address', 'TEXT');
    addStaffCol('date_of_birth', 'TEXT');
    addStaffCol('emergency_contact_name', 'TEXT');
    addStaffCol('emergency_contact_phone', 'TEXT');
    addStaffCol('shifter_worker_profile_id', 'TEXT');
    addStaffCol('availability_json', 'TEXT');
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('staff onboarding columns migration:', e.message);
  }

  // Staff onboarding tables (if not already in schema run)
  try {
    db.exec(`
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
      )
    `);
    db.exec(`
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
      )
    `);
    db.exec(`
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
      )
    `);
    db.exec(`
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
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_policy_files (
        id TEXT PRIMARY KEY,
        provider_profile_id TEXT,
        display_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_policy_acknowledgements (
        id TEXT PRIMARY KEY,
        staff_onboarding_id TEXT NOT NULL,
        policy_file_id TEXT,
        acknowledged_at TEXT DEFAULT (datetime('now')),
        signature_data TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (staff_onboarding_id) REFERENCES staff_onboarding(id) ON DELETE CASCADE,
        FOREIGN KEY (policy_file_id) REFERENCES company_policy_files(id) ON DELETE SET NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_certification_reminders (
        id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL,
        document_type TEXT NOT NULL,
        reminder_type TEXT NOT NULL,
        sent_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
      )
    `);
    try {
      const staffDocCols = db.prepare("PRAGMA table_info(staff_compliance_documents)").all();
      if (!staffDocCols.some((c) => c.name === 'onedrive_item_id')) {
        db.exec('ALTER TABLE staff_compliance_documents ADD COLUMN onedrive_item_id TEXT');
      }
      if (!staffDocCols.some((c) => c.name === 'onedrive_web_url')) {
        db.exec('ALTER TABLE staff_compliance_documents ADD COLUMN onedrive_web_url TEXT');
      }
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('staff_compliance_documents OneDrive migration:', e.message);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_renewal_tokens (
        id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_onboarding_staff ON staff_onboarding(staff_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_intake_fields_onboarding ON staff_intake_fields(staff_onboarding_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_compliance_documents_staff ON staff_compliance_documents(staff_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_compliance_documents_expiry ON staff_compliance_documents(expiry_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_company_policy_files_provider ON company_policy_files(provider_profile_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_certification_reminders_staff ON staff_certification_reminders(staff_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_renewal_tokens_token ON staff_renewal_tokens(token)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('staff onboarding tables migration:', e.message);
  }

  // Coordinator settings: per-user billing interval (15 min default), staff link for coordinators
  try {
    const userCols = db.prepare("PRAGMA table_info(users)").all();
    if (!userCols.some(c => c.name === 'billing_interval_minutes')) {
      db.exec('ALTER TABLE users ADD COLUMN billing_interval_minutes INTEGER DEFAULT 15');
    }
    if (!userCols.some(c => c.name === 'staff_id')) {
      db.exec('ALTER TABLE users ADD COLUMN staff_id TEXT REFERENCES staff(id)');
    }
    if (!userCols.some(c => c.name === 'signature_data')) {
      db.exec('ALTER TABLE users ADD COLUMN signature_data TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('users coordinator migration:', e.message);
  }

  // CRM roles: users.role, user_participants, delegate_grants
  try {
    const userCols = db.prepare("PRAGMA table_info(users)").all();
    if (!userCols.some(c => c.name === 'role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
      db.exec("UPDATE users SET role = 'admin' WHERE role IS NULL OR role = ''");
    }
    if (!userCols.some(c => c.name === 'org_id')) {
      db.exec('ALTER TABLE users ADD COLUMN org_id TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('users role migration:', e.message);
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_participants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, participant_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_participants_user ON user_participants(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_participants_participant ON user_participants(participant_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('user_participants migration:', e.message);
  }
  // staff_participants: assign participants to staff (support workers)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_participants (
        id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(staff_id, participant_id),
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_participants_staff ON staff_participants(staff_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_participants_participant ON staff_participants(participant_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('staff_participants migration:', e.message);
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delegate_grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        full_control INTEGER DEFAULT 1,
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_delegate_grants_user ON delegate_grants(user_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('delegate_grants migration:', e.message);
  }

  // Supabase auth linkage + participant tenancy (provider org)
  try {
    const uCols2 = db.prepare('PRAGMA table_info(users)').all();
    if (!uCols2.some((c) => c.name === 'auth_uid')) {
      db.exec('ALTER TABLE users ADD COLUMN auth_uid TEXT');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_auth_uid_unique ON users(auth_uid) WHERE auth_uid IS NOT NULL');
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('users auth_uid migration:', e.message);
  }
  try {
    const oCols = db.prepare('PRAGMA table_info(organisations)').all();
    if (!oCols.some((c) => c.name === 'owner_org_id')) {
      db.exec('ALTER TABLE organisations ADD COLUMN owner_org_id TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_organisations_owner_org ON organisations(owner_org_id)');
    // If we already have per-user org membership, seed ownership for legacy rows.
    const distinctUserOrgs = db
      .prepare('SELECT COUNT(DISTINCT org_id) AS c FROM users WHERE org_id IS NOT NULL')
      .get();
    if (distinctUserOrgs && distinctUserOrgs.c === 1) {
      const userOrg = db.prepare('SELECT org_id FROM users WHERE org_id IS NOT NULL LIMIT 1').get();
      if (userOrg?.org_id) {
        db.prepare('UPDATE organisations SET owner_org_id = ? WHERE owner_org_id IS NULL').run(userOrg.org_id);
        db.prepare('UPDATE staff SET org_id = ? WHERE org_id IS NULL').run(userOrg.org_id);
        db.prepare('UPDATE business_settings SET org_id = ? WHERE org_id IS NULL').run(userOrg.org_id);
      }
    }
    // Ensure provider organisation row self-owns when user/org ids are aligned.
    db.exec('UPDATE organisations SET owner_org_id = id WHERE owner_org_id IS NULL AND id IN (SELECT DISTINCT org_id FROM users WHERE org_id IS NOT NULL)');
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('organisations owner_org_id migration:', e.message);
  }
  try {
    const pCols2 = db.prepare('PRAGMA table_info(participants)').all();
    if (!pCols2.some((c) => c.name === 'provider_org_id')) {
      db.exec('ALTER TABLE participants ADD COLUMN provider_org_id TEXT REFERENCES organisations(id)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_participants_provider_org ON participants(provider_org_id)');
    const orgCountRow = db.prepare('SELECT COUNT(*) as c FROM organisations').get();
    if (orgCountRow && orgCountRow.c === 1) {
      const onlyOrg = db.prepare('SELECT id FROM organisations LIMIT 1').get();
      if (onlyOrg?.id) {
        db.prepare('UPDATE participants SET provider_org_id = ? WHERE provider_org_id IS NULL').run(onlyOrg.id);
      }
    }
    // Same tenant: multiple organisation rows (e.g. plan managers) but only one provider org on users — backfill legacy NULLs
    const distinctUserOrgs = db
      .prepare('SELECT COUNT(DISTINCT org_id) AS c FROM users WHERE org_id IS NOT NULL')
      .get();
    if (distinctUserOrgs && distinctUserOrgs.c === 1) {
      const userOrg = db.prepare('SELECT org_id FROM users WHERE org_id IS NOT NULL LIMIT 1').get();
      if (userOrg?.org_id) {
        const orgRow = db.prepare('SELECT id FROM organisations WHERE id = ?').get(userOrg.org_id);
        if (orgRow?.id) {
          db.prepare('UPDATE participants SET provider_org_id = ? WHERE provider_org_id IS NULL').run(userOrg.org_id);
        }
      }
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('participants provider_org_id migration:', e.message);
  }

  // Per-org Microsoft OneDrive (delegated): tokens + upload register
  try {
    db.exec(`
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
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('organization_onedrive_link migration:', e.message);
  }
} catch (err) {
  console.warn('Migration error:', err.message);
}
