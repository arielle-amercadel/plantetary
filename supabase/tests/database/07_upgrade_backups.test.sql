-- Upgrade backups (Stage 7): their own reason, one per user and source
-- revision, their own limit, and no effect on daily history. Also pins the
-- error messages the app uses to tell constraint failures apart.

begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'user-a@plantetary.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'user-b@plantetary.test', 'authenticated', 'authenticated');

-- A full daily history for A: 14 backups, the daily limit, on 14 past days.
insert into public.save_backups (user_id, reason, raw_data, created_at)
select 'aaaaaaaa-0000-4000-8000-000000000001', 'daily', 'day ' || n, now() - n * interval '1 day'
from generate_series(1, 14) as n;

-- Act as user A ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data, schema_version, source_revision)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'upgrade', '{"v":1}', 1, 3) $$,
  'A can add an upgrade backup of their own save'
);

select throws_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data, schema_version, source_revision)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'upgrade', '{"v":1}', 1, 3) $$,
  '23505', null,
  'A second upgrade backup of the same revision is refused'
);

select throws_like(
  $$ insert into public.save_backups (user_id, reason, raw_data, source_revision)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'upgrade', '{"v":1}', 3) $$,
  '%"save_backups_upgrade_once"%',
  'The refusal names save_backups_upgrade_once, which the app relies on'
);

select is(
  (select count(*)::int from public.save_backups where reason = 'upgrade'),
  1,
  'Repeated attempts leave one upgrade backup'
);

select lives_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data, source_revision)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'upgrade', '{"v":2}', 7) $$,
  'A later revision gets its own upgrade backup'
);

select throws_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'upgrade', '{"v":1}') $$,
  '23514', null,
  'An upgrade backup must say which revision it came from'
);

select lives_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'conflict', '{"v":1}') $$,
  'Other reasons still don''t need a source revision'
);

select throws_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data, source_revision)
     values ('bbbbbbbb-0000-4000-8000-000000000002', 'upgrade', '{"planted":"by-a"}', 3) $$,
  '42501', null,
  'A cannot add an upgrade backup to B''s account'
);

select is(
  (select count(*)::int from public.save_backups where reason = 'daily'),
  14,
  'Upgrade backups leave daily history alone'
);

-- Act as user B ---------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);

select lives_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data, source_revision)
     values ('bbbbbbbb-0000-4000-8000-000000000002', 'upgrade', '{"owner":"b"}', 3) $$,
  'Another user can back up their own revision 3: the limit is per user'
);

select results_eq(
  'select raw_data from public.save_backups',
  $$ values ('{"owner":"b"}'::text) $$,
  'B sees only their own upgrade backup'
);

-- Retention, as the database owner ---------------------------------------------
reset role;

-- Six more upgrade backups for A, older than the ones above. (Revisions 3 and 7
-- were added in this transaction, so they share a timestamp and the later id
-- sorts first.)
insert into public.save_backups (user_id, reason, raw_data, source_revision, created_at)
select 'aaaaaaaa-0000-4000-8000-000000000001', 'upgrade', 'old ' || n, 100 + n, now() - n * interval '1 hour'
from generate_series(1, 6) as n;

select is(
  (select count(*)::int from public.save_backups
   where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and reason = 'upgrade'),
  5,
  'The newest 5 upgrade backups are kept'
);

select results_eq(
  $$ select source_revision from public.save_backups
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and reason = 'upgrade'
     order by created_at desc, id desc $$,
  $$ values (7::bigint), (3::bigint), (101::bigint), (102::bigint), (103::bigint) $$,
  'The oldest upgrade backups are the ones removed'
);

select is(
  (select count(*)::int from public.save_backups
   where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and reason = 'daily'),
  14,
  'Pruning upgrade backups never removes daily ones'
);

select is(
  (select count(*)::int from public.save_backups
   where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' and reason = 'upgrade'),
  1,
  'Pruning A''s upgrade backups leaves B''s alone'
);

-- Error messages the app reads -------------------------------------------------
--
-- The app tells a newer-format refusal from an oversized save by these
-- messages (both 23514). If either changes, the app's classification must too.

insert into public.quest_saves (user_id, data, schema_version)
values ('aaaaaaaa-0000-4000-8000-000000000001', '{"v":5}', 5);

select throws_like(
  $$ update public.quest_saves set schema_version = 4
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  'quest_saves.schema_version cannot decrease%',
  'The format guard''s message starts as the app expects'
);

select throws_like(
  $$ update public.quest_saves set data = json_build_object('big', repeat('x', 10485760))
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '%"quest_saves_data_check"%',
  'An oversized save is refused by quest_saves_data_check, by name'
);

select throws_like(
  $$ update public.quest_saves set data = '[1, 2, 3]'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '%"quest_saves_data_check"%',
  'A save that isn''t an object is refused by the same check'
);

select * from finish();
rollback;
