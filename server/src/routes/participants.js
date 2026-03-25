import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { db } from '../db/index.js';
import {
  getAssignedParticipantIds,
  canAccessParticipant,
  requireCoordinatorOrAdmin,
  getProviderOrgIdForUser,
  includeNullProviderParticipantsForUser,
  getSingleDistinctUserOrgId
} from '../middleware/roles.js';
import { isSuperAdminEmail } from '../lib/superAdmin.js';
import { recordBudgetLineItemSelection } from '../services/preferenceLearning.service.js';
import * as llm from '../services/llm.service.js';
import { extractPlanFromText } from '../services/ai/planExtractor.js';
import { reconcilePlanExtraction } from '../services/ai/planReconciler.js';
import { parseIntakeFormText } from '../services/intakeFormParser.service.js';
import { initializeParticipantOnboarding, upsertIntakeFields } from '../services/onboarding.service.js';
import { recordMapping } from '../services/csvMappingLearner.service.js';
import { ensurePlanManagerOrg, buildOrgLookupMaps } from '../services/organisations.service.js';
import { tryPushParticipantDocument, resolveOrgIdForParticipant } from '../services/orgOnedriveSync.service.js';
import {
  scheduleRemoveShiftFromNexusSupabase,
  scheduleMirrorShiftsForParticipantId,
} from '../services/nexusPublicShiftsSync.service.js';
import {
  prepareFundReleaseScheduleForStorage,
  parseFundReleaseScheduleFromDb
} from '../utils/fundReleaseSchedule.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const projectRoot = resolve(__dirname, '../../..');
const uploadsDir = process.env.DATA_DIR ? join(process.env.DATA_DIR, 'uploads') : join(projectRoot, 'data', 'uploads');

const router = Router();

const IMPL_FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'random', 'annual'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      cb(null, `${uuidv4()}-${file.originalname}`);
    }
  })
});
const memoryUpload = multer({ storage: multer.memoryStorage() });

/** When a support coordinator creates a participant, link them so the new record appears in their list. */
function assignCreatorIfSupportCoordinator(userId, participantId) {
  if (!userId || !participantId) return;
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (row?.role !== 'support_coordinator') return;
  const linkId = uuidv4();
  try {
    db.prepare('INSERT INTO user_participants (id, user_id, participant_id) VALUES (?, ?, ?)').run(
      linkId,
      userId,
      participantId
    );
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return;
    throw e;
  }
}

function saveUploadedDocumentFromBuffer(participantId, file, category = 'NDIS Plan') {
  if (!participantId || !file?.buffer) return null;
  mkdirSync(uploadsDir, { recursive: true });
  const safeOriginalName = String(file.originalname || 'plan-document').replace(/[\\/]/g, '_');
  const storedFilename = `${uuidv4()}-${safeOriginalName}`;
  const filePath = join(uploadsDir, storedFilename);
  writeFileSync(filePath, file.buffer);

  const docId = uuidv4();
  db.prepare(`
    INSERT INTO participant_documents (id, participant_id, filename, category, file_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(docId, participantId, safeOriginalName, category || null, filePath);
  void tryPushParticipantDocument({
    participantId,
    category: category || 'Other',
    buffer: file.buffer,
    originalFilename: safeOriginalName,
    mimeType: file.mimetype || null,
    notes: `participant_document:${docId}`
  }).then((uploaded) => {
    if (!uploaded?.webUrl && !uploaded?.itemId) return;
    db.prepare(`
      UPDATE participant_documents
      SET onedrive_web_url = COALESCE(?, onedrive_web_url),
          onedrive_item_id = COALESCE(?, onedrive_item_id)
      WHERE id = ?
    `).run(uploaded.webUrl || null, uploaded.itemId || null, docId);
  });
  return docId;
}

function findParticipantOneDriveUrl(participantId, docId, localFilename) {
  const doc = db
    .prepare('SELECT onedrive_web_url FROM participant_documents WHERE id = ? AND participant_id = ?')
    .get(docId, participantId);
  if (doc?.onedrive_web_url) return doc.onedrive_web_url;

  const marker = `participant_document:${docId}`;
  const byMarker = db.prepare(`
    SELECT web_url, graph_item_id
    FROM onedrive_document_register
    WHERE entity_type = 'participant'
      AND entity_id = ?
      AND notes = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(participantId, marker);
  if (byMarker?.web_url) {
    db.prepare(`
      UPDATE participant_documents
      SET onedrive_web_url = ?, onedrive_item_id = COALESCE(?, onedrive_item_id)
      WHERE id = ?
    `).run(byMarker.web_url, byMarker.graph_item_id || null, docId);
    return byMarker.web_url;
  }

  const orgId = resolveOrgIdForParticipant(participantId);
  if (!orgId || !localFilename) return null;
  const rows = db.prepare(`
    SELECT web_url, graph_item_id, filename
    FROM onedrive_document_register
    WHERE organization_id = ?
      AND entity_type = 'participant'
      AND entity_id = ?
      AND web_url IS NOT NULL
    ORDER BY datetime(created_at) DESC
    LIMIT 200
  `).all(orgId, participantId);
  const matched = rows.find((r) => r.filename === localFilename || r.filename?.endsWith(`_${localFilename}`));
  if (!matched?.web_url) return null;
  db.prepare(`
    UPDATE participant_documents
    SET onedrive_web_url = ?, onedrive_item_id = COALESCE(?, onedrive_item_id)
    WHERE id = ?
  `).run(matched.web_url, matched.graph_item_id || null, docId);
  return matched.web_url;
}

/** Parse plan manager name and email from intake. plan_manager_details may be "Name – email" or "email" or "Name". */
function parsePlanManagerFromIntake(intake) {
  const email = (intake?.plan_manager_invoice_email || '').trim() || null;
  const details = (intake?.plan_manager_details || '').trim() || null;
  let name = null;
  let parsedEmail = email;
  if (details) {
    const dash = details.indexOf(' – ');
    if (dash >= 0) {
      const before = details.slice(0, dash).trim();
      const after = details.slice(dash + 3).trim();
      if (before) name = before;
      if (after && after.includes('@')) parsedEmail = parsedEmail || after;
    } else if (details.includes('@')) {
      parsedEmail = parsedEmail || details;
    } else {
      name = details;
    }
  }
  return { name: name || null, email: parsedEmail || null };
}

const VALID_MANAGEMENT_TYPES = new Set(['self', 'plan', 'ndia']);

// Require participant access for all :id routes (support coordinator sees only assigned)
router.param('id', (req, res, next, id) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!canAccessParticipant(req.session.user.id, id)) return res.status(403).json({ error: 'Access denied' });
  next();
});

function normalizeManagementType(value, fallback = 'self') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_MANAGEMENT_TYPES.has(normalized) ? normalized : fallback;
}

function parseManagedServices(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v).padStart(2, '0'));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => String(v).padStart(2, '0')) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Normalise support item number (e.g. Excel 1.002010711 -> 01_002_0107_1_1)
function normalizeSupportItemNumber(val) {
  if (val == null || val === '') return '';
  const s = String(val).trim();
  if (s.includes('_')) return s;
  const n = parseFloat(s);
  if (isNaN(n) || n < 1 || n >= 2) return s;
  const digits = String(Math.round(n * 1e9)).padStart(11, '0').slice(0, 11);
  if (digits.length >= 11) {
    return `${digits.slice(0, 2)}_${digits.slice(2, 5)}_${digits.slice(5, 9)}_${digits[9]}_${digits[10]}`;
  }
  return s;
}

// Parse plan CSV (Format 1: Support Category, Category Name, Budget Amount, Line Items | Format 2: Category ID, Support Category Name, Budget ($), Support Item Numbers)
function parsePlanCsv(buffer) {
  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const delimiter = lines[0]?.includes(';') ? ';' : ',';
  const parseLine = (line) => {
    const result = [];
    let cell = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        i++;
        while (i < line.length && line[i] !== '"') {
          cell += line[i];
          i++;
        }
        if (line[i] === '"') i++;
      } else if (line[i] === delimiter || line[i] === '\t') {
        result.push(cell.trim());
        cell = '';
        i++;
      } else {
        cell += line[i];
        i++;
      }
    }
    result.push(cell.trim());
    return result;
  };
  const rows = lines.map(l => parseLine(l));
  if (rows.length < 2) return { format: null, budgets: [], error: 'Need header and at least one row' };
  const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
  const catIdx = headers.findIndex(h => h.includes('support category') || h.includes('category id'));
  const nameIdx = headers.findIndex(h => h.includes('category name') || h.includes('support category name'));
  const amtIdx = headers.findIndex(h => h.includes('budget') || h.includes('amount'));
  const lineIdx = headers.findIndex(h => h.includes('line item') || h.includes('support item'));
  const managementIdx = headers.findIndex(h => h.includes('management type') || h.includes('management') || h.includes('managed by'));
  const startDateIdx = headers.findIndex(h => h.includes('plan start') || h.includes('start date') || h === 'start');
  const endDateIdx = headers.findIndex(h => h.includes('plan end') || h.includes('end date') || h === 'end');
  const goalIndexes = headers
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => /\bgoals?\b|\bobjective(s)?\b|\boutcome(s)?\b/.test(h))
    .map(({ idx }) => idx);
  if (catIdx < 0 || amtIdx < 0) return { format: null, budgets: [], error: 'Could not find Support Category and Budget columns' };
  const parseCsvDate = (val) => {
    if (!val || typeof val !== 'string') return null;
    const s = val.trim();
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const [, d, m, y] = dmy;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  };
  let plan_dates = null;
  if (startDateIdx >= 0 || endDateIdx >= 0) {
    const firstRow = rows[1];
    const start_date = startDateIdx >= 0 && firstRow ? parseCsvDate(firstRow[startDateIdx]) : null;
    const end_date = endDateIdx >= 0 && firstRow ? parseCsvDate(firstRow[endDateIdx]) : null;
    if (start_date || end_date) plan_dates = { start_date, end_date };
  }
  const budgets = [];
  const goals = [];
  const goalSeen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const catRaw = row[catIdx] || '';
    const cat = String(catRaw).replace(/\D/g, '').slice(0, 2) || catRaw.slice(0, 2);
    if (!cat) continue;
    const name = (nameIdx >= 0 ? row[nameIdx] : '') || `Category ${cat}`;
    const amt = parseFloat(String(row[amtIdx] || '0').replace(/[$,]/g, '')) || 0;
    if (amt <= 0) continue;
    let lineItemsRaw = lineIdx >= 0 ? (row[lineIdx] || '') : '';
    const lineItems = lineItemsRaw.split(/[,;]\s*/).map(s => normalizeSupportItemNumber(s.trim())).filter(Boolean);
    const management_type = normalizeManagementType(managementIdx >= 0 ? row[managementIdx] : null);
    budgets.push({ category: cat.padStart(2, '0'), name, amount: amt, line_item_numbers: lineItems, management_type });

    if (goalIndexes.length > 0) {
      for (const gIdx of goalIndexes) {
        const rawGoal = cleanGoalText(row[gIdx] || '');
        if (!rawGoal || rawGoal.length < 12) continue;
        const key = normalizeGoalText(rawGoal);
        if (goalSeen.has(key)) continue;
        goalSeen.add(key);
        goals.push(rawGoal);
      }
    }
  }
  return { format: 'csv', budgets, plan_dates, goals };
}

function normalizeGoalText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanGoalText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// NDIS plans: goals section can appear before or after budget. PACE (adult) vs early childhood formats.
const GOALS_SECTION_START = /\b(?:your\s+goals?\b|participant\s+goals?\b|^goals?\b|what'?s?\s+important\s+to\s+you\b|my\s+goals?\b|goals?\s+and\s+aspirations\b|plan\s+goals?\b|goals?\s+and\s+outcomes?\b|participant\s+statement\b|this\s+is\s+what\s+i\s+want\s+to\s+achieve\b)/im;
const GOALS_SECTION_END = /\b(?:your\s+supports\b|your\s+current\s+informal\b|what\s+to\s+do\s+if\s+something\s+changes\b|new\s+informal,?\s+community\b|description\s+of\s+support\s*:|funded\s+supports\s+information\b|managing\s+my\s+ndis\s+funding\b)/im;

function extractGoalsSectionText(fullText) {
  const t = String(fullText || '');
  const startMatch = t.match(GOALS_SECTION_START);
  if (!startMatch || startMatch.index === undefined) return t;
  const startIdx = startMatch.index;
  const afterStart = t.slice(startIdx);
  const endMatch = afterStart.match(GOALS_SECTION_END);
  const endIdx = endMatch && endMatch.index !== undefined ? startIdx + endMatch.index : t.length;
  return t.slice(startIdx, endIdx).trim();
}

function fixHyphenatedLineBreaks(s) {
  return String(s || '').replace(/-\s*\n\s*/g, '-');
}

function extractGoalsDeterministic(text) {
  const goalsSectionOnly = extractGoalsSectionText(text);
  const lines = String(goalsSectionOnly || '').split(/\r?\n/).map((line) => line.trim());
  const collected = [];
  let inGoalsSection = false;
  let sectionLines = 0;

  const headingRe = /^(participant\s+)?goals?\b[:\s-]*$|^participant\s+statement\b|^what'?s?\s+important\s+to\s+you\b|^my\s+goals?\b|^goals?\s+and\s+aspirations\b|^plan\s+goals?\b|^your\s+goals?\b|^goals?\s+and\s+outcomes?\b[:\s-]*$|^this\s+is\s+what\s+i\s+want\s+to\s+achieve\b$/i;
  const bulletRe = /^(?:[-*•]\s+|\d{1,2}[.)]\s+)(.+)$/;
  const inlineGoalRe = /^goal\s*\d*\s*[:.\-]\s*(.+)$/i;
  const yourGoalRe = /^your\s+goal\s*:\s*(.+)$/i;
  const howWillYouWorkRe = /^how\s+will\s+you\s+work\s+towards\s+this\s+goal\s*\??/i;
  const stopSectionRe = /^(?:funding|supports?|budget|capacity\s+building|core\s+supports?|capital\s+supports?)\b/i;
  const shortTermGoalRe = /^(?:short-term|medium\s+or\s+long-term)\s+goal\s*$/i;
  const earlyChildhoodGoalRe = /^(.+['']s\s+family\s+would\s+like\s+(?:her|him)\s+to\s+.+\.?)$/i;
  const howIAchieveRe = /^how\s+i\s+will\s+achieve\s+this\s+goal\b/i;

  let currentGoalLines = null;
  let nextLineIsGoal = false;

  for (const line of lines) {
    if (headingRe.test(line)) {
      inGoalsSection = true;
      sectionLines = 0;
      currentGoalLines = null;
      nextLineIsGoal = false;
      continue;
    }

    if (shortTermGoalRe.test(line)) {
      if (currentGoalLines) {
        const joined = fixHyphenatedLineBreaks(currentGoalLines.join('\n'));
        const cleaned = cleanGoalText(joined);
        if (cleaned.length >= 12) collected.push(cleaned);
      }
      currentGoalLines = null;
      nextLineIsGoal = true;
      continue;
    }

    if (nextLineIsGoal && line) {
      const ecMatch = line.match(earlyChildhoodGoalRe);
      if (ecMatch?.[1]) {
        collected.push(cleanGoalText(ecMatch[1]));
      } else if (line.length >= 20 && !howIAchieveRe.test(line)) {
        collected.push(cleanGoalText(line));
      }
      nextLineIsGoal = false;
      continue;
    }

    if (howIAchieveRe.test(line)) {
      if (currentGoalLines) {
        const joined = fixHyphenatedLineBreaks(currentGoalLines.join('\n'));
        const cleaned = cleanGoalText(joined);
        if (cleaned.length >= 12) collected.push(cleaned);
        currentGoalLines = null;
      }
      nextLineIsGoal = false;
      continue;
    }

    const yourGoalMatch = line.match(yourGoalRe);
    if (yourGoalMatch?.[1]) {
      if (currentGoalLines) {
        const joined = fixHyphenatedLineBreaks(currentGoalLines.join('\n'));
        const cleaned = cleanGoalText(joined);
        if (cleaned.length >= 12) collected.push(cleaned);
      }
      currentGoalLines = [yourGoalMatch[1]];
      continue;
    }

    if (howWillYouWorkRe.test(line)) {
      if (currentGoalLines) {
        const joined = fixHyphenatedLineBreaks(currentGoalLines.join('\n'));
        const cleaned = cleanGoalText(joined);
        if (cleaned.length >= 12) collected.push(cleaned);
        currentGoalLines = null;
      }
      continue;
    }

    if (currentGoalLines && line) {
      currentGoalLines.push(line);
      continue;
    }

    const inline = line.match(inlineGoalRe);
    if (inline?.[1]) {
      if (currentGoalLines) {
        const joined = fixHyphenatedLineBreaks(currentGoalLines.join('\n'));
        const cleaned = cleanGoalText(joined);
        if (cleaned.length >= 12) collected.push(cleaned);
        currentGoalLines = null;
      }
      collected.push(cleanGoalText(inline[1]));
      continue;
    }

    if (!inGoalsSection) continue;

    sectionLines += 1;
    if (sectionLines > 50 || stopSectionRe.test(line)) {
      inGoalsSection = false;
      currentGoalLines = null;
      continue;
    }

    const bullet = line.match(bulletRe);
    if (bullet?.[1]) {
      if (currentGoalLines) {
        const joined = fixHyphenatedLineBreaks(currentGoalLines.join('\n'));
        const cleaned = cleanGoalText(joined);
        if (cleaned.length >= 12) collected.push(cleaned);
        currentGoalLines = null;
      }
      collected.push(cleanGoalText(bullet[1]));
      continue;
    }

    const isIntroText = /\b(?:your\s+goals?\s+are\s+set\s+by\s+you|written\s+in\s+your\s+own\s+words|they\s+help\s+the\s+people\s+supporting\s+you|you\s+can\s+change\s+or\s+update\s+your\s+goals?)\b/i;
    if (line.length > 25 && !/^\$[\d,]/.test(line) && !currentGoalLines && !isIntroText.test(line)) {
      collected.push(cleanGoalText(line));
    }
  }

  if (currentGoalLines) {
    const joined = fixHyphenatedLineBreaks(currentGoalLines.join('\n'));
    const cleaned = cleanGoalText(joined);
    if (cleaned.length >= 12) collected.push(cleaned);
  }

  const seen = new Set();
  return collected
    .map(cleanGoalText)
    .filter((g) => g.length >= 12)
    .filter((g) => {
      const key = normalizeGoalText(g);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

async function extractPlanGoals(text, useAi) {
  const deterministic = extractGoalsDeterministic(text);
  if (!useAi) return deterministic;

  try {
    if (!await llm.isAvailable() || String(text || '').trim().length < 80) {
      return deterministic;
    }
    const fullText = String(text || '');
    const goalsSection = extractGoalsSectionText(text);
    const hasGoalsSection = goalsSection.length > 0 && goalsSection.length < fullText.length * 0.9 && /\byour\s+goal\b|\bgoals?\b/i.test(goalsSection);
    const textForLlm = hasGoalsSection ? goalsSection.slice(0, 8000) : fullText.slice(0, 30000);
    const prompt = hasGoalsSection
      ? `Extract participant goals from this NDIS plan goals section. Copy each goal WORD FOR WORD exactly as written. Do NOT paraphrase or rephrase.

Two formats:
1) PACE adult: "Your goal: ..." blocks. Each goal spans multiple lines until "How will you work towards this goal?" or the next "Your goal:". Extract only the goal text, not the strategy. Join multi-line goals (e.g. "self-" + "reliance" -> "self-reliance").
2) Early childhood: "Short-term goal" or "Medium or long-term goal" followed by a line like "X's family would like her/him to...". Extract that full sentence.

Return valid JSON only:
{ "goals": ["Exact goal text 1", "Exact goal text 2", ...] }

Goals section:
---
${textForLlm}
---`
      : `You are reading an NDIS participant plan document. Find the participant goals section and extract the goals.

STEP 1: Search for "Your goals", "My goals", "Participant Goals", "Goals", "This is what I want to achieve", "Participant Statement". The section may appear before or after the budget.

STEP 2: Copy each goal WORD FOR WORD. Two formats:
- PACE adult: "Your goal: ..." blocks until "How will you work towards this goal?" or next "Your goal:"
- Early childhood: After "Short-term goal" or "Medium or long-term goal", the next line is the goal (e.g. "Crystal's family would like her to develop her self-care skills.")

Exclude "How I will achieve", strategy text, and budget/funding. Return valid JSON only:
{ "goals": ["Exact goal text 1", "Exact goal text 2", ...] }

Plan text:
---
${textForLlm}
---`;
    const ai = await llm.completeJson(prompt, { maxTokens: 1200 });
    const aiGoals = Array.isArray(ai?.goals)
      ? ai.goals.map(cleanGoalText).filter((g) => g.length >= 12)
      : [];

    const merged = aiGoals.length > 0 ? [...aiGoals, ...deterministic] : [...deterministic, ...aiGoals];
    const seen = new Set();
    return merged.filter((g) => {
      const key = normalizeGoalText(g);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 20);
  } catch {
    return deterministic;
  }
}

// DEPRECATED: Do not use for participant goals. Budget support_narrative describes funding, not participant goals.
// Goals must come from the plan's goals section only (extractPlanGoals).
function extractGoalsFromBudgetNarratives(budgets) {
  const entries = Array.isArray(budgets) ? budgets : [];
  const out = [];
  const seen = new Set();
  for (const b of entries) {
    const text = cleanGoalText(b?.support_narrative || '');
    if (!text || text.length < 20) continue;
    const candidates = text.split(/[.\n;]/).map((s) => cleanGoalText(s)).filter(Boolean);
    for (const c of candidates) {
      if (c.length < 12) continue;
      const mentionsGoal = /\bgoal(s)?\b/i.test(c);
      const startsWithVerb = /^(improve|increase|build|develop|maintain|learn|participate|engage|access|achieve|support)\b/i.test(c);
      if (!mentionsGoal && !startsWithVerb) continue;
      const key = normalizeGoalText(c);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

// Preferred hourly rates per category for hours estimate (weekday daytime default; core 01-04 prioritise these)
// Used when auto-picking line items so est. hours use the correct rate
const CATEGORY_PREFERRED_RATES = {
  '01': 70.23,   // Assistance with Daily Life - Standard Weekday Daytime (01_011_0107_1_1)
  '02': 58.03,   // Transport - typical
  '03': 59.06,   // Consumables / domestic
  '04': 70.23,   // Social/Community - similar to 01
  '05': 193.99,  // Assistive Technology
  '06': 0,       // Capital - not hourly
  '07': 193.99,  // Support Coordination
  '08': 70.23,   // Improved Living
  '09': 70.23,   // Social/Community Participation
  '10': 70.23,   // Employment
  '11': 193.99,  // Improved Relationships - therapy rate
  '12': 193.99,  // Health/Wellbeing - therapy rate
  '13': 193.99,  // Improved Learning
  '14': 193.99,  // Choice and Control
  '15': 193.99   // Improved Daily Living Skills - therapy/professional rate (15_056, 15_617 etc)
};

// Map NDIS category names (from plan PDFs) to category IDs 01-15
const PDF_CATEGORY_MAP = {
  'assistance with daily life': '01',
  'transport': '02',
  'consumables': '03',
  'assistance with social, economic and community participation': '04',
  'assistive technology': '05',
  'home modifications and sda': '06',
  'support coordination': '07',
  'support coordination and psychosocial recovery coaches': '07',
  'improved living arrangements': '08',
  'increased social and community participation': '09',
  'finding and keeping a job': '10',
  'improved relationships': '11',
  'improved health and wellbeing': '12',
  'improved learning': '13',
  'improved life choices': '14',
  'choice and control': '14',
  'improved daily living skills': '15',
  'daily activities': '01',
  'social and community participation': '09',
  'core - assistance with daily life': '01',
  'capacity - assistance with daily life': '01',
  'core - transport': '02',
  'capacity - transport': '02',
  'core - consumables': '03',
  'core - support coordination': '07',
  'capacity - support coordination': '07',
  'core - improved living': '08',
  'core - increased social': '09',
  'capacity - increased social': '09',
  'core - finding and keeping a job': '10',
  'capacity - improved relationships': '11',
  'capacity - improved health': '12',
  'capacity - improved learning': '13',
  'capacity - improved life choices': '14',
  'capacity - improved daily living': '15',
  'improved daily living (cb daily activity)': '15',
  'cb daily activity': '15',
  'improved health and wellbeing (cb health & wellbeing)': '12',
  'cb health & wellbeing': '12',
  'cb health and wellbeing': '12',
  'core supports': '01'
};

// Extract total plan budget from document (search full text for "Total funded supports", "Total plan budget", etc.)
function extractPlanTotalFromText(text) {
  const patterns = [
    /(?:total\s+funded\s+supports|total\s+plan\s+budget|plan\s+total|total\s+funding|total\s+budget|plan\s+value)\s*[:\s]*\$?([\d,]+(?:\.\d{2})?)/i,
    /\$([\d,]+(?:\.\d{2})?)\s*(?:total\s+funded\s+supports|total\s+plan|plan\s+total)/i,
    /(?:your\s+plan\s+is\s+valued\s+at|valued\s+at)\s*\$?([\d,]+(?:\.\d{2})?)/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const amt = parseFloat(String(m[1]).replace(/[$,]/g, '')) || 0;
      if (amt >= 100) return amt;
    }
  }
  return null;
}

// Month name to number for "11 October 2023" style dates
const MONTH_NAMES = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };

// Extract plan dates from NDIS PDF text (e.g. "Your plan starts on 21/11/2024", "NDIS plan start date: 11 October 2023", "plan review due date: 10 October 2025")
function extractPlanDatesFromPdf(text) {
  let start_date = null;
  let end_date = null;
  // "NDIS plan start date: 11 October 2023" or "Plan Approved: 11 October 2023"
  const ndisStartMatch = text.match(/(?:NDIS\s+plan\s+start\s+date|plan\s+approved|plan\s+starts?\s+on|starts?\s+on)\s*[:\s]+(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
  if (ndisStartMatch) {
    const [, d, mon, y] = ndisStartMatch;
    start_date = `${y}-${MONTH_NAMES[mon.toLowerCase()]}-${String(d).padStart(2, '0')}`;
  }
  // "NDIS plan review due date: 10 October 2025" or "will be reviewed by 10 October 2025"
  const ndisEndMatch = text.match(/(?:NDIS\s+plan\s+review\s+due\s+date|review\s+due\s+date|will\s+be\s+reviewed\s+by|ends?\s+on|plan\s+ends?\s+on)\s*[:\s]+(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
  if (ndisEndMatch) {
    const [, d, mon, y] = ndisEndMatch;
    end_date = `${y}-${MONTH_NAMES[mon.toLowerCase()]}-${String(d).padStart(2, '0')}`;
  }
  // Fallback: dd/mm/yyyy or dd-mm-yyyy
  if (!start_date) {
    const startMatch = text.match(/(?:plan\s+starts?\s+on|starts?\s+on)\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i);
    if (startMatch) {
      const [, d, m, y] = startMatch;
      start_date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  if (!end_date) {
    const endMatch = text.match(/(?:ends?\s+on|plan\s+ends?\s+on)\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i);
    if (endMatch) {
      const [, d, m, y] = endMatch;
      end_date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  if (!start_date && text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/)) {
    const all = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/g) || [];
    const parsed = all.map(s => {
      const [d, m, y] = s.split(/[\/\-]/);
      return { iso: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, raw: s };
    });
    if (parsed.length >= 2) {
      start_date = parsed[0].iso;
      end_date = parsed[1].iso;
    } else if (parsed.length === 1) start_date = parsed[0].iso;
  }
  return { start_date, end_date };
}

// Parse dollar amount from document text - EXACT to the cent. No AI, no estimation.
// "$77,683.73" -> 77683.73 (rounded to 2 decimals for storage)
function parseAmountExact(amountStr) {
  if (!amountStr || typeof amountStr !== 'string') return 0;
  const cleaned = amountStr.replace(/[$,]/g, '').trim();
  const n = parseFloat(cleaned);
  if (isNaN(n) || n < 0) return 0;
  return Math.round(n * 100) / 100; // preserve cents exactly
}

// Labels we must NOT treat as category budgets (plan totals or subtotals)
const PLAN_TOTAL_LABELS = /total\s+funded\s+supports|total\s+plan\s+budget|plan\s+total|total\s+capacity\s+building\s+supports|total\s+core\s+supports|valued\s+at/i;
// When amount is preceded by these, it's a sub-item (e.g. "Includes $1,000") not a category budget
const SUB_ITEM_PREFIX = /(?:includes|funding for|approximately|e\.g\.|up to|max\.?)\s*$/i;
const STATED_SUPPORT_RE = /\bstated\s+(?:support|supports|item|items)\b/i;

function containsStatedSupport(text) {
  return STATED_SUPPORT_RE.test(String(text || ''));
}

// NDIS structure: Core (01-04), Capital (05-06), Capacity Building (07-15)
const CORE_CATS = new Set(['01', '02', '03', '04']);
const CAPITAL_CATS = new Set(['05', '06']);
const CAPACITY_CATS = new Set(['07', '08', '09', '10', '11', '12', '13', '14', '15']);

// Parse NDIS plan from PDF - DETERMINISTIC: scan from top, find $ figure, read what it's linked to, use EXACT amount.
// No AI for amounts - accuracy to the cent is critical.
function parsePlanFromPdfText(text) {
  const budgets = [];
  const planDates = extractPlanDatesFromPdf(text);
  const total_plan_budget = extractPlanTotalFromText(text);
  const catNames = {
    '01': 'Assistance with Daily Life', '02': 'Transport', '03': 'Consumables',
    '04': 'Assistance with Social, Economic and Community Participation',
    '05': 'Assistive Technology', '06': 'Home Modifications and SDA',
    '07': 'Support Coordination', '08': 'Improved Living Arrangements',
    '09': 'Increased Social and Community Participation', '10': 'Finding and Keeping a Job',
    '11': 'Improved Relationships', '12': 'Improved Health and Wellbeing',
    '13': 'Improved Learning', '14': 'Improved Life Choices', '15': 'Improved Daily Living Skills'
  };
  const seen = new Set();

  // For each amount, find which section it belongs to (last section header before the amount)
  const getSectionAt = (pos) => {
    const tl = text.toLowerCase();
    const lastCore = Math.max(tl.lastIndexOf('total core supports', pos), tl.lastIndexOf('core supports funding', pos), tl.lastIndexOf('core supports\n', pos));
    const lastCapBuild = Math.max(tl.lastIndexOf('total capacity building', pos), tl.lastIndexOf('capacity building supports', pos), tl.lastIndexOf('capacity building\n', pos));
    const lastCapital = Math.max(tl.lastIndexOf('capital supports', pos), tl.lastIndexOf('assistive technology', pos), tl.lastIndexOf('home modifications', pos));
    const best = Math.max(lastCore, lastCapBuild, lastCapital);
    if (best < 0) return null;
    if (best === lastCapital) return 'capital';
    if (best === lastCapBuild) return 'capacity';
    return 'core';
  };

  const withCents = text.match(/\$[\d,]+\.\d{2}/g) || [];
  const noCents = text.match(/\$[\d,]+(?!\.)/g) || [];

  // Match $X,XXX.XX OR $X,XXX (amounts without decimals, e.g. $4,620 for category 09)
  const amountRe = /\$([\d,]+(?:\.\d{2})?)(?=\s|$|\)|\.\s|,|;)/g;
  let m;
  while ((m = amountRe.exec(text)) !== null) {
    const amountStr = m[1];
    const amount = parseAmountExact(amountStr);
    if (amount < 1) continue;
    const start = Math.max(0, m.index - 250);
    const preceding = text.slice(start, m.index);
    const precedingLower = preceding.toLowerCase();
    const last60 = preceding.slice(-60);
    const last80 = preceding.slice(-80);

    // Only skip if the IMMEDIATE preceding text (last 80 chars) indicates a total - not when a total appeared 200 chars ago
    const immediatePreceding = preceding.slice(-80);
    let skipReason = null;
    if (total_plan_budget != null && total_plan_budget > 0 && Math.abs(amount - total_plan_budget) / total_plan_budget < 0.005) skipReason = 'plan_total';
    else if (PLAN_TOTAL_LABELS.test(immediatePreceding)) skipReason = 'plan_total_labels';
    else if (SUB_ITEM_PREFIX.test(last60)) skipReason = 'sub_item_prefix';
    // Flexible Core wording often uses "includes $X" as a sub-allocation, not a separate category budget.
    else if (/(?:includes?|including)\b/i.test(immediatePreceding)) {
      const windowBefore = precedingLower.slice(-220);
      const windowAfter = text.slice(m.index, Math.min(text.length, m.index + 220)).toLowerCase();
      const statedSupportNearby = containsStatedSupport(windowBefore) || containsStatedSupport(windowAfter);
      if (!statedSupportNearby) skipReason = 'sub_item_include';
    }
    if (skipReason) {
      continue;
    }

    // Restrict categories by section (Core 01-04, Capital 05-06, Capacity 07-15)
    const section = getSectionAt(m.index);
    const allowedCats = new Set();
    if (section === 'core') CORE_CATS.forEach(c => allowedCats.add(c));
    else if (section === 'capital') CAPITAL_CATS.forEach(c => allowedCats.add(c));
    else if (section === 'capacity') CAPACITY_CATS.forEach(c => allowedCats.add(c));
    else {
      CORE_CATS.forEach(c => allowedCats.add(c));
      CAPITAL_CATS.forEach(c => allowedCats.add(c));
      CAPACITY_CATS.forEach(c => allowedCats.add(c));
    }

    // Match category: prefer the key that appears CLOSEST to the amount (last in preceding)
    let bestCat = null;
    let bestPos = -1;
    for (const [key, c] of Object.entries(PDF_CATEGORY_MAP)) {
      if (seen.has(c) || !allowedCats.has(c)) continue;
      const pos = precedingLower.lastIndexOf(key);
      if (pos >= 0 && pos > bestPos) {
        bestPos = pos;
        bestCat = c;
      }
    }

    let cat = bestCat;

    if (!cat) {
      const catMatch = preceding.match(/(?:^|[\s(])(\d{2})(?![\d_])(?:[\s:]|[^$]{0,80})$/);
      if (catMatch) {
        const twoDigit = catMatch[1];
        const isDateOrPage = /\d{1,2}[\/\-]\d{2}[\/\-]\d{2,4}$|\d{2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}$|page\s+\d{2}\s+of\s+\d+/i.test(preceding.slice(-50));
        if (!isDateOrPage && allowedCats.has(twoDigit)) {
          cat = twoDigit;
        }
      }
    }
    if (!cat) {
      continue;
    }

    // Core funding can describe included sub-allocations; never treat those include amounts
    // as standalone category 03 budgets.
    const hasIncludeInCoreWindow = section === 'core' && /(?:includes?|including)\b/i.test(precedingLower.slice(-220));
    const statedSupportNearby = containsStatedSupport(precedingLower.slice(-260)) || containsStatedSupport(text.slice(m.index, Math.min(text.length, m.index + 220)).toLowerCase());
    if (cat === '03' && hasIncludeInCoreWindow) {
      // "Includes $X" is usually a sub-allocation in Core, except when it is explicitly
      // marked as a Stated support/item which should be budgeted.
      if (!statedSupportNearby) continue;
    }

    seen.add(cat);
    const name = catNames[cat] || `Category ${cat}`;
    const lineItems = (text.slice(m.index, m.index + 80).match(/\d{2}_\d{3}_\d{4}_\d_\d/g) || []);
    budgets.push({
      category: cat,
      name,
      amount,
      line_item_numbers: lineItems,
      management_type: 'self',
      is_stated_support: statedSupportNearby,
      auto_budgeted: statedSupportNearby
    });
  }

  if (budgets.length === 0) return { format: 'pdf', budgets: [], plan_dates: planDates, total_plan_budget, error: 'Could not extract budget from PDF. Try uploading a CSV with the breakdown.' };
  return {
    format: 'pdf',
    budgets,
    plan_dates: planDates,
    total_plan_budget
  };
}

function normalizeParsedAmount(raw) {
  const value = typeof raw === 'number'
    ? raw
    : parseFloat(String(raw ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

// List all participants (scoped by assignment for support coordinators)
router.get('/', (req, res) => {
  try {
    const { search, include_archived } = req.query;
    const userId = req.session?.user?.id;
    const assignedIds = userId ? getAssignedParticipantIds(userId) : null;

    const dbUser = userId ? db.prepare('SELECT role, org_id, email FROM users WHERE id = ?').get(userId) : null;
    const orgScoped = Boolean(dbUser?.org_id) && !isSuperAdminEmail(dbUser?.email);

    let sql = `
      SELECT p.*, o.name as plan_manager_name
      FROM participants p
      LEFT JOIN organisations o ON p.plan_manager_id = o.id`;
    const params = [];
    if (orgScoped) {
      const legacyNull = includeNullProviderParticipantsForUser(dbUser);
      sql += legacyNull
        ? ' WHERE (p.provider_org_id = ? OR p.provider_org_id IS NULL)'
        : ' WHERE p.provider_org_id = ?';
      params.push(dbUser.org_id);
    }
    sql += ' ORDER BY p.name';
    let participants = db.prepare(sql).all(...params);

    if (assignedIds !== null) {
      const idSet = new Set(assignedIds);
      participants = participants.filter(p => idSet.has(p.id));
    }

    if (include_archived !== 'true' && include_archived !== '1') {
      participants = participants.filter(p => !p.archived_at || p.archived_at === '');
    }

    if (search) {
      participants = participants.filter(
        p => (p.name && p.name.toLowerCase().includes(search.toLowerCase())) ||
          (p.ndis_number && p.ndis_number.includes(search))
      );
    }
    res.json(participants);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Budget utilization for participant's current plan (used vs budget per category)
router.get('/:id/budget-utilization', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const plan = db.prepare(`
      SELECT * FROM ndis_plans
      WHERE participant_id = ? AND start_date <= ? AND end_date >= ?
      ORDER BY start_date DESC LIMIT 1
    `).get(req.params.id, today, today);
    if (!plan) return res.json({ plan: null, budgets: [] });

    const budgets = db.prepare(`
      SELECT pb.*, bli.ndis_line_item_id
      FROM plan_budgets pb
      LEFT JOIN budget_line_items bli ON bli.budget_id = pb.id
      WHERE pb.plan_id = ?
    `).all(plan.id);

    const budgetById = {};
    for (const b of budgets) {
      if (!budgetById[b.id]) {
        budgetById[b.id] = { id: b.id, name: b.name, category: b.category, amount: b.amount, used: 0, line_item_ids: [] };
      }
      if (b.ndis_line_item_id) budgetById[b.id].line_item_ids.push(b.ndis_line_item_id);
    }

    const shifts = db.prepare(`
      SELECT s.id, s.start_time, s.end_time
      FROM shifts s
      WHERE s.participant_id = ?
        AND s.start_time >= ? AND s.start_time <= ?
    `).all(req.params.id, `${plan.start_date} 00:00:00`, `${plan.end_date} 23:59:59`);

    const shiftIds = shifts.map(s => s.id);
    if (shiftIds.length > 0) {
      const placeholders = shiftIds.map(() => '?').join(',');
      const lineItems = db.prepare(`
        SELECT sli.shift_id, sli.ndis_line_item_id, sli.quantity, sli.unit_price
        FROM shift_line_items sli
        WHERE sli.shift_id IN (${placeholders})
      `).all(...shiftIds);

      for (const li of lineItems) {
        const cost = (li.quantity || 0) * (li.unit_price || 0);
        for (const bid of Object.keys(budgetById)) {
          const b = budgetById[bid];
          if (b.line_item_ids.includes(li.ndis_line_item_id)) {
            b.used += cost;
            break; // only one budget per line item
          }
        }
      }
    }

    const result = Object.values(budgetById).map(b => ({
      id: b.id,
      name: b.name,
      category: b.category,
      amount: b.amount,
      used: Math.round(b.used * 100) / 100,
      remaining: Math.round((b.amount - b.used) * 100) / 100,
      percent_used: b.amount > 0 ? Math.round((b.used / b.amount) * 100) : 0
    }));

    res.json({ plan: { id: plan.id, start_date: plan.start_date, end_date: plan.end_date }, budgets: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single participant with full details
router.get('/:id', (req, res) => {
  try {
    const participant = db.prepare(`
      SELECT p.*, o.name as plan_manager_name, o.email as plan_manager_email,
        nli.support_item_number as default_line_item_number, nli.description as default_line_item_description
      FROM participants p
      LEFT JOIN organisations o ON p.plan_manager_id = o.id
      LEFT JOIN ndis_line_items nli ON p.default_ndis_line_item_id = nli.id
      WHERE p.id = ?
    `).get(req.params.id);
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    const plans = db.prepare('SELECT * FROM ndis_plans WHERE participant_id = ? ORDER BY start_date DESC').all(req.params.id);
    const planIds = plans.map(p => p.id);
    const budgetsByPlan = {};
    if (planIds.length > 0) {
      const placeholders = planIds.map(() => '?').join(',');
      const budgets = db.prepare(`SELECT * FROM plan_budgets WHERE plan_id IN (${placeholders})`).all(...planIds);
      const budgetIds = budgets.map(b => b.id);
      const lineItemsByBudget = {};
      if (budgetIds.length > 0) {
        const bPlaceholders = budgetIds.map(() => '?').join(',');
        const blItems = db.prepare(`
          SELECT bli.*, n.support_item_number, n.description, n.rate, n.rate_remote, n.rate_very_remote, n.unit
          FROM budget_line_items bli
          JOIN ndis_line_items n ON bli.ndis_line_item_id = n.id
          WHERE bli.budget_id IN (${bPlaceholders})
        `).all(...budgetIds);
        blItems.forEach(li => {
          if (!lineItemsByBudget[li.budget_id]) lineItemsByBudget[li.budget_id] = [];
          lineItemsByBudget[li.budget_id].push(li);
        });
      }
      const implementations = budgetIds.length > 0
        ? db.prepare(`
          SELECT i.*, o.name as provider_name,
            n.support_item_number, n.rate as line_item_rate, n.rate_remote, n.rate_very_remote, n.unit as line_item_unit
          FROM implementations i
          LEFT JOIN organisations o ON i.provider_type = 'organisation' AND i.provider_id = o.id
          LEFT JOIN ndis_line_items n ON i.ndis_line_item_id = n.id
          WHERE i.budget_id IN (${budgetIds.map(() => '?').join(',')})
        `).all(...budgetIds)
        : [];
      const implByBudget = {};
      implementations.forEach(impl => {
        if (!implByBudget[impl.budget_id]) implByBudget[impl.budget_id] = [];
        implByBudget[impl.budget_id].push(impl);
      });
      budgets.forEach(b => {
        if (!budgetsByPlan[b.plan_id]) budgetsByPlan[b.plan_id] = [];
        budgetsByPlan[b.plan_id].push({ ...b, line_items: lineItemsByBudget[b.id] || [], allocations: implByBudget[b.id] || [] });
      });
    }
    const plansWithBudgets = plans.map((p) => ({
      ...p,
      fund_release_schedule: parseFundReleaseScheduleFromDb(p.fund_release_schedule),
      budgets: budgetsByPlan[p.id] || []
    }));
    const participantContacts = db.prepare(`
      SELECT pc.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone, c.role,
             o.name as org_name
      FROM participant_contacts pc
      JOIN contacts c ON pc.contact_id = c.id
      LEFT JOIN organisations o ON c.organisation_id = o.id
      WHERE pc.participant_id = ?
    `).all(req.params.id);
    const goals = db.prepare('SELECT * FROM participant_goals WHERE participant_id = ? AND (archived_at IS NULL OR archived_at = \'\')').all(req.params.id);
    const documents = db.prepare('SELECT * FROM participant_documents WHERE participant_id = ?').all(req.params.id);
    const caseNotes = db.prepare('SELECT * FROM case_notes WHERE participant_id = ? ORDER BY contact_date DESC').all(req.params.id);
    const shifts = db.prepare(`
      SELECT s.*, st.name as staff_name
      FROM shifts s
      JOIN staff st ON s.staff_id = st.id
      WHERE s.participant_id = ?
      ORDER BY s.start_time DESC
    `).all(req.params.id);

    res.json({
      ...participant,
      plans: plansWithBudgets,
      contacts: participantContacts,
      goals,
      documents,
      case_notes: caseNotes,
      shifts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create participant (admin, delegate with grant, or support coordinator — coordinators are auto-assigned)
router.post('/', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const id = uuidv4();
    const { name, ndis_number, email, phone, address, date_of_birth, plan_manager_id, remoteness, notes, parent_guardian_phone, parent_guardian_email, diagnosis, services_required, management_type, ndia_managed_services, plan_managed_services, invoice_emails, invoice_includes_gst } = req.body;
    const servicesJson = typeof services_required === 'string' ? services_required : (Array.isArray(services_required) ? JSON.stringify(services_required) : null);
    const ndiaJson = typeof ndia_managed_services === 'string' ? ndia_managed_services : (Array.isArray(ndia_managed_services) ? JSON.stringify(ndia_managed_services) : null);
    const planJson = typeof plan_managed_services === 'string' ? plan_managed_services : (Array.isArray(plan_managed_services) ? JSON.stringify(plan_managed_services) : null);
    const invoiceEmailsJson = typeof invoice_emails === 'string' ? invoice_emails : (Array.isArray(invoice_emails) ? JSON.stringify(invoice_emails) : null);
    const providerOrgId = getProviderOrgIdForUser(req.session?.user?.id);
    const includesGst = invoice_includes_gst === true || invoice_includes_gst === 1 || invoice_includes_gst === '1' ? 1 : 0;
    db.prepare(`
      INSERT INTO participants (id, name, ndis_number, email, phone, address, date_of_birth, plan_manager_id, remoteness, notes, parent_guardian_phone, parent_guardian_email, diagnosis, services_required, management_type, ndia_managed_services, plan_managed_services, invoice_emails, invoice_includes_gst, provider_org_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name || '', ndis_number || null, email || null, phone || null, address || null, date_of_birth || null, plan_manager_id || null, remoteness || 'standard', notes || null, parent_guardian_phone || null, parent_guardian_email || null, diagnosis || null, servicesJson, management_type || 'self', ndiaJson, planJson, invoiceEmailsJson, includesGst, providerOrgId || null);
    assignCreatorIfSupportCoordinator(req.session?.user?.id, id);
    res.status(201).json({ id, ...req.body });
  } catch (err) {
    console.error('Create participant error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Parse Client Intake Form PDF (preview only, no create)
router.post('/parse-intake-form', memoryUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded. Upload a completed Client Intake Form PDF.' });
    }
    const ext = (req.file.originalname || '').toLowerCase();
    if (!ext.endsWith('.pdf')) {
      return res.status(400).json({ error: 'Upload a PDF file (Client Intake Form).' });
    }
    let pdfText = '';
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      pdfText = data?.text || '';
    } catch (e) {
      console.error('PDF parse error:', e);
      return res.status(400).json({ error: 'Could not read PDF. Ensure it is a valid PDF file.' });
    }
    const parsed = await parseIntakeFormText(pdfText);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    res.json(parsed);
  } catch (err) {
    console.error('Parse intake form error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create participant from completed Client Intake Form PDF (or from pre-parsed JSON)
router.post('/from-intake-form', requireCoordinatorOrAdmin, memoryUpload.single('file'), async (req, res) => {
  try {
    let parsed;

    if (req.file?.buffer) {
      const ext = (req.file.originalname || '').toLowerCase();
      if (!ext.endsWith('.pdf')) {
        return res.status(400).json({ error: 'Upload a PDF file (Client Intake Form).' });
      }
      let pdfText = '';
      try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(req.file.buffer);
        pdfText = data?.text || '';
      } catch (e) {
        console.error('PDF parse error:', e);
        return res.status(400).json({ error: 'Could not read PDF. Ensure it is a valid PDF file.' });
      }
      parsed = await parseIntakeFormText(pdfText);
    } else if (req.body?.participant) {
      parsed = {
        participant: req.body.participant,
        intake: req.body.intake || {},
        contacts: req.body.contacts || [],
        plan: req.body.plan || null,
        goals: req.body.goals || []
      };
    } else {
      return res.status(400).json({ error: 'No file uploaded. Upload a completed Client Intake Form PDF, or provide parsed JSON.' });
    }
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const { participant: pData, intake, contacts, plan, goals } = parsed;
    if (!pData?.name || !pData.name.trim()) {
      return res.status(400).json({ error: 'Could not extract participant name from the form. Please ensure the Client Intake Form is completed and legible.' });
    }

    const invoiceEmails = [];
    if (intake?.plan_manager_invoice_email) invoiceEmails.push(intake.plan_manager_invoice_email);
    if (req.body?.invoice_emails && Array.isArray(req.body.invoice_emails)) {
      req.body.invoice_emails.forEach((e) => { if (e && !invoiceEmails.includes(e)) invoiceEmails.push(e); });
    }

    // Assign plan manager when invoice email or details exist (for plan-managed clients)
    const providerOrgId = getProviderOrgIdForUser(req.session?.user?.id);
    let planManagerId = null;
    const { name: pmName, email: pmEmail } = parsePlanManagerFromIntake(intake);
    if (pmName || pmEmail) {
      const { orgByName, orgByEmail } = buildOrgLookupMaps(providerOrgId);
      planManagerId = ensurePlanManagerOrg(orgByName, orgByEmail, pmName, pmEmail, providerOrgId);
      if (pmEmail && !invoiceEmails.includes(pmEmail)) invoiceEmails.unshift(pmEmail);
    }

    const result = createParticipantFromIntakeData({
      participant: pData,
      intake,
      contacts,
      plan,
      goals,
      remoteness: 'standard',
      uploadedFile: req.file || null,
      invoiceEmails: invoiceEmails.length > 0 ? invoiceEmails : null,
      planManagerId,
      providerOrgId
    });

    assignCreatorIfSupportCoordinator(req.session?.user?.id, result.participantId);

    const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(result.participantId);
    res.status(201).json({
      participant: { ...participant, plan_manager_name: null },
      created_contacts: result.created_contacts,
      created_goals: result.created_goals,
      plan_created: result.plan_created,
      onboarding_initialized: result.onboarding_initialized
    });
  } catch (err) {
    console.error('Create from intake form error:', err);
    res.status(500).json({ error: err.message });
  }
});

function normalizeFundingManagement(val) {
  if (!val || typeof val !== 'string') return 'self';
  const v = val.trim().toLowerCase();
  if (v.includes('plan') || v === 'plan') return 'plan';
  if (v.includes('ndia') || v === 'ndia') return 'ndia';
  return 'self';
}

/**
 * Shared helper: create participant from intake-shaped data.
 * Used by both PDF intake form and CSV import.
 * @param {{ participant: object, intake: object, contacts: object[], plan: object|null, goals: string[], planManagerId?: string|null, remoteness?: string, uploadedFile?: object }} options
 * @returns {{ participantId: string, created_contacts: number, created_goals: number, plan_created: boolean, onboarding_initialized: boolean }}
 */
function createParticipantFromIntakeData({
  participant: pData,
  intake,
  contacts,
  plan,
  goals,
  planManagerId = null,
  remoteness = 'standard',
  uploadedFile = null,
  invoiceEmails = null,
  providerOrgId = null
}) {
  const participantId = uuidv4();
  const managementType = normalizeFundingManagement(intake?.funding_management_type);
  const diagnosis = [intake?.medical_conditions, intake?.mental_health_summary].filter(Boolean).join('; ') || null;
  const notes = [intake?.additional_notes, intake?.support_needs].filter(Boolean).join('\n\n') || null;

  const primaryGuardian = contacts?.find((c) => c.role === 'primary_guardian');
  const parentGuardianPhone = primaryGuardian?.phone || null;
  const parentGuardianEmail = primaryGuardian?.email || null;

  const addr = [intake?.street_address, intake?.suburb_city, intake?.state, intake?.postcode].filter(Boolean).join(', ');
  const address = addr || pData?.address || null;

  const invoiceEmailsJson = Array.isArray(invoiceEmails) && invoiceEmails.length > 0
    ? JSON.stringify(invoiceEmails)
    : null;

  db.prepare(`
    INSERT INTO participants (id, name, ndis_number, email, phone, address, date_of_birth, plan_manager_id, remoteness, notes, parent_guardian_phone, parent_guardian_email, diagnosis, management_type, invoice_emails, provider_org_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    participantId,
    (pData?.name || '').trim(),
    (pData?.ndis_number || '').trim() || null,
    (pData?.email || '').trim() || null,
    (pData?.phone || '').trim() || null,
    address,
    pData?.date_of_birth || null,
    planManagerId,
    remoteness,
    notes,
    parentGuardianPhone,
    parentGuardianEmail,
    diagnosis,
    managementType,
    invoiceEmailsJson,
    providerOrgId || null
  );

  let createdContacts = 0;
  for (const c of contacts || []) {
    if (!c.name && !c.phone && !c.email) continue;
    const contactId = uuidv4();
    db.prepare(`
      INSERT INTO contacts (id, organisation_id, name, email, phone, role)
      VALUES (?, NULL, ?, ?, ?, ?)
    `).run(contactId, (c.name || '').trim() || 'Unknown', c.email || null, c.phone || null, c.role || 'contact');
    db.prepare(`
      INSERT INTO participant_contacts (id, participant_id, contact_id, relationship)
      VALUES (?, ?, ?, ?)
    `).run(uuidv4(), participantId, contactId, c.relationship || null);
    createdContacts++;
  }

  let planId = null;
  if (plan?.start_date && plan?.end_date) {
    planId = uuidv4();
    db.prepare(`
      INSERT INTO ndis_plans (id, participant_id, start_date, end_date)
      VALUES (?, ?, ?, ?)
    `).run(planId, participantId, plan.start_date, plan.end_date);
  }

  let createdGoals = 0;
  const goalsList = Array.isArray(goals) ? goals : [];
  if (goalsList.length > 0) {
    const insGoal = db.prepare(`
      INSERT INTO participant_goals (id, participant_id, plan_id, description, status)
      VALUES (?, ?, ?, ?, 'active')
    `);
    for (const g of goalsList.slice(0, 20)) {
      const t = String(g).trim();
      if (t.length >= 12) {
        insGoal.run(uuidv4(), participantId, planId, t);
        createdGoals++;
      }
    }
  }

  if (uploadedFile?.buffer) {
    saveUploadedDocumentFromBuffer(participantId, uploadedFile, 'Client Intake Form');
  }

  let onboardingInitialized = false;
  const onboardingOrgId =
    providerOrgId || db.prepare('SELECT id FROM organisations ORDER BY created_at ASC LIMIT 1').get()?.id;
  if (onboardingOrgId && Object.keys(intake || {}).length > 0) {
    try {
      const onboarding = initializeParticipantOnboarding({ participantId, providerOrganisationId: onboardingOrgId });
      if (onboarding) {
        const intakeFields = {
          preferred_contact_method: pData?.preferred_contact_method || intake?.preferred_contact_method,
          best_time_to_contact: pData?.best_time_to_contact || intake?.best_time_to_contact,
          preferred_start_date: intake?.preferred_start_date,
          consent_email_sms: intake?.consent_email_sms,
          medical_conditions: intake?.medical_conditions,
          medications: intake?.medications,
          allergies: intake?.allergies,
          mobility_supports: intake?.mobility_supports,
          support_needs: intake?.support_needs,
          goals_and_outcomes: intake?.goals_and_outcomes,
          additional_notes: intake?.additional_notes,
          support_category: intake?.support_category,
          plan_start_date: intake?.plan_start_date,
          plan_end_date: intake?.plan_end_date,
          funding_management_type: intake?.funding_management_type,
          plan_manager_details: intake?.plan_manager_details,
          risks_at_home: intake?.risks_at_home,
          triggers_stressors: intake?.triggers_stressors,
          current_supports_strategies: intake?.current_supports_strategies,
          functional_assistance_needs: intake?.functional_assistance_needs,
          living_arrangements: intake?.living_arrangements,
          mental_health_summary: intake?.mental_health_summary
        };
        const cleaned = Object.fromEntries(Object.entries(intakeFields).filter(([, v]) => v != null && String(v).trim()));
        if (Object.keys(cleaned).length > 0) {
          upsertIntakeFields({ participantId, fields: cleaned });
          onboardingInitialized = true;
        }
      }
    } catch (onbErr) {
      console.error('Onboarding init from intake:', onbErr);
    }
  }

  return {
    participantId,
    created_contacts: createdContacts,
    created_goals: createdGoals,
    plan_created: !!planId,
    onboarding_initialized: onboardingInitialized
  };
}

// Parse participants CSV - flexible column mapping for old database exports
function parseParticipantsCsv(buffer) {
  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { rows: [], error: 'CSV needs a header row and at least one data row' };

  const delimiter = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const parseLine = (line) => {
    const result = [];
    let cell = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        i++;
        while (i < line.length) {
          if (line[i] === '"') {
            if (line[i + 1] === '"') {
              cell += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            cell += line[i];
            i++;
          }
        }
      } else if (line[i] === delimiter) {
        result.push(cell.trim());
        cell = '';
        i++;
      } else {
        cell += line[i];
        i++;
      }
    }
    result.push(cell.trim());
    return result;
  };

  const headers = parseLine(lines[0]).map(h => String(h || '').trim().replace(/\u00A0/g, ' '));
  const headerLower = headers.map(h => h.toLowerCase().replace(/[\s\-]+/g, '_').replace(/\u00A0/g, '_'));

  // Flexible column mapping: various names from old DBs -> our schema
  const findCol = (...aliases) => {
    for (const a of aliases) {
      const idx = headerLower.findIndex(h => h === a || h.includes(a) || a.includes(h));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  // Last-name column: must not match generic "name" (avoids "lastname".includes("name") false positive)
  const findColLastName = (...aliases) => {
    const exclude = new Set(['name', 'full_name', 'participant_name', 'client_name', 'participant']);
    for (const a of aliases) {
      const idx = headerLower.findIndex(h =>
        !exclude.has(h) && (h === a || h.includes(a) || a.includes(h))
      );
      if (idx >= 0) return idx;
    }
    return -1;
  };

  // Exact match only – avoids e.g. "invoice_email" matching alias "email"
  const findColExact = (...aliases) => {
    for (const a of aliases) {
      const idx = headerLower.findIndex(h => h === a);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  // Match only headers that contain email-related terms (avoids "plan_manager" matching "plan_manager_invoice_email")
  const findColEmail = (...aliases) => {
    for (const a of aliases) {
      const idx = headerLower.findIndex(h => (h === a || h.includes(a) || a.includes(h)) && (h.includes('email') || h.includes('invoice') || h.includes('billing')));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  // Name: single column or first+middle+last
  const nameIdx = findCol('name', 'participant_name', 'client_name', 'full_name', 'participant');
  const firstNameIdx = findCol('first_name', 'firstname', 'given_name');
  const middleNameIdx = findCol('middle_name', 'middlename');
  const lastNameIdx = findColLastName('last_name', 'lastname', 'surname', 'family_name', 'familyname', 'family', 'second_name', 'second_surname', 'client_surname', 'participant_surname');
  const ndisIdx = findCol('ndis_number', 'ndis', 'participant_ndis_number');
  // Participant contact email – must not match invoice_email (plan manager). Prefer specific columns, then exact "email".
  const emailIdx = findCol('participant_email', 'client_email', 'contact_email') >= 0
    ? findCol('participant_email', 'client_email', 'contact_email')
    : findColExact('email');
  const phoneIdx = findCol('phone', 'participant_phone', 'contact_phone');
  const mobileIdx = findCol('mobile', 'participant_mobile', 'contact_mobile');
  const addressIdx = findCol('address', 'participant_address', 'street', 'postal_address', 'street_address');
  const suburbIdx = findCol('suburb', 'suburb_city', 'city');
  const stateIdx = findCol('state');
  const postcodeIdx = findCol('postcode', 'postal_code', 'post_code');
  const preferredNameIdx = findCol('preferred_name', 'preferred');
  const dobIdx = findCol('date_of_birth', 'dob', 'birth_date');
  const managementIdx = findCol('management_type', 'management', 'funding_type', 'plan_type');
  const planManagerIdx = findCol('plan_manager', 'plan_manager_name', 'fm_name', 'fm');
  // Plan manager invoice email – must match a column with "email"/"invoice"/"billing" (not "plan_manager" name column)
  const planManagerEmailIdx = findColEmail('plan_manager_invoice_email', 'plan_manager_email', 'invoice_email', 'fm_email', 'billing_email', 'recipient_email', 'invoice_to_email');
  // Invoice email: for self-managed = participant email; for plan-managed = plan manager email (same column)
  const selfManagedEmailIdx = findColEmail('self_managed_invoice_email', 'self_managed_email', 'self_invoice_email', 'invoice_email');
  const remotenessIdx = findCol('remoteness', 'region', 'pricing_region');
  const diagnosisIdx = findCol('diagnosis', 'condition', 'medical_conditions');
  const primaryDiagnosisIdx = findCol('primary_diagnosis', 'primary_diagnosis');
  const secondaryDiagnosisIdx = findCol('secondary_diagnosis', 'secondary_diagnosis');
  const parentPhoneIdx = findCol('parent_guardian_phone', 'guardian_phone', 'parent_phone');
  const parentEmailIdx = findCol('parent_guardian_email', 'guardian_email', 'parent_email');
  const primaryContactIdx = findCol('primary_contact', 'primary_contact_name', 'guardian_name', 'contact_name');
  const primaryContactEmailIdx = findCol('primary_contact_email', 'guardian_email');
  const primaryContactPhoneIdx = findCol('primary_contact_mobile', 'primary_contact_phone', 'guardian_phone', 'contact_phone');
  const emergencyContactNameIdx = findCol('emergency_contact_name', 'emergency_contact', 'emergency_name');
  const emergencyContactPhoneIdx = findCol('emergency_contact_phone', 'emergency_contact_mobile', 'emergency_phone');
  const emergencyContactEmailIdx = findCol('emergency_contact_email', 'emergency_email');
  const notesIdx = findCol('notes', 'additional_notes', 'comments', 'tags');
  const planStartIdx = findCol('current_plan_start_date', 'plan_start_date', 'plan_start');
  const planEndIdx = findCol('current_plan_end_date', 'plan_end_date', 'plan_end');
  const commencementIdx = findCol('commencement_date', 'commencement');
  const goalsIdx = findCol('goals', 'goals_and_outcomes', 'participant_goals');
  const medicationsIdx = findCol('medications');
  const allergiesIdx = findCol('allergies', 'allergies_sensitivities');
  const supportCategoryIdx = findCol('support_category', 'support_category_type');
  const additionalInvoiceEmailsIdx = findCol('additional_invoice_emails', 'cc_invoice_emails', 'extra_invoice_emails', 'invoice_cc');

  const hasNameColumn = nameIdx >= 0;
  const hasFirstLast = (firstNameIdx >= 0 || lastNameIdx >= 0);
  if (!hasNameColumn && !hasFirstLast) {
    return { rows: [], error: 'Could not find a name column. Expected: name, first_name+last_name, participant_name, or client_name' };
  }

  const parseCsvDate = (val) => {
    if (!val || typeof val !== 'string') return null;
    const s = val.trim();
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const [, d, m, y] = dmy;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  };

  // Parse management type: Self Managed Invoice Email = self, Plan Manager/Invoice Email = plan, neither = ndia
  const parseCsvManagementType = (rawManagement, planManagerName, planManagerEmail, selfManagedEmail) => {
    const v = String(rawManagement || '').trim().toLowerCase();
    if (v.includes('ndia') || v === 'ndia') return 'ndia';
    if (v.includes('self') && !v.includes('plan')) return 'self';
    if (v.includes('plan') || v === 'plan' || v.includes('fm') || v.includes('financial')) return 'plan';
    if (planManagerName || planManagerEmail) return 'plan';
    if (selfManagedEmail) return 'self';
    return 'ndia';
  };

  const getCell = (cells, idx) => (idx >= 0 && cells[idx] !== undefined ? String(cells[idx] || '').trim() || null : null);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);

    // Prefer first+middle+last when last_name has data (fixes surname being dropped when "name" column exists)
    let name;
    let last = getCell(cells, lastNameIdx);
    const nameColVal = hasNameColumn ? getCell(cells, nameIdx) : null;
    // Fallback: if no family-name column found but name column has "First Last", use last word(s) as surname
    if (!last && nameColVal && nameColVal.includes(' ')) {
      const parts = nameColVal.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) last = parts.slice(1).join(' ');
    }
    const first = getCell(cells, firstNameIdx) || (hasNameColumn && nameColVal ? nameColVal.split(/\s+/)[0] : '');
    const middle = getCell(cells, middleNameIdx) || '';
    if (last && (firstNameIdx >= 0 || lastNameIdx >= 0 || (hasNameColumn && nameIdx >= 0))) {
      name = [first, middle, last].filter(Boolean).join(' ').trim();
    } else if (hasNameColumn) {
      name = nameColVal;
    } else if (firstNameIdx >= 0 || lastNameIdx >= 0) {
      name = [first, middle, last].filter(Boolean).join(' ').trim();
    }
    if (!name) continue;

    const planManagerName = getCell(cells, planManagerIdx);
    const planManagerEmail = getCell(cells, planManagerEmailIdx);
    const selfManagedEmail = getCell(cells, selfManagedEmailIdx);
    const rawManagement = getCell(cells, managementIdx);
    const managementType = parseCsvManagementType(rawManagement, planManagerName, planManagerEmail, selfManagedEmail);

    const participantEmail = getCell(cells, emailIdx);
    const email = managementType === 'self' && selfManagedEmail ? selfManagedEmail : participantEmail;

    const phone = getCell(cells, phoneIdx) || getCell(cells, mobileIdx);

    let diagnosis = getCell(cells, diagnosisIdx);
    if (!diagnosis && (primaryDiagnosisIdx >= 0 || secondaryDiagnosisIdx >= 0)) {
      const primary = getCell(cells, primaryDiagnosisIdx) || '';
      const secondary = getCell(cells, secondaryDiagnosisIdx) || '';
      diagnosis = [primary, secondary].filter(Boolean).join('; ') || null;
    }

    const parentPhone = getCell(cells, parentPhoneIdx);
    const parentEmail = getCell(cells, parentEmailIdx);
    const emergencyContactName = getCell(cells, emergencyContactNameIdx);
    const emergencyContactPhone = getCell(cells, emergencyContactPhoneIdx);
    const emergencyContactEmail = getCell(cells, emergencyContactEmailIdx);

    let notes = getCell(cells, notesIdx);
    const primaryContact = getCell(cells, primaryContactIdx);
    const primaryContactEmail = getCell(cells, primaryContactEmailIdx);
    const primaryContactPhone = getCell(cells, primaryContactPhoneIdx);
    const commencement = getCell(cells, commencementIdx);
    if (primaryContact || primaryContactEmail || primaryContactPhone || commencement) {
      const parts = [];
      if (primaryContact) parts.push(`Primary contact: ${primaryContact}`);
      if (primaryContactEmail) parts.push(`Primary contact email: ${primaryContactEmail}`);
      if (primaryContactPhone) parts.push(`Primary contact phone: ${primaryContactPhone}`);
      if (commencement) parts.push(`Commencement: ${commencement}`);
      notes = notes ? `${notes}\n\n${parts.join('\n')}` : parts.join('\n');
    }

    const planStartDate = planStartIdx >= 0 ? parseCsvDate(cells[planStartIdx]) : null;
    const planEndDate = planEndIdx >= 0 ? parseCsvDate(cells[planEndIdx]) : null;

    const address = getCell(cells, addressIdx);
    const suburb = getCell(cells, suburbIdx);
    const state = getCell(cells, stateIdx);
    const postcode = getCell(cells, postcodeIdx);
    const fullAddress = address || ([suburb, state, postcode].filter(Boolean).length ? [address, suburb, state, postcode].filter(Boolean).join(', ') : null);

    const planManagerDetails = [planManagerName, planManagerEmail].filter(Boolean).join(planManagerName && planManagerEmail ? ' – ' : '') || null;

    // Build invoice_emails: primary invoice recipient + any additional CC emails
    const primaryInvoiceEmail = managementType === 'plan' ? planManagerEmail : (selfManagedEmail || participantEmail);
    const additionalRaw = getCell(cells, additionalInvoiceEmailsIdx);
    const additionalEmails = additionalRaw ? additionalRaw.split(/[;,]/).map((e) => e.trim()).filter((e) => e.includes('@')) : [];
    const invoiceEmails = [primaryInvoiceEmail, ...additionalEmails].filter(Boolean);

    let goals = null;
    const goalsRaw = getCell(cells, goalsIdx);
    if (goalsRaw) {
      goals = goalsRaw.split(/[;|]|\n/).map((g) => g.trim()).filter((g) => g.length >= 12);
    }

    rows.push({
      name,
      preferred_name: preferredNameIdx >= 0 ? getCell(cells, preferredNameIdx) : null,
      ndis_number: getCell(cells, ndisIdx),
      email,
      phone,
      address: fullAddress,
      street_address: address,
      suburb_city: suburb,
      state,
      postcode,
      date_of_birth: dobIdx >= 0 ? parseCsvDate(cells[dobIdx]) : null,
      management_type: managementType,
      plan_manager_name: planManagerName,
      plan_manager_email: planManagerEmail,
      plan_manager_details: planManagerDetails,
      invoice_emails: invoiceEmails.length > 0 ? invoiceEmails : null,
      remoteness: remotenessIdx >= 0 ? (getCell(cells, remotenessIdx) || 'standard').toLowerCase() : 'standard',
      diagnosis,
      medical_conditions: diagnosis,
      medications: medicationsIdx >= 0 ? getCell(cells, medicationsIdx) : null,
      allergies: allergiesIdx >= 0 ? getCell(cells, allergiesIdx) : null,
      support_category: supportCategoryIdx >= 0 ? getCell(cells, supportCategoryIdx) : null,
      parent_guardian_phone: parentPhone,
      parent_guardian_email: parentEmail,
      primary_contact_name: primaryContact,
      primary_contact_email: primaryContactEmail || parentEmail,
      primary_contact_phone: primaryContactPhone || parentPhone,
      emergency_contact_name: emergencyContactName,
      emergency_contact_phone: emergencyContactPhone,
      emergency_contact_email: emergencyContactEmail,
      notes,
      additional_notes: notes,
      plan_start_date: planStartDate,
      plan_end_date: planEndDate,
      goals,
      _row: i + 1
    });
  }

  const columnMapping = {};
  if (nameIdx >= 0) columnMapping.name = headers[nameIdx];
  if (firstNameIdx >= 0) columnMapping.first_name = headers[firstNameIdx];
  if (lastNameIdx >= 0) columnMapping.last_name = headers[lastNameIdx];
  if (middleNameIdx >= 0) columnMapping.middle_name = headers[middleNameIdx];
  return { rows, headers: headerLower, columnMapping };
}

/** LLM-assisted CSV parse: ask Ollama to map non-standard headers to our schema, then parse. Falls back to deterministic parse if LLM unavailable. */
async function parseParticipantsCsvWithLlm(buffer) {
  const baseResult = parseParticipantsCsv(buffer);
  if (baseResult.error && baseResult.rows.length === 0) return baseResult;
  if (!(await llm.isAvailable())) {
    console.warn('[participants] Ollama not available, using rule-based CSV mapping');
    return { ...baseResult, llmUsed: false };
  }

  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return baseResult;

  const delimiter = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const parseLine = (line) => {
    const result = [];
    let cell = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        i++;
        while (i < line.length) {
          if (line[i] === '"') {
            if (line[i + 1] === '"') {
              cell += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            cell += line[i];
            i++;
          }
        }
      } else if (line[i] === delimiter) {
        result.push(cell.trim());
        cell = '';
        i++;
      } else {
        cell += line[i];
        i++;
      }
    }
    result.push(cell.trim());
    return result;
  };
  const headers = parseLine(lines[0]).map((h) => String(h || '').trim().replace(/\u00A0/g, ' '));
  const prompt = `You are mapping CSV column headers to participant intake fields. Given these headers: ${JSON.stringify(headers)}

Return a JSON object mapping each header (exact string) to one of: name, first_name, last_name, middle_name, preferred_name, ndis_number, email, phone, address, date_of_birth, management_type, plan_manager_name, plan_manager_email, invoice_email, additional_invoice_emails, plan_start_date, plan_end_date, diagnosis, medical_conditions, medications, allergies, goals, support_category, notes, primary_contact_name, primary_contact_email, primary_contact_phone, parent_guardian_phone, parent_guardian_email, emergency_contact_name, emergency_contact_phone, emergency_contact_email. Use null for headers that don't map. IMPORTANT: Map "Family Name", "Surname", "Last Name" to last_name. Example: {"Client Name":"name","First Name":"first_name","Family Name":"last_name","NDIS #":"ndis_number","Guardian":"primary_contact_name"}`;

  try {
    const mapping = await llm.completeJson(prompt, { maxTokens: 500 });
    if (!mapping || typeof mapping !== 'object') return { ...baseResult, llmUsed: false };

    const headerToField = {};
    for (const [h, f] of Object.entries(mapping)) {
      if (h && f && typeof f === 'string') headerToField[String(h).trim()] = String(f).trim();
    }
    // Auto-map family name column if LLM missed it
    const lastMapped = Object.values(headerToField).includes('last_name');
    if (!lastMapped) {
      const familyLike = headers.find(h => {
        const n = String(h || '').toLowerCase();
        return (n.includes('family') || n.includes('surname') || n === 'last name' || n === 'lastname') && !n.includes('first');
      });
      if (familyLike) headerToField[familyLike] = 'last_name';
    }
    // Auto-map plan manager name if LLM missed it (directory linking)
    const planManagerNameMapped = Object.values(headerToField).includes('plan_manager_name');
    if (!planManagerNameMapped) {
      const planManagerLike = headers.find(h => {
        const n = String(h || '').toLowerCase();
        return (n.includes('plan manager') || n.includes('plan management') || n === 'fm' || n.includes('financial manager')) && !n.includes('email');
      });
      if (planManagerLike) headerToField[planManagerLike] = 'plan_manager_name';
    }
    // Auto-map plan manager / invoice email if LLM missed it (invoice emails)
    const planManagerEmailMapped = Object.values(headerToField).includes('plan_manager_email');
    const invoiceEmailMapped = Object.values(headerToField).includes('invoice_email');
    if (!planManagerEmailMapped) {
      const pmEmailLike = headers.find(h => {
        const n = String(h || '').toLowerCase();
        return (n.includes('plan manager') && n.includes('email')) || n.includes('plan manager email') || n.includes('fm email');
      });
      if (pmEmailLike) headerToField[pmEmailLike] = 'plan_manager_email';
    }
    if (!invoiceEmailMapped && !Object.values(headerToField).includes('plan_manager_email')) {
      const invEmailLike = headers.find(h => {
        const n = String(h || '').toLowerCase();
        return (n.includes('invoice') && n.includes('email')) || n.includes('invoice to') || n.includes('billing email') || n.includes('recipient email') || n === 'invoice email' || n === 'billing';
      });
      if (invEmailLike) headerToField[invEmailLike] = 'invoice_email';
    }
    if (Object.keys(headerToField).length === 0) return { ...baseResult, llmUsed: false };

    const parseCsvDate = (val) => {
      if (!val || typeof val !== 'string') return null;
      const s = val.trim();
      const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (dmy) {
        const [, d, m, y] = dmy;
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      return null;
    };

    const headerIdx = {};
    headers.forEach((h, i) => {
      headerIdx[h] = i;
    });

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseLine(lines[i]);
      const raw = {};
      for (const [h, field] of Object.entries(headerToField)) {
        const idx = headerIdx[h];
        if (idx >= 0 && cells[idx] !== undefined) {
          const v = String(cells[idx] || '').trim() || null;
          if (field === 'date_of_birth' || field === 'plan_start_date' || field === 'plan_end_date') {
            raw[field] = parseCsvDate(cells[idx]);
          } else {
            raw[field] = v;
          }
        }
      }

      // Fallback: extract surname from name column when it has "First Last" format
      if (!raw.last_name && raw.name && String(raw.name).includes(' ')) {
        const parts = String(raw.name).split(/\s+/).filter(Boolean);
        if (parts.length >= 2) raw.last_name = parts.slice(1).join(' ');
      }
      const name = raw.name || [raw.first_name, raw.middle_name, raw.last_name].filter(Boolean).join(' ').trim();
      if (!name) continue;

      const managementType = (raw.management_type || '').toLowerCase().includes('plan') ? 'plan' : (raw.management_type || '').toLowerCase().includes('ndia') ? 'ndia' : 'self';
      const email = raw.email || (managementType === 'plan' ? raw.plan_manager_email || raw.invoice_email : raw.invoice_email) || null;
      const goals = raw.goals ? raw.goals.split(/[;|]|\n/).map((g) => g.trim()).filter((g) => g.length >= 12) : null;

      const primaryInvEmail = managementType === 'plan' ? (raw.plan_manager_email || raw.invoice_email) : (raw.invoice_email || raw.email);
      const extraEmails = raw.additional_invoice_emails ? raw.additional_invoice_emails.split(/[;,]/).map((e) => e.trim()).filter((e) => e.includes('@')) : [];
      const invoiceEmails = [primaryInvEmail, ...extraEmails].filter(Boolean);

      rows.push({
        name,
        preferred_name: raw.preferred_name || null,
        ndis_number: raw.ndis_number || null,
        email,
        phone: raw.phone || null,
        address: raw.address || null,
        date_of_birth: raw.date_of_birth || null,
        management_type: managementType,
        plan_manager_name: raw.plan_manager_name || null,
        plan_manager_email: raw.plan_manager_email || raw.invoice_email || null,
        plan_manager_details: [raw.plan_manager_name, raw.plan_manager_email || raw.invoice_email].filter(Boolean).join(' – ') || null,
        invoice_emails: invoiceEmails.length > 0 ? invoiceEmails : null,
        diagnosis: raw.diagnosis || raw.medical_conditions || null,
        medical_conditions: raw.medical_conditions || raw.diagnosis || null,
        medications: raw.medications || null,
        allergies: raw.allergies || null,
        support_category: raw.support_category || null,
        notes: raw.notes || null,
        additional_notes: raw.notes || null,
        plan_start_date: raw.plan_start_date || null,
        plan_end_date: raw.plan_end_date || null,
        goals,
        primary_contact_name: raw.primary_contact_name || null,
        primary_contact_email: raw.primary_contact_email || raw.parent_guardian_email || null,
        primary_contact_phone: raw.primary_contact_phone || raw.parent_guardian_phone || null,
        parent_guardian_phone: raw.parent_guardian_phone || null,
        parent_guardian_email: raw.parent_guardian_email || null,
        emergency_contact_name: raw.emergency_contact_name || null,
        emergency_contact_phone: raw.emergency_contact_phone || null,
        emergency_contact_email: raw.emergency_contact_email || null,
        _row: i + 1
      });
    }

    const inv = {};
    for (const [h, f] of Object.entries(headerToField)) {
      if (f && !inv[f]) inv[f] = h;
    }
    return { rows, headers: headers.map((h) => h.toLowerCase().replace(/\s+/g, '_')), error: rows.length === 0 ? 'No valid rows after LLM mapping' : null, llmUsed: true, columnMapping: { first_name: inv.first_name, last_name: inv.last_name, name: inv.name } };
  } catch (err) {
    console.error('LLM CSV parse error:', err);
    return { ...baseResult, llmUsed: false };
  }
}

// Parse participants CSV (preview only). useLlm in form = try AI-assisted column mapping (Ollama).
router.post('/parse-csv', memoryUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded. Upload a CSV file.' });
    }
    const ext = (req.file.originalname || '').toLowerCase();
    if (!ext.endsWith('.csv') && !ext.endsWith('.txt')) {
      return res.status(400).json({ error: 'Upload a CSV or TXT file.' });
    }
    const useLlm = req.body?.useLlm === 'true' || req.body?.useLlm === true;
    const result = useLlm ? await parseParticipantsCsvWithLlm(req.file.buffer) : { ...parseParticipantsCsv(req.file.buffer), llmUsed: false };
    if (result.error && result.rows.length === 0) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ rows: result.rows, headers: result.headers, total: result.rows.length, columnMapping: result.columnMapping || null, llmUsed: result.llmUsed ?? false });
  } catch (err) {
    console.error('Parse participants CSV error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Import participants from CSV. useLlm in form = try AI-assisted column mapping (Ollama).
router.post('/import-csv', requireCoordinatorOrAdmin, memoryUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded. Upload a CSV file.' });
    }
    const ext = (req.file.originalname || '').toLowerCase();
    if (!ext.endsWith('.csv') && !ext.endsWith('.txt')) {
      return res.status(400).json({ error: 'Upload a CSV or TXT file.' });
    }
    const useLlm = req.body?.useLlm === 'true' || req.body?.useLlm === true;
    const result = useLlm ? await parseParticipantsCsvWithLlm(req.file.buffer) : parseParticipantsCsv(req.file.buffer);
    const { rows, error: parseError } = result;
    if (rows.length === 0) {
      return res.status(400).json({ error: parseError || 'No valid participant rows found. Ensure the CSV has a header row and a name column.' });
    }

    const providerOrgId = getProviderOrgIdForUser(req.session?.user?.id);
    const { orgByName, orgByEmail } = buildOrgLookupMaps(providerOrgId);

    const created = [];
    const skipped = [];
    for (const row of rows) {
      const existing = row.ndis_number
        ? db.prepare('SELECT id, provider_org_id FROM participants WHERE ndis_number = ?').get(row.ndis_number)
        : null;
      if (existing) {
        const myOrg = getProviderOrgIdForUser(req.session?.user?.id);
        const singleOrg = getSingleDistinctUserOrgId();
        const legacyUnscoped =
          existing.provider_org_id == null || String(existing.provider_org_id).trim() === '';
        if (myOrg && singleOrg === myOrg && legacyUnscoped) {
          db.prepare(
            `UPDATE participants SET provider_org_id = ?, updated_at = datetime('now')
             WHERE id = ? AND (provider_org_id IS NULL OR TRIM(COALESCE(provider_org_id, '')) = '')`
          ).run(myOrg, existing.id);
          assignCreatorIfSupportCoordinator(req.session?.user?.id, existing.id);
          skipped.push({
            name: row.name,
            reason: 'Linked existing participant to your organisation (NDIS was already on file)'
          });
          continue;
        }
        skipped.push({ name: row.name, reason: 'NDIS number already exists' });
        continue;
      }

      const planManagerId = (row.plan_manager_name || row.plan_manager_email)
        ? ensurePlanManagerOrg(orgByName, orgByEmail, row.plan_manager_name, row.plan_manager_email, providerOrgId)
        : null;

      const participant = {
        name: row.name,
        preferred_name: row.preferred_name,
        ndis_number: row.ndis_number,
        email: row.email,
        phone: row.phone,
        address: row.address,
        date_of_birth: row.date_of_birth
      };

      const intake = {
        medical_conditions: row.medical_conditions || row.diagnosis,
        medications: row.medications,
        allergies: row.allergies,
        support_category: row.support_category,
        plan_start_date: row.plan_start_date,
        plan_end_date: row.plan_end_date,
        funding_management_type: row.management_type,
        plan_manager_details: row.plan_manager_details,
        additional_notes: row.additional_notes || row.notes,
        street_address: row.street_address,
        suburb_city: row.suburb_city,
        state: row.state,
        postcode: row.postcode
      };

      const contacts = [];
      if (row.primary_contact_name || row.primary_contact_phone || row.primary_contact_email || row.parent_guardian_phone || row.parent_guardian_email) {
        contacts.push({
          role: 'primary_guardian',
          name: row.primary_contact_name || null,
          phone: row.primary_contact_phone || row.parent_guardian_phone || null,
          email: row.primary_contact_email || row.parent_guardian_email || null,
          relationship: row.primary_contact_name ? 'Guardian' : 'Contact'
        });
      }
      if (row.emergency_contact_name || row.emergency_contact_phone || row.emergency_contact_email) {
        contacts.push({
          role: 'emergency',
          name: row.emergency_contact_name || null,
          phone: row.emergency_contact_phone || null,
          email: row.emergency_contact_email || null,
          relationship: 'Emergency'
        });
      }

      const plan = (row.plan_start_date && row.plan_end_date)
        ? { start_date: row.plan_start_date, end_date: row.plan_end_date }
        : null;

      const result = createParticipantFromIntakeData({
        participant,
        intake,
        contacts,
        plan,
        goals: row.goals || [],
        planManagerId,
        remoteness: ['remote', 'very_remote'].includes(row.remoteness) ? row.remoteness : 'standard',
        invoiceEmails: row.invoice_emails || null,
        providerOrgId: getProviderOrgIdForUser(req.session?.user?.id)
      });

      assignCreatorIfSupportCoordinator(req.session?.user?.id, result.participantId);

      created.push({ id: result.participantId, name: row.name });
    }

    try {
      if (result.column_map) {
        for (const [header, field] of Object.entries(result.column_map)) {
          if (header && field) recordMapping('participants', header, field);
        }
      }
    } catch (e) { console.warn('[participants] mapping learning error:', e.message); }

    res.status(201).json({
      created: created.length,
      skipped: skipped.length,
      created_ids: created.map(c => c.id),
      skipped_details: skipped
    });
  } catch (err) {
    console.error('Import participants CSV error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update participant
router.put('/:id', (req, res) => {
  try {
    const { name, ndis_number, email, phone, address, date_of_birth, plan_manager_id, remoteness, notes, parent_guardian_phone, parent_guardian_email, diagnosis, services_required, management_type, ndia_managed_services, plan_managed_services, invoice_emails, default_ndis_line_item_id, invoice_includes_gst } = req.body;
    const servicesJson = typeof services_required === 'string' ? services_required : (Array.isArray(services_required) ? JSON.stringify(services_required) : null);
    const ndiaJson = typeof ndia_managed_services === 'string' ? ndia_managed_services : (Array.isArray(ndia_managed_services) ? JSON.stringify(ndia_managed_services) : null);
    const planJson = typeof plan_managed_services === 'string' ? plan_managed_services : (Array.isArray(plan_managed_services) ? JSON.stringify(plan_managed_services) : null);
    const invoiceEmailsJson = typeof invoice_emails === 'string' ? invoice_emails : (Array.isArray(invoice_emails) ? JSON.stringify(invoice_emails) : null);
    const defaultLineItemId = default_ndis_line_item_id && String(default_ndis_line_item_id).trim() ? String(default_ndis_line_item_id).trim() : null;
    const includesGst = invoice_includes_gst === true || invoice_includes_gst === 1 || invoice_includes_gst === '1' ? 1 : 0;
    const before = db.prepare('SELECT name FROM participants WHERE id = ?').get(req.params.id);
    db.prepare(`
      UPDATE participants SET
        name = ?, ndis_number = ?, email = ?, phone = ?, address = ?,
        date_of_birth = ?, plan_manager_id = ?, remoteness = ?, notes = ?,
        parent_guardian_phone = ?, parent_guardian_email = ?, diagnosis = ?, services_required = ?,
        management_type = ?, ndia_managed_services = ?, plan_managed_services = ?,
        invoice_emails = ?, default_ndis_line_item_id = ?, invoice_includes_gst = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, ndis_number, email, phone, address, date_of_birth, plan_manager_id, remoteness || 'standard', notes, parent_guardian_phone || null, parent_guardian_email || null, diagnosis || null, servicesJson, management_type || 'self', ndiaJson, planJson, invoiceEmailsJson, defaultLineItemId, includesGst, req.params.id);
    const nameChanged =
      before && String(before.name || '').trim() !== String(name || '').trim();
    if (nameChanged) {
      scheduleMirrorShiftsForParticipantId(req.params.id);
    }
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Archive participant (soft delete)
router.post('/:id/archive', (req, res) => {
  try {
    db.prepare('UPDATE participants SET archived_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
    res.json({ id: req.params.id, archived: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unarchive participant
router.post('/:id/unarchive', (req, res) => {
  try {
    db.prepare('UPDATE participants SET archived_at = NULL WHERE id = ?').run(req.params.id);
    res.json({ id: req.params.id, archived: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete participant (hard delete – removes all related data)
router.delete('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const shiftIds = db.prepare('SELECT id FROM shifts WHERE participant_id = ?').all(id).map((r) => r.id);
    const deleteParticipant = db.transaction(() => {
      // Tables referencing shifts/coordinator_tasks without ON DELETE CASCADE
      db.prepare(`DELETE FROM billing_invoice_line_items WHERE source_shift_id IN (SELECT id FROM shifts WHERE participant_id = ?) OR source_task_id IN (SELECT id FROM coordinator_tasks WHERE participant_id = ?)`).run(id, id);
      db.prepare('DELETE FROM invoices WHERE shift_id IN (SELECT id FROM shifts WHERE participant_id = ?)').run(id);
      db.prepare('DELETE FROM progress_notes WHERE participant_id = ?').run(id);
      // Participant row + remaining cascading children
      db.prepare('DELETE FROM participants WHERE id = ?').run(id);
    });
    deleteParticipant();
    for (const sid of shiftIds) scheduleRemoveShiftFromNexusSupabase(sid);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply plan breakdown - creates plan + all budgets in one action (automation)
router.post('/:id/apply-plan-breakdown', (req, res) => {
  try {
    const { start_date, end_date, is_pace, budgets, goals, fund_release_schedule } = req.body;
    if (!start_date || !end_date || !Array.isArray(budgets) || budgets.length === 0) {
      return res.status(400).json({ error: 'Provide start_date, end_date, and budgets array' });
    }
    const participant = db.prepare('SELECT management_type, ndia_managed_services, plan_managed_services FROM participants WHERE id = ?').get(req.params.id);
    const participantManagement = normalizeManagementType(participant?.management_type, 'self');
    const ndiaManaged = new Set(parseManagedServices(participant?.ndia_managed_services));
    const planManaged = new Set(parseManagedServices(participant?.plan_managed_services));
    const getBudgetManagementType = (budget) => {
      const cat = String(budget?.category || '').padStart(2, '0');
      if (ndiaManaged.has(cat)) return 'ndia';
      if (planManaged.has(cat)) return 'plan';
      return normalizeManagementType(budget?.management_type, participantManagement);
    };
    const planId = uuidv4();
    const scheduleStored = prepareFundReleaseScheduleForStorage(fund_release_schedule, start_date, end_date);
    db.prepare(`
      INSERT INTO ndis_plans (id, participant_id, start_date, end_date, is_pace, fund_release_schedule)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(planId, req.params.id, start_date, end_date, is_pace ? 1 : 0, scheduleStored);
    const insBudget = db.prepare(`
      INSERT INTO plan_budgets (id, plan_id, name, amount, category, management_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insLineItem = db.prepare('INSERT INTO budget_line_items (id, budget_id, ndis_line_item_id) VALUES (?, ?, ?)');
    const insImpl = db.prepare(`
      INSERT INTO implementations (id, plan_id, budget_id, provider_type, provider_id, amount, hours_per_week, ndis_line_item_id, frequency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of budgets) {
      const budgetId = uuidv4();
      const cat = (b.category || '').toString().padStart(2, '0');
      const name = b.name || `Category ${cat}`;
      const amount = parseFloat(b.amount) || 0;
      const managementType = getBudgetManagementType(b);
      if (amount <= 0) continue;
      insBudget.run(budgetId, planId, name, amount, cat, managementType);
      const lineIds = new Set(Array.isArray(b.line_item_ids) ? b.line_item_ids.filter(Boolean) : []);
      for (const a of Array.isArray(b.allocations) ? b.allocations : []) {
        if (a.ndis_line_item_id || a.line_item_id) lineIds.add(a.ndis_line_item_id || a.line_item_id);
      }
      for (const ndisId of lineIds) {
        insLineItem.run(uuidv4(), budgetId, ndisId);
        recordBudgetLineItemSelection(cat, ndisId);
      }
      for (const a of Array.isArray(b.allocations) ? b.allocations : []) {
        if (!a.provider_id) continue;
        const implId = uuidv4();
        const hrs = a.hours != null ? parseFloat(a.hours) : (a.hours_per_week != null ? parseFloat(a.hours_per_week) : null);
        const amt = a.amount != null ? parseFloat(a.amount) : 0;
        const freq = IMPL_FREQUENCIES.includes(a.frequency) ? a.frequency : 'weekly';
        const lineItemId = a.ndis_line_item_id || a.line_item_id || null;
        const serviceName = String(a.service_name || a.description || '').trim();
        insImpl.run(implId, planId, budgetId, 'organisation', a.provider_id, amt, hrs, lineItemId, freq);
        if (serviceName) {
          db.prepare('UPDATE implementations SET description = ? WHERE id = ?').run(serviceName, implId);
        }
      }
    }
    // Archive existing goals when adding a new plan (like budgets, goals are plan-specific)
    db.prepare(`
      UPDATE participant_goals SET archived_at = datetime('now') WHERE participant_id = ? AND (archived_at IS NULL OR archived_at = '')
    `).run(req.params.id);

    // Goals must come from the plan's goals section (parsed at upload). Never use budget narratives.
    const requestedGoals = Array.isArray(goals) && goals.length > 0
      ? goals.map(cleanGoalText).filter((g) => g.length >= 12)
      : [];
    let goals_added = 0;
    if (requestedGoals.length > 0) {
      const existingGoals = db.prepare('SELECT description FROM participant_goals WHERE participant_id = ? AND (archived_at IS NULL OR archived_at = \'\')').all(req.params.id);
      const existingSet = new Set(existingGoals.map((g) => normalizeGoalText(g.description)));
      const insGoal = db.prepare(`
        INSERT INTO participant_goals (id, participant_id, plan_id, description, status, target_date)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const goalText of requestedGoals) {
        const key = normalizeGoalText(goalText);
        if (!key || existingSet.has(key)) continue;
        insGoal.run(uuidv4(), req.params.id, planId, goalText, 'active', null);
        existingSet.add(key);
        goals_added += 1;
      }
    }

    res.status(201).json({
      plan_id: planId,
      start_date,
      end_date,
      is_pace: !!is_pace,
      budgets_created: budgets.length,
      goals_added
    });
  } catch (err) {
    console.error('Apply plan breakdown error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Parse plan document (CSV or PDF) - returns budgets with matched line_item_ids for auto-fill
router.post('/:id/parse-plan', memoryUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const useAi = req.body?.useAi === 'true' || req.body?.useAi === true;
    const ext = (req.file.originalname || '').toLowerCase();
    let parsed;
    let aiFundReleaseSchedule = null;
    if (ext.endsWith('.pdf')) {
      try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(req.file.buffer);
        const pdfText = data?.text || '';
        // Deterministic baseline (strict amounts) + optional local LLM semantic read.
        const deterministic = parsePlanFromPdfText(pdfText);
        deterministic.budgets = (deterministic.budgets || []).map((b) => ({
          ...b,
          amount: normalizeParsedAmount(b?.amount ?? b?.budget),
          support_narrative: b?.support_narrative || '',
          source: 'deterministic',
          is_stated_support: !!b?.is_stated_support,
          auto_budgeted: !!b?.auto_budgeted,
          needs_review: false
        })).filter((b) => b.amount > 0);

        let llmBudgets = [];
        let goals;
        if (useAi && await llm.isAvailable() && pdfText.trim().length > 50) {
          const [aiResult, goalsResult] = await Promise.all([
            extractPlanFromText(pdfText),
            extractPlanGoals(pdfText, true)
          ]);
          llmBudgets = Array.isArray(aiResult?.budgets) ? aiResult.budgets : [];
          aiFundReleaseSchedule = aiResult?.fund_release_schedule ?? null;
          goals = goalsResult;
        } else {
          goals = await extractPlanGoals(pdfText, useAi);
        }

        const allowLlmOnly = (deterministic.budgets || []).length === 0;
        const reconciled = reconcilePlanExtraction({
          text: pdfText,
          deterministicBudgets: deterministic.budgets,
          llmBudgets,
          allowLlmOnly
        });

        const droppedCount = reconciled.dropped.length;
        const mismatchList = reconciled.budgets.filter((b) => b.validation_status === 'needs_review');
        parsed = {
          ...deterministic,
          goals,
          budgets: reconciled.budgets,
          validation_warning: [
            deterministic.validation_warning || null,
            droppedCount > 0 ? `${droppedCount} AI entries were rejected by validation rules.` : null,
            mismatchList.length > 0 ? `${mismatchList.length} categories need review due to AI/deterministic differences.` : null
          ].filter(Boolean).join(' ')
        };
      } catch (e) {
        console.error('PDF parse error:', e);
        const msg = e?.message || String(e);
        return res.status(400).json({ error: `PDF parsing failed: ${msg}. Try uploading a CSV instead.` });
      }
    } else if (ext.endsWith('.csv') || ext.endsWith('.txt')) {
      parsed = parsePlanCsv(req.file.buffer);
      parsed.budgets = (parsed.budgets || []).map((b) => ({ ...b, source: 'table', needs_review: false }));
    } else {
      return res.status(400).json({ error: 'Upload a CSV, TXT, or PDF file' });
    }
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const participant = db.prepare('SELECT management_type, ndia_managed_services, plan_managed_services FROM participants WHERE id = ?').get(req.params.id);
    const participantManagement = normalizeManagementType(participant?.management_type, 'self');
    const ndiaManaged = new Set(parseManagedServices(participant?.ndia_managed_services));
    const planManaged = new Set(parseManagedServices(participant?.plan_managed_services));
    const getBudgetManagementType = (budget) => {
      const cat = String(budget?.category || '').padStart(2, '0');
      if (ndiaManaged.has(cat)) return 'ndia';
      if (planManaged.has(cat)) return 'plan';
      return normalizeManagementType(budget?.management_type, participantManagement);
    };
    // Match line item numbers to ndis_line_items and attach ndis ids + hours estimate.
    // Core categories (01-04) prefer weekday-daytime rates for hour estimates.
    const allItems = db.prepare('SELECT id, support_item_number, rate, rate_remote, rate_very_remote, unit, support_category, rate_type FROM ndis_line_items').all();
    const byNumber = {};
    for (const it of allItems) {
      byNumber[it.support_item_number] = it;
      const norm = normalizeSupportItemNumber(it.support_item_number);
      if (norm && norm !== it.support_item_number) byNumber[norm] = it;
    }
    // If no line items from parse, auto-pick first available for category from NDIS catalogue
    const itemsByCat = {};
    for (const it of allItems) {
      const sc = it.support_category || (it.support_item_number?.split('_')[0]);
      if (sc && /^\d{2}$/.test(sc)) {
        if (!itemsByCat[sc]) itemsByCat[sc] = [];
        itemsByCat[sc].push(it);
      }
    }
    const CORE_CATEGORIES = new Set(['01', '02', '03', '04']);
    const isWeekdayDaytime = (item) => {
      const rt = String(item?.rate_type || '').toLowerCase();
      return !rt || rt === 'weekday';
    };

    const result = parsed.budgets.map(b => {
      const amount = normalizeParsedAmount(b?.amount ?? b?.budget);
      if (amount <= 0) return null;
      const line_item_ids = [];
      const matched = [];
      for (const num of b.line_item_numbers || []) {
        const n = normalizeSupportItemNumber(num);
        const item = byNumber[n] || byNumber[num];
        if (item) {
          line_item_ids.push(item.id);
          const rate = parseFloat(item.rate) || 0;
          matched.push({ support_item_number: item.support_item_number, rate, unit: item.unit || 'hr', rate_type: item.rate_type });
        }
      }
      // Auto-fill: if no line items matched, pick the item with the preferred rate for this category.
      // Core categories (01-04) prioritise weekday-daytime rates for hour estimates.
      if (line_item_ids.length === 0 && itemsByCat[b.category]) {
        let candidates = itemsByCat[b.category].filter(i => (i.unit || 'hr') === 'hr' && parseFloat(i.rate) > 0);
        if (CORE_CATEGORIES.has(b.category)) {
          const weekdayFirst = candidates.filter(isWeekdayDaytime);
          if (weekdayFirst.length > 0) candidates = weekdayFirst;
        }
        const preferredRate = CATEGORY_PREFERRED_RATES[b.category];
        let pick = null;
        if (preferredRate != null && preferredRate > 0 && candidates.length > 0) {
          const exact = candidates.find(i => Math.abs(parseFloat(i.rate) - preferredRate) < 0.01);
          const closest = exact || candidates.reduce((best, i) => {
            const r = parseFloat(i.rate) || 0;
            if (!best) return i;
            const bestDiff = Math.abs(parseFloat(best.rate) - preferredRate);
            const currDiff = Math.abs(r - preferredRate);
            return currDiff < bestDiff ? i : best;
          });
          pick = closest;
        } else {
          pick = candidates[0] || itemsByCat[b.category][0];
        }
        if (pick) {
          line_item_ids.push(pick.id);
          matched.push({ support_item_number: pick.support_item_number, rate: parseFloat(pick.rate) || 0, unit: pick.unit || 'hr', rate_type: pick.rate_type });
        }
      }
      // For core categories, prefer weekday-daytime rate when multiple matched items exist
      let primaryRate = matched[0]?.rate || 0;
      if (CORE_CATEGORIES.has(b.category) && matched.length > 1) {
        const weekdayMatch = matched.find(m => isWeekdayDaytime({ rate_type: m.rate_type }));
        if (weekdayMatch) primaryRate = weekdayMatch.rate;
      } else if (matched.length > 0) {
        primaryRate = matched[0].rate;
      }
      if (primaryRate <= 0) primaryRate = CATEGORY_PREFERRED_RATES[b.category] || 0;
      const hoursEstimate = primaryRate > 0 && amount > 0 ? amount / primaryRate : null;
      return {
        category: b.category,
        name: b.name,
        amount,
        management_type: getBudgetManagementType(b),
        line_item_ids,
        line_item_numbers: b.line_item_numbers,
        matched_count: line_item_ids.length,
        hours_estimate: hoursEstimate != null ? Math.round(hoursEstimate * 10) / 10 : null,
        primary_rate: primaryRate > 0 ? primaryRate : null,
        primary_item: matched[0]?.support_item_number || null,
        source: b.source || 'table',
        needs_review: b.needs_review ?? false,
        is_stated_support: !!b.is_stated_support,
        auto_budgeted: !!b.auto_budgeted || !!b.is_stated_support,
        support_narrative: b.support_narrative || null,
        evidence_quote: b.evidence_quote || null,
        validation_status: b.validation_status || (b.needs_review ? 'needs_review' : 'verified'),
        validation_reason: b.validation_reason || null,
        ...(b.table_amount != null && b.ai_amount != null && { table_amount: b.table_amount, ai_amount: b.ai_amount })
      };
    }).filter(Boolean);
    const budgets_sum = result.reduce((s, b) => s + (b.amount || 0), 0);
    const total_plan_budget = parsed.total_plan_budget || null;
    let validation_warning = parsed.validation_warning || null;
    if (total_plan_budget != null && total_plan_budget > 0) {
      const diff = Math.abs(budgets_sum - total_plan_budget);
      const pct = (diff / total_plan_budget) * 100;
      if (pct > 1) {
        validation_warning = `Budget total ($${budgets_sum.toLocaleString()}) does not match plan total ($${total_plan_budget.toLocaleString()}). Check for missing or incorrect categories.`;
      }
    }
    try {
      saveUploadedDocumentFromBuffer(req.params.id, req.file, req.body?.documentCategory || 'NDIS Plan');
    } catch (uploadErr) {
      // Parsing should still succeed even if document persistence fails.
      console.error('Parse plan document save warning:', uploadErr);
    }
    res.json({
      format: parsed.format,
      plan_dates: parsed.plan_dates || null,
      total_plan_budget,
      budgets_sum,
      validation_warning,
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      budgets: result,
      fund_release_schedule: aiFundReleaseSchedule
    });
  } catch (err) {
    console.error('Parse plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// NDIS Plans
router.get('/:id/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM ndis_plans WHERE participant_id = ? ORDER BY start_date DESC').all(req.params.id);
  res.json(plans);
});

router.post('/:id/plans', (req, res) => {
  try {
    const id = uuidv4();
    const { start_date, end_date, is_pace, fund_release_schedule } = req.body;
    const scheduleStored = prepareFundReleaseScheduleForStorage(fund_release_schedule, start_date, end_date);
    db.prepare(`
      INSERT INTO ndis_plans (id, participant_id, start_date, end_date, is_pace, fund_release_schedule)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, start_date, end_date, is_pace ? 1 : 0, scheduleStored);
    res.status(201).json({
      id,
      participant_id: req.params.id,
      start_date,
      end_date,
      is_pace: !!is_pace,
      fund_release_schedule: parseFundReleaseScheduleFromDb(scheduleStored)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/plans/:planId', (req, res) => {
  try {
    const { start_date, end_date, is_pace, fund_release_schedule } = req.body;
    const hasScheduleKey = Object.prototype.hasOwnProperty.call(req.body, 'fund_release_schedule');
    const scheduleStr = hasScheduleKey
      ? prepareFundReleaseScheduleForStorage(fund_release_schedule, start_date, end_date)
      : undefined;
    if (hasScheduleKey) {
      db.prepare(`
        UPDATE ndis_plans SET start_date = ?, end_date = ?, is_pace = ?, fund_release_schedule = ?, updated_at = datetime('now')
        WHERE id = ? AND participant_id = ?
      `).run(start_date, end_date, is_pace ? 1 : 0, scheduleStr, req.params.planId, req.params.id);
    } else {
      db.prepare(`
        UPDATE ndis_plans SET start_date = ?, end_date = ?, is_pace = ?, updated_at = datetime('now')
        WHERE id = ? AND participant_id = ?
      `).run(start_date, end_date, is_pace ? 1 : 0, req.params.planId, req.params.id);
    }
    const row = db.prepare('SELECT fund_release_schedule FROM ndis_plans WHERE id = ? AND participant_id = ?').get(req.params.planId, req.params.id);
    res.json({
      id: req.params.planId,
      start_date,
      end_date,
      is_pace: !!is_pace,
      fund_release_schedule: parseFundReleaseScheduleFromDb(row?.fund_release_schedule)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/plans/:planId', (req, res) => {
  // Delete goals linked to this plan (goals are plan-specific; SQLite may not enforce FK CASCADE)
  db.prepare('DELETE FROM participant_goals WHERE plan_id = ?').run(req.params.planId);
  db.prepare('DELETE FROM ndis_plans WHERE id = ? AND participant_id = ?').run(req.params.planId, req.params.id);
  res.status(204).send();
});

// Refresh a current plan to today's available funding.
// Creates a new plan from today with remaining amounts and closes the old one yesterday.
router.post('/:id/plans/:planId/refresh-available-funding', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const plan = db.prepare(`
      SELECT * FROM ndis_plans
      WHERE id = ? AND participant_id = ?
    `).get(req.params.planId, req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.end_date < today) {
      return res.status(400).json({ error: 'Plan has already ended; no funding left to refresh.' });
    }
    if (plan.start_date >= today) {
      return res.status(400).json({ error: 'Plan starts today or in the future. Refresh is only for in-progress plans.' });
    }

    const budgetRows = db.prepare(`
      SELECT pb.*, bli.ndis_line_item_id
      FROM plan_budgets pb
      LEFT JOIN budget_line_items bli ON bli.budget_id = pb.id
      WHERE pb.plan_id = ?
    `).all(plan.id);
    if (!budgetRows.length) {
      return res.status(400).json({ error: 'Plan has no budgets to refresh.' });
    }

    const byBudgetId = new Map();
    for (const row of budgetRows) {
      if (!byBudgetId.has(row.id)) {
        byBudgetId.set(row.id, {
          id: row.id,
          name: row.name,
          category: row.category,
          management_type: row.management_type || 'self',
          amount: Number(row.amount) || 0,
          used: 0,
          line_item_ids: []
        });
      }
      if (row.ndis_line_item_id) byBudgetId.get(row.id).line_item_ids.push(row.ndis_line_item_id);
    }

    const shifts = db.prepare(`
      SELECT s.id
      FROM shifts s
      WHERE s.participant_id = ?
        AND s.start_time >= ? AND s.start_time <= ?
    `).all(req.params.id, `${plan.start_date} 00:00:00`, `${today} 23:59:59`);
    const shiftIds = shifts.map((s) => s.id);
    if (shiftIds.length > 0) {
      const placeholders = shiftIds.map(() => '?').join(',');
      const shiftLineItems = db.prepare(`
        SELECT sli.ndis_line_item_id, sli.quantity, sli.unit_price
        FROM shift_line_items sli
        WHERE sli.shift_id IN (${placeholders})
      `).all(...shiftIds);
      for (const li of shiftLineItems) {
        const cost = (Number(li.quantity) || 0) * (Number(li.unit_price) || 0);
        for (const budget of byBudgetId.values()) {
          if (budget.line_item_ids.includes(li.ndis_line_item_id)) {
            budget.used += cost;
            break;
          }
        }
      }
    }

    const budgets = Array.from(byBudgetId.values()).map((b) => {
      const used = Math.round((Number(b.used) || 0) * 100) / 100;
      const remaining = Math.max(0, Math.round(((Number(b.amount) || 0) - used) * 100) / 100);
      return { ...b, used, remaining };
    });

    const oldPlanEndDate = new Date(`${today}T00:00:00Z`);
    oldPlanEndDate.setUTCDate(oldPlanEndDate.getUTCDate() - 1);
    const oldPlanEnd = oldPlanEndDate.toISOString().slice(0, 10);
    if (oldPlanEnd < plan.start_date) {
      return res.status(400).json({ error: 'Cannot split this plan at today. Try editing budgets manually.' });
    }

    const implementations = db.prepare(`
      SELECT *
      FROM implementations
      WHERE plan_id = ?
    `).all(plan.id);

    const tx = db.transaction(() => {
      const newPlanId = uuidv4();
      db.prepare(`
        INSERT INTO ndis_plans (id, participant_id, start_date, end_date, is_pace, fund_release_schedule)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(newPlanId, req.params.id, today, plan.end_date, plan.is_pace ? 1 : 0, plan.fund_release_schedule || null);

      db.prepare(`
        UPDATE ndis_plans
        SET end_date = ?, updated_at = datetime('now')
        WHERE id = ? AND participant_id = ?
      `).run(oldPlanEnd, plan.id, req.params.id);

      const budgetIdMap = new Map();
      const insBudget = db.prepare(`
        INSERT INTO plan_budgets (id, plan_id, name, amount, category, management_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insLineItem = db.prepare(`
        INSERT INTO budget_line_items (id, budget_id, ndis_line_item_id)
        VALUES (?, ?, ?)
      `);
      for (const b of budgets) {
        const newBudgetId = uuidv4();
        budgetIdMap.set(b.id, newBudgetId);
        insBudget.run(newBudgetId, newPlanId, b.name, b.remaining, b.category || null, b.management_type || 'self');
        for (const ndisId of (b.line_item_ids || [])) {
          insLineItem.run(uuidv4(), newBudgetId, ndisId);
        }
      }

      const insImpl = db.prepare(`
        INSERT INTO implementations (
          id, plan_id, budget_id, description, provider_type, provider_id,
          amount, hours_per_week, ndis_line_item_id, frequency, status, implemented_date, details
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const impl of implementations) {
        const mappedBudgetId = budgetIdMap.get(impl.budget_id);
        if (!mappedBudgetId) continue;
        insImpl.run(
          uuidv4(),
          newPlanId,
          mappedBudgetId,
          impl.description || null,
          impl.provider_type || null,
          impl.provider_id || null,
          impl.amount != null ? Number(impl.amount) : 0,
          impl.hours_per_week != null ? Number(impl.hours_per_week) : null,
          impl.ndis_line_item_id || null,
          impl.frequency || null,
          impl.status || 'active',
          impl.implemented_date || null,
          impl.details || null
        );
      }

      return newPlanId;
    });

    const newPlanId = tx();
    res.status(201).json({
      old_plan_id: plan.id,
      old_plan_new_end_date: oldPlanEnd,
      new_plan_id: newPlanId,
      new_plan_start_date: today,
      new_plan_end_date: plan.end_date,
      budgets: budgets.map((b) => ({
        category: b.category,
        name: b.name,
        previous_amount: b.amount,
        used_to_date: b.used,
        refreshed_amount: b.remaining
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Participant contacts
router.get('/:id/contacts', (req, res) => {
  const contacts = db.prepare(`
    SELECT pc.*, c.name, c.email, c.phone, c.role, o.name as org_name
    FROM participant_contacts pc
    JOIN contacts c ON pc.contact_id = c.id
    LEFT JOIN organisations o ON c.organisation_id = o.id
    WHERE pc.participant_id = ?
  `).all(req.params.id);
  res.json(contacts);
});

router.post('/:id/contacts', (req, res) => {
  try {
    const id = uuidv4();
    const { contact_id, relationship, consent_to_share, is_starred, additional_details } = req.body;
    db.prepare(`
      INSERT INTO participant_contacts (id, participant_id, contact_id, relationship, consent_to_share, is_starred, additional_details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, contact_id, relationship || null, consent_to_share ? 1 : 0, is_starred ? 1 : 0, additional_details || null);
    res.status(201).json({ id, participant_id: req.params.id, contact_id, relationship, consent_to_share, is_starred });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/contacts/:pcId', (req, res) => {
  const { relationship, consent_to_share, is_starred, additional_details } = req.body;
  db.prepare(`
    UPDATE participant_contacts SET relationship = ?, consent_to_share = ?, is_starred = ?, additional_details = ?
    WHERE id = ? AND participant_id = ?
  `).run(relationship, consent_to_share ? 1 : 0, is_starred ? 1 : 0, additional_details, req.params.pcId, req.params.id);
  res.json({ id: req.params.pcId, ...req.body });
});

router.delete('/:id/contacts/:pcId', (req, res) => {
  db.prepare('DELETE FROM participant_contacts WHERE id = ? AND participant_id = ?').run(req.params.pcId, req.params.id);
  res.status(204).send();
});

// Goals
router.get('/:id/goals', (req, res) => {
  const goals = db.prepare('SELECT * FROM participant_goals WHERE participant_id = ? AND (archived_at IS NULL OR archived_at = \'\')').all(req.params.id);
  res.json(goals);
});

router.post('/:id/goals', (req, res) => {
  try {
    const id = uuidv4();
    const { description, status, target_date } = req.body;
    db.prepare(`
      INSERT INTO participant_goals (id, participant_id, description, status, target_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.id, description, status || 'active', target_date || null);
    res.status(201).json({ id, participant_id: req.params.id, description, status, target_date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/goals/:goalId', (req, res) => {
  const { description, status, target_date } = req.body;
  db.prepare(`
    UPDATE participant_goals SET description = ?, status = ?, target_date = ?, updated_at = datetime('now')
    WHERE id = ? AND participant_id = ?
  `).run(description, status, target_date, req.params.goalId, req.params.id);
  res.json({ id: req.params.goalId, ...req.body });
});

router.delete('/:id/goals/:goalId', (req, res) => {
  db.prepare('DELETE FROM participant_goals WHERE id = ? AND participant_id = ?').run(req.params.goalId, req.params.id);
  res.status(204).send();
});

// Case notes
router.get('/:id/case-notes', (req, res) => {
  const notes = db.prepare('SELECT * FROM case_notes WHERE participant_id = ? ORDER BY contact_date DESC').all(req.params.id);
  res.json(notes);
});

// Documents
router.get('/:id/documents', (req, res) => {
  const docs = db.prepare('SELECT * FROM participant_documents WHERE participant_id = ?').all(req.params.id);
  res.json(docs);
});

router.post('/:id/documents', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const id = uuidv4();
    const { category } = req.body;
    const filePath = req.file.path;
    const filename = req.file.originalname;
    db.prepare(`
      INSERT INTO participant_documents (id, participant_id, filename, category, file_path)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.id, filename, category || null, filePath);
    try {
      const buf = readFileSync(filePath);
      const uploaded = await tryPushParticipantDocument({
        participantId: req.params.id,
        category: category || 'Other',
        buffer: buf,
        originalFilename: filename,
        mimeType: req.file.mimetype || null,
        notes: `participant_document:${id}`
      });
      if (uploaded?.webUrl || uploaded?.itemId) {
        db.prepare(`
          UPDATE participant_documents
          SET onedrive_web_url = COALESCE(?, onedrive_web_url),
              onedrive_item_id = COALESCE(?, onedrive_item_id)
          WHERE id = ?
        `).run(uploaded?.webUrl || null, uploaded?.itemId || null, id);
      }
    } catch (e) {
      console.warn('[participants] OneDrive push skipped:', e?.message);
    }
    res.status(201).json({ id, participant_id: req.params.id, filename, category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/documents/:docId/file', (req, res) => {
  const doc = db.prepare('SELECT * FROM participant_documents WHERE id = ? AND participant_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const oneDriveUrl = findParticipantOneDriveUrl(req.params.id, req.params.docId, doc.filename);
  if (oneDriveUrl) return res.redirect(oneDriveUrl);
  const absUploadsDir = resolve(uploadsDir);
  const absPath = resolve(doc.file_path);
  if (!absPath.startsWith(absUploadsDir)) return res.status(403).json({ error: 'Invalid path' });
  if (!existsSync(absPath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(absPath, { headers: { 'Content-Disposition': `inline; filename="${doc.filename}"` } });
});

router.delete('/:id/documents/:docId', (req, res) => {
  const doc = db.prepare('SELECT * FROM participant_documents WHERE id = ? AND participant_id = ?').get(req.params.docId, req.params.id);
  if (doc) {
    db.prepare('DELETE FROM participant_documents WHERE id = ?').run(req.params.docId);
  }
  res.status(204).send();
});

router.post('/:id/case-notes', (req, res) => {
  try {
    const id = uuidv4();
    const { contact_type, notes, contact_date, goal_id } = req.body;
    db.prepare(`
      INSERT INTO case_notes (id, participant_id, contact_type, notes, contact_date, goal_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, contact_type || 'phone', notes, contact_date || new Date().toISOString().slice(0, 10), goal_id || null);
    res.status(201).json({ id, participant_id: req.params.id, contact_type, notes, contact_date, goal_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Plan budgets
router.get('/:id/plans/:planId/budgets', (req, res) => {
  const budgets = db.prepare('SELECT * FROM plan_budgets WHERE plan_id = ?').all(req.params.planId);
  res.json(budgets);
});

router.post('/:id/plans/:planId/budgets', (req, res) => {
  try {
    const id = uuidv4();
    const { name, amount, category, line_item_ids, management_type } = req.body;
    const supportCategory = category || null;
    const displayName = name || (supportCategory ? `Category ${supportCategory}` : 'Budget');
    const participant = db.prepare('SELECT management_type FROM participants WHERE id = ?').get(req.params.id);
    const budgetManagementType = normalizeManagementType(management_type, normalizeManagementType(participant?.management_type, 'self'));
    db.prepare(`
      INSERT INTO plan_budgets (id, plan_id, name, amount, category, management_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.planId, displayName, amount, supportCategory, budgetManagementType);
    const ids = Array.isArray(line_item_ids) ? line_item_ids.filter(Boolean) : [];
    if (ids.length > 0) {
      const ins = db.prepare('INSERT INTO budget_line_items (id, budget_id, ndis_line_item_id) VALUES (?, ?, ?)');
      for (const ndisId of ids) {
        ins.run(uuidv4(), id, ndisId);
        if (supportCategory) recordBudgetLineItemSelection(supportCategory, ndisId);
      }
    }
    const lineItems = ids.length > 0 ? db.prepare(`
      SELECT bli.*, n.support_item_number, n.description, n.rate, n.rate_remote, n.rate_very_remote, n.unit
      FROM budget_line_items bli
      JOIN ndis_line_items n ON bli.ndis_line_item_id = n.id
      WHERE bli.budget_id = ?
    `).all(id) : [];
    res.status(201).json({ id, plan_id: req.params.planId, name: displayName, amount, category: supportCategory, management_type: budgetManagementType, line_items: lineItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/plans/:planId/budgets/:budgetId', (req, res) => {
  try {
    const { name, amount, category, line_item_ids, management_type } = req.body;
    const existing = db.prepare('SELECT management_type FROM plan_budgets WHERE id = ? AND plan_id = ?').get(req.params.budgetId, req.params.planId);
    const participant = db.prepare('SELECT management_type FROM participants WHERE id = ?').get(req.params.id);
    const fallbackManagement = normalizeManagementType(existing?.management_type, normalizeManagementType(participant?.management_type, 'self'));
    const budgetManagementType = normalizeManagementType(management_type, fallbackManagement);
    db.prepare(`
      UPDATE plan_budgets SET name = ?, amount = ?, category = ?, management_type = ?
      WHERE id = ? AND plan_id = ?
    `).run(name, amount, category || null, budgetManagementType, req.params.budgetId, req.params.planId);
    db.prepare('DELETE FROM budget_line_items WHERE budget_id = ?').run(req.params.budgetId);
    const ids = Array.isArray(line_item_ids) ? line_item_ids.filter(Boolean) : [];
    const cat = category || null;
    if (ids.length > 0) {
      const ins = db.prepare('INSERT INTO budget_line_items (id, budget_id, ndis_line_item_id) VALUES (?, ?, ?)');
      for (const ndisId of ids) {
        ins.run(uuidv4(), req.params.budgetId, ndisId);
        if (cat) recordBudgetLineItemSelection(cat, ndisId);
      }
    }
    const updated = db.prepare('SELECT * FROM plan_budgets WHERE id = ?').get(req.params.budgetId);
    const lineItems = db.prepare(`
      SELECT bli.*, n.support_item_number, n.description, n.rate, n.rate_remote, n.rate_very_remote, n.unit
      FROM budget_line_items bli
      JOIN ndis_line_items n ON bli.ndis_line_item_id = n.id
      WHERE bli.budget_id = ?
    `).all(req.params.budgetId);
    res.json({ ...updated, line_items: lineItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/plans/:planId/budgets/:budgetId', (req, res) => {
  db.prepare('DELETE FROM plan_budgets WHERE id = ? AND plan_id = ?').run(req.params.budgetId, req.params.planId);
  res.status(204).send();
});

// Implementations
router.get('/:id/plans/:planId/implementations', (req, res) => {
  const impl = db.prepare(`
    SELECT i.*, pb.name as budget_name
    FROM implementations i
    JOIN plan_budgets pb ON i.budget_id = pb.id
    WHERE i.plan_id = ?
  `).all(req.params.planId);
  res.json(impl);
});

router.post('/:id/plans/:planId/implementations', (req, res) => {
  try {
    const id = uuidv4();
    const { budget_id, description, service_name, provider_type, provider_id, amount, hours_per_week, ndis_line_item_id, frequency, status, implemented_date, details } = req.body;
    const freq = IMPL_FREQUENCIES.includes(frequency) ? frequency : null;
    const serviceLabel = String(service_name || description || '').trim();
    db.prepare(`
      INSERT INTO implementations (id, plan_id, budget_id, description, provider_type, provider_id, amount, hours_per_week, ndis_line_item_id, frequency, status, implemented_date, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.planId, budget_id, serviceLabel || null, provider_type || null, provider_id || null, amount != null ? parseFloat(amount) : 0, hours_per_week != null ? parseFloat(hours_per_week) : null, ndis_line_item_id || null, freq, status || 'active', implemented_date || null, details || null);
    const created = db.prepare('SELECT i.*, o.name as provider_name FROM implementations i LEFT JOIN organisations o ON i.provider_type = ? AND i.provider_id = o.id WHERE i.id = ?').get('organisation', id);
    res.status(201).json(created || { id, plan_id: req.params.planId, budget_id, description, amount, hours_per_week, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/plans/:planId/implementations/:implId', (req, res) => {
  try {
    const { description, service_name, provider_type, provider_id, amount, hours_per_week, ndis_line_item_id, frequency, status, implemented_date, details } = req.body;
    const freq = frequency != null && IMPL_FREQUENCIES.includes(frequency) ? frequency : null;
    const serviceLabel = String(service_name || description || '').trim();
    db.prepare(`
      UPDATE implementations SET description = ?, provider_type = ?, provider_id = ?, amount = ?, hours_per_week = ?, ndis_line_item_id = ?, frequency = ?, status = ?, implemented_date = ?, details = ?, updated_at = datetime('now')
      WHERE id = ? AND plan_id = ?
    `).run(serviceLabel || null, provider_type || null, provider_id || null, amount != null ? parseFloat(amount) : 0, hours_per_week != null ? parseFloat(hours_per_week) : null, ndis_line_item_id || null, freq, status || 'active', implemented_date || null, details || null, req.params.implId, req.params.planId);
    const updated = db.prepare('SELECT i.*, o.name as provider_name FROM implementations i LEFT JOIN organisations o ON i.provider_type = ? AND i.provider_id = o.id WHERE i.id = ?').get('organisation', req.params.implId);
    res.json(updated || { id: req.params.implId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/plans/:planId/implementations/:implId', (req, res) => {
  db.prepare('DELETE FROM implementations WHERE id = ? AND plan_id = ?').run(req.params.implId, req.params.planId);
  res.status(204).send();
});

export default router;
