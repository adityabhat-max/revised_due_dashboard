-- Replaces the webhook-driven due-invoice pipeline (zenoti_open_invoices +
-- all the manual payment-dedup/center-lookup/item-type-guessing logic in
-- due_invoices_report) with a periodic pull from Zenoti's own Sales -
-- Accrual report (POST /v1/reports/sales/accrual_basis/flat_file). That
-- report computes due/collected/center_name/item_type/sold_by/created_by
-- itself, authoritatively, and includes invoice_notes - eliminating the
-- fragility of re-deriving all of this from raw webhook events. One row
-- per invoice line item, matching the report's own grain.
create table if not exists public.zenoti_sales_report (
  invoice_item_id text primary key,
  invoice_id text not null,
  invoice_no text not null,
  sale_date timestamptz not null,
  guest_name text,
  guest_code text,
  center_name text,
  item_name text,
  item_type text,
  sales_inc_tax numeric,
  collected numeric,
  due numeric,
  status text,
  sold_by text,
  created_by text,
  invoice_notes text,
  payment_1_date date,
  payment_1_amount numeric,
  payment_2_date date,
  payment_2_amount numeric,
  payment_3_date date,
  payment_3_amount numeric,
  fetched_at timestamptz not null default now()
);

create index if not exists zenoti_sales_report_due_idx
  on public.zenoti_sales_report (due) where due > 0;

create index if not exists zenoti_sales_report_sale_date_idx
  on public.zenoti_sales_report (sale_date desc);

alter table public.zenoti_sales_report enable row level security;
grant select, insert, update, delete on public.zenoti_sales_report to service_role;

-- Simple now: no more payment dedup CTEs, no more center/staff lookups, no
-- more item-type code guessing - the report already computed all of it.
-- Dropped and recreated (not `create or replace`) since several columns
-- change from text to their proper date/numeric types here.
drop view if exists public.due_invoices_report;

create view public.due_invoices_report as
select
  sale_date as "Sale Date",
  invoice_no as "Invoice No",
  guest_name as "Guest Name",
  guest_code as "Guest Code",
  center_name as "Center",
  item_name as "Item",
  item_type as "Item Type",
  sold_by as "Sold By",
  created_by as "Created By",
  sales_inc_tax as "Sales (Inc. Tax)",
  collected as "Collected",
  due as "Due",
  -- Whichever parsed installment isn't yet covered by what's actually been
  -- collected so far, per the invoice's own note-based plan (best-effort -
  -- only meaningful when invoice_notes actually parsed into a plan).
  case
    when payment_1_date is not null and coalesce(collected, 0) < coalesce(payment_1_amount, 0)
      then payment_1_date
    when payment_2_date is not null and coalesce(collected, 0) < coalesce(payment_1_amount, 0) + coalesce(payment_2_amount, 0)
      then payment_2_date
    when payment_3_date is not null and coalesce(collected, 0) < coalesce(payment_1_amount, 0) + coalesce(payment_2_amount, 0) + coalesce(payment_3_amount, 0)
      then payment_3_date
    else null
  end::text as "Next Payment Date",
  payment_1_date as "1st Payment Date",
  payment_1_amount as "1st Payment Amount",
  payment_2_date as "2nd Payment Date",
  payment_2_amount as "2nd Payment Amount",
  payment_3_date as "3rd Payment Date",
  payment_3_amount as "3rd Payment Amount"
from public.zenoti_sales_report
where due > 0
  and sale_date >= now() - interval '30 days'
order by sale_date desc;

grant select on public.due_invoices_report to service_role;
