-- Stage 7: a backup reason of its own for saves upgraded to a newer format.
--
-- When the app loads a cloud save in an older format, it upgrades it in the
-- browser. Before the upgraded save replaces the original, the original is
-- kept as a backup, exactly as browser saves already are.
--
-- These backups get their own reason, `upgrade`, so they never use up the
-- `daily` backups' limit or push daily history out:
--   - At most one per user and source revision. Revisions never repeat for a
--     user (see the revision fix), so a revision identifies one version of a
--     save, and loading it again any number of times backs it up only once.
--     A second attempt fails with 23505 on `save_backups_upgrade_once`, which
--     the app treats as "already backed up".
--   - They must say which revision they came from.
--   - The newest 5 are kept per user, like browser imports. A save is only
--     upgraded once per format change, so 5 covers several app versions.
--
-- Earlier migrations are already deployed and are left unchanged. RLS
-- policies and grants are unchanged: users can still add and read only their
-- own backups, and never edit one.

-- The new reason --------------------------------------------------------------

alter table public.save_backups drop constraint save_backups_reason_check;
alter table public.save_backups add constraint save_backups_reason_check
  check (reason in ('browser_import', 'conflict', 'daily', 'upgrade'));

alter table public.save_backups add constraint save_backups_upgrade_source_revision_check
  check (reason <> 'upgrade' or source_revision is not null);

create unique index save_backups_upgrade_once
  on public.save_backups (user_id, source_revision)
  where reason = 'upgrade';

comment on index public.save_backups_upgrade_once is
  'At most one upgrade backup per user and source revision, so loading the same old save again never adds another.';

-- The pruning lock table lists the reasons too.
alter table private.save_backup_retention_locks drop constraint save_backup_retention_locks_reason_check;
alter table private.save_backup_retention_locks add constraint save_backup_retention_locks_reason_check
  check (reason in ('browser_import', 'conflict', 'daily', 'upgrade'));

-- Retention -------------------------------------------------------------------
--
-- Same function as before, with a limit for `upgrade`. Each reason is still
-- pruned on its own, so upgrade backups never remove daily ones.

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
    when 'upgrade' then 5
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
  'Trigger: after a backup is added, removes that user''s oldest backups with the same reason beyond the limit (daily 14, conflict 20, browser_import 5, upgrade 5). Concurrent inserts for one user and reason take turns.';

revoke execute on function private.prune_save_backups() from public, anon, authenticated;
