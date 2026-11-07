begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(not p.prosecdef, 'Import is SECURITY INVOKER, without an RLS bypass')
from pg_proc p where p.oid = 'public.import_browser_save(uuid,bigint,json,integer)'::regprocedure;
select is((select proconfig[1] from pg_proc where oid =
  'public.import_browser_save(uuid,bigint,json,integer)'::regprocedure), 'search_path=""', 'Empty search_path');
select ok(has_function_privilege('authenticated', 'public.import_browser_save(uuid,bigint,json,integer)', 'execute'), 'Authenticated can call');
select ok(not has_function_privilege('anon', 'public.import_browser_save(uuid,bigint,json,integer)', 'execute'), 'Anon cannot call');
select ok(not has_function_privilege('service_role', 'public.import_browser_save(uuid,bigint,json,integer)', 'execute'), 'No unnecessary service-role execution grant');

insert into auth.users (id, email, aud, role) values
 ('aaaaaaaa-0000-4000-8000-000000000001', 'import-a@plantetary.test', 'authenticated', 'authenticated'),
 ('bbbbbbbb-0000-4000-8000-000000000002', 'import-b@plantetary.test', 'authenticated', 'authenticated');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', null, '{ "garden": "cloud", "key": 1 }', 5) $$,
 $$ values ('imported'::text, 1::bigint) $$, 'Empty-account import creates revision 1');
select is((select count(*)::int from public.save_backups), 0, 'First import needs no replaced-garden backup');
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', null, '{"race":"loser"}', 5) $$,
 $$ values ('conflict'::text, null::bigint) $$, 'Insert-only import never overwrites an existing save');
reset role;
select is((select last_revision from private.quest_save_revisions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
 1::bigint, 'Conflicting first import rolls back its counter side effect');
set local role authenticated;
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 1, '{"garden":"guest"}', 5) $$,
 $$ values ('imported'::text, 2::bigint) $$, 'Replacement imports atomically');
select results_eq(
 $$ select raw_data, schema_version, source_revision from public.save_backups where reason = 'browser_import' $$,
 $$ values ('{ "garden": "cloud", "key": 1 }'::text, 5, 1::bigint) $$,
 'Backup preserves exact stored text, order, whitespace and metadata');
select is((select data::text from public.quest_saves), '{"garden":"guest"}', 'Cloud now holds the imported garden');
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 1, '{"race":"stale"}', 5) $$,
 $$ values ('conflict'::text, null::bigint) $$, 'Stale revision returns conflict');
select is((select count(*)::int from public.save_backups where reason = 'browser_import'), 1, 'Stale imports create no backup');

-- Importing the garden the cloud already holds writes nothing (formatting and key order don't matter),
-- so repeated imports can't push the original pre-import backup out of retention.
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 2, '{ "garden" : "guest" }', 5) $$,
 $$ values ('unchanged'::text, 2::bigint) $$, 'An identical garden is left unchanged');
select is((select count(*)::int from public.save_backups where reason = 'browser_import'), 1, 'An unchanged import adds no backup');
select is((select revision from public.quest_saves), 2::bigint, 'An unchanged import keeps the revision');
select is((select data::text from public.quest_saves), '{"garden":"guest"}', 'An unchanged import keeps the stored text');
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 1, '{"garden":"guest"}', 5) $$,
 $$ values ('conflict'::text, null::bigint) $$, 'An identical garden at a stale revision is still a conflict');

select throws_ok(
 $$ select * from public.import_browser_save('bbbbbbbb-0000-4000-8000-000000000002', null, '{}', 5) $$,
 '42501', null, 'A cannot import as B, including into B empty account');
select throws_ok(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 0, '{}', 5) $$,
 '22023', null, 'Invalid expected revisions are refused');
select throws_ok(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 2, '[]', 5) $$,
 '23514', null, 'Non-object saves are refused');
select throws_ok(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 2, json_build_object('big', repeat('x', 10485760)), 5) $$,
 '23514', null, 'Oversized saves are refused before any replacement');

-- Fail AFTER the import backup was made: the format guard aborts the entire RPC statement.
select throws_ok(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 2, '{"bad":"downgrade"}', 4) $$,
 '23514', null, 'A failed replacement rolls back the transaction');
select is((select count(*)::int from public.save_backups where reason = 'browser_import'), 1, 'Failed replacement rolled back its new backup');
select is((select revision from public.quest_saves), 2::bigint, 'Failed replacement did not advance revision');
select is((select data::text from public.quest_saves), '{"garden":"guest"}', 'Failed replacement preserved cloud garden');

-- A genuine backup insertion failure must stop before replacement.
reset role;
create function pg_temp.refuse_import_backup() returns trigger language plpgsql as $$
begin raise exception 'Injected backup failure'; end; $$;
create trigger test_refuse_import_backup before insert on public.save_backups
for each row when (new.reason = 'browser_import') execute function pg_temp.refuse_import_backup();
set local role authenticated;
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 2, '{"bad":"backup failed"}', 5) $$,
 $$ values ('backup_failed'::text, null::bigint) $$, 'Backup failure is a typed outcome');
select is((select revision from public.quest_saves), 2::bigint, 'Backup failure never writes garden');
reset role;
drop trigger test_refuse_import_backup on public.save_backups;

-- Fill retention, then verify a successful import only prunes its own reason.
insert into public.save_backups (user_id, reason, raw_data, created_at)
select 'aaaaaaaa-0000-4000-8000-000000000001', 'browser_import', 'old ' || n, now() - n * interval '1 hour'
from generate_series(1, 6) n;
insert into public.save_backups (user_id, reason, raw_data)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'conflict', 'keep conflict'),
 ('bbbbbbbb-0000-4000-8000-000000000002', 'browser_import', 'keep B');
set local role authenticated;
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 2, '{"garden":"import 2"}', 5) $$,
 $$ values ('imported'::text, 3::bigint) $$, 'Import works with a full retention window');
select is((select count(*)::int from public.save_backups where reason = 'browser_import'), 5, 'Still only five browser-import backups');
select ok(exists(select 1 from public.save_backups where reason = 'browser_import' and raw_data = '{"garden":"guest"}' and source_revision = 2), 'The replaced revision is retained');
select ok(exists(select 1 from public.save_backups where reason = 'conflict' and raw_data = 'keep conflict'), 'Other backup reasons remain');

-- Another failed update must restore the oldest backup that its insertion would have evicted.
reset role;
create temporary table backups_before as select * from public.save_backups;
set local role authenticated;
select throws_ok(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 3, '{"bad":"downgrade"}', 4) $$,
 '23514', null, 'Failure after retention pruning aborts');
reset role;
select results_eq('select id from public.save_backups order by id', 'select id from backups_before order by id', 'Retention deletions rolled back along with failed replacement');
select is((select count(*)::int from public.save_backups where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 1, 'B backups were never touched');

-- A sufficiently old transaction timestamp could cause the inserted backup itself to be pruned.
delete from public.save_backups where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and reason = 'browser_import';
insert into public.save_backups (user_id, reason, raw_data, created_at)
select 'aaaaaaaa-0000-4000-8000-000000000001', 'browser_import', 'future ' || n, now() + n * interval '1 hour'
from generate_series(1, 5) n;
set local role authenticated;
select results_eq(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 3, '{}', 5) $$,
 $$ values ('backup_failed'::text, null::bigint) $$, 'Self-pruned backup never permits replacement');
select is((select revision from public.quest_saves), 3::bigint, 'Self-pruned backup leaves cloud unchanged');
select is((select count(*)::int from public.save_backups where reason = 'browser_import'), 5, 'Self-pruning failure preserves existing backups');

select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', 3, '{}', 5) $$,
 '42501', null, 'B cannot replace A garden');
select is((select count(*)::int from public.quest_saves), 0, 'RLS hides A garden from B');
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
 $$ select * from public.import_browser_save('aaaaaaaa-0000-4000-8000-000000000001', null, '{}', 5) $$,
 '42501', null, 'Even an authenticated role without a user cannot import');
select * from finish();
rollback;
