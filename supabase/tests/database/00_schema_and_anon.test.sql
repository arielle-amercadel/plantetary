-- Schema-level safety checks, and proof that logged-out visitors can do nothing.

begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- Row Level Security is on for every table --------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.quest_saves'::regclass),
  'RLS is enabled on quest_saves'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'RLS is enabled on profiles'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.save_backups'::regclass),
  'RLS is enabled on save_backups'
);

-- Every policy applies to signed-in users only ------------------------------
select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public'
       and tablename in ('quest_saves', 'profiles', 'save_backups')
       and roles <> '{authenticated}' $$,
  'Every policy is limited to the authenticated role'
);

select policies_are('public', 'quest_saves', array[
  'Users can read their own save',
  'Users can create their own save',
  'Users can update their own save',
  'Users can delete their own save'
], 'quest_saves has exactly the four expected policies');

select policies_are('public', 'profiles', array[
  'Users can read their own profile',
  'Users can create their own profile',
  'Users can update their own profile',
  'Users can delete their own profile'
], 'profiles has exactly the four expected policies');

select policies_are('public', 'save_backups', array[
  'Users can read their own backups',
  'Users can create their own backups',
  'Users can delete their own backups'
], 'save_backups has no update policy');

-- Table privileges ------------------------------------------------------------
select table_privs_are('public', 'quest_saves', 'anon', array[]::text[],
  'anon has no table privileges on quest_saves');
select table_privs_are('public', 'profiles', 'anon', array[]::text[],
  'anon has no table privileges on profiles');
select table_privs_are('public', 'save_backups', 'anon', array[]::text[],
  'anon has no table privileges on save_backups');

select table_privs_are('public', 'quest_saves', 'authenticated', array['SELECT', 'DELETE'],
  'authenticated has only SELECT and DELETE on all of quest_saves (writes are per column)');
select table_privs_are('public', 'profiles', 'authenticated', array['SELECT', 'DELETE'],
  'authenticated has only SELECT and DELETE on all of profiles (writes are per column)');
select table_privs_are('public', 'save_backups', 'authenticated', array['SELECT', 'DELETE'],
  'authenticated has only SELECT and DELETE on all of save_backups (inserts are per column)');

-- The private schema can't be used from the API --------------------------------
select ok(
  not has_schema_privilege('anon', 'private', 'USAGE')
    and not has_schema_privilege('authenticated', 'private', 'USAGE'),
  'anon and authenticated cannot use the private schema'
);

-- Logged-out visitors ---------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'user-a@plantetary.test', 'authenticated', 'authenticated');
insert into public.quest_saves (user_id, data, schema_version)
  values ('aaaaaaaa-0000-4000-8000-000000000001', '{"owner":"a"}', 3);
insert into public.profiles (user_id, display_name)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'Ada');
insert into public.save_backups (user_id, reason, raw_data)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'conflict', '{"owner":"a"}');

set local role anon;
-- Even a forged token naming user A must not help a logged-out visitor.
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"anon"}', true);

select throws_ok('select * from public.quest_saves', '42501', null,
  'anon cannot read quest_saves');
select throws_ok(
  $$ insert into public.quest_saves (user_id, data, schema_version)
     values ('aaaaaaaa-0000-4000-8000-000000000001', '{}', 3) $$,
  '42501', null, 'anon cannot write quest_saves');
select throws_ok(
  $$ delete from public.quest_saves $$,
  '42501', null, 'anon cannot delete quest_saves');

select throws_ok('select * from public.profiles', '42501', null,
  'anon cannot read profiles');
select throws_ok(
  $$ update public.profiles set display_name = 'Anon' $$,
  '42501', null, 'anon cannot update profiles');

select throws_ok('select * from public.save_backups', '42501', null,
  'anon cannot read save_backups');
select throws_ok(
  $$ insert into public.save_backups (user_id, reason, raw_data)
     values ('aaaaaaaa-0000-4000-8000-000000000001', 'conflict', '{}') $$,
  '42501', null, 'anon cannot write save_backups');

-- Signed-in users can't call the trigger functions ----------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok('select private.set_updated_at()', '42501', null,
  'authenticated cannot call private functions');

-- Nothing changed ---------------------------------------------------------------
reset role;

select results_eq('select data::text from public.quest_saves', $$ values ('{"owner":"a"}') $$,
  'The save is unchanged');
select results_eq('select display_name from public.profiles', $$ values ('Ada'::text) $$,
  'The profile is unchanged');
select results_eq('select count(*)::int from public.save_backups', 'values (1)',
  'The backups are unchanged');

select * from finish();
rollback;
