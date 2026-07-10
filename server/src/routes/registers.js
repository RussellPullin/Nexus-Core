import { Router } from 'express';
import ExcelJS from 'exceljs';
import { requireCoordinatorOrAdmin } from '../middleware/roles.js';
import { db } from '../db/index.js';
import { buildRegisterSnapshotForOrg, getOrgRegisterSettings, isRegisterEditableForOrg, saveOrgRegisterSettings, REGISTER_CATALOG, sheetKeyToViewId, createManualRegisterRow, deleteManualRegisterRow, migrateManualRegisterRowKey, isManualRegisterRowKey, REGISTER_CATALOG_BY_VIEW_ID } from '../services/registerSnapshots.service.js';
import { ensureOnedriveLinkedRegistersImported, refreshOnedriveLinkedRegisters } from '../services/registerOnedriveImport.service.js';

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

const VIEW_ALIASES = Object.fromEntries(
  REGISTER_CATALOG.flatMap((def) => {
    const id = sheetKeyToViewId(def.sheetKey);
    const aliases = [id];
    const short = id.replace(/_register$/, '').replace(/_/g, '');
    if (short && short !== id) aliases.push(short);
    return aliases.map((a) => [a, id]);
  })
);

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

router.get('/snapshot', requireCoordinatorOrAdmin, async (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    await ensureOnedriveLinkedRegistersImported(orgId);
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

router.post('/import-onedrive', requireCoordinatorOrAdmin, async (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    await refreshOnedriveLinkedRegisters(orgId);
    res.json(buildRegisterSnapshotForOrg(orgId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/settings', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const settings = getOrgRegisterSettings(orgId);
    const catalog = REGISTER_CATALOG.map((def) => {
      const id = sheetKeyToViewId(def.sheetKey);
      const s = settings[id] || { visible: false, editable: false };
      return {
        id,
        title: def.title,
        sheet_key: def.sheetKey,
        visible: !!s.visible,
        editable: !!s.editable,
        supports_inline_edit: def.inline_edit !== false,
        pending: !!def.pending
      };
    });
    res.json({ catalog });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const items = Array.isArray(req.body?.registers) ? req.body.registers : req.body?.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'registers array is required' });
    }
    saveOrgRegisterSettings(orgId, items);
    res.json(buildRegisterSnapshotForOrg(orgId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:viewId/rows', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const viewId = VIEW_ALIASES[String(req.params.viewId || '').trim()] || String(req.params.viewId || '').trim();
    const snapshot = buildRegisterSnapshotForOrg(orgId);
    const view = snapshot.views.find((v) => v.id === viewId);
    if (!view && !REGISTER_CATALOG_BY_VIEW_ID[viewId]) {
      return res.status(404).json({ error: 'Register view not found' });
    }
    const values = Array.isArray(req.body?.values) ? req.body.values.map((v) => String(v ?? '')) : [];
    createManualRegisterRow(orgId, viewId, req.session.user.id, {
      values,
      existingRows: view?.rows || []
    });
    res.status(201).json(buildRegisterSnapshotForOrg(orgId));
  } catch (e) {
    res.status(e.message?.includes('cannot be edited') ? 400 : 500).json({ error: e.message });
  }
});

router.delete('/:viewId/rows/:rowKey', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const viewId = VIEW_ALIASES[String(req.params.viewId || '').trim()] || String(req.params.viewId || '').trim();
    deleteManualRegisterRow(orgId, viewId, decodeURIComponent(req.params.rowKey || ''));
    res.json(buildRegisterSnapshotForOrg(orgId));
  } catch (e) {
    res.status(e.message?.includes('cannot be edited') || e.message?.includes('Only manually') ? 400 : 500).json({
      error: e.message
    });
  }
});

/**
 * Set (upsert) a manual override for a single cell of a derived register. Overrides are layered
 * on top of the auto-generated rows so editing a register never mutates the source records.
 */
router.put('/:viewId/cell', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const viewId = String(req.params.viewId || '').trim();
    if (!isRegisterEditableForOrg(orgId, viewId)) {
      return res.status(400).json({ error: 'This register cannot be edited inline.' });
    }
    let rowKey = String(req.body?.row_key ?? '').trim();
    const colIndex = Number.parseInt(req.body?.col_index, 10);
    if (!rowKey) return res.status(400).json({ error: 'row_key is required' });
    if (!Number.isInteger(colIndex) || colIndex < 0) {
      return res.status(400).json({ error: 'col_index must be a non-negative integer' });
    }
    const value = req.body?.value == null ? '' : String(req.body.value);
    const keyColIndex = REGISTER_CATALOG_BY_VIEW_ID[viewId]?.key_column_index ?? 0;
    db.prepare(
      `INSERT INTO register_cell_overrides (org_id, view_id, row_key, col_index, value, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(org_id, view_id, row_key, col_index)
       DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`
    ).run(orgId, viewId, rowKey, colIndex, value, req.session.user.id);
    if (isManualRegisterRowKey(rowKey) && colIndex === keyColIndex && value.trim()) {
      rowKey = migrateManualRegisterRowKey(orgId, viewId, rowKey, value.trim(), keyColIndex);
    }
    res.json(buildRegisterSnapshotForOrg(orgId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Clear a manual override so the cell reverts to its derived value. */
router.delete('/:viewId/cell', requireCoordinatorOrAdmin, (req, res) => {
  try {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const viewId = String(req.params.viewId || '').trim();
    if (!isRegisterEditableForOrg(orgId, viewId)) {
      return res.status(400).json({ error: 'This register cannot be edited inline.' });
    }
    const rowKey = String(req.query.row_key ?? '').trim();
    const colIndex = Number.parseInt(req.query.col_index, 10);
    if (!rowKey || !Number.isInteger(colIndex)) {
      return res.status(400).json({ error: 'row_key and col_index are required' });
    }
    db.prepare(
      'DELETE FROM register_cell_overrides WHERE org_id = ? AND view_id = ? AND row_key = ? AND col_index = ?'
    ).run(orgId, viewId, rowKey, colIndex);
    res.json(buildRegisterSnapshotForOrg(orgId));
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
