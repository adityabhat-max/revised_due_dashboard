-- due > 0 let sub-rupee rounding noise (e.g. 0.0042 from Zenoti's own
-- pricing math on essentially-fully-paid invoices) show up as "due".
-- Raised to > 1 so only genuinely outstanding balances appear.
create or replace view public.due_invoices_report as
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
where due > 1
  and sale_date >= now() - interval '30 days'
  and item_type <> 'Service'
order by sale_date desc;

grant select on public.due_invoices_report to service_role;
