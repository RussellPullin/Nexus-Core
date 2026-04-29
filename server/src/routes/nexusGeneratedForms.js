/**
 * Download generated form PDFs (immutable snapshots).
 */
import { Router } from 'express';
import { existsSync, createReadStream } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { canAccessParticipant } from '../middleware/roles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

const ROUTER = Router();

ROUTER.get('/:id/pdf', (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    const userId = req.session.user.id;
    const row = db.prepare(`SELECT * FROM nexus_generated_form_documents WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (!canAccessParticipant(userId, row.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const u = db.prepare(`SELECT org_id FROM users WHERE id = ?`).get(userId);
    if (u?.org_id && row.org_id !== u.org_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const rel = row.pdf_relative_path;
    if (!rel) return res.status(404).json({ error: 'PDF not stored' });
    const abs = join(projectRoot, rel.split(/[/\\]/).join('/'));
    if (!existsSync(abs)) return res.status(404).json({ error: 'File missing on server' });

    const dlName = `Service-Agreement-${row.participant_id?.slice(0, 8) || 'participant'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${dlName.replace(/"/g, '')}"`);
    createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default ROUTER;
