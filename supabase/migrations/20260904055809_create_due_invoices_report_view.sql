-- Sales-register style report of invoice line items belonging to invoices
-- that still have an outstanding balance (due > 0).
--
-- Data quirks handled here (found by inspecting real Zenoti payloads):
--   - Zenoti resends the full transaction list on every event for an
--     invoice (Invoice.Closed and every Invoice.Payments.Added), so summing
--     payments across events double-counts unless deduped by transaction_id.
--   - Center name and Sold By name aren't present on Invoice.Closed itself
--     (only center_id / sale_by_id). Backfilled from center/staff names seen
--     on other event types (Guest.Package.Created, transaction_center) and
--     appointments (TherapistId -> therapist_name). Falls back to the raw ID
--     when no name has been observed yet.
--   - "Created By" has no source anywhere in the webhook payloads Zenoti
--     sends for these event types, so it's left null.
--   - Item type codes (0/2/4) aren't documented by Zenoti; mapped from
--     observed item names (0 = Service, 2 = Product, 4 = Package).
create or replace view public.due_invoices_report as
with closed_invoices as (
  select
    payload->>'data.invoice.id' as invoice_id,
    coalesce(payload->>'data.invoice.invoice_number_prefix','') || coalesce(payload->>'data.invoice.invoice_number','') as invoice_no,
    (payload->>'data.invoice.invoice_date')::timestamptz as sale_date,
    trim(coalesce(payload->>'data.invoice.guest.first_name','') || ' ' || coalesce(payload->>'data.invoice.guest.last_name','')) as guest_name,
    payload->>'data.invoice.guest.code' as guest_code,
    payload->>'data.invoice.center_id' as center_id,
    (payload->>'data.invoice.total_price.sum_total')::numeric as invoice_sales_inc_tax,
    coalesce(payload->'data.invoice.invoice_items', '[]'::jsonb) as invoice_items,
    coalesce(payload->'data.invoice.appointments', '[]'::jsonb) as appointments,
    coalesce(payload->'data.invoice.additional_fields', '[]'::jsonb) as additional_fields,
    coalesce(payload->'data.invoice.transactions', '[]'::jsonb) as embedded_transactions
  from public.webhook_events
  where payload->>'event_type' = 'Invoice.Closed'
),
payments_added as (
  select
    payload->>'data.invoice_id' as invoice_id,
    coalesce(payload->'data.transactions', '[]'::jsonb) as txns
  from public.webhook_events
  where payload->>'event_type' = 'Invoice.Payments.Added'
),
all_payments_raw as (
  select invoice_id, txn->>'transaction_id' as transaction_id, txn->>'payment_date' as payment_date_raw, (txn->>'amount_paid')::numeric as amount_paid
  from closed_invoices, jsonb_array_elements(embedded_transactions) txn
  union all
  select invoice_id, txn->>'transaction_id' as transaction_id, txn->>'payment_date' as payment_date_raw, (txn->>'amount_paid')::numeric as amount_paid
  from payments_added, jsonb_array_elements(txns) txn
),
all_payments as (
  select distinct on (invoice_id, transaction_id) invoice_id, transaction_id, payment_date_raw, amount_paid
  from all_payments_raw
  order by invoice_id, transaction_id, payment_date_raw
),
ranked_payments as (
  select
    invoice_id,
    payment_date_raw,
    amount_paid,
    row_number() over (partition by invoice_id order by payment_date_raw) as rn
  from all_payments
),
payment_summary as (
  select
    invoice_id,
    sum(amount_paid) as collected,
    max(payment_date_raw) filter (where rn = 1) as payment_1_date,
    max(amount_paid) filter (where rn = 1) as payment_1_amount,
    max(payment_date_raw) filter (where rn = 2) as payment_2_date,
    max(amount_paid) filter (where rn = 2) as payment_2_amount,
    max(payment_date_raw) filter (where rn = 3) as payment_3_date,
    max(amount_paid) filter (where rn = 3) as payment_3_amount
  from ranked_payments
  group by invoice_id
),
center_lookup as (
  select distinct payload->>'data.center.id' as center_id, payload->>'data.center.name' as center_name
  from public.webhook_events
  where payload->>'event_type' = 'Guest.Package.Created' and payload->>'data.center.id' is not null
  union
  select distinct txn->'transaction_center'->>'id' as center_id, txn->'transaction_center'->>'name' as center_name
  from public.webhook_events, jsonb_array_elements(coalesce(payload->'data.transactions','[]'::jsonb)) txn
  where payload->>'event_type' = 'Invoice.Payments.Added'
),
staff_lookup as (
  select distinct appt->>'TherapistId' as staff_id, appt->>'therapist_name' as staff_name
  from closed_invoices, jsonb_array_elements(appointments) appt
  where appt->>'TherapistId' is not null
),
item_rows as (
  select
    ci.invoice_id,
    ci.sale_date,
    ci.invoice_no,
    ci.guest_name,
    ci.guest_code,
    ci.center_id,
    item->>'name' as item_name,
    item->>'type' as item_type_code,
    item->>'sale_by_id' as sold_by_id,
    (nullif(item->'price'->>'final',''))::numeric as item_sales_inc_tax,
    ci.invoice_sales_inc_tax,
    (
      select af->>'value' from jsonb_array_elements(ci.additional_fields) af
      where af->>'key' = 'Next payment Date'
      limit 1
    ) as next_payment_date
  from closed_invoices ci, jsonb_array_elements(ci.invoice_items) item
)
select
  ir.sale_date as "Sale Date",
  ir.invoice_no as "Invoice No",
  ir.guest_name as "Guest Name",
  ir.guest_code as "Guest Code",
  coalesce(cl.center_name, ir.center_id) as "Center",
  ir.item_name as "Item",
  case ir.item_type_code
    when '0' then 'Service'
    when '2' then 'Product'
    when '4' then 'Package'
    else 'Unknown (' || ir.item_type_code || ')'
  end as "Item Type",
  coalesce(sl.staff_name, ir.sold_by_id) as "Sold By",
  null as "Created By",
  ir.item_sales_inc_tax as "Sales (Inc. Tax)",
  coalesce(ps.collected, 0) as "Collected",
  ir.invoice_sales_inc_tax - coalesce(ps.collected, 0) as "Due",
  nullif(ir.next_payment_date, '') as "Next Payment Date",
  ps.payment_1_date as "1st Payment Date",
  ps.payment_1_amount as "1st Payment Amount",
  ps.payment_2_date as "2nd Payment Date",
  ps.payment_2_amount as "2nd Payment Amount",
  ps.payment_3_date as "3rd Payment Date",
  ps.payment_3_amount as "3rd Payment Amount"
from item_rows ir
left join payment_summary ps on ps.invoice_id = ir.invoice_id
left join center_lookup cl on cl.center_id = ir.center_id
left join staff_lookup sl on sl.staff_id = ir.sold_by_id
where (ir.invoice_sales_inc_tax - coalesce(ps.collected, 0)) > 0
order by ir.sale_date desc;

grant select on public.due_invoices_report to service_role;
