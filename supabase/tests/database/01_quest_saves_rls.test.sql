-- quest_saves: a signed-in user can reach only their own save.
-- Everything runs in a transaction that is rolled back, so no data is kept.

begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- Test users: A and B each have a save; C has none yet.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'user-a@plantetary.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'user-b@plantetary.test', 'authenticated', 'authenticated'),
  ('cccccccc-0000-4000-8000-000000000003', 'user-c@plantetary.test', 'authenticated', 'authenticated');

insert into public.quest_saves (user_id, data, schema_version) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '{"owner":"a"}', 3),
  ('bbbbbbbb-0000-4000-8000-000000000002', '{"owner":"b"}', 3);

-- Act as user A ------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

select results_eq(
  'select user_id from public.quest_saves',
  $$ values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid) $$,
  'A sees only their own save'
);

select is_empty(
  $$ select 1 from public.quest_saves where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' $$,
  'A cannot read B''s save, even by asking for it directly'
);

select is_empty(
  $$ update public.quest_saves set data = '{"owner":"hacked"}'
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' returning 1 $$,
  'A cannot update B''s save'
);

select throws_ok(
  $$ delete from public.quest_saves
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' $$,
  '42501', null,
  'A cannot delete B''s save'
);

select throws_ok(
  $$ delete from public.quest_saves
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501', null,
  'A cannot delete even their own save (only deleting the account removes it)'
);

select throws_ok(
  $$ insert into public.quest_saves (user_id, data, schema_version)
     values ('cccccccc-0000-4000-8000-000000000003', '{"owner":"a-pretending-to-be-c"}', 3) $$,
  '42501', null,
  'A cannot create a save for another user'
);

select throws_ok(
  $$ update public.quest_saves set user_id = 'bbbbbbbb-0000-4000-8000-000000000002'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501', null,
  'A cannot reassign their save to another user'
);

select throws_ok(
  $$ update public.quest_saves set user_id = 'cccccccc-0000-4000-8000-000000000003'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501', null,
  'A cannot reassign their save to a user with no save'
);

select throws_ok(
  $$ update public.quest_saves set revision = 999
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501', null,
  'A cannot set the revision directly'
);

select throws_ok(
  $$ update public.quest_saves set created_at = '2020-01-01'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  '42501', null,
  'A cannot set created_at directly'
);

select results_eq(
  $$ update public.quest_saves set data = '{"owner":"a","xp":10}'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and revision = 1
     returning revision $$,
  $$ values (2::bigint) $$,
  'A can update their own save, and the revision goes up'
);

select is_empty(
  $$ update public.quest_saves set data = '{"owner":"a","stale":true}'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and revision = 1
     returning 1 $$,
  'A save based on an old revision changes nothing (conflict detection)'
);

-- Act as user B --------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);

select results_eq(
  'select user_id from public.quest_saves',
  $$ values ('bbbbbbbb-0000-4000-8000-000000000002'::uuid) $$,
  'B sees only their own save'
);

select is_empty(
  $$ update public.quest_saves set data = '{"owner":"hacked-by-b"}'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' returning 1 $$,
  'B cannot update A''s save'
);

-- Act as user C, who has no save yet -----------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}', true);

select is_empty('select 1 from public.quest_saves', 'C sees no saves before creating one');

select lives_ok(
  $$ insert into public.quest_saves (user_id, data, schema_version)
     values ('cccccccc-0000-4000-8000-000000000003', '{"owner":"c"}', 3) $$,
  'C can create their own save'
);

-- Signed in, but with no user ID in the token --------------------------------
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);

select is_empty('select 1 from public.quest_saves', 'A token with no user ID sees no saves');

-- Back to the database owner to check nothing leaked -------------------------
reset role;

select results_eq(
  $$ select data::text from public.quest_saves where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' $$,
  $$ values ('{"owner":"b"}') $$,
  'B''s save is unchanged after A''s attempts'
);

select results_eq(
  $$ select data::text from public.quest_saves where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values ('{"owner":"a","xp":10}') $$,
  'A''s save has A''s own change only'
);

select results_eq(
  'select count(*)::int from public.quest_saves',
  'values (3)',
  'All three saves still exist'
);

select * from finish();
rollback;
