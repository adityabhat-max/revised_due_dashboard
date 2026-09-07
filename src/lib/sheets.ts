import { google } from "googleapis";

const SOURCE_TAB = "Payment terms";
const ROSTER_TAB = "Sheet6";

export interface InvoiceRow {
  itemType: string;
  itemName: string;
  invoiceNo: string;
  guestCode: string;
  saleDate: string;
  guestName: string;
  centerName: string;
  due: number;
  collected: number;
  invoiceCreatedBy: string;
  soldBy: string;
  salesIncTax: number;
  nextPaymentDate: string;
  payment1Date: string;
  payment1Amount: number | null;
  payment2Date: string;
  payment2Amount: number | null;
  payment3Date: string;
  payment3Amount: number | null;
}

function cleanNumber(raw: string): number {
  if (!raw || !raw.trim()) return 0;
  const n = parseFloat(raw.replace(/,/g, "").trim());
  return Number.isNaN(n) ? 0 : n;
}

function cleanOptionalNumber(raw: string): number | null {
  if (!raw || !raw.trim()) return null;
  const n = parseFloat(raw.replace(/,/g, "").trim());
  return Number.isNaN(n) ? null : n;
}

function getSheetsClient() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const credsJson = process.env.SERVICE_ACCOUNT_JSON;
  if (!sheetId || !credsJson) {
    throw new Error("GOOGLE_SHEET_ID and SERVICE_ACCOUNT_JSON must both be set");
  }

  const credentials = JSON.parse(credsJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return { sheetId, sheets: google.sheets({ version: "v4", auth }) };
}

export async function fetchInvoices(): Promise<InvoiceRow[]> {
  const { sheetId, sheets } = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${SOURCE_TAB}'!A1:Z10000`,
  });

  const values = response.data.values || [];
  if (values.length === 0) return [];

  const header = values[0] as string[];
  const idx = (name: string) => header.indexOf(name);

  const i = {
    itemType: idx("Item Type"),
    itemName: idx("Item Name"),
    invoiceNo: idx("Invoice No"),
    guestCode: idx("Guest Code"),
    saleDate: idx("Sale Date"),
    guestName: idx("Guest Name"),
    centerName: idx("Center Name"),
    due: idx("Due"),
    collected: idx("Collected"),
    invoiceCreatedBy: idx("Invoice created by"),
    soldBy: idx("Sold By"),
    salesIncTax: idx("Sales(Inc. Tax)"),
    nextPaymentDate: idx("Next payment Date"),
    p1Date: idx("1st Payment Date"),
    p1Amt: idx("1st Payment Amount"),
    p2Date: idx("2nd Payment Date"),
    p2Amt: idx("2nd Payment Amount"),
    p3Date: idx("3rd Payment Date"),
    p3Amt: idx("3rd Payment Amount"),
  };

  const rows: InvoiceRow[] = [];
  for (const row of values.slice(1)) {
    if (!row.some((c) => (c ?? "").toString().trim())) continue;
    const get = (col: number) => (col >= 0 && col < row.length ? String(row[col] ?? "") : "");

    rows.push({
      itemType: get(i.itemType),
      itemName: get(i.itemName),
      invoiceNo: get(i.invoiceNo),
      guestCode: get(i.guestCode),
      saleDate: get(i.saleDate),
      guestName: get(i.guestName),
      centerName: get(i.centerName) || "(Unspecified)",
      due: cleanNumber(get(i.due)),
      collected: cleanNumber(get(i.collected)),
      invoiceCreatedBy: get(i.invoiceCreatedBy),
      soldBy: get(i.soldBy),
      salesIncTax: cleanNumber(get(i.salesIncTax)),
      nextPaymentDate: get(i.nextPaymentDate),
      payment1Date: get(i.p1Date),
      payment1Amount: cleanOptionalNumber(get(i.p1Amt)),
      payment2Date: get(i.p2Date),
      payment2Amount: cleanOptionalNumber(get(i.p2Amt)),
      payment3Date: get(i.p3Date),
      payment3Amount: cleanOptionalNumber(get(i.p3Amt)),
    });
  }

  return rows;
}

/**
 * Sheet6 is a roster grid, not a normal table: row 1 has one column per
 * center, and each column lists (downward, ragged length) the staff who
 * work there. Returns { centerName: [person, ...] }.
 */
export async function fetchRoster(): Promise<Record<string, string[]>> {
  const { sheetId, sheets } = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${ROSTER_TAB}'!A1:ZZ1000`,
  });

  const values = response.data.values || [];
  if (values.length === 0) return {};

  const header = values[0] as string[];
  const rows = values.slice(1);

  const roster: Record<string, string[]> = {};
  header.forEach((rawCenter, colIdx) => {
    const center = (rawCenter || "").toString().trim();
    if (!center) return;
    const people: string[] = [];
    for (const row of rows) {
      const name = (row[colIdx] || "").toString().trim();
      if (name) people.push(name);
    }
    roster[center] = people;
  });

  return roster;
}
