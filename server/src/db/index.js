import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { seedNexusFormTemplateMastersIfNeeded } from '../services/nexusFormTemplateSeed.service.js';
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

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function ensureScheduleCoreTables() {
  if (!tableExists('shifts')) {
    db.exec(`
      CREATE TABLE shifts (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        staff_id TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        status TEXT DEFAULT 'scheduled',
        notes TEXT,
        roster_sent_at TEXT,
        recurring_group_id TEXT,
        expenses REAL DEFAULT 0,
        shifter_shift_id TEXT,
        line_items_locked INTEGER NOT NULL DEFAULT 0,
        billing_invoice_id TEXT,
        open_shift_broadcast_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL
      );
    `);
  }

  if (!tableExists('shift_line_items')) {
    db.exec(`
      CREATE TABLE shift_line_items (
        id TEXT PRIMARY KEY,
        shift_id TEXT NOT NULL,
        ndis_line_item_id TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit_price REAL NOT NULL,
        claim_type TEXT DEFAULT 'standard',
        FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
        FOREIGN KEY (ndis_line_item_id) REFERENCES ndis_line_items(id)
      );
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shifts_participant ON shifts(participant_id);
    CREATE INDEX IF NOT EXISTS idx_shifts_staff ON shifts(staff_id);
    CREATE INDEX IF NOT EXISTS idx_shifts_start ON shifts(start_time);
    CREATE INDEX IF NOT EXISTS idx_shifts_recurring_group ON shifts(recurring_group_id);
    CREATE INDEX IF NOT EXISTS idx_shifts_shifter_shift_id ON shifts(shifter_shift_id);
    CREATE INDEX IF NOT EXISTS idx_shift_line_items_shift ON shift_line_items(shift_id);
  `);
}

try {
  ensureScheduleCoreTables();
} catch (err) {
  console.warn('Could not ensure schedule core tables:', err.message);
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
  addParticipantCol('default_billing_category', 'TEXT');
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
  const shiftColsLock = db.prepare('PRAGMA table_info(shifts)').all();
  if (!shiftColsLock.some((c) => c.name === 'line_items_locked')) {
    try {
      db.exec('ALTER TABLE shifts ADD COLUMN line_items_locked INTEGER NOT NULL DEFAULT 0');
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('shifts.line_items_locked migration:', e.message);
    }
  }
  const shiftColsOpen = db.prepare('PRAGMA table_info(shifts)').all();
  if (!shiftColsOpen.some((c) => c.name === 'open_shift_broadcast_at')) {
    try {
      db.exec('ALTER TABLE shifts ADD COLUMN open_shift_broadcast_at TEXT');
    } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('shifts.open_shift_broadcast_at migration:', e.message);
    }
  }
  // Allow open shifts (participant only, no staff yet)
  try {
    const staffCol = db.prepare('PRAGMA table_info(shifts)').all().find((c) => c.name === 'staff_id');
    if (staffCol?.notnull === 1) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        CREATE TABLE shifts_open_migration (
          id TEXT PRIMARY KEY,
          participant_id TEXT NOT NULL,
          staff_id TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          status TEXT DEFAULT 'scheduled',
          notes TEXT,
          roster_sent_at TEXT,
          recurring_group_id TEXT,
          expenses REAL DEFAULT 0,
          shifter_shift_id TEXT,
          line_items_locked INTEGER NOT NULL DEFAULT 0,
          billing_invoice_id TEXT,
          open_shift_broadcast_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
          FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL
        );
        INSERT INTO shifts_open_migration (
          id, participant_id, staff_id, start_time, end_time, status, notes,
          roster_sent_at, recurring_group_id, expenses, shifter_shift_id,
          line_items_locked, billing_invoice_id, open_shift_broadcast_at, created_at, updated_at
        )
        SELECT
          id, participant_id, staff_id, start_time, end_time, status, notes,
          roster_sent_at, recurring_group_id, expenses, shifter_shift_id,
          line_items_locked, billing_invoice_id, open_shift_broadcast_at, created_at, updated_at
        FROM shifts;
        DROP TABLE shifts;
        ALTER TABLE shifts_open_migration RENAME TO shifts;
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_shifts_participant ON shifts(participant_id);
        CREATE INDEX IF NOT EXISTS idx_shifts_staff ON shifts(staff_id);
        CREATE INDEX IF NOT EXISTS idx_shifts_start ON shifts(start_time);
        CREATE INDEX IF NOT EXISTS idx_shifts_recurring_group ON shifts(recurring_group_id);
        CREATE INDEX IF NOT EXISTS idx_shifts_shifter_shift_id ON shifts(shifter_shift_id);
      `);
      db.exec('PRAGMA foreign_keys = ON');
    }
  } catch (e) {
    console.warn('shifts nullable staff_id migration:', e.message);
    try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS open_shift_recipients (
        shift_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        notified_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (shift_id, staff_id),
        FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_open_shift_recipients_shift ON open_shift_recipients(shift_id);
    `);
  } catch (e) {
    if (!/already exists|duplicate table/i.test(String(e.message || ''))) {
      console.warn('open_shift_recipients migration:', e.message);
    }
  }
  // Prevent re-importing the same external shift after hard-delete (Excel / Shifter pull)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shift_import_suppressed_shifter_ids (
        nexus_org_id TEXT NOT NULL,
        shifter_shift_id TEXT NOT NULL,
        reason TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (nexus_org_id, shifter_shift_id)
      );
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_shift_import_supp_shifter_id ON shift_import_suppressed_shifter_ids(shifter_shift_id);',
    );
  } catch (e) {
    if (!/already exists|duplicate table/i.test(String(e.message || ''))) {
      console.warn('shift_import_suppressed_shifter_ids migration:', e.message);
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
    if (!userCols.some(c => c.name === 'active_session_id')) {
      db.exec('ALTER TABLE users ADD COLUMN active_session_id TEXT');
    }
    if (!userCols.some(c => c.name === 'active_session_started_at')) {
      db.exec('ALTER TABLE users ADD COLUMN active_session_started_at TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('users migration:', e.message);
  }

  // case_notes.shift_id: mirror completed shift session notes into case notes (quarterly reporting / CRM)
  try {
    const cnCols = db.prepare('PRAGMA table_info(case_notes)').all();
    if (cnCols.length && !cnCols.some((c) => c.name === 'shift_id')) {
      db.exec('ALTER TABLE case_notes ADD COLUMN shift_id TEXT');
    }
    if (cnCols.length) {
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_case_notes_shift_id ON case_notes(shift_id) WHERE shift_id IS NOT NULL'
      );
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('case_notes.shift_id migration:', e.message);
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

  // Drop legacy Adobe Sign columns left over from earlier installs. SQLite ≥ 3.35
  // supports DROP COLUMN; on older versions this is a no-op (the columns just stay
  // dormant, since no code reads or writes them anymore).
  try {
    const ppCols = new Set(db.prepare('PRAGMA table_info(provider_profiles)').all().map((c) => c.name));
    if (ppCols.has('adobe_template_set_id')) {
      try { db.exec('ALTER TABLE provider_profiles DROP COLUMN adobe_template_set_id'); } catch { /* old sqlite */ }
    }
    const ftCols = new Set(db.prepare('PRAGMA table_info(form_templates)').all().map((c) => c.name));
    if (ftCols.has('adobe_template_id')) {
      try { db.exec('ALTER TABLE form_templates DROP COLUMN adobe_template_id'); } catch { /* old sqlite */ }
    }
    const bsCols = new Set(db.prepare('PRAGMA table_info(business_settings)').all().map((c) => c.name));
    for (const legacy of [
      'adobe_sign_refresh_token',
      'adobe_sign_api_access_point',
      'adobe_sign_web_access_point',
      'dropbox_sign_access_token',
      'dropbox_sign_refresh_token'
    ]) {
      if (bsCols.has(legacy)) {
        try { db.exec(`ALTER TABLE business_settings DROP COLUMN ${legacy}`); } catch { /* old sqlite */ }
      }
    }
  } catch (e) {
    console.warn('adobe-sign column cleanup migration:', e?.message);
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
        provider_name TEXT DEFAULT 'native',
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
        provider_name TEXT DEFAULT 'native',
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

  // envelope_id deliberately has no FK to signature_envelopes: the library-master send path
  // (branded onboarding-pack documents, including staff onboarding which has no participant_id)
  // never creates a signature_envelopes row — envelope_id is just a grouping key there. Rows
  // sent via createEnvelopeRecords (the primary /send-form, /send-signatures paths) do have a
  // matching signature_envelopes row, looked up by id when present.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS signature_envelope_documents (
        id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL,
        org_id TEXT,
        form_instance_id TEXT,
        display_name TEXT,
        document_path TEXT NOT NULL,
        signing_layout_json TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (form_instance_id) REFERENCES participant_form_instances(id) ON DELETE SET NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_signature_envelope_documents_envelope ON signature_envelope_documents(envelope_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('signature_envelope_documents migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS signature_envelope_signers (
        id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL,
        name TEXT,
        email TEXT,
        role TEXT,
        sequence INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        token_hash TEXT NOT NULL UNIQUE,
        values_json TEXT,
        signature_data TEXT,
        consent_given INTEGER DEFAULT 0,
        sent_at TEXT,
        viewed_at TEXT,
        signed_at TEXT,
        declined_at TEXT,
        decline_reason TEXT,
        source_ip TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_signature_envelope_signers_envelope ON signature_envelope_signers(envelope_id, sequence)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signature_envelope_signers_token ON signature_envelope_signers(token_hash)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('signature_envelope_signers migration:', e.message);
  }

  // envelope_id deliberately has no FK to signature_envelopes, for the same reason as
  // signature_envelope_documents above: staff-only envelopes (library-master sends and the
  // custom-staff-template send path) never create a signature_envelopes row.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_signature_envelopes (
        id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL UNIQUE,
        staff_id TEXT NOT NULL,
        org_id TEXT,
        form_template_id TEXT,
        display_name TEXT,
        status TEXT DEFAULT 'sent',
        sent_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        signed_document_path TEXT,
        certificate_document_path TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_signature_envelopes_staff ON staff_signature_envelopes(staff_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_signature_envelopes_envelope ON staff_signature_envelopes(envelope_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('staff_signature_envelopes migration:', e.message);
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
      CREATE TABLE IF NOT EXISTS incident_register_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id TEXT NOT NULL,
        incident_date TEXT,
        participant_id INTEGER REFERENCES participants(id),
        staff_id INTEGER REFERENCES staff(id),
        location TEXT,
        description TEXT,
        immediate_actions TEXT,
        follow_up TEXT,
        reported_by TEXT,
        reported_to TEXT,
        outcome TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_incident_register_entries_org ON incident_register_entries(org_id, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_incident_register_entries_date ON incident_register_entries(incident_date);
    `);
    const incidentCols = db.prepare('PRAGMA table_info(incident_register_entries)').all();
    if (!incidentCols.some((c) => c.name === 'deleted_at')) {
      db.exec('ALTER TABLE incident_register_entries ADD COLUMN deleted_at TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('incident_register_entries migration:', e.message);
  }

  // Per-cell manual edits layered on top of the derived register snapshots so the
  // auto-generated registers (staff compliance, participants, etc.) are editable in-app
  // without mutating the underlying operational records.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS register_cell_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id TEXT NOT NULL,
        view_id TEXT NOT NULL,
        row_key TEXT NOT NULL,
        col_index INTEGER NOT NULL,
        value TEXT,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(org_id, view_id, row_key, col_index)
      );
      CREATE INDEX IF NOT EXISTS idx_register_cell_overrides_lookup ON register_cell_overrides(org_id, view_id);
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('register_cell_overrides migration:', e.message);
  }

  // Per-org which registers appear in the live Registers UI and whether inline editing is enabled.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_register_settings (
        org_id TEXT NOT NULL,
        view_id TEXT NOT NULL,
        visible INTEGER NOT NULL DEFAULT 0,
        editable INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (org_id, view_id)
      );
      CREATE INDEX IF NOT EXISTS idx_org_register_settings_org ON org_register_settings(org_id);
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('org_register_settings migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS register_onedrive_sheet_cache (
        org_id TEXT NOT NULL,
        sheet_key TEXT NOT NULL,
        rows_json TEXT NOT NULL DEFAULT '[]',
        imported_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (org_id, sheet_key)
      );
      CREATE INDEX IF NOT EXISTS idx_register_onedrive_sheet_cache_org ON register_onedrive_sheet_cache(org_id);
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('register_onedrive_sheet_cache migration:', e.message);
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
    let biVoidCols = db.prepare('PRAGMA table_info(billing_invoices)').all();
    if (!biVoidCols.some((c) => c.name === 'voided_at')) {
      db.exec('ALTER TABLE billing_invoices ADD COLUMN voided_at TEXT');
    }
    biVoidCols = db.prepare('PRAGMA table_info(billing_invoices)').all();
    if (!biVoidCols.some((c) => c.name === 'void_reason')) {
      db.exec('ALTER TABLE billing_invoices ADD COLUMN void_reason TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('billing_invoices void columns migration:', e.message);
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
    for (const col of [
      // Org-specific pay period anchor date (yyyy-mm-dd). If null, fallback to DEFAULT_PAY_PERIOD_START in shiftHours.service.js.
      'pay_period_start',
      'xero_client_id',
      'xero_client_secret',
      'xero_redirect_uri',
      'xero_refresh_token',
      'xero_tenant_id',
      'xero_tenant_name',
      // Per-org Xero invoice line settings (sales account code + GST/exempt tax types). Falls
      // back to XERO_SALES_ACCOUNT_CODE/XERO_LINE_TAX_TYPE_GST/XERO_LINE_TAX_TYPE_EXEMPT env vars
      // when unset, so existing orgs are unaffected. See xeroBillingPush.service.js.
      'xero_sales_account_code',
      'xero_tax_type_gst',
      'xero_tax_type_exempt'
    ]) {
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
    addStaffCol('pay_rates_json', 'TEXT');
    addStaffCol('pay_frequency', 'TEXT');
    addStaffCol('governing_state', 'TEXT');
    addStaffCol('supervisor_name', 'TEXT');
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
        display_name TEXT,
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
      if (!staffDocCols.some((c) => c.name === 'display_name')) {
        db.exec('ALTER TABLE staff_compliance_documents ADD COLUMN display_name TEXT');
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

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_document_packs (
        id TEXT PRIMARY KEY,
        provider_profile_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        workflow TEXT NOT NULL DEFAULT 'both',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_document_packs_provider ON onboarding_document_packs(provider_profile_id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_document_pack_items (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        policy_file_id TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        FOREIGN KEY (pack_id) REFERENCES onboarding_document_packs(id) ON DELETE CASCADE,
        FOREIGN KEY (policy_file_id) REFERENCES company_policy_files(id) ON DELETE CASCADE,
        UNIQUE(pack_id, policy_file_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_pack_items_pack ON onboarding_document_pack_items(pack_id)');

    const ppCols = db.prepare('PRAGMA table_info(provider_profiles)').all();
    if (!ppCols.some((c) => c.name === 'default_staff_onboarding_pack_id')) {
      db.exec('ALTER TABLE provider_profiles ADD COLUMN default_staff_onboarding_pack_id TEXT');
    }
    if (!ppCols.some((c) => c.name === 'default_participant_onboarding_pack_id')) {
      db.exec('ALTER TABLE provider_profiles ADD COLUMN default_participant_onboarding_pack_id TEXT');
    }

    const soCols = db.prepare('PRAGMA table_info(staff_onboarding)').all();
    if (!soCols.some((c) => c.name === 'document_pack_id')) {
      db.exec('ALTER TABLE staff_onboarding ADD COLUMN document_pack_id TEXT');
    }

    const poCols = db.prepare('PRAGMA table_info(participant_onboarding)').all();
    if (!poCols.some((c) => c.name === 'document_pack_id')) {
      db.exec('ALTER TABLE participant_onboarding ADD COLUMN document_pack_id TEXT');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_document_pack_form_items (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        form_template_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (pack_id) REFERENCES onboarding_document_packs(id) ON DELETE CASCADE,
        FOREIGN KEY (form_template_id) REFERENCES form_templates(id) ON DELETE CASCADE,
        UNIQUE(pack_id, form_template_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pack_form_items_pack ON onboarding_document_pack_form_items(pack_id)');
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('onboarding_document_packs migration:', e.message);
  }

  // Link participant custom form_templates to provider_required_forms (for generateFormPack)
  try {
    const orphans = db
      .prepare(
        `
      SELECT ft.id AS id, ft.provider_profile_id AS provider_profile_id
      FROM form_templates ft
      WHERE ft.form_type = 'custom'
        AND (ft.workflow = 'participant_onboarding' OR ft.workflow IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM provider_required_forms prf
          WHERE prf.form_template_id = ft.id AND prf.provider_profile_id = ft.provider_profile_id
        )
    `
      )
      .all();
    const ins = db.prepare(`
      INSERT INTO provider_required_forms (id, provider_profile_id, form_template_id, is_required)
      VALUES (?, ?, ?, 1)
    `);
    for (const row of orphans) {
      ins.run(randomUUID(), row.provider_profile_id, row.id);
    }
    if (orphans.length) console.log(`[nexus] Backfilled provider_required_forms for ${orphans.length} participant custom form(s).`);
  } catch (e) {
    if (!e.message?.includes('no such table')) console.warn('provider_required_forms custom backfill:', e.message);
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
    if (!userCols.some((c) => c.name === 'ollama_local_base_url')) {
      db.exec('ALTER TABLE users ADD COLUMN ollama_local_base_url TEXT');
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
    let oColsProd = db.prepare('PRAGMA table_info(organisations)').all();
    if (!oColsProd.some((c) => c.name === 'coordination_enabled')) {
      db.exec('ALTER TABLE organisations ADD COLUMN coordination_enabled INTEGER DEFAULT 0');
    }
    oColsProd = db.prepare('PRAGMA table_info(organisations)').all();
    if (!oColsProd.some((c) => c.name === 'agency_enabled')) {
      db.exec('ALTER TABLE organisations ADD COLUMN agency_enabled INTEGER DEFAULT 1');
    }
    db.exec(`
      UPDATE organisations
      SET coordination_enabled = COALESCE(coordination_enabled, 0),
          agency_enabled = CASE WHEN agency_enabled IS NULL THEN 1 ELSE agency_enabled END
      WHERE id = owner_org_id
    `);
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('organisations product flags migration:', e.message);
  }
  try {
    let oColsOpenAi = db.prepare('PRAGMA table_info(organisations)').all();
    if (!oColsOpenAi.some((c) => c.name === 'openai_api_key')) {
      db.exec('ALTER TABLE organisations ADD COLUMN openai_api_key TEXT');
    }
    oColsOpenAi = db.prepare('PRAGMA table_info(organisations)').all();
    if (!oColsOpenAi.some((c) => c.name === 'openai_model')) {
      db.exec("ALTER TABLE organisations ADD COLUMN openai_model TEXT DEFAULT 'gpt-4o-mini'");
    }
    oColsOpenAi = db.prepare('PRAGMA table_info(organisations)').all();
    if (!oColsOpenAi.some((c) => c.name === 'openai_base_url')) {
      db.exec('ALTER TABLE organisations ADD COLUMN openai_base_url TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('organisations openai_* migration:', e.message);
  }
  try {
    let uColsProd = db.prepare('PRAGMA table_info(users)').all();
    if (!uColsProd.some((c) => c.name === 'coordination_access')) {
      db.exec('ALTER TABLE users ADD COLUMN coordination_access INTEGER DEFAULT 1');
    }
    uColsProd = db.prepare('PRAGMA table_info(users)').all();
    if (!uColsProd.some((c) => c.name === 'agency_access')) {
      db.exec('ALTER TABLE users ADD COLUMN agency_access INTEGER DEFAULT 1');
    }
    db.exec(`
      UPDATE users SET
        coordination_access = COALESCE(
          (SELECT o.coordination_enabled FROM organisations o WHERE o.id = users.org_id AND o.owner_org_id = o.id),
          coordination_access,
          0
        ),
        agency_access = COALESCE(
          (SELECT o.agency_enabled FROM organisations o WHERE o.id = users.org_id AND o.owner_org_id = o.id),
          agency_access,
          1
        )
      WHERE org_id IS NOT NULL
    `);
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('users product access migration:', e.message);
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

  // Phase 1: Universal org profile fields used by every document/register renderer.
  // Stored on `organisations` so getOrgRenderContext can build one canonical object.
  try {
    const orgProfileCols = [
      ['legal_name', 'TEXT'],
      ['trading_name', 'TEXT'],
      ['acn', 'TEXT'],
      ['postal_address', 'TEXT'],
      ['street_address', 'TEXT'],
      ['logo_path', 'TEXT'],
      ['primary_contact_name', 'TEXT'],
      ['primary_contact_role', 'TEXT'],
      ['primary_contact_email', 'TEXT'],
      ['primary_contact_phone', 'TEXT'],
      ['default_signatory_name', 'TEXT'],
      ['default_signatory_role', 'TEXT'],
      ['default_signatory_email', 'TEXT'],
      ['bank_name', 'TEXT'],
      ['bsb', 'TEXT'],
      ['account_name', 'TEXT'],
      ['account_number', 'TEXT'],
      ['xero_short_code', 'TEXT'],
      ['brand_primary_color', 'TEXT'],
      ['brand_accent_color', 'TEXT'],
      ['letterhead_footer_text', 'TEXT'],
      ['setup_completed_at', 'TEXT']
    ];
    const existing = db.prepare('PRAGMA table_info(organisations)').all();
    const existingNames = new Set(existing.map((c) => c.name));
    for (const [name, type] of orgProfileCols) {
      if (!existingNames.has(name)) {
        db.exec(`ALTER TABLE organisations ADD COLUMN ${name} ${type}`);
      }
    }
  } catch (e) {
    if (!e.message?.includes('duplicate column')) console.warn('organisations profile fields migration:', e.message);
  }

  // Phase 7: NDIS Practice Standards mapping. Pre-seeded reference of each standard +
  // sub-element, with a join row per (org, standard) so the compliance dashboard can
  // surface evidence pointers (policy slug + register slug + last review date).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ndis_practice_standards (
        id TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        standard_code TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        intent TEXT,
        evidence_required_json TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ndis_practice_standards_module ON ndis_practice_standards(module);

      CREATE TABLE IF NOT EXISTS org_practice_standard_status (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        standard_id TEXT NOT NULL,
        evidence_policy_slug TEXT,
        evidence_register_slug TEXT,
        last_reviewed_at TEXT,
        review_due_at TEXT,
        status TEXT DEFAULT 'unreviewed',
        notes TEXT,
        updated_by_user_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(organisation_id, standard_id),
        FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE,
        FOREIGN KEY (standard_id) REFERENCES ndis_practice_standards(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_org_practice_status_org ON org_practice_standard_status(organisation_id);
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('practice standards migration:', e.message);
  }

  // Phase 4: Public participant self-service intake tokens. Each row issues a unique URL
  // that the participant follows to fill in their own details before a coordinator runs
  // onboarding. Tokens are single-use and expire; we store a hash, never the raw value.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS participant_intake_tokens (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        organisation_id TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        issued_by_user_id TEXT,
        issued_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        completed_at TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
        FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_participant_intake_tokens_participant ON participant_intake_tokens(participant_id);
      CREATE INDEX IF NOT EXISTS idx_participant_intake_tokens_status ON participant_intake_tokens(status, expires_at);
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('participant_intake_tokens migration:', e.message);
  }

  // Phase 1: Document library master registry — tracks file-based templates dropped into
  // data/forms/templates/library/<slug>/ so each org gets a per-org clone with branding.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_library_masters (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        category TEXT,
        form_type TEXT NOT NULL,
        engine TEXT NOT NULL,
        version TEXT NOT NULL,
        template_file_path TEXT NOT NULL,
        placeholders_json TEXT,
        manifest_json TEXT,
        required_signer_role TEXT,
        renewal_days INTEGER,
        is_active INTEGER DEFAULT 1,
        last_synced_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_document_library_masters_slug ON document_library_masters(slug);
      CREATE INDEX IF NOT EXISTS idx_document_library_masters_form_type ON document_library_masters(form_type);

      CREATE TABLE IF NOT EXISTS document_library_org_clones (
        id TEXT PRIMARY KEY,
        master_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        provider_profile_id TEXT,
        form_template_id TEXT,
        variable_overrides_json TEXT,
        override_mode TEXT NOT NULL DEFAULT 'inherit',
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(master_id, org_id),
        FOREIGN KEY (master_id) REFERENCES document_library_masters(id) ON DELETE CASCADE,
        FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_document_library_org_clones_org ON document_library_org_clones(org_id);

      CREATE TABLE IF NOT EXISTS document_library_org_section_overrides (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        master_id TEXT NOT NULL,
        section_key TEXT NOT NULL,
        content_html TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT,
        UNIQUE(org_id, master_id, section_key),
        FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
        FOREIGN KEY (master_id) REFERENCES document_library_masters(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_document_library_org_section_overrides_org_master
        ON document_library_org_section_overrides(org_id, master_id);
    `);
    const dlmCols = db.prepare('PRAGMA table_info(document_library_masters)').all();
    if (!dlmCols.some((c) => c.name === 'sections_json')) {
      db.exec('ALTER TABLE document_library_masters ADD COLUMN sections_json TEXT');
    }
    const dlocCols = db.prepare('PRAGMA table_info(document_library_org_clones)').all();
    if (!dlocCols.some((c) => c.name === 'override_mode')) {
      db.exec("ALTER TABLE document_library_org_clones ADD COLUMN override_mode TEXT NOT NULL DEFAULT 'inherit'");
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('document library migration:', e.message);
  }

  // Per-org mapping of library masters to send stages (participant_intake, participant_sa, staff_intake, staff_contract)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_library_send_stages (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        master_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(org_id, master_id, stage),
        FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
        FOREIGN KEY (master_id) REFERENCES document_library_masters(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_org_library_send_stages_org_stage ON org_library_send_stages(org_id, stage);
    `);
    // Seed defaults for any org that has library clones but no send stages yet
    const STAGE_DEFAULTS = {
      participant_intake: ['client-induction-checklist', 'privacy-consent-form'],
      participant_sa:     ['service-schedule'],
      staff_intake:       ['staff-induction-checklist', 'worker-declarations', 'pre-employment-collection-form'],
      staff_contract:     []
    };
    const orgsWithClones = db.prepare(
      `SELECT DISTINCT org_id FROM document_library_org_clones WHERE is_active = 1`
    ).all();
    const insertStage = db.prepare(
      `INSERT OR IGNORE INTO org_library_send_stages (id, org_id, master_id, stage) VALUES (?, ?, ?, ?)`
    );
    for (const { org_id } of orgsWithClones) {
      const existing = db.prepare(`SELECT COUNT(*) AS n FROM org_library_send_stages WHERE org_id = ?`).get(org_id);
      if (existing.n > 0) continue;
      for (const [stage, slugs] of Object.entries(STAGE_DEFAULTS)) {
        for (const slug of slugs) {
          const m = db.prepare(`SELECT id FROM document_library_masters WHERE slug = ? AND is_active = 1`).get(slug);
          if (m) insertStage.run(randomUUID(), org_id, m.id, stage);
        }
      }
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('org_library_send_stages migration:', e.message);
  }

  // Nexus structured form templates (masters + org clones + generated PDF snapshots)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS nexus_form_template_masters (
        id TEXT PRIMARY KEY,
        template_key TEXT NOT NULL UNIQUE,
        template_type TEXT NOT NULL,
        title TEXT NOT NULL,
        version_label TEXT,
        definition_json TEXT NOT NULL,
        variable_schema_json TEXT NOT NULL,
        branding_slots_json TEXT,
        variable_slots_json TEXT,
        sections_json TEXT,
        page_layout_json TEXT,
        category TEXT DEFAULT 'custom',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS nexus_org_form_templates (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        master_id TEXT NOT NULL,
        label TEXT,
        variable_values_json TEXT,
        branding_json TEXT,
        branding_slots_json TEXT,
        variable_slots_json TEXT,
        sections_json TEXT,
        page_layout_json TEXT,
        category TEXT DEFAULT 'custom',
        metadata_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
        FOREIGN KEY (master_id) REFERENCES nexus_form_template_masters(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_nexus_org_form_templates_org ON nexus_org_form_templates(org_id);
      CREATE INDEX IF NOT EXISTS idx_nexus_org_form_templates_master ON nexus_org_form_templates(master_id);
      CREATE TABLE IF NOT EXISTS nexus_generated_form_documents (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        org_template_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'generated',
        snapshot_json TEXT NOT NULL,
        pdf_relative_path TEXT,
        onedrive_item_id TEXT,
        onedrive_web_url TEXT,
        generated_by_user_id TEXT,
        generated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
        FOREIGN KEY (org_template_id) REFERENCES nexus_org_form_templates(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_nexus_generated_org_participant ON nexus_generated_form_documents(org_id, participant_id);
      CREATE INDEX IF NOT EXISTS idx_nexus_generated_participant ON nexus_generated_form_documents(participant_id);
    `);
    const addNexusCol = (table, col, def) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    };
    for (const [col, def] of [
      ['branding_slots_json', 'TEXT'],
      ['variable_slots_json', 'TEXT'],
      ['sections_json', 'TEXT'],
      ['page_layout_json', 'TEXT'],
      ['category', "TEXT DEFAULT 'custom'"]
    ]) {
      addNexusCol('nexus_form_template_masters', col, def);
      addNexusCol('nexus_org_form_templates', col, def);
    }
    try {
      db.prepare(
        `UPDATE nexus_form_template_masters
         SET template_key = 'service_agreement_standard_v3',
             title = 'Standard NDIS Services Agreement (Version 3 structure)',
             category = CASE WHEN category IS NULL OR category = 'custom' THEN 'service_agreement' ELSE category END
         WHERE template_key = 'service_agreement_spring2_v3'`
      ).run();
    } catch (e) {
      if (!e.message?.includes('no such table')) console.warn('nexus_form_template master rename:', e.message);
    }
    const seedResult = seedNexusFormTemplateMastersIfNeeded(db);
    if (seedResult?.seeded) {
      console.log('[nexus] Seeded default Service Agreement master template:', seedResult.master_id);
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('nexus_form_template migration:', e.message);
  }

  // Company documents library (per-org bulk upload + OneDrive import)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_company_documents (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'policy',
        engine TEXT NOT NULL DEFAULT 'static-pdf',
        template_filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'upload',
        library_master_id TEXT,
        onedrive_item_id TEXT,
        onedrive_path TEXT,
        sync_to_onboarding INTEGER DEFAULT 0,
        company_policy_file_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(org_id, slug),
        FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
        FOREIGN KEY (library_master_id) REFERENCES document_library_masters(id) ON DELETE SET NULL,
        FOREIGN KEY (company_policy_file_id) REFERENCES company_policy_files(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_org_company_documents_org ON org_company_documents(org_id);
      CREATE INDEX IF NOT EXISTS idx_org_company_documents_master ON org_company_documents(library_master_id);
    `);
    const cpfCols = db.prepare('PRAGMA table_info(company_policy_files)').all();
    if (!cpfCols.some((c) => c.name === 'org_company_document_id')) {
      db.exec('ALTER TABLE company_policy_files ADD COLUMN org_company_document_id TEXT');
    }
    const odCols = db.prepare('PRAGMA table_info(organization_onedrive_link)').all();
    if (odCols.length) {
      if (!odCols.some((c) => c.name === 'import_source_path')) {
        db.exec('ALTER TABLE organization_onedrive_link ADD COLUMN import_source_path TEXT');
      }
      if (!odCols.some((c) => c.name === 'import_enabled')) {
        db.exec('ALTER TABLE organization_onedrive_link ADD COLUMN import_enabled INTEGER DEFAULT 0');
      }
      if (!odCols.some((c) => c.name === 'import_last_synced_at')) {
        db.exec('ALTER TABLE organization_onedrive_link ADD COLUMN import_last_synced_at TEXT');
      }
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('org_company_documents migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_risk_assessment_templates (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        stored_filename TEXT NOT NULL,
        is_default_blank INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_activity_risk_templates_org
        ON activity_risk_assessment_templates(organisation_id);
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('activity_risk_assessment_templates migration:', e.message);
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_risk_assessment_records (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        title TEXT NOT NULL,
        field_values_json TEXT NOT NULL DEFAULT '{}',
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES activity_risk_assessment_templates(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_activity_risk_records_org
        ON activity_risk_assessment_records(organisation_id);
      CREATE INDEX IF NOT EXISTS idx_activity_risk_records_template
        ON activity_risk_assessment_records(template_id);
    `);
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('activity_risk_assessment_records migration:', e.message);
  }

  try {
    const riskRecordCols = db.prepare('PRAGMA table_info(activity_risk_assessment_records)').all();
    if (!riskRecordCols.some((c) => c.name === 'admin_signed_at')) {
      db.exec('ALTER TABLE activity_risk_assessment_records ADD COLUMN admin_signed_at TEXT');
    }
    if (!riskRecordCols.some((c) => c.name === 'admin_signed_by_user_id')) {
      db.exec('ALTER TABLE activity_risk_assessment_records ADD COLUMN admin_signed_by_user_id TEXT');
    }
    if (!riskRecordCols.some((c) => c.name === 'admin_signature_data')) {
      db.exec('ALTER TABLE activity_risk_assessment_records ADD COLUMN admin_signature_data TEXT');
    }
    if (!riskRecordCols.some((c) => c.name === 'signature_envelope_id')) {
      db.exec('ALTER TABLE activity_risk_assessment_records ADD COLUMN signature_envelope_id TEXT');
    }
    if (!riskRecordCols.some((c) => c.name === 'signed_document_path')) {
      db.exec('ALTER TABLE activity_risk_assessment_records ADD COLUMN signed_document_path TEXT');
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('activity_risk_records admin sign migration:', e.message);
  }

  // One-time data correction: a shift whose date is still in the future can never have been
  // delivered, so it must not sit as 'completed' (and must not carry charges). Earlier imports
  // marked future roster shifts completed when Shifter sent a completed-like status. Reset those
  // back to 'scheduled' and clear their auto-built charges. Only touches future shifts with NO
  // delivery evidence (no notes/expenses/progress note), and never billed, admin-completed, or
  // coordinator-curated shifts. Idempotent (safe to run every startup).
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Inline of shiftCompletionEvidenceSql('s') (lib/shiftBillingEligibility.js) — kept inline to
    // avoid importing app libs into the db bootstrap.
    const hasEvidenceSql = `(
      s.status = 'completed_by_admin'
      OR s.line_items_locked = 1
      OR (s.notes IS NOT NULL AND TRIM(s.notes) <> '')
      OR (s.expenses IS NOT NULL AND s.expenses > 0)
      OR EXISTS (
        SELECT 1 FROM progress_notes pn
        WHERE pn.shift_id = s.id
          AND (
            (pn.session_details IS NOT NULL AND TRIM(pn.session_details) <> '')
            OR (pn.mood IS NOT NULL AND TRIM(pn.mood) <> '')
            OR (pn.incidents IS NOT NULL AND TRIM(pn.incidents) <> '')
            OR (pn.travel_km IS NOT NULL AND pn.travel_km > 0)
            OR (pn.travel_time_min IS NOT NULL AND pn.travel_time_min > 0)
          )
      )
    )`;
    const futureCompleted = db
      .prepare(
        `SELECT s.id, s.line_items_locked
         FROM shifts s
         WHERE LOWER(COALESCE(s.status, '')) = 'completed'
           AND (s.billing_invoice_id IS NULL OR s.billing_invoice_id = '')
           AND NOT ${hasEvidenceSql}
           AND substr(REPLACE(s.start_time, ' ', 'T'), 1, 10) > ?`
      )
      .all(today);
    if (futureCompleted.length) {
      const clearLines = db.prepare('DELETE FROM shift_line_items WHERE shift_id = ?');
      const setScheduled = db.prepare(
        `UPDATE shifts SET status = 'scheduled', updated_at = datetime('now') WHERE id = ?`
      );
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          if (Number(r.line_items_locked) !== 1) clearLines.run(r.id);
          setScheduled.run(r.id);
        }
      });
      tx(futureCompleted);
      console.log(`[migration] reset ${futureCompleted.length} future-dated shift(s) from completed back to scheduled`);
    }
  } catch (e) {
    console.warn('future-completed shift correction:', e.message);
  }
} catch (err) {
  console.warn('Migration error:', err.message);
}
