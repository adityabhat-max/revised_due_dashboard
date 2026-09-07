import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const WEBHOOK_SHARED_SECRET = Deno.env.get("WEBHOOK_SHARED_SECRET");

const ZENOTI_ACCOUNT_NAME = Deno.env.get("ZENOTI_ACCOUNT_NAME");
const ZENOTI_APP_ID = Deno.env.get("ZENOTI_APP_ID");
const ZENOTI_APP_SECRET = Deno.env.get("ZENOTI_APP_SECRET");
const ZENOTI_DEVICE_ID = Deno.env.get("ZENOTI_DEVICE_ID");

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

// --- Zenoti API enrichment -------------------------------------------------
//
// Zenoti's webhooks never fully describe an open/due invoice: Invoice.Closed
// only fires once an invoice is fully paid, and Invoice.Payments.Added (which
// does fire for open invoices) carries only the invoice id + payment, not the
// guest/items/total. To fill that gap we call Zenoti's REST API directly for
// any invoice we see open. Access tokens expire after 24h; refresh_token is
// used to get a new pair without needing the employee password again, and the
// new pair is persisted in zenoti_auth_tokens (functions can't rewrite their
// own Supabase secrets at runtime, so the database holds this mutable state).

async function refreshZenotiToken(refreshToken: string): Promise<string> {
  const resp = await fetch("https://api.zenoti.com/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.credentials) {
    throw new Error(`zenoti token refresh failed: ${JSON.stringify(json)}`);
  }

  const c = json.credentials;
  const { error } = await supabase
    .from("zenoti_auth_tokens")
    .update({
      access_token: c.access_token,
      access_token_expiry: c.access_token_expiry,
      refresh_token: c.refresh_token,
      refresh_token_expiry: c.refresh_token_expiry,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) throw new Error(`storing refreshed zenoti token failed: ${error.message}`);

  return c.access_token as string;
}

async function getValidZenotiToken(): Promise<string> {
  const { data, error } = await supabase
    .from("zenoti_auth_tokens")
    .select("access_token, access_token_expiry, refresh_token")
    .eq("id", 1)
    .single();
  if (error || !data) throw new Error("no zenoti token stored");

  const expiresAt = new Date(data.access_token_expiry).getTime();
  if (Date.now() < expiresAt - 60_000) {
    return data.access_token as string;
  }
  return await refreshZenotiToken(data.refresh_token as string);
}

// `expand` only takes one value per call - passing a comma-separated list
// (as the docs imply is possible) silently drops the fields for every value
// but the last, so a full invoice record takes two separate calls.
async function fetchZenotiInvoiceExpand(
  invoiceId: string,
  expand: "InvoiceItems" | "Transactions",
): Promise<Record<string, unknown>> {
  const url = `https://api.zenoti.com/v1/invoices/${invoiceId}?expand=${expand}`;
  let token = await getValidZenotiToken();
  let resp = await fetch(url, { headers: { Authorization: `bearer ${token}` } });

  if (resp.status === 401) {
    const { data } = await supabase
      .from("zenoti_auth_tokens")
      .select("refresh_token")
      .eq("id", 1)
      .single();
    if (!data) throw new Error("no zenoti token stored to refresh from");
    token = await refreshZenotiToken(data.refresh_token as string);
    resp = await fetch(url, { headers: { Authorization: `bearer ${token}` } });
  }

  const json = await resp.json();
  if (!resp.ok || !json.invoice) {
    throw new Error(`zenoti invoice fetch (${expand}) failed for ${invoiceId}: ${JSON.stringify(json)}`);
  }
  return json.invoice as Record<string, unknown>;
}

async function fetchAndStoreOpenInvoice(invoiceId: string): Promise<void> {
  const itemsInvoice = await fetchZenotiInvoiceExpand(invoiceId, "InvoiceItems");
  const txnsInvoice = await fetchZenotiInvoiceExpand(invoiceId, "Transactions");

  const flattened: Record<string, unknown> = {};
  flattenObject(itemsInvoice, flattened);

  const { error } = await supabase
    .from("zenoti_open_invoices")
    .upsert(
      {
        invoice_id: invoiceId,
        payload: flattened,
        transactions: txnsInvoice.transactions ?? [],
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "invoice_id" },
    );
  if (error) throw new Error(`storing open invoice failed: ${error.message}`);
}

async function removeClosedInvoice(invoiceId: string): Promise<void> {
  const { error } = await supabase
    .from("zenoti_open_invoices")
    .delete()
    .eq("invoice_id", invoiceId);
  if (error) throw new Error(`removing closed invoice failed: ${error.message}`);
}

async function enrichFromZenoti(data: Record<string, unknown>): Promise<void> {
  if (!ZENOTI_ACCOUNT_NAME || !ZENOTI_APP_ID || !ZENOTI_APP_SECRET || !ZENOTI_DEVICE_ID) return;

  const eventType = data.event_type;
  const eventData = data.data as Record<string, unknown> | undefined;
  if (!eventData) return;

  if (
    (eventType === "Invoice.Payments.Added" || eventType === "Invoice.Payments.Deleted") &&
    eventData.is_closed === false
  ) {
    // Deleted (reversed) payments need the same re-fetch as Added ones -
    // the view excludes deleted transaction_ids explicitly, but keeping the
    // cached snapshot current too avoids it drifting from Zenoti's own state.
    const invoiceId = eventData.invoice_id as string | undefined;
    if (invoiceId) await fetchAndStoreOpenInvoice(invoiceId);
  } else if (eventType === "Invoice.Closed") {
    const invoice = eventData.invoice as Record<string, unknown> | undefined;
    const invoiceId = invoice?.id as string | undefined;
    if (invoiceId) await removeClosedInvoice(invoiceId);
  }
}

// ----------------------------------------------------------------------------

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

    // Best-effort: never let a Zenoti API hiccup fail the webhook ack itself,
    // since Zenoti retries on non-2xx and we already have the raw event saved.
    try {
      await enrichFromZenoti(data);
    } catch (enrichErr) {
      console.error("zenoti enrichment failed:", enrichErr);
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
