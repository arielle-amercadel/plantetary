-- Stage 4 fixes, from code review. Earlier migrations are already deployed
-- and are left unchanged.
--
-- Fix 1: a save's revision never repeats for a user, even after the save is
--        deleted and created again.
-- Fix 2: backup limits hold when several backups are added at the same time.
--
-- RLS policies and grants on the public tables are unchanged.

-- ---------------------------------------------------------------------------
-- Fix 1: revisions that never repeat
-- ---------------------------------------------------------------------------
--
-- The problem: revision restarted at 1 when a save was recreated. A tab that
-- had loaded the old save at revision 1 could then save "where revision = 1"
-- and silently overwrite the new save.
--
-- The fix: remember each user's highest revision in a private table that
-- outlives the save. A recreated save continues from there, so every revision
-- a user has ever had is unique, and a stale tab's revision never matches.
-- Updates still add 1, as in the Stage 3 design.
--
-- Writing the counter row also locks it, so two writes to the same user's
-- save always get different revisions.

create table private.quest_save_revisions (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  last_revision bigint not null check (last_revision >= 1)
);

comment on table private.quest_save_revisions is
  'Highest quest_saves.revision each user has had. Kept when a save is deleted so revisions never repeat.';

revoke all on table private.quest_save_revisions from public, anon, authenticated;

-- Start the counters from the saves that already exist.
insert into private.quest_save_revisions (user_id, last_revision)
select user_id, revision
from public.quest_saves;

-- Same trigger as before, now taking the next revision from the counter. It
-- runs as its owner because signed-in users can't reach the private schema.
-- It only ever touches the counter for the row being written, and RLS still
-- checks that row afterwards. If RLS rejects it, the counter change is
-- rolled back with it.
create or replace function private.quest_saves_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The lowest revision the result may follow. For an update this is the
  -- current revision, which also covers a save that has no counter yet.
  previous_revision bigint := 0;
begin
  if tg_op = 'UPDATE' then
    if new.schema_version < old.schema_version then
      raise exception 'quest_saves.schema_version cannot decrease (saved: %, attempted: %)',
        old.schema_version, new.schema_version
        using errcode = 'check_violation',
              hint = 'This save was made by a newer version of Plantetary. Refresh the app before saving.';
    end if;

    previous_revision := old.revision;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;

  insert into private.quest_save_revisions as counter (user_id, last_revision)
  values (new.user_id, previous_revision + 1)
  on conflict (user_id) do update
    set last_revision = greatest(counter.last_revision, previous_revision) + 1
  returning counter.last_revision into new.revision;

  new.updated_at := now();
  return new;
end;
$$;

comment on function private.quest_saves_before_write() is
  'Trigger: gives quest_saves a revision that never repeats for a user, manages timestamps, and stops schema_version from going down.';

revoke execute on function private.quest_saves_before_write() from public, anon, authenticated;

comment on column public.quest_saves.revision is
  'Set by the database: +1 on every save, and never reused for a user, even after the save is deleted and recreated. Clients save with "where revision = <the revision they loaded>" to detect conflicts.';

-- ---------------------------------------------------------------------------
-- Fix 2: backup limits under concurrent inserts
-- ---------------------------------------------------------------------------
--
-- The problem: pruning only saw backups that were already committed. Two
-- backups added at the same time each missed the other, so both were kept
-- and the limit was exceeded.
--
-- The fix: before pruning, each insert locks one row for its user and reason.
-- A second insert waits there until the first commits, then prunes with the
-- first one's backup in view. Different users, and different reasons, never
-- wait for each other.
--
-- Under the default READ COMMITTED isolation, the waiting insert continues
-- normally. Under REPEATABLE READ or SERIALIZABLE it fails with a
-- serialization error (40001) and must be retried, so the limit is never
-- exceeded either way.

create table private.save_backup_retention_locks (
  user_id uuid not null references auth.users (id) on delete cascade,
  reason  text not null check (reason in ('browser_import', 'conflict', 'daily')),
  primary key (user_id, reason)
);

comment on table private.save_backup_retention_locks is
  'One row per user and backup reason, locked while that user''s backups are pruned so concurrent inserts take turns.';

revoke all on table private.save_backup_retention_locks from public, anon, authenticated;

create or replace function private.prune_save_backups()
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
  -- Take this user's lock for this reason. It's held until the transaction
  -- ends.
  insert into private.save_backup_retention_locks as held (user_id, reason)
  values (new.user_id, new.reason)
  on conflict (user_id, reason) do update set reason = held.reason;

  -- This query starts after the lock is held, so it sees any backup that a
  -- transaction holding the lock before us has committed.
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
  'Trigger: after a backup is added, removes that user''s oldest backups with the same reason beyond the limit. Concurrent inserts for one user and reason take turns.';

revoke execute on function private.prune_save_backups() from public, anon, authenticated;
