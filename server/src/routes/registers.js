import { Router } from 'express';
import ExcelJS from 'exceljs';
import { requireCoordinatorOrAdmin } from '../middleware/roles.js';
import { db } from '../db/index.js';
import { buildRegisterSnapshotForOrg } from '../services/registerSnapshots.service.js';

const router = Router();

function getRequestOrgId(req) {
  const u = db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.session.user.id);
  return u?.org_id || null;
}

function requireOrg(req, res) {
  const orgId = getRequestOrgId(req);
  if (!orgId) {
    res.status(400).json({ error: 'No organisation on your account.' });
    return null;
  }
  return orgId;
}

const VIEW_ALIASES = {
  staff_compliance: 'staff_compliance_register',
  staff_compliance_register: 'staff_compliance_register',
  incidents: 'incident_register',
  incident_register: 'incident_register',
  risk_assessments: 'risk_assessment_register',
  risk_assessment_register: 'risk_assessment_register',
  participants: 'participant_register',
  participant_register: 'participant_register',
  staff: 'staff_register',
  staff_register: 'staff_register'
};

function filterRowsByDate(view, from, to) {
  if (!view?.date_column || (!from && !to)) return view?.rows || [];
  const idx = view.columns.indexOf(view.date_column);
  if (idx < 0) return view.rows || [];
  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(to).getTime() : null;
  return (view.rows || []).filter((row) => {
    const value = row[idx];
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return false;
    if (fromTime != null && time < fromTime) return false;
    if (toTime != null && time > toTime) return false;
    return true;
  });
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function incidentPayload(body = {}) {
  return {
    incident_date: body.incident_date || null,
    participant_id: body.participant_id || null,
    staff_id: body.staff_id || null,
    location: body.location || null,
    description: body.description || null,
    immediate_actions: body.immediate_actions || null,
    follow_up: body.follow_up || null,
    reported_by: body.reported_by || null,
    reported_to: body.reported_to || null,
    outcome: body.outcome || null
  };
}

router.get('/snapshot', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    res.json(buildRegisterSnapshotForOrg(orgId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/incidents', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const rows = db
      .prepare(
        `SELECT ire.*, p.name AS participant_name, s.name AS staff_name
         FROM incident_register_entries ire
         LEFT JOIN participants p ON p.id = ire.participant_id
         LEFT JOIN staff s ON s.id = ire.staff_id
         WHERE ire.org_id = ?
           AND ire.deleted_at IS NULL
         ORDER BY datetime(COALESCE(ire.incident_date, ire.created_at)) DESC`
      )
      .all(orgId);
    res.json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/incidents', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const p = incidentPayload(req.body);
    const info = db
      .prepare(
        `INSERT INTO incident_register_entries (
          org_id, incident_date, participant_id, staff_id, location, description,
          immediate_actions, follow_up, reported_by, reported_to, outcome, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        orgId,
        p.incident_date,
        p.participant_id,
        p.staff_id,
        p.location,
        p.description,
        p.immediate_actions,
        p.follow_up,
        p.reported_by,
        p.reported_to,
        p.outcome,
        req.session.user.id
      );
    const row = db.prepare('SELECT * FROM incident_register_entries WHERE id = ? AND org_id = ?').get(info.lastInsertRowid, orgId);
    res.status(201).json({ entry: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/incidents/:id', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const p = incidentPayload(req.body);
    const info = db
      .prepare(
        `UPDATE incident_register_entries
         SET incident_date = ?, participant_id = ?, staff_id = ?, location = ?, description = ?,
             immediate_actions = ?, follow_up = ?, reported_by = ?, reported_to = ?, outcome = ?,
             updated_at = datetime('now')
         WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
      )
      .run(
        p.incident_date,
        p.participant_id,
        p.staff_id,
        p.location,
        p.description,
        p.immediate_actions,
        p.follow_up,
        p.reported_by,
        p.reported_to,
        p.outcome,
        req.params.id,
        orgId
      );
    if (!info.changes) return res.status(404).json({ error: 'Incident entry not found' });
    const row = db.prepare('SELECT * FROM incident_register_entries WHERE id = ? AND org_id = ?').get(req.params.id, orgId);
    res.json({ entry: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/incidents/:id', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const info = db
      .prepare(
        `UPDATE incident_register_entries
         SET deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
      )
      .run(req.params.id, orgId);
    if (!info.changes) return res.status(404).json({ error: 'Incident entry not found' });
    res.json({ id: req.params.id, deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/export', requireCoordinatorOrAdmin, async (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const viewId = VIEW_ALIASES[String(req.query.view || '').trim()] || 'staff_compliance_register';
    const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
    const snapshot = buildRegisterSnapshotForOrg(orgId);
    const view = snapshot.views.find((v) => v.id === viewId);
    if (!view) return res.status(404).json({ error: 'Register view not found' });
    const rows = filterRowsByDate(view, req.query.from, req.query.to);
    const baseName = `${view.id}-${new Date().toISOString().slice(0, 10)}`;

    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(view.title || view.id);
      ws.columns = view.columns.map((header) => ({ header, key: header, width: Math.min(Math.max(String(header).length + 4, 14), 42) }));
      for (const row of rows) {
        const obj = {};
        view.columns.forEach((col, idx) => {
          obj[col] = row[idx] ?? '';
        });
        ws.addRow(obj);
      }
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = `A1:${String.fromCharCode(64 + Math.max(1, Math.min(view.columns.length, 26)))}1`;
      const out = await wb.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
      return res.send(Buffer.isBuffer(out) ? out : Buffer.from(out));
    }

    const csv = [view.columns, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
