import { db } from '../db/index.js';
import { getEmailConfigForUser, getRelayConfigFromEnv } from '../lib/emailSendConfig.js';
import { getValidAccessToken } from './emailOAuthTokens.service.js';

/** True when user has OAuth email connected and server has relay URL */
export function isEmailConfiguredForUser(userId) {
  if (!userId) return false;
  return !!getEmailConfigForUser(userId) && !!getRelayConfigFromEnv()?.url;
}

/** @deprecated use isEmailConfiguredForUser */
export function isEmailConfigured(emailConfig) {
  return !!(emailConfig?.provider && emailConfig?.from);
}

function normalizeAttachmentsForRelay(attachments) {
  if (!attachments?.length) return [];
  return attachments.map((a) => {
    const content = a.content;
    const contentBytes = typeof content === 'string'
      ? (content.match(/^[A-Za-z0-9+/=\s]+$/) && content.length > 100
        ? content.replace(/\s/g, '')
        : Buffer.from(content, 'utf8').toString('base64'))
      : (Buffer.isBuffer(content) ? content.toString('base64') : String(content));
    return {
      filename: a.filename || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      content: contentBytes
    };
  });
}

/**
 * Send via Azure Function using user's OAuth token.
 * @param {string} userId
 */
export async function sendEmailViaRelay(userId, to, subject, text, from, attachments) {
  const relay = getRelayConfigFromEnv();
  if (!relay?.url) {
    const e = new Error('Email sending is not set up on the server yet. Ask your administrator.');
    e.code = 'EMAIL_RELAY_NOT_CONFIGURED';
    throw e;
  }
  const cfg = getEmailConfigForUser(userId);
  if (!cfg) {
    const e = new Error('Connect your email in Settings to send rosters and messages.');
    e.code = 'EMAIL_NOT_CONNECTED';
    throw e;
  }
  let accessToken;
  try {
    accessToken = await getValidAccessToken(userId);
  } catch (err) {
    if (err.code === 'EMAIL_RECONNECT_REQUIRED' || err.code === 'EMAIL_NOT_CONNECTED') throw err;
    const e = new Error(err.message || 'Email connection issue. Reconnect in Settings.');
    e.code = err.code || 'EMAIL_RECONNECT_REQUIRED';
    throw e;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (relay.apiKey) headers['x-api-key'] = relay.apiKey;
  const body = {
    provider: cfg.provider,
    accessToken,
    to: Array.isArray(to) ? to : to,
    subject,
    text,
    from: from || cfg.from,
    attachments: normalizeAttachmentsForRelay(attachments || [])
  };
  let res;
  let textRes = '';
  try {
    res = await fetch(relay.url, { method: 'POST', headers, body: JSON.stringify(body) });
    textRes = await res.text();
  } catch (fetchErr) {
    throw new Error(`Could not reach email service: ${fetchErr?.message || fetchErr}`);
  }
  if (!res.ok) {
    let errMsg = 'Email could not be sent';
    try {
      const err = JSON.parse(textRes);
      errMsg = err?.error || errMsg;
    } catch {
      if (textRes) errMsg = textRes.slice(0, 500);
    }
    if (res.status === 401) errMsg = 'Email service security check failed.';
    const e = new Error(errMsg);
    e.statusCode = res.status;
    throw e;
  }
}

export async function sendShiftNotification(shift, event, userId) {
  if (!shift || !shift.staff_id || !userId) return;
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(shift.staff_id);
  if (!staff) return;
  const participant = db.prepare('SELECT name FROM participants WHERE id = ?').get(shift.participant_id);
  const participantName = participant?.name || 'Participant';

  const startDate = new Date(shift.start_time);
  const endDate = new Date(shift.end_time);
  const dateStr = startDate.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = `${startDate.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} - ${endDate.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;

  const subject = event === 'created' ? 'New shift scheduled' : 'Shift updated';
  const text = `You have been ${event === 'created' ? 'scheduled' : 'assigned'} for a shift:\n\n` +
    `Date: ${dateStr}\n` +
    `Time: ${timeStr}\n` +
    `Participant: ${participantName}\n` +
    (shift.notes ? `Notes: ${shift.notes}\n` : '');

  if (staff.notify_email && staff.email && isEmailConfiguredForUser(userId)) {
    try {
      const cfg = getEmailConfigForUser(userId);
      await sendEmailViaRelay(userId, staff.email, subject, text, cfg.from, null);
    } catch (err) {
      console.warn('[sendShiftNotification] email failed:', err?.message);
    }
  }

  if (staff.notify_sms && staff.phone && process.env.TWILIO_ACCOUNT_SID) {
    try {
      const twilio = await import('twilio');
      const client = twilio.default(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.messages.create({
        body: `${subject}: ${dateStr} ${timeStr} with ${participantName}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: staff.phone.replace(/\s/g, '')
      });
    } catch (err) {
      console.warn('SMS failed:', err.message);
    }
  }
}

export function formatSmtpAuthError(err) {
  return err?.message || String(err) || 'Email send failed';
}

/** @param {string} userId - logged-in admin sending the roster */
export async function sendICSByEmail(toEmail, subject, icsContent, filename = 'shift.ics', staffShifts = null, userId) {
  if (!userId) {
    const e = new Error('Connect your email in Settings to send rosters and messages.');
    e.code = 'EMAIL_NOT_CONNECTED';
    throw e;
  }
  const cfg = getEmailConfigForUser(userId);
  if (!cfg || !getRelayConfigFromEnv()?.url) {
    const e = new Error('Connect your email in Settings to send rosters and messages.');
    e.code = 'EMAIL_NOT_CONNECTED';
    throw e;
  }
  const from = cfg.from;

  let text = 'Please find your shift(s) attached. Open the .ics file to add to your calendar.';
  if (staffShifts && staffShifts.length > 0) {
    const lines = staffShifts.map((s) => {
      const start = new Date(s.start_time);
      const end = new Date(s.end_time);
      const dateStr = start.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const timeStr = `${start.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
      let line = `\n• ${dateStr} ${timeStr} - ${s.participant_name}`;
      if (s.notes) line += `\n  Notes: ${s.notes}`;
      return line;
    });
    text = `Your roster for this week:\n${lines.join('\n')}\n\nPlease find your shift(s) attached. Open the .ics file to add to your calendar.`;
  }

  const attachments = [{ filename, content: icsContent, contentType: 'text/calendar' }];
  await sendEmailViaRelay(userId, toEmail, subject, text, from, attachments);
}
