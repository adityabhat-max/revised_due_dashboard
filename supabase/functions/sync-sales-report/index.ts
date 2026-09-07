import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET");

// Excludes ZTraining Center (test/sandbox data), Surat, Srinagar, and VV
// Headoffice, per explicit instruction - these aren't real due invoices.
const CENTER_IDS = [
  "7f146830-cfbd-4494-aa5a-3da9fcac15fa", "25f66248-305e-4726-b3e8-fdf307d4f40f",
  "343d81c9-3c8a-47c7-a703-bc0bfb3389c1", "26261064-7255-4a38-8daa-4a570bd6acfe",
  "e594c0df-8648-4085-ac51-fdeb047b6aad", "25267390-20e4-4dac-a0e8-5650a6133db3",
  "c49ab48d-532b-4c15-bc80-e08f6834a408", "f45be8f9-1271-4850-8af8-314901192a15",
  "ecc48c1d-fba8-4f17-b0bb-31f13a5a8bdb", "3fc55c7d-d5c8-4e17-8dfb-13e61df23baf",
  "2261e0fa-5a73-4b71-a601-20f4d8b8fbfa", "b3045736-9b3f-4ab6-a134-5b077343efa7",
  "c84beb68-2f66-4c0c-9278-080cfd0e9cef", "65c930c5-2e91-4276-a88c-747c741c6198",
  "c8d725bf-867f-44e5-acb1-41a87aa736a1", "015ffd5e-0ac4-4884-ad65-98fc57e732e0",
  "3da5b7f2-c900-4e18-863a-6245bbc907b2",
];

const DAYS_BACK = 30;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// --- Zenoti auth (mirrors webhook-receiver's helpers) -----------------------

async function refreshZenotiToken(refreshToken: string): Promise<string> {
  const resp = await fetch("https://api.zenoti.com/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken, grant_type: "refresh_token" }),
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

// --- Invoice Notes payment-plan parser --------------------------------------
// Ports payment_notes_parser.py exactly: up to 3 "DD-MM-YYYY AMOUNT"
// installments separated by ';', amounts may carry currency symbols/commas/
// trailing '/-'. A '///' marker splits a parseable plan from a free-text
// comment - only the part before it is parsed. Anything that doesn't
// cleanly match is treated as a pure comment (all 3 slots left blank),
// never throws.

interface ParsedPlan {
  date1: string | null; amount1: number | null;
  date2: string | null; amount2: number | null;
  date3: string | null; amount3: number | null;
}

const BLANK_PLAN: ParsedPlan = {
  date1: null, amount1: null,
  date2: null, amount2: null,
  date3: null, amount3: null,
};

const AMOUNT_STRIP_RE = /[₹,]|rs\.?/gi;

function cleanAmount(raw: string): number {
  let s = raw.replace(AMOUNT_STRIP_RE, "").trim();
  if (s.endsWith("/-")) s = s.slice(0, -2);
  else if (s.endsWith("/")) s = s.slice(0, -1);
  s = s.trim();
  const n = Number(s);
  if (!s || Number.isNaN(n)) throw new Error(`invalid amount: ${raw}`);
  return n;
}

function parseInstallment(segment: string): [string, number] {
  const trimmed = segment.trim();
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) throw new Error(`expected 'date amount', got ${segment}`);
  const dateStr = trimmed.slice(0, spaceIdx);
  const amountStr = trimmed.slice(spaceIdx + 1).trim();
  if (!dateStr || !amountStr) throw new Error(`expected 'date amount', got ${segment}`);

  const m = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) throw new Error(`invalid date: ${dateStr}`);
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`invalid date: ${dateStr}`);
  }
  const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return [isoDate, cleanAmount(amountStr)];
}

function parseInvoiceNotes(note: string | null | undefined): ParsedPlan {
  if (!note || !note.trim()) return BLANK_PLAN;

  const planPart = note.trim().split("///")[0].trim();
  if (!planPart) return BLANK_PLAN;

  const segments = planPart.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > 3) return BLANK_PLAN;

  let installments: [string, number][];
  try {
    installments = segments.map(parseInstallment);
  } catch {
    return BLANK_PLAN;
  }

  const result: ParsedPlan = { ...BLANK_PLAN };
  const slots: (keyof ParsedPlan)[][] = [
    ["date1", "amount1"], ["date2", "amount2"], ["date3", "amount3"],
  ];
  installments.forEach(([date, amount], i) => {
    const [dateKey, amountKey] = slots[i];
    (result as Record<string, unknown>)[dateKey] = date;
    (result as Record<string, unknown>)[amountKey] = amount;
  });
  return result;
}

// --- Sync logic --------------------------------------------------------------

interface SalesRow {
  invoice_item_id: string;
  invoice_id: string;
  invoice_no: string;
  sale_date: string;
  guest_name: string | null;
  guest_code: string | null;
  center_name: string | null;
  item_name: string | null;
  item_type: string | null;
  sales_inc_tax: number | null;
  collected: number | null;
  due: number | null;
  status: string | null;
  sold_by: string | null;
  created_by: string | null;
  invoice_notes: string | null;
}

async function fetchAccrualReport(token: string): Promise<SalesRow[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (DAYS_BACK - 1));

  const resp = await fetch(
    "https://api.zenoti.com/v1/reports/sales/accrual_basis/flat_file?Page=1&Size=50000",
    {
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        center_ids: CENTER_IDS,
        start_date: fmtDate(start),
        end_date: fmtDate(end),
      }),
    },
  );
  const json = await resp.json();
  if (!resp.ok || !Array.isArray(json.sales)) {
    throw new Error(`accrual report fetch failed: HTTP ${resp.status} ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.sales as SalesRow[];
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return jsonResponse({ success: false, message: "Method not allowed" }, 405);
    }

    const url = new URL(req.url);
    const providedSecret = req.headers.get("x-sync-secret") ?? url.searchParams.get("secret");
    if (!SYNC_SHARED_SECRET || providedSecret !== SYNC_SHARED_SECRET) {
      return jsonResponse({ success: false, message: "Unauthorized" }, 401);
    }

    const token = await getValidZenotiToken();
    const sales = await fetchAccrualReport(token);

    const rows = sales.map((s) => {
      const plan = parseInvoiceNotes(s.invoice_notes);
      return {
        invoice_item_id: s.invoice_item_id,
        invoice_id: s.invoice_id,
        invoice_no: s.invoice_no,
        sale_date: s.sale_date,
        guest_name: s.guest_name,
        guest_code: s.guest_code,
        center_name: s.center_name,
        item_name: s.item_name,
        item_type: s.item_type,
        sales_inc_tax: s.sales_inc_tax,
        collected: s.collected,
        due: s.due,
        status: s.status,
        sold_by: s.sold_by,
        created_by: s.created_by,
        invoice_notes: s.invoice_notes,
        payment_1_date: plan.date1,
        payment_1_amount: plan.amount1,
        payment_2_date: plan.date2,
        payment_2_amount: plan.amount2,
        payment_3_date: plan.date3,
        payment_3_amount: plan.amount3,
        fetched_at: new Date().toISOString(),
      };
    });

    // Full snapshot each run - clear and reinsert rather than upsert, so
    // rows that fell out of the report (aged past the window, or the
    // invoice no longer exists) don't linger.
    const { error: deleteError } = await supabase
      .from("zenoti_sales_report")
      .delete()
      .gte("fetched_at", "1970-01-01");
    if (deleteError) throw new Error(`clearing old rows failed: ${deleteError.message}`);

    const BATCH_SIZE = 1000;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error: insertError } = await supabase.from("zenoti_sales_report").insert(batch);
      if (insertError) throw new Error(`inserting rows failed: ${insertError.message}`);
    }

    const withPlan = rows.filter((r) => r.payment_1_date).length;

    return jsonResponse({
      success: true,
      rows_synced: rows.length,
      rows_with_parsed_plan: withPlan,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err) }, 500);
  }
});
