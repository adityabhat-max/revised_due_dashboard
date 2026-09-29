import { createClient } from "@supabase/supabase-js";
import type { InvoiceRow } from "./sheets";

// Parallel data source to sheets.ts's fetchInvoices, reading the same shape
// from Supabase's due_invoices_report view instead of the "Payment terms"
// Google Sheet tab - kept side by side so the existing Sheets-backed
// fetchInvoices (and fetchRoster, which has no Supabase equivalent yet)
// stay completely untouched while this is validated against the live site.

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set");
  }
  return createClient(url, key);
}

// page.tsx's ddmmyyyyToIso() (and paymentUrgency, which depends on it) only
// understand "D-M-YYYY"/"DD-MM-YYYY" strings, matching the raw format
// Zenoti's own report and the Google Sheets pipeline already use - so
// Supabase's real date/timestamptz columns need converting to that exact
// shape for this dashboard, even though they're stored properly internally.
function toDdMmYyyy(value: string | null): string {
  if (!value) return "";
  const datePart = value.slice(0, 10); // "YYYY-MM-DD" prefix of a date or timestamptz
  const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const [, yyyy, mm, dd] = m;
  return `${dd}-${mm}-${yyyy}`;
}

interface SupabaseDueRow {
  "Sale Date": string | null;
  "Invoice No": string | null;
  "Guest Name": string | null;
  "Guest Code": string | null;
  "Center": string | null;
  "Item": string | null;
  "Item Type": string | null;
  "Sold By": string | null;
  "Created By": string | null;
  "Sales (Inc. Tax)": number | null;
  "Collected": number | null;
  "Due": number | null;
  "Next Payment Date": string | null;
  "1st Payment Date": string | null;
  "1st Payment Amount": number | null;
  "2nd Payment Date": string | null;
  "2nd Payment Amount": number | null;
  "3rd Payment Date": string | null;
  "3rd Payment Amount": number | null;
}

// PostgREST caps every response at the project's max-rows setting (1000 by
// default) and silently truncates past it - so the view has to be read in
// pages until an empty page comes back, or totals quietly undercount once
// there are more due line items than that. Offsets advance by however many
// rows actually came back (not PAGE_SIZE), so a max-rows set lower than
// PAGE_SIZE still can't skip anything.
const PAGE_SIZE = 1000;

// A view has no primary key, so pages need an explicit, as-close-to-unique
// ordering - otherwise Postgres is free to return tied rows in a different
// order per request, duplicating some rows across page boundaries and
// skipping others.
const ORDER_COLUMNS = [
  "Sale Date",
  "Invoice No",
  "Item",
  "Item Type",
  "Sold By",
  "Sales (Inc. Tax)",
  "Collected",
  "Due",
];

async function fetchAllDueRows(): Promise<SupabaseDueRow[]> {
  const supabase = getSupabaseClient();
  const rows: SupabaseDueRow[] = [];

  for (let from = 0; ; from = rows.length) {
    let query = supabase.from("due_invoices_report").select("*");
    for (const col of ORDER_COLUMNS) {
      query = query.order(col, { ascending: true, nullsFirst: true });
    }
    const { data, error } = await query
      .range(from, from + PAGE_SIZE - 1)
      .returns<SupabaseDueRow[]>();

    if (error) throw new Error(`Supabase due_invoices_report query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
  }

  return rows;
}

export async function fetchInvoicesFromSupabase(): Promise<InvoiceRow[]> {
  const data = await fetchAllDueRows();

  return data.map((row) => ({
    itemType: row["Item Type"] ?? "",
    itemName: row["Item"] ?? "",
    invoiceNo: row["Invoice No"] ?? "",
    guestCode: row["Guest Code"] ?? "",
    saleDate: toDdMmYyyy(row["Sale Date"]),
    guestName: row["Guest Name"] ?? "",
    centerName: row["Center"] || "(Unspecified)",
    due: row["Due"] ?? 0,
    collected: row["Collected"] ?? 0,
    invoiceCreatedBy: row["Created By"] ?? "",
    soldBy: row["Sold By"] ?? "",
    salesIncTax: row["Sales (Inc. Tax)"] ?? 0,
    nextPaymentDate: toDdMmYyyy(row["Next Payment Date"]),
    payment1Date: toDdMmYyyy(row["1st Payment Date"]),
    payment1Amount: row["1st Payment Amount"],
    payment2Date: toDdMmYyyy(row["2nd Payment Date"]),
    payment2Amount: row["2nd Payment Amount"],
    payment3Date: toDdMmYyyy(row["3rd Payment Date"]),
    payment3Amount: row["3rd Payment Amount"],
  }));
}
