-- Stage 4: cloud backups of game saves.
--
-- Backups are never edited. Each one keeps the exact original text, so it
-- survives even if the save format changes later.
--
-- Reasons:
--   browser_import  the browser save, uploaded before an import (Stage 8)
--   conflict        the losing copy when two devices saved at once (Stage 9)
--   daily           made automatically by the database, at most once a day

create table public.save_backups (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  reason          text not null check (reason in ('browser_import', 'conflict', 'daily')),
  raw_data        text not null check (octet_length(raw_data) <= 10485760),  -- exact original text
  schema_version  integer check (schema_version >= 1),  -- format of raw_data, if known
  source_revision bigint check (source_revision >= 1),  -- quest_saves.revision it came from, if any
  created_at      timestamptz not null default now()
);

comment on table public.save_backups is
  'Read-only copies of game saves. RLS limits each user to their own backups.';

create index save_backups_user_created
  on public.save_backups (user_id, created_at desc);

-- Keep the newest backups only ----------------------------------------------
--
-- Without a limit, backups could grow forever. After each new backup, older
-- ones with the same reason are removed beyond these limits:
--   daily 14, conflict 20, browser_import 5

create function private.prune_save_backups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  keep_count integer := case new.reason
    when 'daily' then 14
    when 'conflict' then 20
    when 'browser_import' then 5
  end;
begin
  delete from public.save_backups
  where user_id = new.user_id
    and reason = new.reason
    and id not in (
      select id
      from public.save_backups
      where user_id = new.user_id
        and reason = new.reason
      order by created_at desc, id desc
      limit keep_count
    );
  return null;
end;
$$;

comment on function private.prune_save_backups() is
  'Trigger: after a backup is added, removes that user''s oldest backups with the same reason beyond the limit.';

revoke execute on function private.prune_save_backups() from public, anon, authenticated;

create trigger save_backups_prune
  after insert on public.save_backups
  for each row execute function private.prune_save_backups();

-- Automatic daily backup ----------------------------------------------------
--
-- When a save's content changes, the copy being replaced is backed up, unless
-- this user already has a daily backup from the same UTC day. The day is used
-- only to space out backups; it is never used for game logic.

create function private.backup_quest_save_daily()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.save_backups
    where user_id = old.user_id
      and reason = 'daily'
      and created_at >= date_trunc('day', now(), 'UTC')
  ) then
    insert into public.save_backups (user_id, reason, raw_data, schema_version, source_revision)
    values (old.user_id, 'daily', old.data::text, old.schema_version, old.revision);
  end if;
  return null;
end;
$$;

comment on function private.backup_quest_save_daily() is
  'Trigger: backs up the previous quest save, at most once per user per UTC day.';

revoke execute on function private.backup_quest_save_daily() from public, anon, authenticated;

-- `json` has no equality operator, so the content is compared as text.
create trigger quest_saves_backup_daily
  after update on public.quest_saves
  for each row
  when (old.data::text is distinct from new.data::text)
  execute function private.backup_quest_save_daily();

-- Access rules -------------------------------------------------------------
--
-- Users can read, add and delete their own backups, but never change one.
-- They may not set `id` or `created_at`, so backup order can't be faked.

alter table public.save_backups enable row level security;

revoke all on table public.save_backups from public, anon, authenticated;
grant all on table public.save_backups to service_role;

grant select, delete on table public.save_backups to authenticated;
grant insert (user_id, reason, raw_data, schema_version, source_revision)
  on table public.save_backups to authenticated;

create policy "Users can read their own backups"
  on public.save_backups for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own backups"
  on public.save_backups for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own backups"
  on public.save_backups for delete to authenticated
  using ((select auth.uid()) = user_id);
