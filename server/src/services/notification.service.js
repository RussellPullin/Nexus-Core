import { db } from '../db/index.js';
import {
  getEmailConfigForUser,
  getRelayConfigFromEnv,
  relayHostLooksLikeDocPlaceholder,
  relayUrlPointsToThisNexusApi
} from '../lib/emailSendConfig.js';
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
  const rawRelay = process.env.AZURE_EMAIL_FUNCTION_URL || '';
  if (relayHostLooksLikeDocPlaceholder(rawRelay)) {
    const e = new Error(
      'AZURE_EMAIL_FUNCTION_URL is still the example placeholder. In Azure Portal open your Function app → Overview and copy the real host (e.g. myapp.azurewebsites.net), then set AZURE_EMAIL_FUNCTION_URL to https://myapp.azurewebsites.net/api/sendEmail — no angle brackets, no literal your-function-app unless that is your app name.'
    );
    e.code = 'EMAIL_RELAY_PLACEHOLDER_URL';
    throw e;
  }
  const relay = getRelayConfigFromEnv();
  if (!relay?.url) {
    const e = new Error('Email sending is not set up on the server yet. Ask your administrator.');
    e.code = 'EMAIL_RELAY_NOT_CONFIGURED';
    throw e;
  }
  if (relayUrlPointsToThisNexusApi(relay.url)) {
    let host = '';
    try {
      host = new URL(relay.url).hostname;
    } catch {
      /* ignore */
    }
    const e = new Error(
      `AZURE_EMAIL_FUNCTION_URL points at this Nexus server (${host}), not your Azure email function. ` +
        'The relay then calls Nexus without a session cookie and you get "Not authenticated". ' +
        'Set AZURE_EMAIL_FUNCTION_URL to your Azure Function HTTPS URL (e.g. https://<app>.azurewebsites.net/api/sendEmail), same as in local .env — not your Fly app URL.'
    );
    e.code = 'EMAIL_RELAY_SELF_URL';
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
  // #region agent log
  try {
    const relayUrl = new URL(relay.url);
    fetch('http://127.0.0.1:7395/ingest/9396d2bf-ffd7-4cdc-a66d-39fbe0a7e677', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'fa9c18' },
      body: JSON.stringify({
        sessionId: 'fa9c18',
        location: 'notification.service.js:before-relay-fetch',
        message: 'relay POST about to run',
        data: {
          hypothesisId: 'A,B,D,E',
          relayHost: relayUrl.host,
          relayPathname: relayUrl.pathname,
          sendsXApiKey: Boolean(headers['x-api-key']),
          xApiKeyLen: headers['x-api-key'] ? String(headers['x-api-key']).length : 0
        },
        timestamp: Date.now()
      })
    }).catch(() => {});
  } catch (_) {}
  // #endregion
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
    const fm = fetchErr?.message || String(fetchErr);
    if (/Failed to parse URL/i.test(fm)) {
      throw new Error(
        'AZURE_EMAIL_FUNCTION_URL is not a valid URL. In Fly secrets (or .env), set it to your real Azure Function address, e.g. https://myfunctionapp.azurewebsites.net/api/sendEmail — not the <your-function-app> placeholder.'
      );
    }
    throw new Error(`Could not reach email service: ${fm}`);
  }
  if (!res.ok) {
    let errMsg = 'Email could not be sent';
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(textRes);
      errMsg = parsedBody?.error || errMsg;
    } catch {
      if (textRes) errMsg = textRes.slice(0, 500);
    }
    if (res.status === 401) {
      // #region agent log
      fetch('http://127.0.0.1:7395/ingest/9396d2bf-ffd7-4cdc-a66d-39fbe0a7e677', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'fa9c18' },
        body: JSON.stringify({
          sessionId: 'fa9c18',
          location: 'notification.service.js:relay-401',
          message: 'relay returned 401',
          data: {
            hypothesisId: 'A,C',
            parsedError: parsedBody?.error != null ? String(parsedBody.error).slice(0, 200) : '',
            bodySnippet: (textRes || '').slice(0, 400)
          },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      console.warn(
        '[email-relay] HTTP 401 from relay',
        relay.url,
        'x-api-key sent:',
        Boolean(relay.apiKey),
        'key length:',
        relay.apiKey ? relay.apiKey.length : 0,
        'response snippet:',
        (textRes || '').slice(0, 120)
      );
      console.warn(
        'AGENT_DEBUG_RELAY_401',
        JSON.stringify({
          relayHost: (() => {
            try {
              return new URL(relay.url).host;
            } catch {
              return '';
            }
          })(),
          sendsXApiKey: Boolean(relay.apiKey),
          xApiKeyLen: relay.apiKey ? relay.apiKey.length : 0,
          parsedError: parsedBody?.error != null ? String(parsedBody.error).slice(0, 200) : null,
          bodyStart: (textRes || '').slice(0, 200).replace(/\s+/g, ' ')
        })
      );
      const fromRelay =
        parsedBody?.error != null
          ? String(parsedBody.error).trim()
          : (textRes || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const lowerRelay = fromRelay.toLowerCase();
      const looksLikeFunctionApiKeyReject = /invalid or missing api key/i.test(fromRelay);
      const looksLikePlatformAuthWall =
        /\bnot authenticated\b/.test(lowerRelay) ||
        (lowerRelay.includes('unauthorized') && !looksLikeFunctionApiKeyReject);

      if (looksLikeFunctionApiKeyReject || (!looksLikePlatformAuthWall && !fromRelay)) {
        errMsg = [
          parsedBody?.error ? String(parsedBody.error).trim() : 'Invalid or missing API key',
          'Azure API_KEY and Nexus AZURE_EMAIL_API_KEY must match exactly after trimming (no extra spaces or UTF-8 BOM).',
          'Redeploy the email function after changing API_KEY; restart Fly after fly secrets set.',
          'If you do not want a key, remove API_KEY on the function app and unset AZURE_EMAIL_API_KEY on Fly.'
        ].join(' ');
      } else if (looksLikePlatformAuthWall) {
        const lead = fromRelay
          ? `${fromRelay.replace(/\.\s*$/, '')}.`
          : 'The email relay URL returned 401 before the sendEmail function ran.';
        errMsg = [
          lead,
          'Azure App Service Authentication (Easy Auth) or another gateway can block server-to-server POSTs before your function runs.',
          'In Azure Portal: open your Function app → Authentication — allow anonymous access to the app or exclude /api/sendEmail so the Nexus server can POST without a browser login.',
          'Confirm AZURE_EMAIL_FUNCTION_URL is the HTTPS URL for this function (e.g. …/api/sendEmail), not a different app or front door.',
          'Optional custom API_KEY mismatches are reported as "Invalid or missing API key" from the function itself, not this message.'
        ].join(' ');
      } else {
        errMsg = [
          fromRelay || 'Email relay returned 401.',
          'Check AZURE_EMAIL_FUNCTION_URL, Azure host authentication, and that AZURE_EMAIL_API_KEY matches Function API_KEY when you use a custom key.'
        ].join(' ');
      }
    }
    const e = new Error(errMsg);
    e.statusCode = res.status;
    e.code = res.status === 401 ? 'EMAIL_RELAY_AUTH_FAILED' : undefined;
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
