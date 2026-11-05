-- Stage 4: shared helpers for Plantetary's database.
--
-- Trigger functions live in a `private` schema. Supabase's Data API only
-- exposes the schemas listed in supabase/config.toml (`public` and
-- `graphql_public`), so nothing here can be called from the browser.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

-- Keeps `updated_at` current on every update, whatever the client sends.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.set_updated_at() is
  'Trigger: sets updated_at to the current time on every update.';

revoke execute on function private.set_updated_at() from public, anon, authenticated;
