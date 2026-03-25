import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/index.js';
import { getAssignedParticipantIds, canAccessParticipant } from '../middleware/roles.js';
import {
  getSupportCoordLineItem,
  roundToBillableUnits
} from '../services/coordinatorTasks.service.js';

const router = Router();
const TASK_TYPES = ['email', 'meeting_f2f', 'meeting_non_f2f', 'phone', 'other'];

function getBillingIntervalForUser(userId) {
  const u = db.prepare('SELECT billing_interval_minutes FROM users WHERE id = ?').get(userId);
  return u?.billing_interval_minutes ?? 15;
}
const CASE_STATUSES = ['open', 'in_progress', 'completed', 'on_hold'];
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

function filterByAccess(tasks, userId) {
  const assignedIds = userId ? getAssignedParticipantIds(userId) : null;
  if (assignedIds === null) return tasks;
  const idSet = new Set(assignedIds);
  return tasks.filter((t) => idSet.has(t.participant_id));
}

// List cases (optionally filtered by participant)
router.get('/', (req, res) => {
  try {
    const { participant_id, status } = req.query;
    const userId = req.session?.user?.id;

    let cases = db.prepare(`
      SELECT cc.*, p.name as participant_name, p.ndis_number,
             (SELECT COUNT(*) FROM coordinator_case_tasks cct WHERE cct.case_id = cc.id AND cct.status = 'completed') as completed_tasks,
             (SELECT COUNT(*) FROM coordinator_case_tasks cct WHERE cct.case_id = cc.id) as total_tasks
      FROM coordinator_cases cc
      JOIN participants p ON p.id = cc.participant_id
      ORDER BY cc.updated_at DESC, cc.created_at DESC
    `).all();

    cases = filterByAccess(cases, userId);
    if (participant_id) cases = cases.filter((c) => c.participant_id === participant_id);
    if (status) cases = cases.filter((c) => c.status === status);

    res.json(cases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create case
router.post('/', (req, res) => {
  try {
    const { participant_id, title, description, status, due_date } = req.body;

    if (!participant_id || !title?.trim()) {
      return res.status(400).json({ error: 'participant_id and title required' });
    }

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, participant_id)) {
      return res.status(403).json({ error: 'Access denied to this participant' });
    }

    const caseStatus = status && CASE_STATUSES.includes(status) ? status : 'open';

    const id = uuidv4();
    db.prepare(`
      INSERT INTO coordinator_cases (id, participant_id, title, description, status, due_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, participant_id, title.trim(), description?.trim() || null, caseStatus, due_date || null);

    const created = db.prepare(`
      SELECT cc.*, p.name as participant_name, p.ndis_number
      FROM coordinator_cases cc
      JOIN participants p ON p.id = cc.participant_id
      WHERE cc.id = ?
    `).get(id);

    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suggested task titles from internal memory (built from existing case tasks across the CRM)
router.get('/suggested-task-titles', (req, res) => {
  try {
    const userId = req.session?.user?.id;
    let rows;
    if (userId) {
      const assignedIds = getAssignedParticipantIds(userId);
      if (assignedIds !== null && assignedIds.length > 0) {
        rows = db.prepare(`
          SELECT cct.title, COUNT(*) as use_count
          FROM coordinator_case_tasks cct
          JOIN coordinator_cases cc ON cc.id = cct.case_id
          WHERE cc.participant_id IN (${assignedIds.map(() => '?').join(',')})
            AND cct.title IS NOT NULL AND TRIM(cct.title) != ''
          GROUP BY TRIM(LOWER(cct.title))
          ORDER BY use_count DESC
          LIMIT 60
        `).all(...assignedIds);
      } else {
        rows = db.prepare(`
          SELECT title, COUNT(*) as use_count
          FROM coordinator_case_tasks
          WHERE title IS NOT NULL AND TRIM(title) != ''
          GROUP BY TRIM(LOWER(title))
          ORDER BY use_count DESC
          LIMIT 60
        `).all();
      }
    } else {
      rows = db.prepare(`
        SELECT title, COUNT(*) as use_count
        FROM coordinator_case_tasks
        WHERE title IS NOT NULL AND TRIM(title) != ''
        GROUP BY TRIM(LOWER(title))
        ORDER BY use_count DESC
        LIMIT 60
      `).all();
    }
    const titles = rows.map((r) => ({ title: r.title, use_count: r.use_count }));
    res.json({ titles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single case with tasks
router.get('/:id', (req, res) => {
  try {
    const c = db.prepare(`
      SELECT cc.*, p.name as participant_name, p.ndis_number
      FROM coordinator_cases cc
      JOIN participants p ON p.id = cc.participant_id
      WHERE cc.id = ?
    `).get(req.params.id);

    if (!c) return res.status(404).json({ error: 'Case not found' });

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, c.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const tasks = db.prepare(`
      SELECT * FROM coordinator_case_tasks
      WHERE case_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `).all(req.params.id);

    const billableByCaseTask = db.prepare(`
      SELECT ct.*, st.name as staff_name,
             nli.support_item_number, nli.description as ndis_description
      FROM coordinator_tasks ct
      JOIN staff st ON st.id = ct.staff_id
      LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
      WHERE ct.case_id = ? AND ct.case_task_id IS NOT NULL
      ORDER BY ct.activity_date DESC, ct.created_at ASC
    `).all(req.params.id);

    const byCaseTaskId = {};
    billableByCaseTask.forEach((bt) => {
      const tid = bt.case_task_id;
      if (!byCaseTaskId[tid]) byCaseTaskId[tid] = [];
      byCaseTaskId[tid].push(bt);
    });

    const tasksWithBillable = tasks.map((t) => ({
      ...t,
      billable_entries: byCaseTaskId[t.id] || []
    }));

    res.json({ ...c, tasks: tasksWithBillable });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add billable task to case (creates a coordinator_task linked to this case)
router.post('/:id/billable-tasks', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM coordinator_cases WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, c.participant_id)) {
      return res.status(403).json({ error: 'Access denied to this participant' });
    }

    const {
      staff_id,
      task_type,
      description,
      evidence_text,
      activity_date,
      duration_minutes,
      includes_travel,
      travel_km,
      travel_time_min,
      ndis_line_item_id,
      case_task_id
    } = req.body;

    if (!staff_id || !task_type || !activity_date || duration_minutes == null) {
      return res.status(400).json({ error: 'staff_id, task_type, activity_date, duration_minutes required' });
    }

    if (case_task_id) {
      const caseTask = db.prepare('SELECT id, case_id FROM coordinator_case_tasks WHERE id = ? AND case_id = ?').get(case_task_id, req.params.id);
      if (!caseTask) return res.status(400).json({ error: 'case_task_id must belong to this case' });
    }

    const user = userId ? db.prepare('SELECT role, staff_id FROM users WHERE id = ?').get(userId) : null;
    if (user?.role === 'support_coordinator' && user?.staff_id && staff_id !== user.staff_id) {
      return res.status(403).json({ error: 'Support coordinators must use their own staff record for tasks' });
    }
    if (!TASK_TYPES.includes(task_type)) {
      return res.status(400).json({ error: `task_type must be one of: ${TASK_TYPES.join(', ')}` });
    }

    const interval = userId ? getBillingIntervalForUser(userId) : 15;

    const lineItem = ndis_line_item_id
      ? db.prepare('SELECT id, rate FROM ndis_line_items WHERE id = ?').get(ndis_line_item_id)
      : getSupportCoordLineItem(c.participant_id, activity_date);

    if (!lineItem) {
      return res.status(400).json({ error: 'No NDIS line items found. Import the NDIS pricing catalogue in NDIS Pricing first.' });
    }

    const quantity = roundToBillableUnits(Number(duration_minutes) || 0, interval);
    const unitPrice = lineItem.rate;

    const taskId = uuidv4();
    db.prepare(`
      INSERT INTO coordinator_tasks (
        id, participant_id, staff_id, task_type, description, evidence_text,
        activity_date, duration_minutes, bill_interval_minutes, includes_travel,
        travel_km, travel_time_min, ndis_line_item_id, quantity, unit_price, case_id, case_task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      c.participant_id,
      staff_id,
      task_type,
      description || null,
      evidence_text || null,
      activity_date,
      Number(duration_minutes) || 0,
      null,
      includes_travel ? 1 : 0,
      travel_km ?? null,
      travel_time_min ?? null,
      lineItem.id,
      quantity,
      unitPrice,
      req.params.id,
      case_task_id || null
    );

    const task = db.prepare(`
      SELECT ct.*, p.name as participant_name, st.name as staff_name,
             nli.support_item_number, nli.description as ndis_description
      FROM coordinator_tasks ct
      JOIN participants p ON p.id = ct.participant_id
      JOIN staff st ON st.id = ct.staff_id
      LEFT JOIN ndis_line_items nli ON nli.id = ct.ndis_line_item_id
      WHERE ct.id = ?
    `).get(taskId);

    res.status(201).json(task);
  } catch (err) {
    console.error('[coordinator-cases billable-tasks]', err);
    res.status(500).json({ error: err.message || 'Failed to add billable task' });
  }
});

// Update case
router.put('/:id', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM coordinator_cases WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, c.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { title, description, status, due_date } = req.body;

    db.prepare(`
      UPDATE coordinator_cases SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        status = COALESCE(?, status),
        due_date = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      title !== undefined ? title.trim() : c.title,
      description !== undefined ? (description?.trim() || null) : c.description,
      status && CASE_STATUSES.includes(status) ? status : c.status,
      due_date !== undefined ? due_date : c.due_date,
      req.params.id
    );

    const updated = db.prepare(`
      SELECT cc.*, p.name as participant_name, p.ndis_number
      FROM coordinator_cases cc
      JOIN participants p ON p.id = cc.participant_id
      WHERE cc.id = ?
    `).get(req.params.id);

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete case (cascades to tasks)
router.delete('/:id', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM coordinator_cases WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, c.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    db.prepare('DELETE FROM coordinator_case_tasks WHERE case_id = ?').run(req.params.id);
    db.prepare('DELETE FROM coordinator_cases WHERE id = ?').run(req.params.id);

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Case tasks ───────────────────────────────────────────────────────────────

// Add task to case (optional billable time: if set, creates a linked coordinator_task for nf2f/f2f/travel)
router.post('/:id/tasks', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM coordinator_cases WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, c.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { title, description, status, due_date, notes, billable_minutes, task_type, staff_id, activity_date, travel_km, travel_time_min } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: 'title required' });
    }

    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM coordinator_case_tasks WHERE case_id = ?').get(req.params.id);
    const sortOrder = (maxOrder?.m ?? 0) + 1;
    const taskStatus = status && TASK_STATUSES.includes(status) ? status : 'pending';

    const taskId = uuidv4();
    db.prepare(`
      INSERT INTO coordinator_case_tasks (id, case_id, title, description, status, due_date, sort_order, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, req.params.id, title.trim(), description?.trim() || null, taskStatus, due_date || null, sortOrder, notes?.trim() || null);

    db.prepare('UPDATE coordinator_cases SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);

    const hasBillable = Number(billable_minutes) > 0;
    if (hasBillable) {
      const allowedBillableTypes = ['meeting_f2f', 'meeting_non_f2f'];
      if (!task_type || !allowedBillableTypes.includes(task_type)) {
        return res.status(400).json({ error: 'When billable time is set, task_type must be meeting_f2f or meeting_non_f2f' });
      }
      const user = userId ? db.prepare('SELECT staff_id FROM users WHERE id = ?').get(userId) : null;
      const effectiveStaffId = user?.staff_id || staff_id;
      if (!effectiveStaffId) {
        return res.status(400).json({ error: 'Your account has no staff record; you cannot add billable time. Ask an admin to link your user to a staff member.' });
      }
      const actDate = activity_date || due_date || new Date().toISOString().slice(0, 10);
      const interval = userId ? getBillingIntervalForUser(userId) : 15;
      const lineItem = getSupportCoordLineItem(c.participant_id, actDate);
      if (!lineItem) {
        return res.status(400).json({ error: 'No NDIS line items found. Import the NDIS pricing catalogue in NDIS Pricing first.' });
      }
      const quantity = roundToBillableUnits(Number(billable_minutes) || 0, interval);
      const unitPrice = lineItem.rate;
      const includesTravel = (Number(travel_km) > 0 || Number(travel_time_min) > 0);
      const coordTaskId = uuidv4();
      db.prepare(`
        INSERT INTO coordinator_tasks (
          id, participant_id, staff_id, task_type, description, evidence_text,
          activity_date, duration_minutes, bill_interval_minutes, includes_travel,
          travel_km, travel_time_min, ndis_line_item_id, quantity, unit_price, case_id, case_task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        coordTaskId,
        c.participant_id,
        effectiveStaffId,
        task_type,
        title.trim(),
        null,
        actDate,
        Number(billable_minutes) || 0,
        null,
        includesTravel ? 1 : 0,
        travel_km != null && travel_km !== '' ? Number(travel_km) : null,
        travel_time_min != null && travel_time_min !== '' ? Number(travel_time_min) : null,
        lineItem.id,
        quantity,
        unitPrice,
        req.params.id,
        taskId
      );
    }

    const task = db.prepare('SELECT * FROM coordinator_case_tasks WHERE id = ?').get(taskId);
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update task
router.put('/:id/tasks/:taskId', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM coordinator_cases WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, c.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const task = db.prepare('SELECT * FROM coordinator_case_tasks WHERE id = ? AND case_id = ?').get(req.params.taskId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { title, description, status, due_date, notes, sort_order } = req.body;

    const newStatus = status && TASK_STATUSES.includes(status) ? status : task.status;
    let completedAt = task.completed_at;
    if (status !== undefined && TASK_STATUSES.includes(status)) {
      completedAt = newStatus === 'completed' ? (task.completed_at || new Date().toISOString()) : null;
    }

    db.prepare(`
      UPDATE coordinator_case_tasks SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        status = ?,
        due_date = ?,
        notes = COALESCE(?, notes),
        sort_order = COALESCE(?, sort_order),
        completed_at = ?,
        updated_at = datetime('now')
      WHERE id = ? AND case_id = ?
    `).run(
      title !== undefined ? title.trim() : task.title,
      description !== undefined ? (description?.trim() || null) : task.description,
      newStatus,
      due_date !== undefined ? due_date : task.due_date,
      notes !== undefined ? (notes?.trim() || null) : task.notes,
      sort_order !== undefined ? sort_order : task.sort_order,
      status !== undefined && TASK_STATUSES.includes(status) ? completedAt : task.completed_at,
      req.params.taskId,
      req.params.id
    );

    db.prepare('UPDATE coordinator_cases SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);

    const updated = db.prepare('SELECT * FROM coordinator_case_tasks WHERE id = ?').get(req.params.taskId);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark task complete
router.put('/:id/tasks/:taskId/complete', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM coordinator_cases WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, c.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const task = db.prepare('SELECT * FROM coordinator_case_tasks WHERE id = ? AND case_id = ?').get(req.params.taskId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE coordinator_case_tasks SET status = 'completed', completed_at = ?, updated_at = datetime('now')
      WHERE id = ? AND case_id = ?
    `).run(now, req.params.taskId, req.params.id);

    db.prepare('UPDATE coordinator_cases SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);

    const updated = db.prepare('SELECT * FROM coordinator_case_tasks WHERE id = ?').get(req.params.taskId);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete task
router.delete('/:id/tasks/:taskId', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM coordinator_cases WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const userId = req.session?.user?.id;
    if (userId && !canAccessParticipant(userId, c.participant_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const task = db.prepare('SELECT * FROM coordinator_case_tasks WHERE id = ? AND case_id = ?').get(req.params.taskId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    db.prepare('DELETE FROM coordinator_case_tasks WHERE id = ? AND case_id = ?').run(req.params.taskId, req.params.id);
    db.prepare('UPDATE coordinator_cases SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
