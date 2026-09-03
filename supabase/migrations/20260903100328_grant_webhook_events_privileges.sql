-- Fresh tables on this project don't inherit the usual anon/authenticated/
-- service_role DML grants. anon and authenticated ended up with a stray
-- TRUNCATE grant, which RLS does not filter (RLS has no effect on TRUNCATE),
-- so it's revoked outright rather than left as a latent wipe vector.
revoke all on table public.webhook_events from anon, authenticated;

grant select, insert on table public.webhook_events to service_role;
