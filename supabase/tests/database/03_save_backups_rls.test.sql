-- save_backups: a signed-in user can reach only their own backups, and no one
-- can change a backup after it is made.

begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'user-a@plantetary.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'user-b@plantetary.test', 'authenticated', 'authenticated');

insert into public.save_backups (user_id, reason, raw_data) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'conflict', '{"owner":"a"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'conflict', '{"owner":"b"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'browser_import', '{"owner":"b","import":true}');

-- Act as user A ------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

select results_eq(
  'select raw_data from public.save_backups',
  $$ values ('{"owner":"a"}'::text) $$,
  'A sees only their own backups'
);

select is_empty(
  $$ select 1 from public.save_backups where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' $$,
  'A cannot read B''s backups'
);

select is_empty(
  $$ delete from public.save_backups
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' returning 1 $$,
  'A cannot delete B''s backups'
);

select throws_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data)
     values ('bbbbbbbb-0000-4000-8000-000000000002', 'conflict', '{"planted":"by-a"}') $$,
  '42501', null,
  'A cannot add a backup to B''s account'
);

select throws_ok(
  $$ update public.save_backups set raw_data = '{"owner":"hacked"}'
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' $$,
  '42501', null,
  'A cannot edit B''s backups'
);

select throws_ok(
  $$ update public.save_backups set raw_data = '{"owner":"a","edited":true}'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501', null,
  'A cannot edit even their own backups'
);

select throws_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data, created_at)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'conflict', '{}', '2020-01-01') $$,
  '42501', null,
  'A cannot backdate a backup'
);

select throws_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'not_a_reason', '{}') $$,
  '23514', null,
  'Backups must use a known reason'
);

select lives_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data, schema_version)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'browser_import', '{"owner":"a","import":true}', 3) $$,
  'A can add a backup to their own account'
);

select results_eq(
  $$ delete from public.save_backups where reason = 'conflict' returning user_id $$,
  $$ values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid) $$,
  'A delete with no user filter removes only A''s own backups'
);

-- Act as user B --------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);

select results_eq(
  'select raw_data from public.save_backups order by id',
  $$ values ('{"owner":"b"}'::text), ('{"owner":"b","import":true}'::text) $$,
  'B sees only their own backups'
);

-- Back to the database owner -------------------------------------------------
reset role;

select results_eq(
  $$ select count(*)::int from public.save_backups
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' $$,
  'values (2)',
  'B''s backups are all still there after A''s attempts'
);

select results_eq(
  $$ select reason from public.save_backups
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values ('browser_import'::text) $$,
  'A has only the backup A kept'
);

select * from finish();
rollback;
