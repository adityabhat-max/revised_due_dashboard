-- Runs sync-sales-report every 30 minutes. The function's shared secret is
-- looked up from Supabase Vault by name (set separately via
-- vault.create_secret, not committed here) so the actual value never ends
-- up in a migration file.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'sync-sales-report-every-30-min',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://bfvcuqjlcbhqujgtwsvf.supabase.co/functions/v1/sync-sales-report',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_shared_secret')
    )
  );
  $$
);
