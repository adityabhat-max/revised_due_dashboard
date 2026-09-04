-- Extends due_invoices_report to also cover invoices that are open/due but
-- never appeared as Invoice.Closed (which by definition only fires once an
-- invoice is fully paid). Those come from zenoti_open_invoices, populated by
-- calling Zenoti's API directly since Invoice.Payments.Added alone doesn't
-- carry guest/items/total. Center names now come from the real
-- zenoti_centers lookup instead of best-effort backfill from webhook
-- byproducts; Sold By for open invoices uses therapist_name straight from
-- the API response, which Invoice.Closed never included on items at all.
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
open_invoices as (
  select
    payload->>'id' as invoice_id,
    coalesce(payload->>'invoice_number_prefix','') || coalesce(payload->>'invoice_number','') as invoice_no,
    (payload->>'invoice_date')::timestamptz as sale_date,
    trim(coalesce(payload->>'guest.first_name','') || ' ' || coalesce(payload->>'guest.last_name','')) as guest_name,
    payload->>'guest.code' as guest_code,
    payload->>'center_id' as center_id,
    (payload->>'total_price.sum_total')::numeric as invoice_sales_inc_tax,
    coalesce(payload->'invoice_items', '[]'::jsonb) as invoice_items,
    coalesce(payload->'additional_fields', '[]'::jsonb) as additional_fields
  from public.zenoti_open_invoices
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
staff_lookup as (
  select distinct appt->>'TherapistId' as staff_id, appt->>'therapist_name' as staff_name
  from closed_invoices, jsonb_array_elements(appointments) appt
  where appt->>'TherapistId' is not null
),
closed_item_rows as (
  select
    ci.invoice_id,
    ci.sale_date,
    ci.invoice_no,
    ci.guest_name,
    ci.guest_code,
    ci.center_id,
    item->>'name' as item_name,
    item->>'type' as item_type_code,
    coalesce(sl.staff_name, item->>'sale_by_id') as sold_by,
    (nullif(item->'price'->>'final',''))::numeric as item_sales_inc_tax,
    ci.invoice_sales_inc_tax,
    (
      select af->>'value' from jsonb_array_elements(ci.additional_fields) af
      where af->>'key' = 'Next payment Date'
      limit 1
    ) as next_payment_date
  from closed_invoices ci, jsonb_array_elements(ci.invoice_items) item
  left join staff_lookup sl on sl.staff_id = item->>'sale_by_id'
),
open_item_rows as (
  select
    oi.invoice_id,
    oi.sale_date,
    oi.invoice_no,
    oi.guest_name,
    oi.guest_code,
    oi.center_id,
    item->>'name' as item_name,
    item->>'type' as item_type_code,
    coalesce(item->>'therapist_name', item->>'sale_by_id') as sold_by,
    (nullif(item->'price'->>'final',''))::numeric as item_sales_inc_tax,
    oi.invoice_sales_inc_tax,
    (
      select af->>'value' from jsonb_array_elements(oi.additional_fields) af
      where af->>'key' = 'Next payment Date'
      limit 1
    ) as next_payment_date
  from open_invoices oi, jsonb_array_elements(oi.invoice_items) item
),
item_rows as (
  select * from closed_item_rows
  union all
  select * from open_item_rows
)
select
  ir.sale_date as "Sale Date",
  ir.invoice_no as "Invoice No",
  ir.guest_name as "Guest Name",
  ir.guest_code as "Guest Code",
  coalesce(zc.name, ir.center_id) as "Center",
  ir.item_name as "Item",
  case ir.item_type_code
    when '0' then 'Service'
    when '2' then 'Product'
    when '4' then 'Package'
    else 'Unknown (' || ir.item_type_code || ')'
  end as "Item Type",
  ir.sold_by as "Sold By",
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
left join public.zenoti_centers zc on zc.center_id = ir.center_id
where (ir.invoice_sales_inc_tax - coalesce(ps.collected, 0)) > 0
order by ir.sale_date desc;

grant select on public.due_invoices_report to service_role;
