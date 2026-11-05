-- Triggers: timestamps, revisions, the schema-version guard, daily backups,
-- backup limits and account deletion.
--
-- now() is fixed for the whole transaction, so "a later day" is simulated by
-- moving existing backups into the past.

begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'user-a@plantetary.test', 'authenticated', 'authenticated'),
  ('dddddddd-0000-4000-8000-000000000004', 'user-d@plantetary.test', 'authenticated', 'authenticated');

-- quest_saves: values the database owns ---------------------------------------

-- Even the database owner can't pick the starting revision or timestamps.
insert into public.quest_saves (user_id, data, schema_version, revision, created_at, updated_at)
values ('aaaaaaaa-0000-4000-8000-000000000001', '{"day":1}', 3, 99, '2020-01-01', '2020-01-01');

select results_eq(
  $$ select revision, created_at = now(), updated_at = now() from public.quest_saves
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values (1::bigint, true, true) $$,
  'A new save starts at revision 1 with current timestamps'
);

update public.quest_saves
set data = '{"day":2}', revision = 50, created_at = '2020-01-01', updated_at = '2020-01-01'
where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

select results_eq(
  $$ select revision, created_at = now(), updated_at = now() from public.quest_saves
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values (2::bigint, true, true) $$,
  'An update adds 1 to the revision and keeps created_at, whatever is sent'
);

-- quest_saves: schema_version can't go down -----------------------------------
select throws_ok(
  $$ update public.quest_saves set schema_version = 2
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null,
  'A save cannot move to an older schema_version'
);

select lives_ok(
  $$ update public.quest_saves set schema_version = 4
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  'A save can move to a newer schema_version'
);

select throws_ok(
  $$ update public.quest_saves set schema_version = 3
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null,
  'After upgrading, an old tab cannot save the older format'
);

-- quest_saves: input checks ---------------------------------------------------
select throws_ok(
  $$ update public.quest_saves set data = '[1, 2, 3]'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null,
  'Save data must be a JSON object'
);

select throws_ok(
  $$ update public.quest_saves set data = '{"day":3'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '22P02', null,
  'Save data must be valid JSON'
);

select throws_ok(
  $$ update public.quest_saves
     set data = json_build_object('padding', repeat('x', 10485760))
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null,
  'Save data over 10 MB is rejected'
);

-- quest_saves: JSON is stored exactly as sent ---------------------------------
update public.quest_saves set data = '{"zebra":1,"apple":2}'
where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

select results_eq(
  $$ select data::text from public.quest_saves
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values ('{"zebra":1,"apple":2}') $$,
  'Key order in the save is kept (why the column is json, not jsonb)'
);

-- profiles: updated_at ----------------------------------------------------------
insert into public.profiles (user_id, display_name, created_at, updated_at)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'Ada', '2020-01-01', '2020-01-01');

update public.profiles set avatar = 'seedling'
where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

select results_eq(
  $$ select updated_at = now(), created_at = '2020-01-01'::timestamptz from public.profiles
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values (true, true) $$,
  'Updating a profile refreshes updated_at and leaves created_at alone'
);

-- profiles: input checks matching settings-logic.ts ----------------------------
select throws_ok(
  $$ update public.profiles set display_name = '   ' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null, 'A blank display name is rejected');
select throws_ok(
  $$ update public.profiles set display_name = repeat('a', 33) where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null, 'A display name over 32 characters is rejected');
select lives_ok(
  $$ update public.profiles set display_name = repeat('🌱', 32) where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  'A 32-character display name is allowed, counting emoji as one character');
select throws_ok(
  $$ update public.profiles set avatar = 'robot' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null, 'An unknown avatar is rejected');
select throws_ok(
  $$ update public.profiles set reminder_time = '24:00' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null, 'An invalid reminder time is rejected');
select throws_ok(
  $$ update public.profiles set reminder_quest_types = '{daily,weekly}' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '23514', null, 'An unknown reminder quest type is rejected');

-- Daily backups -----------------------------------------------------------------
-- Start from a clean slate for user D.
insert into public.quest_saves (user_id, data, schema_version)
values ('dddddddd-0000-4000-8000-000000000004', '{"v":1}', 3);

select is_empty(
  $$ select 1 from public.save_backups where user_id = 'dddddddd-0000-4000-8000-000000000004' $$,
  'Creating a save makes no backup'
);

update public.quest_saves set data = '{"v":2}'
where user_id = 'dddddddd-0000-4000-8000-000000000004';

select results_eq(
  $$ select reason, raw_data, schema_version, source_revision from public.save_backups
     where user_id = 'dddddddd-0000-4000-8000-000000000004' $$,
  $$ values ('daily'::text, '{"v":1}'::text, 3, 1::bigint) $$,
  'The first change of the day backs up the save it replaced'
);

update public.quest_saves set data = '{"v":3}'
where user_id = 'dddddddd-0000-4000-8000-000000000004';

select results_eq(
  $$ select count(*)::int from public.save_backups where user_id = 'dddddddd-0000-4000-8000-000000000004' $$,
  'values (1)',
  'A second change on the same day makes no new backup'
);

-- Move today's backup to yesterday, then save again.
update public.save_backups set created_at = now() - interval '1 day'
where user_id = 'dddddddd-0000-4000-8000-000000000004';

update public.quest_saves set schema_version = 4
where user_id = 'dddddddd-0000-4000-8000-000000000004';

select results_eq(
  $$ select count(*)::int from public.save_backups where user_id = 'dddddddd-0000-4000-8000-000000000004' $$,
  'values (1)',
  'A save whose data did not change makes no backup'
);

update public.quest_saves set data = '{"v":4}'
where user_id = 'dddddddd-0000-4000-8000-000000000004';

select results_eq(
  $$ select raw_data, schema_version, source_revision from public.save_backups
     where user_id = 'dddddddd-0000-4000-8000-000000000004'
     order by created_at desc limit 1 $$,
  $$ values ('{"v":3}'::text, 4, 4::bigint) $$,
  'The first change on a new day makes a new backup'
);

select results_eq(
  $$ select count(*)::int from public.save_backups
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and reason = 'daily' $$,
  'values (1)',
  'Daily backups for one user never touch another user''s count'
);

-- Backup limits -------------------------------------------------------------------
delete from public.save_backups where user_id = 'dddddddd-0000-4000-8000-000000000004';

insert into public.save_backups (user_id, reason, raw_data, created_at)
select 'dddddddd-0000-4000-8000-000000000004', 'daily', 'day ' || n, now() - n * interval '1 day'
from generate_series(1, 16) as n;

select is_empty(
  $$ select 1 from public.save_backups
     where user_id = 'dddddddd-0000-4000-8000-000000000004'
       and raw_data in ('day 15', 'day 16') $$,
  'The two oldest daily backups are the ones removed'
);

select results_eq(
  $$ select count(*)::int from public.save_backups
     where user_id = 'dddddddd-0000-4000-8000-000000000004' $$,
  'values (14)',
  'Only the newest 14 daily backups are kept'
);

insert into public.save_backups (user_id, reason, raw_data, created_at)
select 'dddddddd-0000-4000-8000-000000000004', 'conflict', 'conflict ' || n, now() - n * interval '1 hour'
from generate_series(1, 25) as n;

select results_eq(
  $$ select count(*)::int from public.save_backups
     where user_id = 'dddddddd-0000-4000-8000-000000000004' and reason = 'conflict' $$,
  'values (20)',
  'Only the newest 20 conflict backups are kept'
);

insert into public.save_backups (user_id, reason, raw_data, created_at)
select 'dddddddd-0000-4000-8000-000000000004', 'browser_import', 'import ' || n, now() - n * interval '1 hour'
from generate_series(1, 7) as n;

select results_eq(
  $$ select count(*)::int from public.save_backups
     where user_id = 'dddddddd-0000-4000-8000-000000000004' and reason = 'browser_import' $$,
  'values (5)',
  'Only the newest 5 browser-import backups are kept'
);

select results_eq(
  $$ select count(*)::int from public.save_backups
     where user_id = 'dddddddd-0000-4000-8000-000000000004' and reason = 'daily' $$,
  'values (14)',
  'Limits apply per reason, so other backups are not removed'
);

-- Pruning also works when a signed-in user adds the backup.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-0000-4000-8000-000000000004","role":"authenticated"}', true);
insert into public.save_backups (user_id, reason, raw_data)
values ('dddddddd-0000-4000-8000-000000000004', 'browser_import', 'import newest');
reset role;

select results_eq(
  $$ select count(*)::int, bool_or(raw_data = 'import newest') from public.save_backups
     where user_id = 'dddddddd-0000-4000-8000-000000000004' and reason = 'browser_import' $$,
  $$ values (5, true) $$,
  'A user''s own new backup is kept and the oldest is removed'
);

-- Deleting an account removes all of its data ------------------------------------
delete from auth.users where id = 'dddddddd-0000-4000-8000-000000000004';

select results_eq(
  $$ select
       (select count(*)::int from public.quest_saves where user_id = 'dddddddd-0000-4000-8000-000000000004'),
       (select count(*)::int from public.save_backups where user_id = 'dddddddd-0000-4000-8000-000000000004') $$,
  $$ values (0, 0) $$,
  'Deleting a user deletes their save and backups'
);

select results_eq(
  $$ select count(*)::int from public.quest_saves where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  'values (1)',
  'Deleting one user leaves other users'' data alone'
);

select * from finish();
rollback;
