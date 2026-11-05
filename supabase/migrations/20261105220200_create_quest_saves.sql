-- Stage 4: the game save, one versioned JSON record per user (Stage 3, Option A).
--
-- `data` holds the same object the app keeps in the browser key
-- `plantetary-quest-data` (StoredQuestData in src/app/quest-types.ts).
--
-- It is `json`, not `jsonb`, on purpose: `jsonb` does not keep object key
-- order, and the completion history view lists personal completions in key
-- order. Nothing searches inside this record, so `json` costs nothing.

create table public.quest_saves (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  data           json not null
                 check (json_typeof(data) = 'object'
                        and octet_length(data::text) <= 10485760),  -- 10 MB safety limit
  schema_version integer not null check (schema_version >= 1),      -- format of the save
  revision       bigint not null default 1,                         -- +1 on every save
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.quest_saves is
  'One game save per user. RLS limits each user to their own row.';
comment on column public.quest_saves.revision is
  'Set by the database: 1 on insert, +1 on every update. Clients save with "where revision = <the revision they loaded>" to detect conflicts.';
comment on column public.quest_saves.schema_version is
  'The save format (StoredQuestData.schemaVersion). It can never go down, so an old open tab cannot overwrite a newer save.';

-- Revision, timestamps and format guard -----------------------------------
--
-- The database owns `revision`, `created_at` and `updated_at`, so clients
-- cannot set them. This keeps conflict detection trustworthy.

create function private.quest_saves_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.schema_version < old.schema_version then
    raise exception 'quest_saves.schema_version cannot decrease (saved: %, attempted: %)',
      old.schema_version, new.schema_version
      using errcode = 'check_violation',
            hint = 'This save was made by a newer version of Plantetary. Refresh the app before saving.';
  end if;

  new.user_id := old.user_id;
  new.revision := old.revision + 1;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.quest_saves_before_write() is
  'Trigger: manages revision and timestamps on quest_saves, and stops schema_version from going down.';

revoke execute on function private.quest_saves_before_write() from public, anon, authenticated;

create trigger quest_saves_before_write
  before insert or update on public.quest_saves
  for each row execute function private.quest_saves_before_write();

-- Access rules -------------------------------------------------------------
--
-- Signed-in users may only write `data` and `schema_version` (plus `user_id`
-- when creating their row). Logged-out visitors get nothing.

alter table public.quest_saves enable row level security;

revoke all on table public.quest_saves from public, anon, authenticated;
grant all on table public.quest_saves to service_role;

grant select, delete on table public.quest_saves to authenticated;
grant insert (user_id, data, schema_version) on table public.quest_saves to authenticated;
grant update (data, schema_version) on table public.quest_saves to authenticated;

create policy "Users can read their own save"
  on public.quest_saves for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own save"
  on public.quest_saves for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own save"
  on public.quest_saves for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own save"
  on public.quest_saves for delete to authenticated
  using ((select auth.uid()) = user_id);
