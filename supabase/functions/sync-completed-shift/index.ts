import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type WebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
};

const LOG_PREFIX = "[sync-completed-shift]";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Optional shared secret from Database Webhook HTTP headers. */
function verifyWebhookSecret(req: Request): boolean {
  const expected = Deno.env.get("SYNC_COMPLETED_SHIFT_WEBHOOK_SECRET")?.trim();
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

function isProgressNoteInsert(payload: WebhookPayload): boolean {
  if (payload.table !== "progress_notes" || payload.schema !== "public") {
    return false;
  }
  if (payload.type !== "INSERT") return false;
  return Boolean(payload.record && typeof payload.record === "object");
}

function str(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return v.trim();
}

/** progress_notes.worker_id (or staff_id) → profiles.id === auth.users.id */
function workerIdFromNote(record: Record<string, unknown>): string | null {
  return str(record.worker_id) ?? str(record.staff_id) ?? str(record.profile_id);
}

function shiftIdFromNote(record: Record<string, unknown>): string | null {
  return str(record.shift_id);
}

/**
 * Build ISO-like timestamps for NexusCore from Shifter progress note fields.
 * Handles full ISO strings, or support_date + start_time/end_time.
 */
function toIsoDateTime(
  supportDate: unknown,
  time: unknown,
  fallbackFromShift: string | null,
): string | null {
  const direct = str(time);
  if (direct) {
    if (direct.includes("T") || direct.length >= 19) {
      const d = new Date(direct);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }

  const datePart = str(supportDate as string) ?? fallbackFromShift;
  if (!datePart) return direct;

  const dateOnly = datePart.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    return direct;
  }

  const t = direct ?? "00:00:00";
  const normalized =
    t.length === 5 ? `${t}:00` : t.length >= 8 ? t.slice(0, 8) : "00:00:00";
  const combined = `${dateOnly}T${normalized}`;
  const d = new Date(combined);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function notesFromRecord(record: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const key of [
    "notes",
    "session_details",
    "body",
    "content",
    "description",
    "incidents",
  ]) {
    const s = str(record[key]);
    if (s) parts.push(s);
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!verifyWebhookSecret(req)) {
    console.error(LOG_PREFIX, { event: "auth_failed" });
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const shifterUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const shifterServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  const nexusUrl = Deno.env.get("NEXUSCORE_SUPABASE_URL")?.trim();
  const nexusServiceKey = Deno.env.get("NEXUSCORE_SERVICE_ROLE_KEY")?.trim();

  if (!shifterUrl || !shifterServiceKey) {
    console.error(LOG_PREFIX, {
      event: "config_error",
      detail: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing (Shifter)",
    });
    return jsonResponse({ error: "Shifter Supabase env missing" }, 500);
  }

  if (!nexusUrl || !nexusServiceKey) {
    console.error(LOG_PREFIX, {
      event: "config_error",
      detail: "NEXUSCORE_SUPABASE_URL or NEXUSCORE_SERVICE_ROLE_KEY missing",
    });
    return jsonResponse({ error: "NexusCore Supabase env missing" }, 500);
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

  if (!isProgressNoteInsert(payload)) {
    console.log(LOG_PREFIX, {
      event: "skipped",
      reason: "not_public_progress_notes_insert",
      type: payload.type,
      table: payload.table,
      schema: payload.schema,
    });
    return jsonResponse({ ok: true, skipped: true });
  }

  const record = payload.record as Record<string, unknown>;
  const progressNoteId = str(record.id);

  const shiftId = shiftIdFromNote(record);
  if (!shiftId) {
    console.error(LOG_PREFIX, {
      event: "failure",
      reason: "missing_shift_id",
      progress_note_id: progressNoteId,
    });
    return jsonResponse({ ok: false, error: "progress_notes.shift_id is required" }, 422);
  }

  const workerId = workerIdFromNote(record);
  if (!workerId) {
    console.error(LOG_PREFIX, {
      event: "failure",
      reason: "missing_worker_id",
      progress_note_id: progressNoteId,
      shift_id: shiftId,
    });
    return jsonResponse(
      { ok: false, error: "progress_notes.worker_id (or staff_id) is required" },
      422,
    );
  }

  const shifter: SupabaseClient = createClient(shifterUrl, shifterServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nexus: SupabaseClient = createClient(nexusUrl, nexusServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: shiftRow, error: shiftErr } = await shifter
      .from("shifts")
      .select("nexuscore_shift_id, scheduled_start")
      .eq("id", shiftId)
      .maybeSingle();

    if (shiftErr) {
      console.error(LOG_PREFIX, {
        event: "shifter_shift_fetch_failed",
        shift_id: shiftId,
        progress_note_id: progressNoteId,
        error: shiftErr.message,
      });
      return jsonResponse({ ok: false, error: shiftErr.message }, 502);
    }

    if (!shiftRow) {
      console.error(LOG_PREFIX, {
        event: "failure",
        reason: "shift_not_found",
        shift_id: shiftId,
        progress_note_id: progressNoteId,
      });
      return jsonResponse({ ok: false, error: "Shift not found in Shifter" }, 404);
    }

    const nexuscoreShiftId = str(shiftRow.nexuscore_shift_id as string);
    if (!nexuscoreShiftId) {
      console.warn(LOG_PREFIX, {
        event: "skipped",
        reason: "nexuscore_shift_id_null",
        shift_id: shiftId,
        progress_note_id: progressNoteId,
      });
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "nexuscore_shift_id_null",
      });
    }

    const { data: profile, error: profileErr } = await shifter
      .from("profiles")
      .select("email")
      .eq("id", workerId)
      .maybeSingle();

    if (profileErr) {
      console.error(LOG_PREFIX, {
        event: "shifter_profile_lookup_failed",
        worker_id: workerId,
        progress_note_id: progressNoteId,
        error: profileErr.message,
      });
      return jsonResponse({ ok: false, error: profileErr.message }, 502);
    }

    const workerEmail = str(profile?.email as string);
    if (!workerEmail) {
      console.warn(LOG_PREFIX, {
        event: "warning",
        reason: "profile_missing_email",
        worker_id: workerId,
        progress_note_id: progressNoteId,
      });
    }

    const dateFallback = str(shiftRow.scheduled_start as string)?.slice(0, 10) ?? null;

    const actualStart =
      toIsoDateTime(record.support_date, record.actual_start ?? record.start_time, dateFallback) ??
      toIsoDateTime(record.support_date, record.started_at, dateFallback);

    const actualEnd =
      toIsoDateTime(record.support_date, record.actual_end ?? record.end_time, dateFallback) ??
      toIsoDateTime(record.support_date, record.ended_at, dateFallback);

    const notes = notesFromRecord(record);

    const { error: updateErr } = await nexus
      .from("shifts")
      .update({
        actual_start: actualStart,
        actual_end: actualEnd,
        notes,
        status: "completed",
      })
      .eq("id", nexuscoreShiftId);

    if (updateErr) {
      console.error(LOG_PREFIX, {
        event: "nexus_shift_update_failed",
        nexuscore_shift_id: nexuscoreShiftId,
        shift_id: shiftId,
        progress_note_id: progressNoteId,
        error: updateErr.message,
        details: updateErr,
      });
      return jsonResponse({ ok: false, error: updateErr.message }, 502);
    }

    console.log(LOG_PREFIX, {
      event: "success",
      nexuscore_shift_id: nexuscoreShiftId,
      shifter_shift_id: shiftId,
      progress_note_id: progressNoteId,
      worker_id: workerId,
      worker_email: workerEmail ?? null,
    });

    return jsonResponse({
      ok: true,
      synced: true,
      nexuscore_shift_id: nexuscoreShiftId,
      shifter_shift_id: shiftId,
      progress_note_id: progressNoteId,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(LOG_PREFIX, {
      event: "unexpected_error",
      progress_note_id: progressNoteId,
      shift_id: shiftId,
      error: message,
    });
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
