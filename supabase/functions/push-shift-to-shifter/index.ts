import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type WebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
};

const LOG_PREFIX = "[push-shift-to-shifter]";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Optional shared secret from Database Webhook HTTP headers. */
function verifyWebhookSecret(req: Request): boolean {
  const expected = Deno.env.get("SHIFT_PUSH_WEBHOOK_SECRET")?.trim();
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

function isShiftInsertOrUpdate(payload: WebhookPayload): boolean {
  if (payload.table !== "shifts" || payload.schema !== "public") return false;
  if (payload.type !== "INSERT" && payload.type !== "UPDATE") return false;
  return Boolean(payload.record && typeof payload.record === "object");
}

/** NexusCore shift row → profiles.id of the assigned worker (adjust keys if your schema differs). */
function staffProfileIdFromShift(record: Record<string, unknown>): string | null {
  for (const key of ["staff_id", "worker_id", "profile_id", "user_id"]) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function shiftId(record: Record<string, unknown>): string | null {
  const id = record.id;
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

function pickScheduledStart(record: Record<string, unknown>): unknown {
  return record.scheduled_start ?? record.start_time ?? null;
}

function pickScheduledEnd(record: Record<string, unknown>): unknown {
  return record.scheduled_end ?? record.end_time ?? null;
}

function pickClient(record: Record<string, unknown>): unknown {
  return record.client ?? record.client_name ?? record.client_id ?? null;
}

function pickOrg(record: Record<string, unknown>): unknown {
  return record.org ?? record.org_id ?? null;
}

function pickStatus(record: Record<string, unknown>): unknown {
  return record.status ?? null;
}

/** Shifter columns are text-friendly; adjust if your Shifter schema uses jsonb/uuid types only. */
function coerceShifterField(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!verifyWebhookSecret(req)) {
    console.error(LOG_PREFIX, { event: "auth_failed" });
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const nexusUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const nexusServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  const shifterUrl = Deno.env.get("SHIFTER_SUPABASE_URL")?.trim();
  const shifterServiceKey = Deno.env.get("SHIFTER_SERVICE_ROLE_KEY")?.trim();

  if (!nexusUrl || !nexusServiceKey) {
    console.error(LOG_PREFIX, {
      event: "config_error",
      detail: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing",
    });
    return jsonResponse({ error: "NexusCore Supabase env missing" }, 500);
  }

  if (!shifterUrl || !shifterServiceKey) {
    console.error(LOG_PREFIX, {
      event: "config_error",
      detail: "SHIFTER_SUPABASE_URL or SHIFTER_SERVICE_ROLE_KEY missing",
    });
    return jsonResponse({ error: "Shifter Supabase env missing" }, 500);
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

  if (!isShiftInsertOrUpdate(payload)) {
    console.log(LOG_PREFIX, {
      event: "skipped",
      reason: "not_public_shifts_insert_or_update",
      type: payload.type,
      table: payload.table,
      schema: payload.schema,
    });
    return jsonResponse({ ok: true, skipped: true });
  }

  const record = payload.record as Record<string, unknown>;
  const shiftRowId = shiftId(record);
  if (!shiftRowId) {
    console.error(LOG_PREFIX, { event: "failure", reason: "missing_shift_id" });
    return jsonResponse({ ok: false, error: "Shift record has no id" }, 422);
  }

  const staffProfileId = staffProfileIdFromShift(record);
  if (!staffProfileId) {
    console.log(LOG_PREFIX, {
      event: "skipped",
      reason: "no_staff_profile_key_on_shift",
      shift_id: shiftRowId,
    });
    return jsonResponse({ ok: true, skipped: true, reason: "no_staff_profile_key" });
  }

  const nexus: SupabaseClient = createClient(nexusUrl, nexusServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const shifter: SupabaseClient = createClient(shifterUrl, shifterServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: nexusProfile, error: nexusProfileErr } = await nexus
      .from("profiles")
      .select("id, email, shifter_enabled")
      .eq("id", staffProfileId)
      .maybeSingle();

    if (nexusProfileErr) {
      console.error(LOG_PREFIX, {
        event: "nexus_profile_lookup_failed",
        shift_id: shiftRowId,
        staff_profile_id: staffProfileId,
        error: nexusProfileErr.message,
      });
      return jsonResponse(
        { ok: false, error: nexusProfileErr.message },
        502,
      );
    }

    if (!nexusProfile?.shifter_enabled) {
      console.log(LOG_PREFIX, {
        event: "skipped",
        reason: "shifter_not_enabled",
        shift_id: shiftRowId,
        staff_profile_id: staffProfileId,
      });
      return jsonResponse({ ok: true, skipped: true, reason: "shifter_not_enabled" });
    }

    const rawEmail = nexusProfile.email;
    if (typeof rawEmail !== "string" || !rawEmail.trim()) {
      console.error(LOG_PREFIX, {
        event: "failure",
        reason: "nexus_profile_missing_email",
        shift_id: shiftRowId,
        staff_profile_id: staffProfileId,
      });
      return jsonResponse(
        { ok: false, error: "NexusCore profile has no email" },
        422,
      );
    }

    const emailNorm = normalizeEmail(rawEmail);

    const { data: shifterProfiles, error: shifterLookupErr } = await shifter
      .from("profiles")
      .select("id")
      .ilike("email", emailNorm)
      .limit(2);

    if (shifterLookupErr) {
      console.error(LOG_PREFIX, {
        event: "shifter_profile_lookup_failed",
        shift_id: shiftRowId,
        email: emailNorm,
        error: shifterLookupErr.message,
      });
      return jsonResponse(
        { ok: false, error: shifterLookupErr.message },
        502,
      );
    }

    if (!shifterProfiles?.length) {
      console.error(LOG_PREFIX, {
        event: "failure",
        reason: "no_shifter_profile_for_email",
        shift_id: shiftRowId,
        email: emailNorm,
      });
      return jsonResponse(
        { ok: false, error: "No Shifter profile for this email" },
        422,
      );
    }

    if (shifterProfiles.length > 1) {
      console.error(LOG_PREFIX, {
        event: "failure",
        reason: "ambiguous_shifter_email",
        shift_id: shiftRowId,
        email: emailNorm,
        count: shifterProfiles.length,
      });
      return jsonResponse(
        { ok: false, error: "Multiple Shifter profiles match this email" },
        422,
      );
    }

    const workerId = shifterProfiles[0].id as string;

    const scheduledStart = pickScheduledStart(record);
    const scheduledEnd = pickScheduledEnd(record);
    if (scheduledStart === null || scheduledEnd === null) {
      console.error(LOG_PREFIX, {
        event: "failure",
        reason: "missing_schedule_bounds",
        shift_id: shiftRowId,
      });
      return jsonResponse(
        { ok: false, error: "Shift missing scheduled_start/end (or start_time/end_time)" },
        422,
      );
    }

    const statusStr = coerceShifterField(pickStatus(record));
    const upsertRow = {
      nexuscore_shift_id: shiftRowId,
      worker_id: workerId,
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      client: coerceShifterField(pickClient(record)),
      org: coerceShifterField(pickOrg(record)),
      status:
        statusStr === null || statusStr === "" ? "scheduled" : statusStr,
    };

    const { error: upsertErr } = await shifter.from("shifts").upsert(upsertRow, {
      onConflict: "nexuscore_shift_id",
    });

    if (upsertErr) {
      console.error(LOG_PREFIX, {
        event: "shifter_upsert_failed",
        shift_id: shiftRowId,
        worker_id: workerId,
        error: upsertErr.message,
        details: upsertErr,
      });
      return jsonResponse({ ok: false, error: upsertErr.message }, 502);
    }

    console.log(LOG_PREFIX, {
      event: "success",
      shift_id: shiftRowId,
      worker_id: workerId,
      email: emailNorm,
    });

    return jsonResponse({
      ok: true,
      synced: true,
      nexuscore_shift_id: shiftRowId,
      shifter_worker_id: workerId,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(LOG_PREFIX, {
      event: "unexpected_error",
      shift_id: shiftRowId,
      error: message,
    });
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
