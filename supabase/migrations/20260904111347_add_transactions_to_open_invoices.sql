-- Full payment transaction history for open invoices (from GET
-- /v1/invoices/{id}?expand=Transactions), stored alongside the item/guest
-- detail already captured via expand=InvoiceItems. Needed so backfilled
-- invoices (no webhook-observed payment history at all) still compute an
-- accurate Collected/Due, and so live invoices' payment history isn't
-- limited to only what happened to arrive via webhook after we started
-- listening.
alter table public.zenoti_open_invoices
  add column if not exists transactions jsonb not null default '[]'::jsonb;
