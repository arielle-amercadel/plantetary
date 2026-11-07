-- Stage 8 Step 2. One PostgREST RPC call is one transaction. SECURITY INVOKER deliberately
-- retains the caller's existing column grants and RLS; no new table privileges or bypass role.
create function public.import_browser_save(
  p_user_id uuid,
  p_expected_revision bigint,
  p_data json,
  p_schema_version integer
)
returns table (outcome text, revision bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  previous public.quest_saves%rowtype;
  saved_revision bigint;
  backup_id bigint;
begin
  -- Bind to the adapter's original verified account, even if its HTTP token changed meanwhile.
  if auth.uid() is null or p_user_id is distinct from auth.uid() then
    raise exception 'Import account does not match authenticated account' using errcode = '42501';
  end if;
  if p_expected_revision is not null and p_expected_revision < 1 then
    raise exception 'Expected revision must be positive or null' using errcode = '22023';
  end if;
  if p_data is null or json_typeof(p_data) <> 'object' or octet_length(p_data::text) > 10485760 then
    raise exception 'Invalid or oversized import data' using errcode = '23514';
  end if;
  if p_schema_version is null or p_schema_version < 1 then
    raise exception 'Invalid import schema version' using errcode = '22023';
  end if;

  if p_expected_revision is null then
    -- No absent-row lock is possible. The primary key arbitrates concurrent creates; never upsert.
    begin
      insert into public.quest_saves (user_id, data, schema_version)
      values (p_user_id, p_data, p_schema_version)
      returning quest_saves.revision into saved_revision;
    exception when unique_violation then
      -- Roll back even the BEFORE INSERT revision-counter side effect of a competing create.
      return query select 'conflict'::text, null::bigint;
      return;
    end;
    return query select 'imported'::text, saved_revision;
    return;
  end if;

  select * into previous from public.quest_saves
  where user_id = p_user_id for update;
  if not found or previous.revision <> p_expected_revision then
    return query select 'conflict'::text, null::bigint;
    return;
  end if;

  -- The cloud already holds this exact garden: nothing to replace. Writing anyway would add a backup
  -- of the same garden, and repeated imports could push the original pre-import backup out of the
  -- five-backup retention window. Compared as jsonb, so formatting and key order don't matter.
  if previous.data::jsonb = p_data::jsonb and previous.schema_version = p_schema_version then
    return query select 'unchanged'::text, previous.revision;
    return;
  end if;

  begin
    insert into public.save_backups (user_id, reason, raw_data, schema_version, source_revision)
    values (p_user_id, 'browser_import', previous.data::text, previous.schema_version, previous.revision)
    returning id into backup_id;
    -- Retention can discard this insertion when a long-running transaction's timestamp is older
    -- than five existing backups. Never replace unless the backup actually survived pruning.
    if not exists (select 1 from public.save_backups where id = backup_id and user_id = p_user_id) then
      raise exception 'Import backup was not retained';
    end if;
  exception when others then
    -- This subtransaction rolls back the insertion AND retention's deletes on a backup failure.
    return query select 'backup_failed'::text, null::bigint;
    return;
  end;

  update public.quest_saves set data = p_data, schema_version = p_schema_version
  where user_id = p_user_id and quest_saves.revision = p_expected_revision
  returning quest_saves.revision into saved_revision;
  if saved_revision is null then
    -- Defensive: triggers/permissions must not allow a backup-only successful transaction.
    raise exception 'Import replacement did not update the locked save';
  end if;
  -- Any update error propagates, rolling back the backup, pruning, daily backup and revision counter.
  return query select 'imported'::text, saved_revision;
end;
$$;

revoke all on function public.import_browser_save(uuid, bigint, json, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.import_browser_save(uuid, bigint, json, integer) to authenticated;

comment on function public.import_browser_save(uuid, bigint, json, integer) is
  'Account-bound, revision-checked garden import. Atomically backs up the exact replaced cloud JSON as browser_import; an identical garden is left unchanged. SECURITY INVOKER preserves RLS and existing grants.';
