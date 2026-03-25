/**
 * Daily cron: check staff_compliance_documents for expiry in 60, 30, 7 days.
 * Send reminder email to staff and manager (or first admin). Record in staff_certification_reminders.
 * Run: node server/scripts/run-staff-certification-reminders.js (from project root; ensure .env is loaded).
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

import { v4 as uuidv4 } from 'uuid';
import { db } from '../src/db/index.js';
import { sendEmailViaRelay, isEmailConfiguredForUser } from '../src/services/notification.service.js';

const REMINDER_DAYS = [60, 30, 7];

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(ymd, days) {
  const d = new Date(ymd + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function sendReminder(adminId, staff, doc, reminderType) {
  const subject = `Compliance document expiring – ${doc.document_type} – Nexus Core`;
  const days = reminderType === '60_days' ? 60 : reminderType === '30_days' ? 30 : 7;
  const text = `Hi ${staff.name},\n\nYour compliance document "${doc.document_type}" expires on ${doc.expiry_date}. Please renew and upload it (or contact your manager for a renewal link).\n\nThis is a ${days}-day reminder.\n\nThank you.`;
  await sendEmailViaRelay(adminId, staff.email, subject, text, null, null);
}

async function sendManagerNotify(adminId, managerEmail, staffName, doc, reminderType) {
  const days = reminderType === '60_days' ? 60 : reminderType === '30_days' ? 30 : 7;
  const subject = `Staff compliance reminder: ${staffName} – ${doc.document_type}`;
  const text = `${staffName}'s compliance document "${doc.document_type}" expires on ${doc.expiry_date}. A ${days}-day reminder has been sent to the staff member.`;
  await sendEmailViaRelay(adminId, managerEmail, subject, text, null, null);
}

async function run() {
  const admin = db.prepare('SELECT id, email FROM users WHERE role = ? ORDER BY created_at ASC LIMIT 1').get('admin');
  if (!admin) {
    console.log('No admin user; skipping staff certification reminders.');
    return;
  }
  if (!isEmailConfiguredForUser(admin.id)) {
    console.log('Admin has not connected email in Settings; skipping staff certification reminders.');
    return;
  }

  const today = todayYmd();
  let sent = 0;
  for (const days of REMINDER_DAYS) {
    const targetDate = addDays(today, days);
    const reminderType = `${days}_days`;
    const docs = db.prepare(`
      SELECT scd.id, scd.staff_id, scd.document_type, scd.expiry_date
      FROM staff_compliance_documents scd
      WHERE scd.expiry_date = ? AND scd.expiry_date IS NOT NULL
    `).all(targetDate);

    for (const doc of docs) {
      const already = db.prepare(
        'SELECT id FROM staff_certification_reminders WHERE staff_id = ? AND document_type = ? AND reminder_type = ?'
      ).get(doc.staff_id, doc.document_type, reminderType);
      if (already) continue;

      const staff = db.prepare('SELECT id, name, email, manager_id FROM staff WHERE id = ?').get(doc.staff_id);
      if (!staff?.email) continue;

      try {
        await sendReminder(admin.id, staff, doc, reminderType);
        const manager = staff.manager_id ? db.prepare('SELECT email FROM staff WHERE id = ?').get(staff.manager_id) : null;
        const managerEmail = manager?.email || admin.email;
        if (managerEmail && managerEmail !== staff.email) {
          await sendManagerNotify(admin.id, managerEmail, staff.name, doc, reminderType);
        }
        db.prepare(
          'INSERT INTO staff_certification_reminders (id, staff_id, document_type, reminder_type) VALUES (?, ?, ?, ?)'
        ).run(uuidv4(), doc.staff_id, doc.document_type, reminderType);
        sent++;
      } catch (err) {
        console.error('Reminder send failed:', doc.staff_id, doc.document_type, reminderType, err.message);
      }
    }
  }
  console.log(`Staff certification reminders done. Sent: ${sent}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
