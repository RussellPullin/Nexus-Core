/**
 * Receipts API - accepts expense receipt uploads from Shifter (dual-write after OneDrive).
 * Auth: session (coordinator) OR x-api-key / Authorization: Bearer (CRM_API_KEY)
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { resolveParticipantByName } from '../services/progressNoteMatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

const router = Router();

function hasValidApiKey(req) {
  const expected = process.env.CRM_API_KEY?.trim?.() || process.env.CRM_API_KEY || '';
  if (!expected) return false;
  const apiKey = (req.headers['x-api-key'] || '').trim();
  if (apiKey && apiKey === expected) return true;
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() === expected;
  }
  return false;
}

/**
 * POST /api/receipts
 * Body: { clientName, shiftId, shiftDate, description, imageBase64 }
 * Resolves participant by clientName, saves image to data/uploads, inserts into participant_documents.
 */
router.post('/', async (req, res) => {
  const hasSession = !!req.session?.user;
  const hasKey = hasValidApiKey(req);

  if (!hasSession && !hasKey) {
    return res.status(401).json({
      error: 'Unauthorized. Sign in as coordinator or provide x-api-key / Authorization: Bearer (CRM_API_KEY).',
    });
  }

  try {
    const { clientName, shiftId, shiftDate, description, imageBase64 } = req.body || {};

    if (!clientName?.trim()) {
      return res.status(400).json({ error: 'clientName is required.' });
    }
    if (!shiftId) {
      return res.status(400).json({ error: 'shiftId is required.' });
    }
    if (!description?.trim()) {
      return res.status(400).json({ error: 'description is required.' });
    }
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 is required.' });
    }

    const participant = resolveParticipantByName(clientName.trim());
    if (!participant) {
      return res.status(404).json({
        error: `Participant not found for client name "${clientName.trim()}". Add the participant in Nexus first.`,
      });
    }

    let buffer;
    try {
      buffer = Buffer.from(imageBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'Invalid imageBase64.' });
    }

    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 10MB).' });
    }

    const uploadDir = join(projectRoot, 'data', 'uploads');
    mkdirSync(uploadDir, { recursive: true });

    const ext = (req.body.mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const sanitized = String(description).trim().replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').substring(0, 50) || 'receipt';
    const timestamp = Math.floor(Date.now() / 1000);
    const filename = `${shiftId}_${sanitized}_${timestamp}.${ext}`;
    const storedFilename = `${uuidv4()}-${filename}`;
    const filePath = join(uploadDir, storedFilename);

    writeFileSync(filePath, buffer);

    const docId = uuidv4();
    const docCols = db.prepare("PRAGMA table_info(participant_documents)").all();
    const hasShiftId = docCols.some((c) => c.name === 'shift_id');
    const hasReceiptDesc = docCols.some((c) => c.name === 'receipt_description');

    if (hasShiftId && hasReceiptDesc) {
      db.prepare(`
        INSERT INTO participant_documents (id, participant_id, filename, category, file_path, shift_id, receipt_description)
        VALUES (?, ?, ?, 'Expense Receipt', ?, ?, ?)
      `).run(docId, participant.id, filename, filePath, String(shiftId), description.trim());
    } else if (hasShiftId) {
      db.prepare(`
        INSERT INTO participant_documents (id, participant_id, filename, category, file_path, shift_id)
        VALUES (?, ?, ?, 'Expense Receipt', ?, ?)
      `).run(docId, participant.id, filename, filePath, String(shiftId));
    } else {
      db.prepare(`
        INSERT INTO participant_documents (id, participant_id, filename, category, file_path)
        VALUES (?, ?, ?, 'Expense Receipt', ?)
      `).run(docId, participant.id, filename, filePath);
    }

    res.status(201).json({
      success: true,
      id: docId,
      participant_id: participant.id,
      filename,
      shift_id: shiftId,
    });
  } catch (err) {
    console.error('[receipts]', err);
    res.status(500).json({ error: err.message || 'Failed to save receipt.' });
  }
});

export default router;
