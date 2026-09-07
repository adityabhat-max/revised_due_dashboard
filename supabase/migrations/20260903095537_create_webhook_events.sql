create table if not exists public.webhook_events (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  payload jsonb not null
);

create index if not exists webhook_events_payload_gin_idx
  on public.webhook_events using gin (payload);

create index if not exists webhook_events_received_at_idx
  on public.webhook_events (received_at desc);

alter table public.webhook_events enable row level security;
