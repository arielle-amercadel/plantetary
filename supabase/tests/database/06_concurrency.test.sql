-- Concurrency: backup limits and save revisions with several sessions at once.
--
-- One test session can't race itself, so these tests open extra database
-- sessions with dblink. Those sessions commit for real, so they use their own
-- test users and delete them at the start and end.
--
-- LOCAL ONLY. These tests run only on the local Supabase stack, recognised
-- by the CLI's public demo JWT secret, and log in with its password
-- ("postgres"). Anywhere else, such as `supabase test db --remote`, they
-- don't attempt a connection and every test is skipped, so nothing is
-- written to a hosted database and no failed logins are recorded.

begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(22);

-- Try to open the setup session, on the local stack only. inet_server_addr() is this server's own
-- address on the Docker network, where logins need a password.
select format(
  'host=%s port=5432 dbname=postgres user=postgres password=postgres connect_timeout=5',
  host(inet_server_addr())
) as conninfo \gset

create function pg_temp.try_connect(conn text, conninfo text) returns boolean
language plpgsql as $$
begin
  -- Only the local CLI stack sets this well-known demo value.
  if current_setting('app.settings.jwt_secret', true) is distinct from
     'super-secret-jwt-token-with-at-least-32-characters-long' then
    return false;
  end if;
  perform extensions.dblink_connect(conn, conninfo);
  return true;
exception when others then
  return false;
end;
$$;

select pg_temp.try_connect('setup', :'conninfo') as can_connect \gset

-- Lets the DO block below read the connection string.
select set_config('plantetary_test.conninfo', :'conninfo', true) is not null as conninfo_set \gset

\if :can_connect

-- Helper: run one statement in a session and wait for it.
create function pg_temp.run(conn text, sql text) returns void
language sql as $$ select extensions.dblink_exec(conn, sql) $$;

-- Helper: start a session's transaction as a signed-in user.
create function pg_temp.begin_as(conn text, user_id uuid) returns void
language sql as $$
  select extensions.dblink_exec(conn, format(
    'begin; set local role authenticated; set local "request.jwt.claims" = %L',
    json_build_object('sub', user_id, 'role', 'authenticated')::text));
$$;

-- Helper: wait for a statement sent with dblink_send_query and return its
-- command tag, such as 'INSERT 0 1' or 'UPDATE 0'.
create function pg_temp.finish_query(conn text) returns text
language plpgsql as $$
declare
  tag text;
  waited integer := 0;
begin
  while extensions.dblink_is_busy(conn) = 1 loop
    perform pg_sleep(0.05);
    waited := waited + 1;
    if waited > 200 then
      raise exception 'session % still busy after 10 seconds', conn;
    end if;
  end loop;
  select r.tag into tag from extensions.dblink_get_result(conn) as r(tag text);
  perform * from extensions.dblink_get_result(conn) as r(tag text);  -- clears the connection
  return tag;
end;
$$;

-- Helper: read one number through the setup session (it sees committed data).
create function pg_temp.committed_count(sql text) returns integer
language sql as $$
  select n from extensions.dblink('setup', sql) as r(n integer);
$$;

select pg_temp.run('setup', $sql$
  delete from auth.users where id in (
    'eeeeeeee-0000-4000-8000-000000000005',
    'ffffffff-0000-4000-8000-000000000006');
  insert into auth.users (id, email, aud, role) values
    ('eeeeeeee-0000-4000-8000-000000000005', 'user-e@plantetary.test', 'authenticated', 'authenticated'),
    ('ffffffff-0000-4000-8000-000000000006', 'user-f@plantetary.test', 'authenticated', 'authenticated');
$sql$);

-- 1. Two backups at once, with the limit already reached ----------------------
-- E already has 20 conflict backups, the limit. Two sessions each add one,
-- with the second starting before the first has committed.
select pg_temp.run('setup', $sql$
  insert into public.save_backups (user_id, reason, raw_data, created_at)
  select 'eeeeeeee-0000-4000-8000-000000000005', 'conflict', 'old ' || n, now() - n * interval '1 hour'
  from generate_series(1, 20) as n;
$sql$);

select extensions.dblink_connect('s1', :'conninfo');
select extensions.dblink_connect('s2', :'conninfo');

select pg_temp.begin_as('s1', 'eeeeeeee-0000-4000-8000-000000000005');
select pg_temp.run('s1', $sql$
  insert into public.save_backups (user_id, reason, raw_data)
  values ('eeeeeeee-0000-4000-8000-000000000005', 'conflict', 'new from s1') $sql$);

select pg_temp.begin_as('s2', 'eeeeeeee-0000-4000-8000-000000000005');
select extensions.dblink_send_query('s2', $sql$
  insert into public.save_backups (user_id, reason, raw_data)
  values ('eeeeeeee-0000-4000-8000-000000000005', 'conflict', 'new from s2') $sql$);

select pg_sleep(0.5);
select is(extensions.dblink_is_busy('s2'), 1,
  'A second backup for the same user and reason waits for the first to finish');

select pg_temp.run('s1', 'commit');
select pg_temp.finish_query('s2');
select pg_temp.run('s2', 'commit');

select is(
  pg_temp.committed_count($sql$
    select count(*)::int from public.save_backups
    where user_id = 'eeeeeeee-0000-4000-8000-000000000005' and reason = 'conflict' $sql$),
  20,
  'Two concurrent conflict backups still leave exactly 20'
);

select is(
  pg_temp.committed_count($sql$
    select count(*)::int from public.save_backups
    where user_id = 'eeeeeeee-0000-4000-8000-000000000005' and raw_data like 'new from %' $sql$),
  2,
  'Both new backups are kept and the two oldest are removed'
);

-- 2. Six backups at once ---------------------------------------------------------
-- E already has 5 browser-import backups, the limit. Six sessions each start a
-- transaction and add one. Each is committed as soon as its insert finishes.
select pg_temp.run('setup', $sql$
  insert into public.save_backups (user_id, reason, raw_data, created_at)
  select 'eeeeeeee-0000-4000-8000-000000000005', 'browser_import', 'old import ' || n, now() - n * interval '1 hour'
  from generate_series(1, 5) as n;
$sql$);

do $$
declare
  sessions text[] := array['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  pending text[] := sessions;
  conn text;
  rounds integer := 0;
begin
  foreach conn in array sessions loop
    perform extensions.dblink_connect(conn, current_setting('plantetary_test.conninfo'));
    perform pg_temp.begin_as(conn, 'eeeeeeee-0000-4000-8000-000000000005');
    perform extensions.dblink_send_query(conn, format(
      'insert into public.save_backups (user_id, reason, raw_data) '
      'values (''eeeeeeee-0000-4000-8000-000000000005'', ''browser_import'', ''parallel %s'')', conn));
  end loop;

  while cardinality(pending) > 0 loop
    foreach conn in array pending loop
      if extensions.dblink_is_busy(conn) = 0 then
        perform pg_temp.finish_query(conn);
        perform pg_temp.run(conn, 'commit');
        perform extensions.dblink_disconnect(conn);
        pending := array_remove(pending, conn);
      end if;
    end loop;
    perform pg_sleep(0.05);
    rounds := rounds + 1;
    if rounds > 400 then
      raise exception 'parallel backup sessions did not finish: %', pending;
    end if;
  end loop;
end;
$$;

select is(
  pg_temp.committed_count($sql$
    select count(*)::int from public.save_backups
    where user_id = 'eeeeeeee-0000-4000-8000-000000000005' and reason = 'browser_import' $sql$),
  5,
  'Six concurrent import backups still leave exactly 5'
);

select is(
  pg_temp.committed_count($sql$
    select count(*)::int from public.save_backups
    where user_id = 'eeeeeeee-0000-4000-8000-000000000005' and raw_data like 'old import %' $sql$),
  0,
  'The 5 kept import backups are the newest ones'
);

-- 3. Delete and recreate at the same time as a stale tab ------------------------
-- F's save reaches revision 3. One session deletes it while another recreates
-- it; the recreate has to wait for the delete to commit.
select pg_temp.run('setup', $sql$
  insert into public.quest_saves (user_id, data, schema_version)
  values ('ffffffff-0000-4000-8000-000000000006', '{"v":1}', 3);
  update public.quest_saves set data = '{"v":2}' where user_id = 'ffffffff-0000-4000-8000-000000000006';
  update public.quest_saves set data = '{"v":3}' where user_id = 'ffffffff-0000-4000-8000-000000000006';
$sql$);

select pg_temp.begin_as('s1', 'ffffffff-0000-4000-8000-000000000006');
select pg_temp.run('s1', $sql$
  delete from public.quest_saves where user_id = 'ffffffff-0000-4000-8000-000000000006' $sql$);

select pg_temp.begin_as('s2', 'ffffffff-0000-4000-8000-000000000006');
select extensions.dblink_send_query('s2', $sql$
  insert into public.quest_saves (user_id, data, schema_version)
  values ('ffffffff-0000-4000-8000-000000000006', '{"recreated":true}', 3) $sql$);

select pg_sleep(0.2);
select pg_temp.run('s1', 'commit');
select pg_temp.finish_query('s2');
select pg_temp.run('s2', 'commit');

select is(
  pg_temp.committed_count($sql$
    select revision::int from public.quest_saves
    where user_id = 'ffffffff-0000-4000-8000-000000000006' $sql$),
  4,
  'A save recreated while the old one was being deleted continues at revision 4'
);

select pg_temp.begin_as('s1', 'ffffffff-0000-4000-8000-000000000006');
select extensions.dblink_send_query('s1', $sql$
  update public.quest_saves set data = '{"stale":true}'
  where user_id = 'ffffffff-0000-4000-8000-000000000006' and revision = 1 $sql$);
select is(pg_temp.finish_query('s1'), 'UPDATE 0',
  'A stale tab holding revision 1 cannot overwrite the recreated save');
select pg_temp.run('s1', 'commit');

-- 4. Two tabs save from the same revision at the same time -----------------------
select pg_temp.begin_as('s1', 'ffffffff-0000-4000-8000-000000000006');
select pg_temp.begin_as('s2', 'ffffffff-0000-4000-8000-000000000006');

select extensions.dblink_send_query('s1', $sql$
  update public.quest_saves set data = '{"from":"tab 1"}'
  where user_id = 'ffffffff-0000-4000-8000-000000000006' and revision = 4 $sql$);
select is(pg_temp.finish_query('s1'), 'UPDATE 1', 'The first tab''s save goes through');

select extensions.dblink_send_query('s2', $sql$
  update public.quest_saves set data = '{"from":"tab 2"}'
  where user_id = 'ffffffff-0000-4000-8000-000000000006' and revision = 4 $sql$);
select pg_sleep(0.2);
select pg_temp.run('s1', 'commit');
select is(pg_temp.finish_query('s2'), 'UPDATE 0',
  'The second tab, which loaded the same revision, is told nothing was saved');
select pg_temp.run('s2', 'commit');

select is(
  pg_temp.committed_count($sql$
    select revision::int from public.quest_saves
    where user_id = 'ffffffff-0000-4000-8000-000000000006'
      and data::text = '{"from":"tab 1"}' $sql$),
  5,
  'The first tab''s save is kept at revision 5'
);

-- 5. An import waits for a normal save, then rejects its stale expected revision.
select pg_temp.begin_as('s1', 'ffffffff-0000-4000-8000-000000000006');
select pg_temp.run('s1', $sql$
 update public.quest_saves set data = '{"from":"normal before import"}'
 where user_id = 'ffffffff-0000-4000-8000-000000000006' and revision = 5 $sql$);
select pg_temp.begin_as('s2', 'ffffffff-0000-4000-8000-000000000006');
select extensions.dblink_send_query('s2', $sql$
 select outcome from public.import_browser_save('ffffffff-0000-4000-8000-000000000006', 5, '{"import":"stale"}', 3) $sql$);
select pg_sleep(0.2);
select is(extensions.dblink_is_busy('s2'), 1, 'Import waits for the normal save row lock');
select pg_temp.run('s1', 'commit');
select is(pg_temp.finish_query('s2'), 'conflict', 'Import rechecks revision after the normal save commits');
select pg_temp.run('s2', 'commit');

-- 6. A normal save waits for an import, then cannot overwrite its new revision.
select pg_temp.begin_as('s1', 'ffffffff-0000-4000-8000-000000000006');
select extensions.dblink_send_query('s1', $sql$
 select outcome from public.import_browser_save('ffffffff-0000-4000-8000-000000000006', 6, '{"from":"import"}', 3) $sql$);
select is(pg_temp.finish_query('s1'), 'imported', 'Import wins the row lock');
select pg_temp.begin_as('s2', 'ffffffff-0000-4000-8000-000000000006');
select extensions.dblink_send_query('s2', $sql$
 update public.quest_saves set data = '{"normal":"stale"}'
 where user_id = 'ffffffff-0000-4000-8000-000000000006' and revision = 6 $sql$);
select pg_sleep(0.2);
select pg_temp.run('s1', 'commit');
select is(pg_temp.finish_query('s2'), 'UPDATE 0', 'Normal save cannot overwrite a committed import');
select pg_temp.run('s2', 'commit');
select is(pg_temp.committed_count($sql$
 select count(*)::int from public.save_backups
 where user_id = 'ffffffff-0000-4000-8000-000000000006' and reason = 'browser_import'
 and source_revision = 6 and raw_data = '{"from":"normal before import"}' $sql$), 1,
 'Import backs up exactly the locked revision, not an earlier snapshot');

-- 7. Two concurrent first imports: the primary key admits exactly one.
select pg_temp.begin_as('s1', 'eeeeeeee-0000-4000-8000-000000000005');
select extensions.dblink_send_query('s1', $sql$
 select outcome from public.import_browser_save('eeeeeeee-0000-4000-8000-000000000005', null, '{"first":"winner"}', 3) $sql$);
select is(pg_temp.finish_query('s1'), 'imported', 'First import creates its garden');
select pg_temp.begin_as('s2', 'eeeeeeee-0000-4000-8000-000000000005');
select extensions.dblink_send_query('s2', $sql$
 select outcome from public.import_browser_save('eeeeeeee-0000-4000-8000-000000000005', null, '{"first":"loser"}', 3) $sql$);
select pg_sleep(0.2);
select is(extensions.dblink_is_busy('s2'), 1, 'Competing first import waits for the uncommitted row');
select pg_temp.run('s1', 'commit');
select is(pg_temp.finish_query('s2'), 'conflict', 'Competing first import never overwrites the winner');
select pg_temp.run('s2', 'commit');
select is(pg_temp.committed_count($sql$
 select count(*)::int from public.quest_saves where user_id = 'eeeeeeee-0000-4000-8000-000000000005'
 and revision = 1 and data::text = '{"first":"winner"}' $sql$), 1, 'Winning first garden is unchanged');

-- 8. Two imports from the same existing revision only back up/replace once.
select pg_temp.begin_as('s1', 'ffffffff-0000-4000-8000-000000000006');
select extensions.dblink_send_query('s1', $sql$
 select outcome from public.import_browser_save('ffffffff-0000-4000-8000-000000000006', 7, '{"import":"second"}', 3) $sql$);
select is(pg_temp.finish_query('s1'), 'imported', 'Replacement import wins');
select pg_temp.begin_as('s2', 'ffffffff-0000-4000-8000-000000000006');
select extensions.dblink_send_query('s2', $sql$
 select outcome from public.import_browser_save('ffffffff-0000-4000-8000-000000000006', 7, '{"import":"loser"}', 3) $sql$);
select pg_sleep(0.2);
select pg_temp.run('s1', 'commit');
select is(pg_temp.finish_query('s2'), 'conflict', 'Concurrent replacement import rejects the old revision');
select pg_temp.run('s2', 'commit');
select is(pg_temp.committed_count($sql$
 select count(*)::int from public.save_backups
 where user_id = 'ffffffff-0000-4000-8000-000000000006' and reason = 'browser_import' $sql$), 2,
 'Only the two successful replacements created import backups');

-- Clean up the committed test data ------------------------------------------------
select pg_temp.run('setup', $sql$
  delete from auth.users where id in (
    'eeeeeeee-0000-4000-8000-000000000005',
    'ffffffff-0000-4000-8000-000000000006');
$sql$);
select extensions.dblink_disconnect('s1');
select extensions.dblink_disconnect('s2');
select extensions.dblink_disconnect('setup');

\else

select skip('Concurrency tests run only on the local Supabase stack', 22);

\endif

select * from finish();
rollback;
