-- Stage 4: profile and reminder preferences, one row per user.
--
-- Mirrors the browser keys `plantetary-profile-preferences-v1` and
-- `plantetary-reminder-preferences-v1` (src/app/settings-logic.ts). These are
-- ordinary columns, not part of the game save, so changing an avatar never
-- conflicts with completing a quest.

create table public.profiles (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  display_name         text not null
                       check (char_length(display_name) between 1 and 32
                              and char_length(btrim(display_name)) > 0),
  avatar               text
                       check (avatar in ('seedling', 'leaf', 'flower', 'cactus')),
  reminders_enabled    boolean not null default false,
  reminder_quest_types text[] not null default '{daily,personal}'
                       check (reminder_quest_types <@ array['daily', 'personal']),
  reminder_time        text not null default '20:00'
                       check (reminder_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.profiles is
  'Display name, avatar and reminder preferences. One row per user; RLS limits each user to their own row.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- Access rules -------------------------------------------------------------
--
-- Grants are set explicitly because a hosted project may automatically expose
-- new tables to `anon` and `authenticated`. Logged-out visitors get nothing.
-- Signed-in users may only write the preference columns, never `user_id`,
-- `created_at` or `updated_at`.

alter table public.profiles enable row level security;

revoke all on table public.profiles from public, anon, authenticated;
grant all on table public.profiles to service_role;

grant select, delete on table public.profiles to authenticated;
grant insert (user_id, display_name, avatar, reminders_enabled, reminder_quest_types, reminder_time)
  on table public.profiles to authenticated;
grant update (display_name, avatar, reminders_enabled, reminder_quest_types, reminder_time)
  on table public.profiles to authenticated;

create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own profile"
  on public.profiles for delete to authenticated
  using ((select auth.uid()) = user_id);
