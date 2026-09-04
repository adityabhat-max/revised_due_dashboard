-- Supports enriching invoices that are open/due (which Zenoti's webhooks
-- never fully describe - see Invoice.Payments.Added, which only carries the
-- invoice id + payment, not guest/items/total) by calling Zenoti's REST API
-- directly for those invoice ids.

-- Singleton row holding the current Zenoti API access/refresh token pair.
-- Access tokens expire after 24h; the Edge Function refreshes automatically
-- using refresh_token (itself valid 90 days, rotated on every refresh) and
-- writes the new pair back here - tokens can't be persisted by updating a
-- Supabase secret from inside a running function, so the database is the
-- natural place for this mutable state instead.
create table if not exists public.zenoti_auth_tokens (
  id int primary key default 1,
  access_token text not null,
  access_token_expiry timestamptz not null,
  refresh_token text not null,
  refresh_token_expiry timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint zenoti_auth_tokens_singleton check (id = 1)
);

alter table public.zenoti_auth_tokens enable row level security;
grant select, insert, update on public.zenoti_auth_tokens to service_role;

-- One row per currently-open (unpaid/partially-paid) invoice, populated by
-- calling GET /v1/invoices/{id} when a webhook shows a new open invoice.
-- Deleted once the invoice's Invoice.Closed event arrives (fully paid).
create table if not exists public.zenoti_open_invoices (
  invoice_id text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists zenoti_open_invoices_payload_gin_idx
  on public.zenoti_open_invoices using gin (payload);

alter table public.zenoti_open_invoices enable row level security;
grant select, insert, update, delete on public.zenoti_open_invoices to service_role;

-- Static reference data from GET /v1/centers, since Invoice.Closed only
-- ever gives a center_id, never a name.
create table if not exists public.zenoti_centers (
  center_id text primary key,
  code text,
  name text not null
);

alter table public.zenoti_centers enable row level security;
grant select on public.zenoti_centers to service_role;

insert into public.zenoti_centers (center_id, code, name) values
  ('7f146830-cfbd-4494-aa5a-3da9fcac15fa', 'VV', 'Vasant Vihar, New Delhi'),
  ('8227da41-8b5f-45d2-8346-d5fc893f5ca6', 'TC', 'ZTraining Center'),
  ('25f66248-305e-4726-b3e8-fdf307d4f40f', 'GK', 'Greater Kailash, New Delhi'),
  ('343d81c9-3c8a-47c7-a703-bc0bfb3389c1', 'BLR', 'Bangalore'),
  ('26261064-7255-4a38-8daa-4a570bd6acfe', 'KM', 'Khan Market, New Delhi'),
  ('e594c0df-8648-4085-ac51-fdeb047b6aad', 'MU', 'Santacruz, Mumbai'),
  ('25267390-20e4-4dac-a0e8-5650a6133db3', 'ND', 'Noida'),
  ('562782bc-5e17-44ac-ae97-91194cf59a7c', 'HO', 'VV_Headoffice'),
  ('c49ab48d-532b-4c15-bc80-e08f6834a408', 'HAD', 'Hyderabad'),
  ('f45be8f9-1271-4850-8af8-314901192a15', 'DLF', 'Gurgaon - (DLF)'),
  ('ecc48c1d-fba8-4f17-b0bb-31f13a5a8bdb', 'SExt./', 'South Extension, New Delhi'),
  ('3fc55c7d-d5c8-4e17-8dfb-13e61df23baf', 'BSSN', 'Bangalore (Sadashiva)'),
  ('2261e0fa-5a73-4b71-a601-20f4d8b8fbfa', 'M3M', 'Gurgaon -(M3M)'),
  ('657a9d82-1d92-4739-a8a1-0c0e4e20cd80', 'SN', 'Srinagar'),
  ('d5254740-a696-4734-91df-391094f55383', 'Surat', 'Surat'),
  ('b3045736-9b3f-4ab6-a134-5b077343efa7', 'PNB', 'Punjabi Bagh, New Delhi'),
  ('c84beb68-2f66-4c0c-9278-080cfd0e9cef', 'MOH', 'Mohali, Punjab'),
  ('65c930c5-2e91-4276-a88c-747c741c6198', 'GM', 'Gurgaon -(Galleria)'),
  ('c8d725bf-867f-44e5-acb1-41a87aa736a1', 'LUH', 'Ludhiana, Punjab'),
  ('015ffd5e-0ac4-4884-ad65-98fc57e732e0', 'KKDM', 'Karkardooma,New Delhi'),
  ('3da5b7f2-c900-4e18-863a-6245bbc907b2', 'CTP', 'Chhatarpur,New Delhi')
on conflict (center_id) do update set code = excluded.code, name = excluded.name;
