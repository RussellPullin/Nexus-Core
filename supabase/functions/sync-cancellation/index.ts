import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type WebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
};

type DeploymentSide = "shifter" | "nexuscore";

type CancellationReason =
  | "client_cancelled_notice"
  | "client_cancelled_short_notice"
  | "worker_cancelled"
  | "emergency"
  | "no_show";

type BillingAction = "none" | "cancellation_fee" | "review";

const LOG_PREFIX = "[sync-cancellation]";

const CANCELLATION_REASONS = new Set<string>([
  "client_cancelled_notice",
  "client_cancelled_short_notice",
  "worker_cancelled",
  "emergency",
  "no_show",
]);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function verifyWebhookSecret(req: Request): boolean {
  const expected = Deno.env.get("SYNC_CANCELLATION_WEBHOOK_SECRET")?.trim();
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

function str(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return v.trim();
}

function detectDeploymentSide(): DeploymentSide | null {
  const nexusRemote = Deno.env.get("NEXUSCORE_SUPABASE_URL")?.trim();
  const shifterRemote = Deno.env.get("SHIFTER_SUPABASE_URL")?.trim();
  if (nexusRemote && !shifterRemote) return "shifter";
  if (shifterRemote && !nexusRemote) return "nexuscore";
  console.error(LOG_PREFIX, {
    event: "config_error",
    detail:
      "Set exactly one remote pair: (NEXUSCORE_SUPABASE_URL + NEXUSCORE_SERVICE_ROLE_KEY) on Shifter, or (SHIFTER_SUPABASE_URL + SHIFTER_SERVICE_ROLE_KEY) on NexusCore",
  });
  return null;
}

function makeClients(side: DeploymentSide): {
  local: SupabaseClient;
  remote: SupabaseClient;
} {
  const localUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const localKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!localUrl || !localKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing for local project");
  }
  const local = createClient(localUrl, localKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (side === "shifter") {
    const remoteUrl = Deno.env.get("NEXUSCORE_SUPABASE_URL")?.trim();
    const remoteKey = Deno.env.get("NEXUSCORE_SERVICE_ROLE_KEY")?.trim();
    if (!remoteUrl || !remoteKey) {
      throw new Error("NEXUSCORE_SUPABASE_URL or NEXUSCORE_SERVICE_ROLE_KEY missing");
    }
    const remote = createClient(remoteUrl, remoteKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return { local, remote };
  }

  const remoteUrl = Deno.env.get("SHIFTER_SUPABASE_URL")?.trim();
  const remoteKey = Deno.env.get("SHIFTER_SERVICE_ROLE_KEY")?.trim();
  if (!remoteUrl || !remoteKey) {
    throw new Error("SHIFTER_SUPABASE_URL or SHIFTER_SERVICE_ROLE_KEY missing");
  }
  const remote = createClient(remoteUrl, remoteKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { local, remote };
}

function statusStr(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  return str(record.status);
}

/** True when this row update was applied by the peer app — do not echo back. */
function isEchoFromPeer(side: DeploymentSide, record: Record<string, unknown>): boolean {
  const marker = str(record.cancellation_synced_from);
  if (side === "shifter" && marker === "nexuscore") return true;
  if (side === "nexuscore" && marker === "shifter") return true;
  return false;
}

function becameCancelled(payload: WebhookPayload): boolean {
  if (payload.type !== "UPDATE" || payload.table !== "shifts" || payload.schema !== "public") {
    return false;
  }
  const now = statusStr(payload.record);
  const before = statusStr(payload.old_record);
  return now === "cancelled" && before !== "cancelled";
}

function cancellationReasonFromRecord(record: Record<string, unknown>): string | null {
  return (
    str(record.cancellation_reason) ??
    str(record.cancel_reason) ??
    str(record.cancellation_reason_code)
  );
}

function billingActionForReason(reason: string): {
  billing_action: BillingAction;
  escalate: boolean;
} {
  const r = reason;
  switch (r as CancellationReason) {
    case "client_cancelled_notice":
      return { billing_action: "none", escalate: false };
    case "client_cancelled_short_notice":
      return { billing_action: "cancellation_fee", escalate: false };
    case "worker_cancelled":
      return { billing_action: "review", escalate: false };
    case "emergency":
      return { billing_action: "review", escalate: false };
    case "no_show":
      return { billing_action: "review", escalate: true };
    default:
      return { billing_action: "review", escalate: false };
  }
}

async function ensureDraftCancellationFeeLine(
  nexus: SupabaseClient,
  shiftId: string,
  reason: string,
): Promise<{ created: boolean; line_id?: string; error?: string }> {
  const amountRaw = Deno.env.get("CANCELLATION_FEE_AMOUNT")?.trim() ?? "0";
  const amount = Number.parseFloat(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.warn(LOG_PREFIX, {
      event: "cancellation_fee_skipped",
      reason: "invalid_or_zero_CANCELLATION_FEE_AMOUNT",
      nexuscore_shift_id: shiftId,
    });
    return { created: false, error: "CANCELLATION_FEE_AMOUNT not set or invalid" };
  }

  const table = Deno.env.get("NEXUS_DRAFT_INVOICE_LINE_TABLE")?.trim() ||
    "draft_invoice_line_items";

  const { data: existing, error: selErr } = await nexus
    .from(table)
    .select("id")
    .eq("shift_id", shiftId)
    .eq("line_type", "cancellation_fee")
    .eq("status", "draft")
    .maybeSingle();

  if (selErr) {
    return { created: false, error: selErr.message };
  }
  if (existing?.id) {
    console.log(LOG_PREFIX, {
      event: "draft_line_already_exists",
      nexuscore_shift_id: shiftId,
      draft_line_id: existing.id,
    });
    return { created: false, line_id: str(existing.id as string) ?? undefined };
  }

  const description =
    Deno.env.get("CANCELLATION_FEE_DESCRIPTION")?.trim() ??
    "Short-notice cancellation fee";

  const row = {
    shift_id: shiftId,
    line_type: "cancellation_fee",
    description,
    quantity: 1,
    unit_amount: amount,
    status: "draft",
    metadata: { cancellation_reason: reason },
  };

  const { data: inserted, error: insErr } = await nexus.from(table).insert(row).select("id").single();
  if (insErr) {
    return { created: false, error: insErr.message };
  }
  const lineId = str(inserted?.id as string);
  return { created: true, line_id: lineId ?? undefined };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!verifyWebhookSecret(req)) {
    console.error(LOG_PREFIX, { event: "auth_failed" });
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const side = detectDeploymentSide();
  if (!side) {
    return jsonResponse({ error: "Invalid env: could not detect deployment side" }, 500);
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

  if (!becameCancelled(payload)) {
    console.log(LOG_PREFIX, {
      event: "skipped",
      reason: "not_shift_update_to_cancelled",
      type: payload.type,
      table: payload.table,
    });
    return jsonResponse({ ok: true, skipped: true });
  }

  const record = payload.record as Record<string, unknown>;

  if (isEchoFromPeer(side, record)) {
    console.log(LOG_PREFIX, {
      event: "skipped",
      reason: "echo_from_peer",
      side,
      cancellation_synced_from: str(record.cancellation_synced_from),
    });
    return jsonResponse({ ok: true, skipped: true, reason: "echo_from_peer" });
  }

  let local: SupabaseClient;
  let remote: SupabaseClient;
  try {
    ({ local, remote } = makeClients(side));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(LOG_PREFIX, { event: "config_error", error: message });
    return jsonResponse({ error: message }, 500);
  }

  const reason = cancellationReasonFromRecord(record);
  if (!reason || !CANCELLATION_REASONS.has(reason)) {
    console.error(LOG_PREFIX, {
      event: "failure",
      reason: "missing_or_unknown_cancellation_reason",
      side,
      cancellation_reason: reason,
    });
    return jsonResponse(
      {
        ok: false,
        error:
          "cancellation_reason must be one of: client_cancelled_notice, client_cancelled_short_notice, worker_cancelled, emergency, no_show",
      },
      422,
    );
  }

  const { billing_action, escalate } = billingActionForReason(reason);
  const cancelledAt = str(record.cancelled_at) ?? new Date().toISOString();

  try {
    if (side === "shifter") {
      // --- Shifter (local) → NexusCore (remote) ---
      const shifterShiftId = str(record.id);
      const nexuscoreShiftId = str(record.nexuscore_shift_id);
      if (!shifterShiftId) {
        return jsonResponse({ ok: false, error: "Shift record has no id" }, 422);
      }
      if (!nexuscoreShiftId) {
        console.warn(LOG_PREFIX, {
          event: "skipped",
          reason: "nexuscore_shift_id_null",
          shifter_shift_id: shifterShiftId,
        });
        return jsonResponse({ ok: true, skipped: true, reason: "nexuscore_shift_id_null" });
      }

      const nexusPatch = {
        status: "cancelled",
        cancellation_reason: reason,
        billing_action,
        cancellation_escalate: escalate,
        cancelled_at: cancelledAt,
        cancellation_synced_from: "shifter",
      };

      const { error: nexusErr } = await remote.from("shifts").update(nexusPatch).eq(
        "id",
        nexuscoreShiftId,
      );
      if (nexusErr) {
        console.error(LOG_PREFIX, {
          event: "nexus_shift_update_failed",
          direction: "shifter_to_nexuscore",
          shifter_shift_id: shifterShiftId,
          nexuscore_shift_id: nexuscoreShiftId,
          error: nexusErr.message,
        });
        return jsonResponse({ ok: false, error: nexusErr.message }, 502);
      }

      let feeResult: Record<string, unknown> | null = null;
      if (billing_action === "cancellation_fee") {
        feeResult = await ensureDraftCancellationFeeLine(remote, nexuscoreShiftId, reason);
        if (feeResult.error && !feeResult.created) {
          console.error(LOG_PREFIX, {
            event: "draft_line_item_failed",
            nexuscore_shift_id: nexuscoreShiftId,
            error: feeResult.error,
          });
        }
      }

      console.log(LOG_PREFIX, {
        event: "success",
        direction: "shifter_to_nexuscore",
        shifter_shift_id: shifterShiftId,
        nexuscore_shift_id: nexuscoreShiftId,
        cancellation_reason: reason,
        billing_action,
        cancellation_escalate: escalate,
        draft_line: feeResult,
      });

      return jsonResponse({
        ok: true,
        synced: true,
        direction: "shifter_to_nexuscore",
        shifter_shift_id: shifterShiftId,
        nexuscore_shift_id: nexuscoreShiftId,
        billing_action,
        cancellation_escalate: escalate,
        draft_line: feeResult,
      });
    }

    // --- NexusCore (local) → Shifter (remote) ---
    const nexuscoreShiftId = str(record.id);
    if (!nexuscoreShiftId) {
      return jsonResponse({ ok: false, error: "Shift record has no id" }, 422);
    }

      const nexusPatch = {
        cancellation_reason: reason,
        billing_action,
        cancellation_escalate: escalate,
        cancelled_at: cancelledAt,
      };

      const { error: nexusSelfErr } = await local.from("shifts").update(nexusPatch).eq(
        "id",
        nexuscoreShiftId,
      );
    if (nexusSelfErr) {
      console.error(LOG_PREFIX, {
        event: "nexus_self_update_failed",
        direction: "nexuscore_to_shifter",
        nexuscore_shift_id: nexuscoreShiftId,
        error: nexusSelfErr.message,
      });
      return jsonResponse({ ok: false, error: nexusSelfErr.message }, 502);
    }

    let feeResult: Record<string, unknown> | null = null;
    if (billing_action === "cancellation_fee") {
      feeResult = await ensureDraftCancellationFeeLine(local, nexuscoreShiftId, reason);
      if (feeResult.error && !feeResult.created) {
        console.error(LOG_PREFIX, {
          event: "draft_line_item_failed",
          nexuscore_shift_id: nexuscoreShiftId,
          error: feeResult.error,
        });
      }
    }

    const shifterPatch = {
      status: "cancelled",
      cancellation_reason: reason,
      cancelled_at: cancelledAt,
      cancellation_synced_from: "nexuscore",
    };

    const { error: shifterErr } = await remote.from("shifts").update(shifterPatch).eq(
      "nexuscore_shift_id",
      nexuscoreShiftId,
    );
    if (shifterErr) {
      console.error(LOG_PREFIX, {
        event: "shifter_shift_update_failed",
        direction: "nexuscore_to_shifter",
        nexuscore_shift_id: nexuscoreShiftId,
        error: shifterErr.message,
      });
      return jsonResponse({ ok: false, error: shifterErr.message }, 502);
    }

    console.log(LOG_PREFIX, {
      event: "success",
      direction: "nexuscore_to_shifter",
      nexuscore_shift_id: nexuscoreShiftId,
      cancellation_reason: reason,
      billing_action,
      cancellation_escalate: escalate,
      draft_line: feeResult,
    });

    return jsonResponse({
      ok: true,
      synced: true,
      direction: "nexuscore_to_shifter",
      nexuscore_shift_id: nexuscoreShiftId,
      billing_action,
      cancellation_escalate: escalate,
      draft_line: feeResult,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(LOG_PREFIX, { event: "unexpected_error", side, error: message });
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
