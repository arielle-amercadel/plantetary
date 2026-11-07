-- Regression: deleting and recreating a save must never reuse a revision, so a
-- stale tab can't overwrite the new save. Players can't delete saves, but the
-- owner can (a reset by hand, or a future checked reset), so it still matters.

begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'user-a@plantetary.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'user-b@plantetary.test', 'authenticated', 'authenticated'),
  ('cccccccc-0000-4000-8000-000000000003', 'user-c@plantetary.test', 'authenticated', 'authenticated');

-- Act as user A, as the app will -------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- A stale tab loads the save at revision 1 and is then left open.
insert into public.quest_saves (user_id, data, schema_version)
values ('aaaaaaaa-0000-4000-8000-000000000001', '{"save":"original"}', 3);

update public.quest_saves set data = '{"save":"original","xp":5}'
where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';  -- revision 2

-- The save is deleted (by the owner: players can't), then A starts again.
reset role;
select results_eq(
  $$ delete from public.quest_saves
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' returning revision $$,
  $$ values (2::bigint) $$,
  'A''s save is deleted at revision 2'
);
set local role authenticated;

select results_eq(
  $$ insert into public.quest_saves (user_id, data, schema_version)
     values ('aaaaaaaa-0000-4000-8000-000000000001', '{"save":"recreated"}', 3)
     returning revision $$,
  $$ values (3::bigint) $$,
  'The recreated save continues at revision 3, not 1'
);

select is_empty(
  $$ update public.quest_saves set data = '{"save":"stale tab overwrite"}'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and revision = 1
     returning 1 $$,
  'A stale tab saving with revision 1 changes nothing'
);

select is_empty(
  $$ update public.quest_saves set data = '{"save":"stale tab overwrite"}'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and revision = 2
     returning 1 $$,
  'A stale tab saving with the deleted save''s last revision changes nothing'
);

select results_eq(
  $$ select data::text, revision from public.quest_saves
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' $$,
  $$ values ('{"save":"recreated"}', 3::bigint) $$,
  'The recreated save is intact'
);

select results_eq(
  $$ update public.quest_saves set data = '{"save":"recreated","xp":10}'
     where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and revision = 3
     returning revision $$,
  $$ values (4::bigint) $$,
  'A tab holding the current revision can still save, and updates still add 1'
);

-- Several delete-and-recreate rounds never go backwards (deletes by the owner,
-- saves by A).
reset role;
delete from public.quest_saves where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
set local role authenticated;
insert into public.quest_saves (user_id, data, schema_version)
values ('aaaaaaaa-0000-4000-8000-000000000001', '{"round":2}', 3);
reset role;
delete from public.quest_saves where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
set local role authenticated;

select results_eq(
  $$ insert into public.quest_saves (user_id, data, schema_version)
     values ('aaaaaaaa-0000-4000-8000-000000000001', '{"round":3}', 3)
     returning revision $$,
  $$ values (6::bigint) $$,
  'Repeated delete and recreate keeps counting up'
);

-- The new private tables can't be reached by users -------------------------------
select throws_ok(
  'select * from private.quest_save_revisions',
  '42501', null,
  'Signed-in users cannot read the revision counters'
);

select throws_ok(
  $$ update private.quest_save_revisions set last_revision = 0 $$,
  '42501', null,
  'Signed-in users cannot reset the revision counters'
);

select throws_ok(
  'select * from private.save_backup_retention_locks',
  '42501', null,
  'Signed-in users cannot read or hold the backup locks directly'
);

-- A rejected write leaves another user's counter alone ----------------------------
select throws_ok(
  $$ insert into public.quest_saves (user_id, data, schema_version)
     values ('cccccccc-0000-4000-8000-000000000003', '{}', 3) $$,
  '42501', null,
  'A still cannot create a save for another user'
);

-- Other users have their own counters ----------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);

select results_eq(
  $$ insert into public.quest_saves (user_id, data, schema_version)
     values ('bbbbbbbb-0000-4000-8000-000000000002', '{"owner":"b"}', 3)
     returning revision $$,
  $$ values (1::bigint) $$,
  'A new user''s first save starts at revision 1'
);

reset role;

select is_empty(
  $$ select 1 from private.quest_save_revisions
     where user_id = 'cccccccc-0000-4000-8000-000000000003' $$,
  'The rejected write for C left no counter for C'
);

-- A save with no counter row (for example, made before this fix) still moves up.
delete from private.quest_save_revisions where user_id = 'bbbbbbbb-0000-4000-8000-000000000002';
alter table public.quest_saves disable trigger quest_saves_before_write;
update public.quest_saves set revision = 7 where user_id = 'bbbbbbbb-0000-4000-8000-000000000002';
alter table public.quest_saves enable trigger quest_saves_before_write;

select results_eq(
  $$ update public.quest_saves set data = '{"owner":"b","xp":1}'
     where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'
     returning revision $$,
  $$ values (8::bigint) $$,
  'A save without a counter continues from its own revision'
);

select * from finish();
rollback;
