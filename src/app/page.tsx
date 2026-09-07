"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { InvoiceRow } from "@/lib/sheets";

type SortKey = "invoiceNo" | "guestName" | "saleDate" | "centerName" | "due" | "collected" | "nextPaymentDate";
type SortDir = "asc" | "desc";

function formatINR(n: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n));
}

function hasPaymentPlan(row: InvoiceRow): boolean {
  return Boolean(row.payment1Date);
}

const EXPORT_COLUMNS: { label: string; get: (r: InvoiceRow) => string | number }[] = [
  { label: "Sale Date", get: (r) => r.saleDate },
  { label: "Invoice No", get: (r) => r.invoiceNo },
  { label: "Guest Name", get: (r) => r.guestName },
  { label: "Guest Code", get: (r) => r.guestCode },
  { label: "Center", get: (r) => r.centerName },
  { label: "Item", get: (r) => r.itemName },
  { label: "Item Type", get: (r) => r.itemType },
  { label: "Sold By", get: (r) => r.soldBy },
  { label: "Created By", get: (r) => r.invoiceCreatedBy },
  { label: "Sales (Inc. Tax)", get: (r) => r.salesIncTax },
  { label: "Collected", get: (r) => r.collected },
  { label: "Due", get: (r) => r.due },
  { label: "Next Payment Date", get: (r) => r.nextPaymentDate },
  { label: "1st Payment Date", get: (r) => r.payment1Date },
  { label: "1st Payment Amount", get: (r) => r.payment1Amount ?? "" },
  { label: "2nd Payment Date", get: (r) => r.payment2Date },
  { label: "2nd Payment Amount", get: (r) => r.payment2Amount ?? "" },
  { label: "3rd Payment Date", get: (r) => r.payment3Date },
  { label: "3rd Payment Amount", get: (r) => r.payment3Amount ?? "" },
];

function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Exports whatever's currently on screen — the filtered/sorted rows the
// caller already computed — not the full unfiltered dataset, so the CSV
// always matches exactly what the viewer is looking at.
function exportRowsToCsv(rows: InvoiceRow[]): void {
  const lines = [
    EXPORT_COLUMNS.map((c) => csvField(c.label)).join(","),
    ...rows.map((r) => EXPORT_COLUMNS.map((c) => csvField(c.get(r))).join(",")),
  ];
  // Leading BOM so Excel opens the ₹ symbol and other non-ASCII text correctly.
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const link = document.createElement("a");
  link.href = url;
  link.download = `due-invoices-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

interface CollectedBucket {
  label: string;
  test: (n: number) => boolean;
}

// "₹0" is its own bucket (nothing collected yet), separate from "₹0 –
// ₹10,000" (some amount up to 10k). Ranges are ₹10,000-wide up to
// ₹1,50,000, then ₹25,000-wide beyond that — extended dynamically so
// every real Collected value in the data always has a bucket, however
// high amounts eventually get.
function buildCollectedBuckets(maxCollected: number): CollectedBucket[] {
  const buckets: CollectedBucket[] = [{ label: "₹0", test: (n) => n === 0 }];

  let lower = 0;
  const fineStepCeiling = 150_000;
  while (lower < fineStepCeiling) {
    // Bound to fresh per-iteration consts, not the outer `lower` — every
    // bucket's `test` closure must capture its own range, not whatever
    // `lower` happens to hold once the loop finishes.
    const bucketLower = lower;
    const bucketUpper = bucketLower + 10_000;
    buckets.push({
      label: `₹${formatINR(bucketLower)} – ₹${formatINR(bucketUpper)}`,
      test: (n) => n > bucketLower && n <= bucketUpper,
    });
    lower = bucketUpper;
  }

  while (lower < maxCollected) {
    const bucketLower = lower;
    const bucketUpper = bucketLower + 25_000;
    buckets.push({
      label: `₹${formatINR(bucketLower)} – ₹${formatINR(bucketUpper)}`,
      test: (n) => n > bucketLower && n <= bucketUpper,
    });
    lower = bucketUpper;
  }

  return buckets;
}

// Sheet stores Sale Date and Next payment Date as "DD-MM-YYYY" (confirmed
// against the live sheet). Pure string conversion to "YYYY-MM-DD" — no
// Date object, no timezone ambiguity — so range comparisons are just
// string comparisons.
function ddmmyyyyToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Client-only (called from an effect after mount, never during the
// server render pass) so "today"/"yesterday" reflect the viewer's own
// local timezone rather than the server's — those can disagree on which
// calendar day it is for hours at a time otherwise.
function getTodayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getYesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Earliest Sale Date with real data — matches "Payment terms" tab coverage.
const EARLIEST_SALE_DATE_ISO = "2026-08-13";

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

type PaymentUrgency = "overdue" | "soon" | null;

// "soon" = due today through 3 days out; "overdue" = anything before
// today. Only Next payment Date drives this — not the individual
// installment dates — since that's the single field staff use to track
// what's next.
function paymentUrgency(nextPaymentDate: string, todayIso: string): PaymentUrgency {
  const iso = ddmmyyyyToIso(nextPaymentDate);
  if (!iso) return null;
  if (iso < todayIso) return "overdue";
  if (iso <= addDaysIso(todayIso, 3)) return "soon";
  return null;
}

// Rounding-level noise (Sales(Inc. Tax) carries fractional-rupee tax
// math) shouldn't trip a data-quality flag — only a gap large enough to
// be a real entry error.
const AMOUNT_TOLERANCE = 2;

interface DataIssue {
  label: string;
  detail: string;
}

// A payment plan is written as one atomic note (per the SOP, staff type
// the full plan in a single line) — so whenever 1st Payment Amount is
// set, the plan is already complete, not partially filled in. That
// means the installments can always be summed and checked as soon as
// any of them exist, no "wait until all 3 are filled" logic needed.
function getDataIssues(row: InvoiceRow): DataIssue[] {
  const issues: DataIssue[] = [];

  if (row.payment1Amount != null) {
    const planTotal = (row.payment1Amount ?? 0) + (row.payment2Amount ?? 0) + (row.payment3Amount ?? 0);
    const diff = planTotal - row.due;
    if (Math.abs(diff) > AMOUNT_TOLERANCE) {
      issues.push({
        label: "Payment plan doesn't match Due",
        detail:
          diff > 0
            ? `Installments add up to ₹${formatINR(planTotal)} — ₹${formatINR(diff)} more than the ₹${formatINR(row.due)} still Due.`
            : `Installments add up to ₹${formatINR(planTotal)} — ₹${formatINR(-diff)} short of the ₹${formatINR(row.due)} still Due.`,
      });
    }
  }

  const reconDiff = row.collected + row.due - row.salesIncTax;
  if (Math.abs(reconDiff) > AMOUNT_TOLERANCE) {
    issues.push({
      label: "Collected + Due doesn't match Sales",
      detail: `Collected (₹${formatINR(row.collected)}) + Due (₹${formatINR(row.due)}) = ₹${formatINR(row.collected + row.due)}, not the ₹${formatINR(row.salesIncTax)} in Sales (Inc. Tax).`,
    });
  }

  return issues;
}

function KpiCard({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="bg-white border border-[#e7dcd4] rounded-xl p-5 shadow-sm min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#a8988d] mb-2 truncate">
        {label}
      </p>
      <p
        className={`text-2xl font-semibold tabular-nums truncate ${
          emphasize ? "text-[#7a2e40]" : "text-[#2a211d]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  optionLabels,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  optionLabels?: Record<string, string>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border border-[#e7dcd4] rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7a2e40] focus:border-transparent max-w-full min-w-0"
    >
      <option value="All">{label}: All</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {optionLabels?.[opt] ?? opt}
        </option>
      ))}
    </select>
  );
}

// Default Item Type selection on first load — Package + Product only,
// Service excluded. Compared against by set membership (order/duplicates
// don't matter), not array equality, since "Clear filters" resets back
// to this exact set rather than to nothing.
const DEFAULT_ITEM_TYPES = ["Package", "Product"];

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((x) => bSet.has(x));
}

// Multi-select checkbox dropdown — used where picking several values at
// once is genuinely useful (Center, Sold by, Item type). An empty
// selection means "no filter" (matches every value), same as the old
// single-select "All" option.
function CheckboxFilter({
  label,
  selected,
  onChange,
  options,
}: {
  label: string;
  selected: string[];
  onChange: (v: string[]) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function toggle(opt: string) {
    onChange(selected.includes(opt) ? selected.filter((s) => s !== opt) : [...selected, opt]);
  }

  const summary =
    selected.length === 0
      ? `${label}: All`
      : selected.length === 1
        ? `${label}: ${selected[0]}`
        : `${label}: ${selected.length} selected`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="border border-[#e7dcd4] rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7a2e40] focus:border-transparent max-w-[14rem] truncate text-left"
      >
        {summary}
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-64 max-h-72 overflow-y-auto bg-white border border-[#e7dcd4] rounded-lg shadow-lg p-2">
          <div className="flex items-center justify-between px-2 py-1 mb-1 border-b border-[#f1ebe6]">
            <button type="button" onClick={() => onChange([])} className="text-xs text-[#7a2e40] hover:underline">
              Clear
            </button>
            <button type="button" onClick={() => onChange(options)} className="text-xs text-[#7a2e40] hover:underline">
              Select all
            </button>
          </div>
          {options.map((opt) => (
            <label
              key={opt}
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#faf5f1] cursor-pointer text-sm"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                className="accent-[#7a2e40]"
              />
              <span className="truncate">{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [roster, setRoster] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // "all" for an admin account; an exact Center Name for a center-
  // restricted account (server already filtered `invoices` to just that
  // center — this only drives what the UI shows, e.g. hiding the Center
  // filter, since there's nothing left to filter).
  const [userEmail, setUserEmail] = useState<string>("");
  const [userScope, setUserScope] = useState<string>("all");

  const [query, setQuery] = useState("");
  const [centerFilter, setCenterFilter] = useState<string[]>([]);
  const [soldByFilter, setSoldByFilter] = useState<string[]>([]);
  const [createdByFilter, setCreatedByFilter] = useState<string[]>([]);
  const [nextPaymentFilter, setNextPaymentFilter] = useState<"All" | "Has" | "None">("All");
  const [planFilter, setPlanFilter] = useState<"All" | "Has" | "None">("All");
  const [dueFilter, setDueFilter] = useState<"All" | "DueOnly" | "PaidOff">("All");
  const [collectedFilter, setCollectedFilter] = useState<string[]>([]);
  // Package + Product checked by default, Service excluded.
  const [itemTypeFilter, setItemTypeFilter] = useState<string[]>(DEFAULT_ITEM_TYPES);
  // Sale Date range filter. saleDateEnd defaults to "yesterday" (set in
  // the mount effect below, client-side only) — today's rows are
  // excluded by default since a same-day scrape may still be
  // incomplete; widen this to include today whenever that's wanted.
  // saleDateStart stays open-ended by default (no lower bound).
  const [saleDateStart, setSaleDateStart] = useState<string>("");
  const [saleDateEnd, setSaleDateEnd] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("due");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<InvoiceRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/data", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load data");
      setInvoices(data.invoices);
      setRoster(data.roster || {});
      setUserEmail(data.email || "");
      setUserScope(data.scope || "all");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }

  const [todayIso, setTodayIso] = useState<string>("");

  useEffect(() => {
    load();
    setSaleDateEnd(getYesterdayIso());
    setTodayIso(getTodayIso());
  }, []);

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const centers = useMemo(() => {
    if (!invoices) return [];
    const set = new Set(invoices.map((r) => r.centerName));
    return Array.from(set).sort();
  }, [invoices]);

  const itemTypes = useMemo(() => {
    if (!invoices) return [];
    const set = new Set(invoices.map((r) => r.itemType).filter(Boolean));
    return Array.from(set).sort();
  }, [invoices]);

  // No roster tracks "Invoice created by" (unlike Sold by, which comes
  // from the Sheet6 staff roster) — sourced directly from whoever
  // actually appears in the loaded invoices.
  const createdByList = useMemo(() => {
    if (!invoices) return [];
    const set = new Set(invoices.map((r) => r.invoiceCreatedBy).filter(Boolean));
    return Array.from(set).sort();
  }, [invoices]);

  // Computed from the full unfiltered dataset (like centers/itemTypes
  // above), not the currently-filtered rows, so the bucket list stays
  // stable regardless of what else is filtered.
  const collectedBuckets = useMemo(() => {
    const max = invoices ? Math.max(0, ...invoices.map((r) => r.collected)) : 0;
    return buildCollectedBuckets(max);
  }, [invoices]);

  const soldByList = useMemo(() => {
    // Sourced from the Sheet6 staff roster (scoped to the selected
    // center(s)), not from who happens to have a due invoice — so everyone
    // on staff is selectable, including people with zero invoices right now.
    if (centerFilter.length === 0) {
      const set = new Set(Object.values(roster).flat());
      return Array.from(set).sort();
    }
    const set = new Set(centerFilter.flatMap((c) => roster[c] || []));
    return Array.from(set).sort();
  }, [roster, centerFilter]);

  function handleCenterChange(next: string[]) {
    setCenterFilter(next);
    setSoldByFilter([]); // avoid keeping a Sold By selection that doesn't exist at the new center(s)
  }

  // Everything except the Item Type filter — the item-type KPI cards use
  // this (not `filtered`) so they always show the full type breakdown
  // within the rest of the current filter context, even once a single type
  // is selected below.
  const baseFiltered = useMemo(() => {
    if (!invoices) return [];
    const q = query.trim().toLowerCase();
    return invoices.filter((r) => {
      if (centerFilter.length > 0 && !centerFilter.includes(r.centerName)) return false;
      if (soldByFilter.length > 0 && !soldByFilter.includes(r.soldBy)) return false;
      if (createdByFilter.length > 0 && !createdByFilter.includes(r.invoiceCreatedBy)) return false;

      if (nextPaymentFilter === "Has" && !r.nextPaymentDate) return false;
      if (nextPaymentFilter === "None" && r.nextPaymentDate) return false;

      if (planFilter === "Has" && !hasPaymentPlan(r)) return false;
      if (planFilter === "None" && hasPaymentPlan(r)) return false;

      if (dueFilter === "DueOnly" && r.due <= 0) return false;
      if (dueFilter === "PaidOff" && r.due > 0) return false;

      if (collectedFilter.length > 0) {
        const matchesBucket = collectedBuckets
          .filter((b) => collectedFilter.includes(b.label))
          .some((b) => b.test(r.collected));
        if (!matchesBucket) return false;
      }

      if (saleDateStart || saleDateEnd) {
        const iso = ddmmyyyyToIso(r.saleDate);
        // Rows with an unparseable/blank Sale Date are excluded once any
        // date bound is active — there's no date to judge them against.
        if (!iso) return false;
        if (saleDateStart && iso < saleDateStart) return false;
        if (saleDateEnd && iso > saleDateEnd) return false;
      }

      if (!q) return true;
      return (
        r.invoiceNo.toLowerCase().includes(q) ||
        r.guestName.toLowerCase().includes(q) ||
        r.guestCode.toLowerCase().includes(q)
      );
    });
  }, [invoices, query, centerFilter, soldByFilter, createdByFilter, nextPaymentFilter, planFilter, dueFilter, collectedFilter, collectedBuckets, saleDateStart, saleDateEnd]);

  const filtered = useMemo(() => {
    if (itemTypeFilter.length === 0) return baseFiltered;
    return baseFiltered.filter((r) => itemTypeFilter.includes(r.itemType));
  }, [baseFiltered, itemTypeFilter]);

  // A type's card shows its real total only while that type is checked in
  // the Item Type filter — unchecked types show ₹0 rather than a number
  // that doesn't match any row actually visible in the table below. An
  // empty selection means "no filter" (same convention as Center/Sold
  // by), so every type shows its real total in that case.
  const itemTypeBreakdown = useMemo(() => {
    const due = new Map<string, number>();
    for (const r of baseFiltered) {
      due.set(r.itemType, (due.get(r.itemType) || 0) + r.due);
    }
    return itemTypes.map((type) => ({
      type,
      due: itemTypeFilter.length === 0 || itemTypeFilter.includes(type) ? due.get(type) || 0 : 0,
    }));
  }, [baseFiltered, itemTypes, itemTypeFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "due" || sortKey === "collected") {
        cmp = a[sortKey] - b[sortKey];
      } else if (sortKey === "saleDate" || sortKey === "nextPaymentDate") {
        // Chronological, not lexicographic — "DD-MM-YYYY" sorts wrong as a
        // plain string (e.g. "05-09-2026" would sort before "20-08-2026").
        const aIso = ddmmyyyyToIso(a[sortKey]) ?? "";
        const bIso = ddmmyyyyToIso(b[sortKey]) ?? "";
        cmp = aIso.localeCompare(bIso);
      } else {
        cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totals = useMemo(() => {
    const totalDue = filtered.reduce((sum, r) => sum + r.due, 0);
    const invoiceSet = new Set(filtered.map((r) => r.invoiceNo).filter(Boolean));
    return { totalDue, invoiceCount: invoiceSet.size };
  }, [filtered]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "due" || key === "collected" ? "desc" : "asc");
    }
  }

  function SortHeader({
    label,
    sortKeyName,
    hideBelow,
    align = "left",
  }: {
    label: string;
    sortKeyName: SortKey;
    hideBelow?: "sm" | "md" | "lg";
    align?: "left" | "right";
  }) {
    const active = sortKey === sortKeyName;
    const visibility =
      hideBelow === "sm" ? "hidden min-[47.5rem]:table-cell" :
      hideBelow === "md" ? "hidden min-[60.625rem]:table-cell" :
      hideBelow === "lg" ? "hidden min-[75.625rem]:table-cell" : "";
    // Numeric columns' data cells are right-aligned (tabular-nums) — the
    // header must match, or the label and its own values visibly don't
    // line up. Right-aligned columns also get whitespace-nowrap instead
    // of break-words: currency figures shouldn't wrap.
    const alignCls = align === "right" ? "text-right whitespace-nowrap" : "text-left break-words";
    return (
      <th
        className={`${visibility} ${alignCls} text-xs font-semibold uppercase tracking-wide text-[#a8988d] px-2 py-2.5 cursor-pointer select-none`}
        onClick={() => toggleSort(sortKeyName)}
      >
        <span className={active ? "text-[#7a2e40]" : ""}>
          {label}
          {active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
        </span>
      </th>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf5f1] text-[#2a211d]">
      <div className="w-full px-4 sm:px-8 lg:px-12 py-10">
        <header className="mb-8">
          <p className="text-xs font-semibold tracking-wide uppercase text-[#7a2e40] mb-2">
            Isaac Wellness · Due Invoices
          </p>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="text-3xl font-serif">Due Invoices Dashboard</h1>
            <div className="flex items-center gap-3">
              <button
                onClick={load}
                disabled={loading}
                className="text-sm px-3 py-1.5 rounded-lg border border-[#e7dcd4] bg-white hover:bg-[#f6e2e7] transition-colors disabled:opacity-50"
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
              <button
                onClick={() => exportRowsToCsv(sorted)}
                disabled={loading || sorted.length === 0}
                className="text-sm px-3 py-1.5 rounded-lg border border-[#e7dcd4] bg-white hover:bg-[#f6e2e7] transition-colors disabled:opacity-50"
                title="Export the rows currently shown below, with the active filters and sort applied"
              >
                Export CSV
              </button>
              {userEmail && (
                <div className="flex items-center gap-2 text-sm text-[#a8988d]">
                  <span className="truncate max-w-[12rem]" title={userEmail}>
                    {userEmail}
                  </span>
                  <button
                    onClick={handleLogout}
                    className="text-[#7a2e40] hover:underline"
                  >
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
          <p className="text-sm text-[#a8988d] mt-2">
            Live from the &quot;Payment terms&quot; sheet · Due invoices from 13 Aug 2026 to yesterday
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#7a685e] mt-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#fbeaea] border border-[#e7b3b3]" />
              Next payment due within 3 days
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-[#eec4c4] border border-[#d99a9a]" />
              Next payment overdue
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[#b23b3b]">⚠</span>
              Payment figures don&apos;t reconcile — click the row for detail
            </span>
          </div>
        </header>

        {error && (
          <div className="mb-6 rounded-lg border border-[#e7b3b3] bg-[#fbeaea] text-[#8a2e2e] px-4 py-3 text-sm">
            Could not load data: {error}
          </div>
        )}

        {/* KPI row — Total due + Invoices, then one card per Item Type
            (due-only, always reflecting the full type breakdown within the
            other active filters). Auto-fit keeps every card the same width
            and perfectly aligned no matter how many item types exist. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9.375rem,1fr))] gap-3 mb-6">
          <KpiCard label="Total due" value={loading ? "…" : `₹${formatINR(totals.totalDue)}`} emphasize />
          <KpiCard label="Invoices" value={loading ? "…" : String(totals.invoiceCount)} />
          {itemTypeBreakdown.map(({ type, due }) => (
            <KpiCard key={type} label={`${type} due`} value={loading ? "…" : `₹${formatINR(due)}`} emphasize />
          ))}
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#e7dcd4] rounded-xl p-4 mb-4 shadow-sm">
          <input
            type="text"
            placeholder="Search invoice no. or guest name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full border border-[#e7dcd4] rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7a2e40] focus:border-transparent mb-3"
          />
          <div className="flex flex-wrap items-center gap-3">
            {userScope === "all" ? (
              <CheckboxFilter label="Center" selected={centerFilter} onChange={handleCenterChange} options={centers} />
            ) : (
              <span className="border border-[#e7dcd4] rounded-lg px-3 py-2 text-sm bg-[#faf5f1] text-[#7a685e]">
                Center: {userScope}
              </span>
            )}
            <CheckboxFilter label="Sold by" selected={soldByFilter} onChange={setSoldByFilter} options={soldByList} />
            <CheckboxFilter label="Created by" selected={createdByFilter} onChange={setCreatedByFilter} options={createdByList} />
            <CheckboxFilter label="Item type" selected={itemTypeFilter} onChange={setItemTypeFilter} options={itemTypes} />
            <div className="flex items-center gap-1.5 text-sm text-[#7a685e]">
              <span>Sale date</span>
              <input
                type="date"
                aria-label="Sale date from"
                value={saleDateStart}
                min={EARLIEST_SALE_DATE_ISO}
                max={getYesterdayIso()}
                onChange={(e) => setSaleDateStart(e.target.value)}
                className="border border-[#e7dcd4] rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7a2e40] focus:border-transparent"
              />
              <span className="text-[#a8988d]">to</span>
              <input
                type="date"
                aria-label="Sale date to"
                value={saleDateEnd}
                min={EARLIEST_SALE_DATE_ISO}
                max={getYesterdayIso()}
                onChange={(e) => setSaleDateEnd(e.target.value)}
                className="border border-[#e7dcd4] rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7a2e40] focus:border-transparent"
              />
            </div>
            <FilterSelect
              label="Next payment date"
              value={nextPaymentFilter}
              onChange={(v) => setNextPaymentFilter(v as typeof nextPaymentFilter)}
              options={["Has", "None"]}
              optionLabels={{ Has: "Has a date", None: "No date set" }}
            />
            <FilterSelect
              label="Payment plan"
              value={planFilter}
              onChange={(v) => setPlanFilter(v as typeof planFilter)}
              options={["Has", "None"]}
              optionLabels={{ Has: "Has a plan", None: "No plan" }}
            />
            <FilterSelect
              label="Due status"
              value={dueFilter}
              onChange={(v) => setDueFilter(v as typeof dueFilter)}
              options={["DueOnly", "PaidOff"]}
              optionLabels={{ DueOnly: "Still due", PaidOff: "Fully collected" }}
            />
            <CheckboxFilter
              label="Collected"
              selected={collectedFilter}
              onChange={setCollectedFilter}
              options={collectedBuckets.map((b) => b.label)}
            />
            {(centerFilter.length > 0 ||
              soldByFilter.length > 0 ||
              createdByFilter.length > 0 ||
              !sameSet(itemTypeFilter, DEFAULT_ITEM_TYPES) ||
              nextPaymentFilter !== "All" ||
              planFilter !== "All" ||
              dueFilter !== "All" ||
              collectedFilter.length > 0 ||
              saleDateStart !== "" ||
              // Comparing against a freshly-computed "yesterday" rather
              // than a fixed default — moving the end date away from
              // yesterday (e.g. widening to include today) counts as an
              // active filter worth offering to clear back to baseline.
              saleDateEnd !== getYesterdayIso() ||
              query) && (
              <button
                onClick={() => {
                  setQuery("");
                  setCenterFilter([]);
                  setSoldByFilter([]);
                  setCreatedByFilter([]);
                  setItemTypeFilter(DEFAULT_ITEM_TYPES);
                  setNextPaymentFilter("All");
                  setPlanFilter("All");
                  setDueFilter("All");
                  setCollectedFilter([]);
                  setSaleDateStart("");
                  setSaleDateEnd(getYesterdayIso());
                }}
                className="text-sm px-3 py-1.5 rounded-lg text-[#7a2e40] hover:bg-[#f6e2e7] transition-colors"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* Table — fixed-width columns summing to 100% so the table never
            exceeds the viewport width; cells wrap instead of overflowing,
            so the page only ever scrolls vertically, never sideways. Center,
            item, type, collected, next payment and plan only join once
            there's enough width to show them without cramming — they're
            always available in the detail panel on tap/click regardless. */}
        <div className="bg-white border border-[#e7dcd4] rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e7dcd4]">
                <SortHeader label="Sale date" sortKeyName="saleDate" />
                <SortHeader label="Invoice" sortKeyName="invoiceNo" />
                <SortHeader label="Guest" sortKeyName="guestName" />
                <th className="hidden min-[47.5rem]:table-cell text-left text-xs font-semibold uppercase tracking-wide text-[#a8988d] px-2 py-2.5 whitespace-nowrap">
                  Guest code
                </th>
                <SortHeader label="Center" sortKeyName="centerName" hideBelow="sm" />
                <th className="hidden min-[60.625rem]:table-cell text-left text-xs font-semibold uppercase tracking-wide text-[#a8988d] px-2 py-2.5 break-words">
                  Item
                </th>
                <th className="hidden min-[60.625rem]:table-cell text-left text-xs font-semibold uppercase tracking-wide text-[#a8988d] px-2 py-2.5 break-words">
                  Sold by
                </th>
                <th className="hidden min-[60.625rem]:table-cell text-left text-xs font-semibold uppercase tracking-wide text-[#a8988d] px-2 py-2.5 break-words">
                  Created by
                </th>
                <th className="hidden min-[47.5rem]:table-cell text-left text-xs font-semibold uppercase tracking-wide text-[#a8988d] px-2 py-2.5 whitespace-nowrap">
                  Type
                </th>
                <th className="hidden min-[75.625rem]:table-cell text-right text-xs font-semibold uppercase tracking-wide text-[#a8988d] px-3 py-2.5 whitespace-nowrap">
                  Sales (Inc. Tax)
                </th>
                <SortHeader label="Due" sortKeyName="due" align="right" />
                <SortHeader label="Collected" sortKeyName="collected" hideBelow="lg" align="right" />
                <SortHeader label="Next payment" sortKeyName="nextPaymentDate" hideBelow="sm" />
                <th className="hidden min-[47.5rem]:table-cell text-left text-xs font-semibold uppercase tracking-wide text-[#a8988d] px-1.5 py-2.5 whitespace-nowrap">
                  Plan
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={14} className="px-3 py-8 text-center text-[#a8988d]">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-3 py-8 text-center text-[#a8988d]">
                    No matching invoices.
                  </td>
                </tr>
              )}
              {!loading &&
                sorted.map((row, idx) => {
                  const urgency = paymentUrgency(row.nextPaymentDate, todayIso);
                  const issues = getDataIssues(row);
                  const rowBg =
                    urgency === "overdue"
                      ? "bg-[#eec4c4] hover:bg-[#e6b5b5]"
                      : urgency === "soon"
                        ? "bg-[#fbeaea] hover:bg-[#f6dcdc]"
                        : "hover:bg-[#f6e2e7]";
                  return (
                    <tr
                      key={`${row.invoiceNo}-${idx}`}
                      onClick={() => setSelected(row)}
                      className={`border-b border-[#f1ebe6] last:border-0 cursor-pointer transition-colors align-top ${rowBg}`}
                    >
                      <td className="px-3 py-2.5 text-[#7a685e] whitespace-nowrap">{row.saleDate || "—"}</td>
                      <td className="px-3 py-2.5 font-medium break-words">
                        <span className="inline-flex items-center gap-1.5">
                          {row.invoiceNo}
                          {issues.length > 0 && (
                            <span
                              className="text-[#b23b3b]"
                              title={issues.map((i) => i.detail).join(" ")}
                              aria-label="Data quality issue"
                            >
                              ⚠
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 break-words">{row.guestName}</td>
                      <td className="hidden min-[47.5rem]:table-cell px-2 py-2.5 text-[#7a685e] whitespace-nowrap">{row.guestCode || "—"}</td>
                      <td className="hidden min-[47.5rem]:table-cell px-3 py-2.5 text-[#7a685e] break-words">{row.centerName}</td>
                      <td className="hidden min-[60.625rem]:table-cell px-3 py-2.5 text-[#7a685e] break-words">{row.itemName}</td>
                      <td className="hidden min-[60.625rem]:table-cell px-3 py-2.5 text-[#7a685e] break-words">{row.soldBy || "—"}</td>
                      <td className="hidden min-[60.625rem]:table-cell px-3 py-2.5 text-[#7a685e] break-words">{row.invoiceCreatedBy || "—"}</td>
                      <td className="hidden min-[47.5rem]:table-cell px-1.5 py-2.5 whitespace-nowrap">
                        <span className="inline-flex items-center rounded-full bg-[#f1ebe6] text-[#7a685e] text-xs font-medium px-1.5 py-0.5">
                          {row.itemType || "—"}
                        </span>
                      </td>
                      <td className="hidden min-[75.625rem]:table-cell px-3 py-2.5 text-right tabular-nums text-[#7a685e] whitespace-nowrap">
                        ₹{formatINR(row.salesIncTax)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium whitespace-nowrap">₹{formatINR(row.due)}</td>
                      <td className="hidden min-[75.625rem]:table-cell px-3 py-2.5 text-right tabular-nums text-[#7a685e] whitespace-nowrap">
                        ₹{formatINR(row.collected)}
                      </td>
                      <td className="hidden min-[47.5rem]:table-cell px-3 py-2.5 text-[#7a685e] whitespace-nowrap">
                        {row.nextPaymentDate || "—"}
                        {urgency === "overdue" && (
                          <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#8a2e2e]">Overdue</span>
                        )}
                        {urgency === "soon" && (
                          <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#a15a5a]">Soon</span>
                        )}
                      </td>
                      <td className="hidden min-[47.5rem]:table-cell px-1.5 py-2.5 whitespace-nowrap">
                        {hasPaymentPlan(row) ? (
                          <span
                            className={`inline-flex items-center rounded-full text-xs font-medium px-1.5 py-0.5 ${
                              issues.some((i) => i.label === "Payment plan doesn't match Due")
                                ? "bg-[#f3d4d4] text-[#8a2e2e]"
                                : "bg-[#e3ece7] text-[#3f5f4f]"
                            }`}
                          >
                            {issues.some((i) => i.label === "Payment plan doesn't match Due") ? "Mismatch" : "Yes"}
                          </span>
                        ) : (
                          <span className="text-[#c3b8ae] text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-[#a8988d] mt-3">
          Showing {sorted.length} of {invoices?.length ?? 0} line items. Click a row for full detail.
        </p>
      </div>

      {selected && <DetailPanel row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function DetailPanel({ row, onClose }: { row: InvoiceRow; onClose: () => void }) {
  const installments = [
    { label: "1st payment", date: row.payment1Date, amount: row.payment1Amount },
    { label: "2nd payment", date: row.payment2Date, amount: row.payment2Amount },
    { label: "3rd payment", date: row.payment3Date, amount: row.payment3Amount },
  ].filter((p) => p.date);
  const planTotal = installments.reduce((sum, p) => sum + (p.amount ?? 0), 0);
  const urgency = paymentUrgency(row.nextPaymentDate, getTodayIso());
  const issues = getDataIssues(row);

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#7a2e40] mb-1">
              Invoice {row.invoiceNo}
            </p>
            <h2 className="text-xl font-serif text-[#2a211d]">{row.guestName}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-[#a8988d] hover:text-[#2a211d] text-xl leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm mb-5">
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Invoice Number</dt>
            <dd>{row.invoiceNo}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Center</dt>
            <dd>{row.centerName}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Sale date</dt>
            <dd>{row.saleDate || "—"}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Item</dt>
            <dd>{row.itemName || "—"}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Item type</dt>
            <dd>{row.itemType || "—"}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Sold by</dt>
            <dd>{row.soldBy || "—"}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Created by</dt>
            <dd>{row.invoiceCreatedBy || "—"}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Sales (Inc. Tax)</dt>
            <dd className="tabular-nums">₹{formatINR(row.salesIncTax)}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Collected</dt>
            <dd className="tabular-nums">₹{formatINR(row.collected)}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Due</dt>
            <dd className="tabular-nums font-semibold text-[#7a2e40]">₹{formatINR(row.due)}</dd>
          </div>
          <div>
            <dt className="text-[#a8988d] text-xs uppercase tracking-wide mb-0.5">Next payment date</dt>
            <dd>
              {row.nextPaymentDate || "—"}
              {urgency === "overdue" && (
                <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#8a2e2e]">Overdue</span>
              )}
              {urgency === "soon" && (
                <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#a15a5a]">Soon</span>
              )}
            </dd>
          </div>
        </dl>

        {issues.length > 0 && (
          <div className="mb-5 rounded-lg border border-[#e7b3b3] bg-[#fbeaea] px-3 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#8a2e2e] mb-1.5">
              ⚠ Data quality
            </p>
            <ul className="flex flex-col gap-1">
              {issues.map((issue) => (
                <li key={issue.label} className="text-sm text-[#8a2e2e]">
                  {issue.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t border-[#e7dcd4] pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#a8988d] mb-3">
            Payment plan
          </p>
          {installments.length === 0 ? (
            <p className="text-sm text-[#a8988d]">No structured payment plan recorded for this invoice.</p>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {installments.map((p) => (
                  <li
                    key={p.label}
                    className="flex items-center justify-between bg-[#faf5f1] rounded-lg px-3 py-2 text-sm"
                  >
                    <span className="text-[#7a685e]">
                      {p.label} · {p.date}
                    </span>
                    <span className="tabular-nums font-medium">
                      {p.amount != null ? `₹${formatINR(p.amount)}` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between px-3 pt-2.5 text-sm">
                <span className="text-[#a8988d]">Plan total vs. Due</span>
                <span className="tabular-nums font-medium">
                  ₹{formatINR(planTotal)} / ₹{formatINR(row.due)}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
