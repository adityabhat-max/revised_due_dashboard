import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const WEBHOOK_SHARED_SECRET = Deno.env.get("WEBHOOK_SHARED_SECRET");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Recursively flattens nested objects into dot-notation keys
// (invoice.guest.first_name). Arrays and null are kept native since the
// target is JSONB, not a spreadsheet cell.
function flattenObject(
  obj: Record<string, unknown>,
  result: Record<string, unknown>,
  prefix = "",
): void {
  if (obj === null || obj === undefined) return;

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value as Record<string, unknown>, result, newKey);
    } else {
      result[newKey] = value;
    }
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return jsonResponse({ success: false, message: "Method not allowed" }, 405);
    }

    // Accept the secret either as a header (if the sender supports custom
    // headers) or as a ?secret= query param (works with any plain URL field).
    const url = new URL(req.url);
    const providedSecret =
      req.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
    if (!WEBHOOK_SHARED_SECRET || providedSecret !== WEBHOOK_SHARED_SECRET) {
      return jsonResponse({ success: false, message: "Unauthorized" }, 401);
    }

    const rawBody = await req.text();
    if (!rawBody) {
      return jsonResponse({ success: false, message: "Empty webhook body" }, 400);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawBody);
    } catch {
      return jsonResponse(
        { success: false, message: "Invalid JSON", raw_data: rawBody },
        400,
      );
    }

    const flattened: Record<string, unknown> = {};
    flattenObject(data, flattened);

    const { data: row, error } = await supabase
      .from("webhook_events")
      .insert({ payload: flattened })
      .select("id")
      .single();

    if (error) {
      return jsonResponse({ success: false, error: error.message }, 500);
    }

    return jsonResponse({
      success: true,
      message: "Webhook received successfully",
      row_id: row!.id,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err) }, 500);
  }
});
