import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type WebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
};

const LOG_PREFIX = "[invite-to-shifter]";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function verifyWebhookSecret(req: Request): boolean {
  const expected = Deno.env.get("INVITE_WEBHOOK_SECRET")?.trim();
  if (!expected) return true;
  const got =
    req.headers.get("x-webhook-secret")?.trim() ||
    req.headers.get("X-Webhook-Secret")?.trim();
  return got === expected;
}

function isWebhookPayload(x: unknown): x is WebhookPayload {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.type === "string" &&
    typeof o.table === "string" &&
    typeof o.schema === "string" &&
    ("record" in o || "old_record" in o)
  );
}

function shifterJustEnabled(payload: WebhookPayload): boolean {
  if (payload.table !== "profiles" || payload.schema !== "public") return false;
  if (payload.type !== "UPDATE" && payload.type !== "INSERT") return false;

  const record = payload.record;
  if (!record || typeof record !== "object") return false;

  const nowEnabled = record.shifter_enabled === true;
  if (!nowEnabled) return false;

  if (payload.type === "INSERT") return true;

  const old = payload.old_record;
  const wasEnabled =
    old !== null &&
    typeof old === "object" &&
    (old as Record<string, unknown>).shifter_enabled === true;
  return !wasEnabled;
}

function profileEmail(record: Record<string, unknown>): string | null {
  const email = record.email;
  if (typeof email !== "string") return null;
  const t = email.trim();
  return t.length ? t : null;
}

function profileId(record: Record<string, unknown>): string | null {
  const id = record.id;
  if (typeof id === "string" && id.length) return id;
  return null;
}

function buildInviteHtml(params: { magicLink?: string; appLink: string }) {
  const magicBlock = params.magicLink
    ? `<p><a href="${params.magicLink}">Open Shifter (sign-in link)</a></p><p>This link expires shortly; request a new one from your admin if it stops working.</p>`
    : "<p>Use the Shifter mobile app and sign in with this email address.</p>";
  return `
<!DOCTYPE html>
<html><body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
  <p>You have been invited to <strong>Shifter</strong> for shift scheduling.</p>
  ${magicBlock}
  <p>Download the app: <a href="${params.appLink}">${params.appLink}</a></p>
  <p style="color:#666;font-size:14px;">If you did not expect this message, contact your organisation.</p>
</body></html>`;
}

async function sendResendInvite(params: {
  to: string;
  html: string;
  from: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = Deno.env.get("RESEND_API_KEY")?.trim();
  if (!key) return { ok: false, error: "RESEND_API_KEY not set" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from,
      to: [params.to],
      subject: "You are invited to Shifter",
      html: params.html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${text}` };
  }
  return { ok: true };
}

async function sendSendGridInvite(params: {
  to: string;
  html: string;
  fromEmail: string;
  fromName: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = Deno.env.get("SENDGRID_API_KEY")?.trim();
  if (!key) return { ok: false, error: "SENDGRID_API_KEY not set" };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: params.to }] }],
      from: { email: params.fromEmail, name: params.fromName },
      subject: "You are invited to Shifter",
      content: [{ type: "text/html", value: params.html }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `SendGrid ${res.status}: ${text}` };
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!verifyWebhookSecret(req)) {
    console.error(LOG_PREFIX, { event: "auth_failed" });
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceKey) {
    console.error(LOG_PREFIX, {
      event: "config_error",
      detail: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing",
    });
    return jsonResponse({ error: "Server misconfigured" }, 500);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    console.error(LOG_PREFIX, { event: "invalid_json" });
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!isWebhookPayload(payload)) {
    console.error(LOG_PREFIX, { event: "invalid_payload_shape" });
    return jsonResponse({ error: "Invalid webhook payload" }, 400);
  }

  if (!shifterJustEnabled(payload)) {
    console.log(LOG_PREFIX, {
      event: "skipped",
      reason: "not_profiles_shifter_enable_transition",
      type: payload.type,
      table: payload.table,
    });
    return jsonResponse({ ok: true, skipped: true });
  }

  const record = payload.record as Record<string, unknown>;
  const email = profileEmail(record);
  const userId = profileId(record);

  if (!email) {
    console.error(LOG_PREFIX, {
      event: "failure",
      reason: "missing_email",
      profile_id: userId,
    });
    return jsonResponse({ ok: false, error: "Profile has no email" }, 422);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const redirectTo =
    Deno.env.get("SHIFTER_MAGIC_LINK_REDIRECT")?.trim() ||
    Deno.env.get("SITE_URL")?.trim() ||
    undefined;

  const resendKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const sendgridKey = Deno.env.get("SENDGRID_API_KEY")?.trim();
  const customEmailProvider = resendKey
    ? "resend"
    : sendgridKey
      ? "sendgrid"
      : null;

  const appLink =
    Deno.env.get("SHIFTER_APP_DOWNLOAD_URL")?.trim() ||
    "https://example.com/download-shifter";

  try {
    if (customEmailProvider) {
      let magicLink: string | undefined;
      const { data: linkData, error: linkErr } =
        await admin.auth.admin.generateLink({
          type: "magiclink",
          email,
          options: redirectTo ? { redirectTo } : undefined,
        });
      if (linkErr) {
        console.error(LOG_PREFIX, {
          event: "magic_link_failed",
          email,
          profile_id: userId,
          error: linkErr.message,
        });
      } else {
        magicLink = linkData?.properties?.action_link;
      }

      const html = buildInviteHtml({ magicLink, appLink });

      const sent =
        customEmailProvider === "resend"
          ? await sendResendInvite({
              to: email,
              html,
              from:
                Deno.env.get("RESEND_FROM")?.trim() ||
                "Shifter <onboarding@resend.dev>",
            })
          : await sendSendGridInvite({
              to: email,
              html,
              fromEmail:
                Deno.env.get("SENDGRID_FROM_EMAIL")?.trim() ||
                "noreply@example.com",
              fromName: Deno.env.get("SENDGRID_FROM_NAME")?.trim() || "Shifter",
            });

      if (!sent.ok) {
        console.error(LOG_PREFIX, {
          event: "failure",
          channel: customEmailProvider,
          email,
          profile_id: userId,
          error: sent.error,
        });
        return jsonResponse({ ok: false, error: sent.error }, 502);
      }
      console.log(LOG_PREFIX, {
        event: "success",
        channel: customEmailProvider,
        email,
        profile_id: userId,
        had_magic_link: Boolean(magicLink),
      });
      return jsonResponse({ ok: true, channel: customEmailProvider });
    }

    const { data: inviteData, error: inviteErr } =
      await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
      });

    if (inviteErr) {
      const msg = inviteErr.message?.toLowerCase?.() ?? "";
      const alreadyRegistered =
        msg.includes("registered") ||
        msg.includes("already") ||
        msg.includes("exists");

      if (alreadyRegistered) {
        console.error(LOG_PREFIX, {
          event: "failure",
          channel: "auth_invite",
          email,
          profile_id: userId,
          error: inviteErr.message,
          hint: "User already exists; set RESEND_API_KEY or SENDGRID_API_KEY to send a custom Shifter email with a magic link.",
        });
        return jsonResponse(
          {
            ok: false,
            error: inviteErr.message,
            hint:
              "Configure RESEND_API_KEY or SENDGRID_API_KEY for existing users.",
          },
          409,
        );
      }

      console.error(LOG_PREFIX, {
        event: "failure",
        channel: "auth_invite",
        email,
        profile_id: userId,
        error: inviteErr.message,
      });
      return jsonResponse({ ok: false, error: inviteErr.message }, 502);
    }

    console.log(LOG_PREFIX, {
      event: "success",
      channel: "auth_invite",
      email,
      profile_id: userId,
      user_id: inviteData?.user?.id,
    });
    return jsonResponse({ ok: true, channel: "auth_invite" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(LOG_PREFIX, {
      event: "failure",
      email,
      profile_id: userId,
      error: message,
    });
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
