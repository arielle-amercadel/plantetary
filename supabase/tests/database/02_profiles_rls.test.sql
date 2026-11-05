-- profiles: a signed-in user can reach only their own profile.

begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'user-a@plantetary.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'user-b@plantetary.test', 'authenticated', 'authenticated'),
  ('cccccccc-0000-4000-8000-000000000003', 'user-c@plantetary.test', 'authenticated', 'authenticated');

insert into public.profiles (user_id, display_name, avatar) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Ada', 'leaf'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'Bea', 'cactus');

-- Act as user A ------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

select results_eq(
  'select user_id from public.profiles',
  $$ values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid) $$,
  'A sees only their own profile'
);

select is_empty(
  $$ select 1 from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' $$,
  'A cannot read B''s profile'
);

select is_empty(
  $$ update public.profiles set display_name = 'Hacked'
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' returning 1 $$,
  'A cannot update B''s profile'
);

-- No WHERE clause: RLS must still limit this to A's own row.
select results_eq(
  $$ update public.profiles set reminders_enabled = true returning user_id $$,
  $$ values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid) $$,
  'An update with no filter changes only A''s own profile'
);

select is_empty(
  $$ delete from public.profiles
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' returning 1 $$,
  'A cannot delete B''s profile'
);

select throws_ok(
  $$ insert into public.profiles (user_id, display_name)
     values ('cccccccc-0000-4000-8000-000000000003', 'Not C') $$,
  '42501', null,
  'A cannot create a profile for another user'
);

select throws_ok(
  $$ update public.profiles set user_id = 'cccccccc-0000-4000-8000-000000000003'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501', null,
  'A cannot reassign their profile to another user'
);

select throws_ok(
  $$ update public.profiles set updated_at = '2020-01-01'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501', null,
  'A cannot set updated_at directly'
);

select lives_ok(
  $$ update public.profiles set display_name = 'Ada L', avatar = 'flower'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  'A can update their own profile'
);

-- Act as user C, who has no profile yet ---------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}', true);

select lives_ok(
  $$ insert into public.profiles (user_id, display_name)
     values ('cccccccc-0000-4000-8000-000000000003', 'Cleo') $$,
  'C can create their own profile'
);

select results_eq(
  'select user_id from public.profiles',
  $$ values ('cccccccc-0000-4000-8000-000000000003'::uuid) $$,
  'C sees only their own profile'
);

-- Back to the database owner -------------------------------------------------
reset role;

select results_eq(
  $$ select display_name, avatar, reminders_enabled from public.profiles
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' $$,
  $$ values ('Bea'::text, 'cactus'::text, false) $$,
  'B''s profile is unchanged after A''s attempts'
);

select results_eq(
  $$ select display_name, avatar, reminders_enabled from public.profiles
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values ('Ada L'::text, 'flower'::text, true) $$,
  'A''s profile has A''s own changes'
);

select results_eq(
  'select count(*)::int from public.profiles',
  'values (3)',
  'All three profiles still exist'
);

select * from finish();
rollback;
