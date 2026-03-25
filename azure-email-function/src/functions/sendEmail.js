import { app } from '@azure/functions';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

function loadLocalSettings() {
  if (process.env.API_KEY) return;
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'local.settings.json'),
    join(process.cwd(), 'local.settings.json'),
    (process.env.AzureWebJobsScriptRoot && join(process.env.AzureWebJobsScriptRoot, 'local.settings.json')) || '',
    join(process.cwd(), '..', 'local.settings.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const { Values = {} } = JSON.parse(readFileSync(p, 'utf8'));
        if (!process.env.API_KEY && Values.API_KEY) process.env.API_KEY = Values.API_KEY;
        return;
      } catch (_) {}
    }
  }
}

app.http('sendEmail', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      return await handleSendEmail(request, context);
    } catch (topErr) {
      const msg = topErr?.message || String(topErr);
      context.error('Unhandled error:', msg);
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Unhandled: ${msg}` }) };
    }
  }
});

function encodeGmailRaw(rfc822) {
  return Buffer.from(rfc822, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildGmailRfc822({ from, to, subject, text, attachments }) {
  const toList = Array.isArray(to) ? to : [to];
  const boundary = 'nexus_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const hasAtt = attachments && Array.isArray(attachments) && attachments.length > 0;

  let body = '';
  if (hasAtt) {
    body += `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n`;
    body += (text || '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') + '\r\n';
    for (const a of attachments) {
      const name = (a.filename || 'attachment').replace(/[\r\n"\\]/g, '_');
      const ct = a.contentType || 'application/octet-stream';
      const b64 = typeof a.content === 'string' ? a.content.replace(/\s/g, '') : Buffer.from(a.content || '').toString('base64');
      const lines = b64.match(/.{1,76}/g) || [b64];
      body += `--${boundary}\r\nContent-Type: ${ct}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
      body += lines.join('\r\n') + '\r\n';
    }
    body += `--${boundary}--\r\n`;
    return [
      `From: ${from}`,
      `To: ${toList.join(', ')}`,
      `Subject: ${encodeMimeHeader(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      body
    ].join('\r\n');
  }
  return [
    `From: ${from}`,
    `To: ${toList.join(', ')}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text || ''
  ].join('\r\n');
}

function encodeMimeHeader(s) {
  const str = String(s || '');
  if (/^[\x20-\x7E]*$/.test(str) && !/[\r\n]/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

async function handleSendEmail(request, context) {
  loadLocalSettings();
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const reqKey = request.headers.get('x-api-key');
    if (reqKey !== apiKey) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid or missing API key' }) };
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { provider, accessToken, to, subject, text, from: fromEmail, attachments } = body;
  if (!provider || !accessToken || !to || !subject || !fromEmail) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required fields: provider, accessToken, to, subject, from' })
    };
  }

  if (provider !== 'google' && provider !== 'microsoft') {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'provider must be google or microsoft' }) };
  }

  if (provider === 'microsoft') {
    return await sendMicrosoft(context, accessToken, { to, subject, text, from: fromEmail, attachments });
  }
  return await sendGoogle(context, accessToken, { to, subject, text, from: fromEmail, attachments });
}

async function sendMicrosoft(context, token, { to, subject, text, from, attachments }) {
  const message = {
    subject,
    body: { contentType: 'Text', content: text || '' },
    toRecipients: Array.isArray(to) ? to.map((addr) => ({ emailAddress: { address: addr } })) : [{ emailAddress: { address: to } }]
  };

  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    message.attachments = attachments.map((a) => {
      const content = a.content;
      const contentBytes = typeof content === 'string'
        ? (content.match(/^[A-Za-z0-9+/=\s]+$/) ? content.replace(/\s/g, '') : Buffer.from(content, 'utf8').toString('base64'))
        : (Buffer.isBuffer(content) ? content.toString('base64') : String(content));
      return {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename || 'attachment',
        contentType: a.contentType || 'application/octet-stream',
        contentBytes
      };
    });
  }

  const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, saveToSentItems: true })
  });

  const responseBody = await response.text();
  context.log('Graph sendMail', response.status, (responseBody || '').slice(0, 200));

  if (!response.ok) {
    let errMsg = `Graph API ${response.status}`;
    try {
      const parsed = JSON.parse(responseBody);
      errMsg = parsed?.error?.message || parsed?.error?.code || errMsg;
    } catch (_) {}
    return {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: errMsg })
    };
  }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
}

async function sendGoogle(context, token, { to, subject, text, from, attachments }) {
  const rfc822 = buildGmailRfc822({ from, to, subject, text, attachments });
  const raw = encodeGmailRaw(rfc822);
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw })
  });
  const responseBody = await response.text();
  context.log('Gmail send', response.status, (responseBody || '').slice(0, 200));

  if (!response.ok) {
    let errMsg = `Gmail API ${response.status}`;
    try {
      const parsed = JSON.parse(responseBody);
      errMsg = parsed?.error?.message || parsed?.error?.errors?.[0]?.message || errMsg;
    } catch (_) {}
    return {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: errMsg })
    };
  }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
}
