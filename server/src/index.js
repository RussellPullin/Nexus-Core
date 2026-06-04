import { config } from 'dotenv';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { mkdirSync, existsSync, readFileSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import fileStoreFactory from 'session-file-store';

// Load .env from project root (parent of server/) so config works regardless of cwd
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../..');
const envPath = join(projectRoot, '.env');
config({ path: envPath, override: true });
// Optional second file (does not override keys already set — e.g. host injects secrets, root .env has the rest)
config({ path: join(projectRoot, 'server', '.env'), override: false });
config({ path: join(process.cwd(), '.env'), override: false });

// Fallback: dotenv can fail to parse some lines (quotes, # in values, etc.). Read keys from .env directly.
function loadEnvKeyFromFile(key, label) {
  if (process.env[key]) return;
  const tryPaths = [envPath, join(process.cwd(), '.env')];
  for (const p of tryPaths) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${escaped}\\s*=\\s*(.+)`, 'm');
      const m = raw.match(re);
      if (!m) continue;
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      const hash = v.indexOf('#');
      if (hash >= 0 && !v.slice(0, hash).includes('"')) v = v.slice(0, hash).trim();
      if (v) {
        process.env[key] = v;
        console.log(`[nexus] ${label || key} loaded from fallback read:`, p);
        break;
      }
    } catch (e) {
      console.warn('[nexus] Fallback read failed:', p, e?.message);
    }
  }
}

loadEnvKeyFromFile('CRM_API_KEY', 'CRM_API_KEY');
loadEnvKeyFromFile('ONEDRIVE_ADMIN_USER_ID', 'ONEDRIVE_ADMIN_USER_ID');
loadEnvKeyFromFile('AZURE_TENANT_ID', 'AZURE_TENANT_ID');
loadEnvKeyFromFile('AZURE_CLIENT_ID', 'AZURE_CLIENT_ID');
loadEnvKeyFromFile('AZURE_CLIENT_SECRET', 'AZURE_CLIENT_SECRET');
loadEnvKeyFromFile('AZURE_EMAIL_FUNCTION_URL', 'AZURE_EMAIL_FUNCTION_URL');
loadEnvKeyFromFile('AZURE_EMAIL_API_KEY', 'AZURE_EMAIL_API_KEY');

console.log('[nexus] .env path:', envPath);
{
  const azureOk =
    Boolean(process.env.AZURE_TENANT_ID?.trim()) &&
    Boolean(process.env.AZURE_CLIENT_ID?.trim()) &&
    Boolean(process.env.AZURE_CLIENT_SECRET?.trim());
  const adminUpn =
    process.env.ONEDRIVE_ADMIN_USER_ID?.trim() || process.env.ADMIN_USER_ID?.trim() || '';
  const excelPath =
    process.env.ONEDRIVE_EXCEL_PATH?.trim() || 'Progress Notes App/master progress notes.xlsx';
  console.log('[nexus] OneDrive Excel pull config:', {
    CRM_API_KEY: process.env.CRM_API_KEY ? 'set' : 'NOT SET',
    ONEDRIVE_ADMIN_USER_ID: process.env.ONEDRIVE_ADMIN_USER_ID ? 'set' : 'NOT SET',
    ADMIN_USER_ID: process.env.ADMIN_USER_ID ? 'set' : 'NOT SET',
    onedrive_owner_upn: adminUpn ? 'set' : 'NOT SET',
    AZURE_TENANT_ID: process.env.AZURE_TENANT_ID ? 'set' : 'NOT SET',
    AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID ? 'set' : 'NOT SET',
    AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET ? 'set' : 'NOT SET',
    ONEDRIVE_EXCEL_PATH: excelPath,
  });
  if (azureOk && !adminUpn) {
    console.warn(
      '[nexus] Azure app credentials are set but ONEDRIVE_ADMIN_USER_ID (or ADMIN_USER_ID) is missing. Set the Microsoft 365 email (UPN) of the account where the Excel file lives — see repo root .env.example OneDrive section.'
    );
  }
}
{
  const xid = Boolean(process.env.XERO_CLIENT_ID?.trim());
  const xsec = Boolean(process.env.XERO_CLIENT_SECRET?.trim());
  const xuri = Boolean(process.env.XERO_REDIRECT_URI?.trim());
  const oauth = Boolean(process.env.OAUTH_PUBLIC_URL?.trim());
  const xeroReady = xid && xsec && (xuri || oauth);
  console.log('[nexus] Xero OAuth (server env):', {
    XERO_CLIENT_ID: xid ? 'set' : 'NOT SET',
    XERO_CLIENT_SECRET: xsec ? 'set' : 'NOT SET',
    XERO_REDIRECT_URI: xuri ? 'set' : 'NOT SET',
    OAUTH_PUBLIC_URL: oauth ? 'set' : 'NOT SET',
    xero_one_click_ready: xeroReady ? 'yes' : 'no',
  });
  if (!xeroReady && (xid || xsec || xuri)) {
    console.warn(
      '[nexus] Xero vars are incomplete: need CLIENT_ID + CLIENT_SECRET + (XERO_REDIRECT_URI or OAUTH_PUBLIC_URL). Put them in the repo root .env (not client/.env) and restart the API.'
    );
  }
}

// Ensure data directories exist (use DATA_DIR for Azure Files mount when set)
const dataDir = process.env.DATA_DIR || join(projectRoot, 'data');
const uploadsDir = join(dataDir, 'uploads');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
for (const sub of [
  join('forms', 'templates', 'custom'),
  join('forms', 'signer-previews'),
  join('forms', 'org-previews'),
  join('forms', 'company-docs'),
  join('onboarding', 'policies')
]) {
  const p = join(dataDir, sub);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** One-time copy from ephemeral /app/data/forms into the Fly volume when DATA_DIR is set. */
function migrateLegacyFormsIntoDataDir() {
  if (!process.env.DATA_DIR) return;
  const legacyForms = join(projectRoot, 'data', 'forms');
  const targetForms = join(dataDir, 'forms');
  if (!existsSync(legacyForms) || legacyForms === targetForms) return;

  function copyTree(src, dest) {
    if (!existsSync(src)) return;
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      const from = join(src, name);
      const to = join(dest, name);
      if (statSync(from).isDirectory()) copyTree(from, to);
      else if (!existsSync(to)) copyFileSync(from, to);
    }
  }

  for (const sub of ['templates/custom', 'signer-previews', 'org-previews']) {
    copyTree(join(legacyForms, ...sub.split('/')), join(targetForms, ...sub.split('/')));
  }
}

migrateLegacyFormsIntoDataDir();

// Import routes after env is loaded (routes import db which uses DATABASE_PATH)
import authRouter from './routes/auth.js';
import supabaseAuthRouter from './routes/supabaseAuth.js';
import emailOAuthRouter from './routes/emailOAuth.js';
import participantsRouter from './routes/participants.js';
import organisationsRouter from './routes/organisations.js';
import documentLibraryRouter from './routes/documentLibrary.js';
import intakePublicRouter from './routes/intakePublic.js';
import automationRouter from './routes/automation.js';
import complianceRouter from './routes/compliance.js';
import bulkOnboardingRouter from './routes/bulkOnboarding.js';
import staffRouter, { handleSetStaffShifterEnabled } from './routes/staff.js';
import shiftsRouter from './routes/shifts.js';
import ndisRouter from './routes/ndis.js';
import invoicesRouter from './routes/invoices.js';
import progressNotesRouter from './routes/progressNotes.js';
import smartDefaultsRouter from './routes/smartDefaults.js';
import onboardingRouter from './routes/onboarding.js';
import formsRouter from './routes/forms.js';
import companyDocumentsRouter from './routes/companyDocuments.js';
import activityRiskAssessmentsRouter from './routes/activityRiskAssessments.js';
import coordinatorTasksRouter from './routes/coordinatorTasks.js';
import coordinatorCasesRouter from './routes/coordinatorCases.js';
import billingRouter from './routes/billing.js';
import appShiftsRouter from './routes/appShifts.js';
import syncFromExcelRouter from './routes/syncFromExcel.js';
import webhooksPublicRouter from './routes/webhooksPublic.js';
import xeroWebhookRouter from './routes/xeroWebhook.js';
import receiptsRouter from './routes/receipts.js';
import settingsRouter from './routes/settings.js';
import learningRouter from './routes/learning.js';
import reportsRouter from './routes/reports.js';
import usersRouter from './routes/users.js';
import adminRouter from './routes/admin.js';
import orgFeaturesRouter from './routes/orgFeatures.js';
import orgMicrosoftDriveRouter from './routes/orgMicrosoftDrive.js';
import registersRouter from './routes/registers.js';
import nexusFormTemplatesRouter from './routes/nexusFormTemplates.js';
import nexusGeneratedFormsRouter from './routes/nexusGeneratedForms.js';
import participantServiceAgreementsRouter from './routes/participantServiceAgreements.js';
import staffOnboardingPublicRouter from './routes/staffOnboarding.js';
import { requireAuth } from './middleware/auth.js';
import { requireAgencyShell } from './middleware/agencyShell.js';
import { requireAdminOrDelegate, requireCoordinatorOrAdmin } from './middleware/roles.js';
import { startLearningJobs } from './jobs/learningJobs.js';
import { mirrorAllShiftsToNexusSupabase } from './services/nexusPublicShiftsSync.service.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const FileStore = fileStoreFactory(session);

const INSECURE_SESSION_DEFAULT = 'schedule-shift-session-secret-change-in-production';
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  const sec = process.env.SESSION_SECRET;
  if (!sec || sec === INSECURE_SESSION_DEFAULT || sec.length < 32) {
    console.error(
      '[nexus] Refusing to start: production requires SESSION_SECRET (32+ random characters). Set it in your host env; never use the dev default.'
    );
    process.exit(1);
  }
}

app.use(cors({ origin: true, credentials: true }));
// Xero webhooks require the raw body for HMAC verification (must be before express.json on this path).
app.use('/api/webhooks/xero', express.raw({ limit: '2mb', type: '*/*' }), xeroWebhookRouter);
app.use(express.json());
const sessionFilesDir = join(dataDir, 'sessions');
if (!existsSync(sessionFilesDir)) mkdirSync(sessionFilesDir, { recursive: true });
app.use(session({
  store: new FileStore({
    path: sessionFilesDir,
    retries: 1,
    ttl: 7 * 24 * 60 * 60,
    reapInterval: 60 * 60
  }),
  secret: process.env.SESSION_SECRET || INSECURE_SESSION_DEFAULT,
  resave: false,
  saveUninitialized: false,
  // Secure only in production. Do not tie to VITE_DEV_HTTPS: many dev setups use http:// while that flag
  // stays set for Xero, which would mark cookies Secure and break login over HTTP.
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Auth routes (public)
app.use('/api/auth', authRouter);
app.use('/api/auth/supabase', supabaseAuthRouter);
app.use('/api/email/oauth', emailOAuthRouter);
app.use('/api/integrations/microsoft-drive', orgMicrosoftDriveRouter);
app.use('/api/registers', requireAuth, registersRouter);

// Public staff onboarding form (token in URL, no login)
app.use('/api/public/staff-onboarding', staffOnboardingPublicRouter);

// Progress Notes / Schedule Shift → Nexus (CRM_API_KEY only)
app.use('/api/webhooks', webhooksPublicRouter);

// Sync from OneDrive Excel (auth: session OR CRM_API_KEY for cron)
app.use('/api/sync', syncFromExcelRouter);

// Receipts from Shifter (auth: session OR CRM_API_KEY)
app.use('/api/receipts', receiptsRouter);

// Protected API routes
app.use('/api/participants', requireAuth, participantServiceAgreementsRouter);
app.use('/api/participants', requireAuth, participantsRouter);
app.use('/api/form-templates', requireAuth, nexusFormTemplatesRouter);
app.use('/api/generated-forms', requireAuth, nexusGeneratedFormsRouter);
app.use('/api/organisations', requireAuth, organisationsRouter);
app.use('/api/document-library', requireAuth, documentLibraryRouter);
app.use('/api/intake', intakePublicRouter);
app.use('/api/automation', automationRouter);
app.use('/api/compliance', complianceRouter);
app.use('/api/admin', bulkOnboardingRouter);

// Also on the root app (in addition to staffRouter) so POST matches even if nested router fails to update.
app.post('/api/staff/shifter-enabled', requireAuth, requireAdminOrDelegate, requireAgencyShell, handleSetStaffShifterEnabled);
app.post('/api/staff/set-shifter-enabled', requireAuth, requireAdminOrDelegate, requireAgencyShell, handleSetStaffShifterEnabled);
app.use('/api/staff', requireAuth, staffRouter);
app.use('/api/shifts', requireAuth, requireAgencyShell, shiftsRouter);
app.use('/api/ndis', requireAuth, ndisRouter);
app.use('/api/invoices', requireAuth, invoicesRouter);
app.use('/api/progress-notes', requireAuth, progressNotesRouter);
app.use('/api/smart-defaults', requireAuth, smartDefaultsRouter);
app.use('/api/onboarding', requireAuth, onboardingRouter);
app.use('/api/forms', requireAuth, formsRouter);
app.use('/api/company-documents', companyDocumentsRouter);
app.use('/api/activity-risk-assessments', requireAuth, activityRiskAssessmentsRouter);
app.use('/api/coordinator-tasks', requireAuth, coordinatorTasksRouter);
app.use('/api/coordinator-cases', requireAuth, requireCoordinatorOrAdmin, coordinatorCasesRouter);
app.use('/api/app-shifts', requireAuth, requireAgencyShell, appShiftsRouter);
app.use('/api/billing', requireAuth, requireAdminOrDelegate, billingRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/users', usersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/org-features', orgFeaturesRouter);
app.use('/api', requireAuth, learningRouter);
app.use('/api/reports', requireAuth, reportsRouter);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(projectRoot, 'client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(join(projectRoot, 'client/dist/index.html'));
  });
}

// Start server on configured port only. In dev, auto-shifting ports can route
// auth callbacks through a stale backend and cause token validation failures.
function startServer(port) {
  const server = app.listen(port, '0.0.0.0');
  server.on('listening', async () => {
    console.log(`[nexus] Server listening on port ${port}`);
    try {
      const { seedPracticeStandardsIfNeeded } = await import('./services/practiceStandards.service.js');
      const r = seedPracticeStandardsIfNeeded();
      if (r?.seeded) console.log(`[practice-standards] seeded ${r.seeded} reference rows`);
    } catch (e) {
      console.warn('[practice-standards] seed failed:', e?.message);
    }

    try {
      const { syncDocumentLibraryFromDisk } = await import('./services/documentLibrary.service.js');
      const sync = syncDocumentLibraryFromDisk();
      if (sync.registered || sync.skipped.length || sync.warnings.length) {
        console.log(`[document-library] sync: registered=${sync.registered} scanned=${sync.scanned}` +
          (sync.skipped.length ? `, skipped=${sync.skipped.length}` : '') +
          (sync.warnings.length ? `, warnings=${sync.warnings.length}` : ''));
        for (const w of sync.warnings.slice(0, 10)) console.warn('[document-library]', w);
        for (const s of sync.skipped.slice(0, 10)) console.warn('[document-library] skipped', s);
      }
    } catch (e) {
      console.warn('[document-library] boot sync failed:', e?.message);
    }

    // Phase 6: in-process daily automation. The external cron (POST /api/automation/tick)
    // is still recommended for production, but this fallback ensures small/single-node
    // installs do not silently skip renewal scans and intake-token cleanup.
    if (process.env.AUTOMATION_DISABLE_INPROCESS !== '1') {
      try {
        const { runDailyAutomationTick } = await import('./services/dailyAutomation.service.js');
        const intervalMs = Number(process.env.AUTOMATION_TICK_INTERVAL_MS || 6 * 60 * 60 * 1000);
        const initialDelayMs = Number(process.env.AUTOMATION_TICK_INITIAL_DELAY_MS || 60 * 1000);
        setTimeout(() => {
          runDailyAutomationTick({ actorType: 'system' }).catch((e) =>
            console.warn('[automation] initial tick failed:', e?.message)
          );
        }, initialDelayMs);
        setInterval(() => {
          runDailyAutomationTick({ actorType: 'system' }).catch((e) =>
            console.warn('[automation] tick failed:', e?.message)
          );
        }, intervalMs).unref();
        console.log(`[automation] in-process tick every ${(intervalMs / 3600000).toFixed(1)} h (disable via AUTOMATION_DISABLE_INPROCESS=1)`);
      } catch (e) {
        console.warn('[automation] could not start in-process scheduler:', e?.message);
      }
    }
  });
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[nexus] Port ${port} already in use. Stop the existing process on this port and restart so client proxy/auth flow stays aligned.`
      );
    }
    process.exit(1);
  });
}

startServer(PORT);
startLearningJobs();

const publicShiftsSyncMs = Number(process.env.NEXUS_PUBLIC_SHIFTS_SYNC_INTERVAL_MS);
if (Number.isFinite(publicShiftsSyncMs) && publicShiftsSyncMs >= 60_000) {
  const run = () => {
    mirrorAllShiftsToNexusSupabase()
      .then((s) => {
        if (!s.skipped || s.reason !== 'supabase_not_configured') {
          console.log('[nexus-public-shifts] periodic', s);
        }
      })
      .catch((e) => console.warn('[nexus-public-shifts] periodic error', e?.message || e));
  };
  if (String(process.env.NEXUS_PUBLIC_SHIFTS_SYNC_ON_START).toLowerCase() === 'true') {
    run();
  }
  setInterval(run, publicShiftsSyncMs);
  console.log('[nexus-public-shifts] interval', publicShiftsSyncMs, 'ms');
}

