# Supabase database

Plantetary's database tables, access rules and tests (built in Stage 4, extended in Stages 7–8). Since Stage 7, a verified sign-in saves its garden in `quest_saves`, with `conflict` and `upgrade` copies in `save_backups` (see [game-storage.md](game-storage.md)). Stage 8 adds a transactional import RPC, used by the app's import screens, which backs up the existing cloud garden as `browser_import`. Since the post-launch hardening, players can't delete their save or backups (see **Who can do what**). `profiles` isn't used by the app yet. Guests never touch the database.

## What's in this folder

| Path | What it is |
| --- | --- |
| `supabase/config.toml` | Supabase CLI settings for the local test database |
| `supabase/migrations/20261105220000_create_private_helpers.sql` | A `private` schema and the shared `updated_at` trigger function |
| `supabase/migrations/20261105220100_create_profiles.sql` | `profiles` table, its triggers and access rules |
| `supabase/migrations/20261105220200_create_quest_saves.sql` | `quest_saves` table, its triggers and access rules |
| `supabase/migrations/20261105220300_create_save_backups.sql` | `save_backups` table, backup limits, the daily backup trigger and access rules |
| `supabase/migrations/20261105223950_fix_revision_reuse_and_backup_retention.sql` | Review fixes: revisions never repeat, and backup limits hold under concurrent inserts |
| `supabase/migrations/20261106090000_add_upgrade_backups.sql` | Stage 7: the `upgrade` backup reason, one per user and source revision, with its own limit |
| `supabase/migrations/20261107090000_add_browser_import_rpc.sql` | Stage 8: transactional, account-bound, revision-checked import RPC; reuses existing tables and `browser_import` backups |
| `supabase/migrations/20261108090000_remove_player_delete_permissions.sql` | Post-launch hardening: players can no longer delete their save or backups |
| `supabase/tests/database/*.test.sql` | 198 pgTAP tests across 9 files |

Migrations run in filename order. Never edit one after it has been applied to your hosted project; add a new migration instead.

## The tables

All three tables belong to a user through `user_id`, which points at Supabase's `auth.users`. Deleting an account deletes that user's rows.

| Table | Rows | Holds |
| --- | --- | --- |
| `quest_saves` | One per user | The whole game save as JSON (`StoredQuestData`), plus `schema_version` and `revision` |
| `profiles` | One per user | Display name, avatar and reminder preferences |
| `save_backups` | Many per user | Read-only copies of saves, with a reason: `browser_import`, `conflict`, `daily` or `upgrade` |

## Who can do what

Row Level Security (RLS) is on for all three public application tables. The database checks every request.

| | Logged-out visitor | Signed-in user, own rows | Signed-in user, someone else's rows |
| --- | --- | --- | --- |
| `quest_saves` | Nothing | Read, create, update (never delete) | Nothing |
| `profiles` | Nothing | Read, create, update, delete | Nothing |
| `save_backups` | Nothing | Read, create (never edit or delete) | Nothing |

Signed-in users can only write the columns they're meant to. `user_id`, `revision`, `created_at` and `updated_at` are set by the database.

**Nothing in the app deletes a save or a backup**, so players have no permission to (`20261108090000_remove_player_delete_permissions.sql`). Someone holding a stolen session therefore can't wipe a player's save and the backups that would restore it. Rows are still removed in two ways, neither of which uses the player's permissions:

- **Deleting an account** (**Authentication → Users**) deletes its save, backups and profile (the foreign keys cascade). For a player's request, follow [account-deletion.md](account-deletion.md).
- **Backup limits** remove the oldest backups beyond each reason's limit (the trigger runs as its owner).

The import RPC runs with the player's own permissions, so it relies on players being able to read and add their own backups: it checks that its backup was kept before replacing the save. Those permissions stay. `profiles` keeps its delete permission until the app uses the table. A cloud reset from the app (Stage 10) will need its own checked function.

RLS doesn't stop people from editing their own data, including XP. That's fine for a single-player game, but needs rethinking before any leaderboard.

## What the triggers do

| Trigger | Table | Effect |
| --- | --- | --- |
| Revision and timestamps | `quest_saves` | Revision goes up by 1 on every save and never repeats for a user, even if the save is deleted and created again. A user's first save is revision 1. `created_at` never changes, and `updated_at` is set on every update. |
| Format guard | `quest_saves` | `schema_version` can't go down, so an old open tab can't overwrite a save made by a newer version of the app. |
| `updated_at` | `profiles` | Set on every update. |
| Daily backup | `quest_saves` | When a save's content changes, the copy being replaced is backed up, at most once per user per UTC day. |
| Backup limits | `save_backups` | Keeps the newest 14 `daily`, 20 `conflict`, 5 `browser_import` and 5 `upgrade` backups per user, and removes older ones. Each reason is limited on its own, so one never removes another's. Backups added at the same time for one user and reason take turns, so the limits hold. |

The UTC day only spaces out backups. Game days still come from the player's own device, as before.

To save without overwriting another device's change, the app will send `where revision = <the revision it loaded>`. If no row changes, another device saved first, or the save was deleted and recreated, which is a conflict. That's Stage 7's job; the tests here prove the database supports it.

**Upgrade backups (Stage 7).** When the app loads a cloud save in an older format, it keeps the original as an `upgrade` backup before saving the upgraded version. There's at most one per user and source revision (the unique index `save_backups_upgrade_once`), so loading the same old save again never adds another, and they must name their source revision. They have their own limit, so they never use up or remove daily history.

The app tells some errors apart by name, so these are pinned by `07_upgrade_backups.test.sql`: the format guard's message (`quest_saves.schema_version cannot decrease…`), the save check `quest_saves_data_check` (over 10 MB, or not an object), and the index `save_backups_upgrade_once`. If you rename any of them, update `src/app/cloud-game-storage.ts` too.

Two small private tables support this, and users can't reach either:

- `private.quest_save_revisions` remembers each user's highest revision, so it survives the save being deleted.
- `private.save_backup_retention_locks` has one row per user and backup reason, which is locked while backups are pruned.

Under the default `READ COMMITTED` isolation, a second write simply waits its turn. Under `REPEATABLE READ` or `SERIALIZABLE`, it fails with a serialization error (`40001`) and must be retried.

## Changes from the Stage 3 design

The core design is unchanged: one JSON record per user, stored as `json` rather than `jsonb` to keep key order, with the same tables, columns, 10 MB limits and policy shape. These are the adjustments:

| Change | Why |
| --- | --- |
| The database sets `revision`, `created_at` and `updated_at`; users can't write them | Stage 3 said the revision goes up on every save but not who does it. If the app set it, a bug or an edited request could break conflict detection. |
| `schema_version` can't go down, and must be 1 or more | Stage 3 planned for the app to refuse to save over a newer format. The database now enforces it too, in case an old tab skips that check. |
| `save_backups` gains optional `schema_version` and `source_revision` | A restore needs to know which format a backup uses, and a conflict backup should record which revision it came from. |
| Limits for `conflict` (20) and `browser_import` (5) backups | Stage 3 only limited daily backups. Each backup can be up to 10 MB, so a bug that keeps saving conflict copies could grow without limit. After 5 imports, the oldest import backup is removed. |
| Users can't set a backup's `created_at` | Otherwise a backup could be backdated, which would affect which ones the limits remove. |
| `profiles` gains `created_at`, and blank names are rejected | Matches the other tables, and the app already rejects blank names. |
| Revisions never repeat for a user, even after delete and recreate (review fix) | Restarting at 1 let a stale tab that loaded revision 1 overwrite the recreated save without a conflict. |
| Backups for one user and reason are pruned one at a time (review fix) | Pruning only saw committed backups, so two added at the same time could both be kept and exceed the limit. |
| Every grant is written out | A hosted project may expose new tables to logged-out visitors automatically. Explicit grants give the same result either way. |
| Trigger functions live in a `private` schema | The browser can't reach them through the Data API. |
| No automatic profile on sign-up | A profile created at sign-up with the default name "Mira" could compete with the browser profile the user imports in Stage 8. The app will create it instead. |

## Transactional import (Stage 8 Step 2)

`public.import_browser_save(uuid, bigint, json, integer)` is a `SECURITY INVOKER` RPC. Execution is
revoked from `PUBLIC`, `anon`, and `service_role`, then granted only to `authenticated`. Its empty
`search_path` and qualified relation names avoid caller-controlled relation resolution. The passed
account must equal `auth.uid()`; RLS and existing column grants still apply to every table operation.
No new table permissions or privileged helper functions are introduced.

An existing save is locked and checked against the expected revision before any backup is made.
The existing JSON text and metadata are backed up as `browser_import`, and replacement commits in
the same transaction. Failure rolls back backup insertion and pruning as well as the save/revision.
A backup that would itself be pruned fails safely. Importing exactly the garden the cloud already holds returns `unchanged` and writes nothing, so repeated imports never churn the five-backup window. Empty-account imports use the primary key rather
than an upsert. The existing daily backup trigger and per-reason retention limits are preserved.

`08_browser_import.test.sql` covers grants, RLS, exact backups, failure rollback and retention.
`06_concurrency.test.sql` additionally races imports with normal saves, two first imports, and two
replacement imports. Its hosted-execution guard remains in place. See [game-storage.md](game-storage.md)
for client verification after lost responses and the contract for later controller work.

This migration is applied to the hosted project (see **Hosted project status** below). Existing
migrations must not be edited or reapplied manually.

## Hosted project status

Plantetary is live at https://plantetary.vercel.app, using the hosted Supabase project **plantetary** (Postgres 17, matching `major_version` in `supabase/config.toml`).

### Production metadata verification — November 8, 2026

Read-only production metadata verification was completed on November 8, 2026
(U.S. Central time) for **plantetary** (`egtqukzfpuegqzsheehv`). The recorded
results were:

- All eight expected migrations are recorded as applied, including `20261108090000_remove_player_delete_permissions.sql`.
- Effective table and column permissions match the repository configuration.
- RLS is enabled on all three public application tables, and all nine policies contain the expected `auth.uid()` ownership checks.
- The two private tables have RLS disabled; private-schema restrictions and denied application-role grants protect them. Neither `anon` nor `authenticated` has private-schema USAGE/CREATE, superuser or BYPASSRLS privileges.
- All five expected functions have the intended security settings, ownership, search paths and execution permissions.
- All five account-related foreign keys are validated and configured with `ON DELETE CASCADE`.
- All four expected application triggers are present, enabled and connected to the expected helpers.

**Limits:** these were metadata inspections, not penetration tests or behavioral
isolation tests. No production accounts were created or deleted. Function
bodies were not independently reviewed. Trigger `WHEN` expressions remain
unverified: the original inspection query failed, and the corrected query
omitted them. Provider retention and external deletion behavior were not verified.

### Historical production observations

- **Checked from outside, as an anonymous visitor (read-only):** requests for `quest_saves`, `save_backups` and `profiles` with only the publishable key are refused (HTTP 401, permission denied); the `private` schema isn't exposed; only email sign-in is enabled, with email confirmation on.
- **Real players' data lives here now.** Apply any new migration with **Applying a new migration to the hosted project** below, backup first, and test by hand only with your own test addresses.

### Separate staging status

All eight existing migration files, including
`20261108090000_remove_player_delete_permissions.sql`, were applied to
**plantetary-staging** (`rfivrsnzzhgximesvnyz`). Codex verified all eight in remote
history, the three public tables with RLS enabled, both private helper tables,
and account foreign keys with `ON DELETE CASCADE` on all five tables. Private
helper tables do not have RLS enabled; the public-table RLS statement above does
not describe those private tables.

See the [staging deletion test record](account-deletion.md#staging-account-deletion-test-record)
for the verified baseline, owner-reported post-deletion counts and limitations.
Staging results do not establish production migration or permission state.

## Run the tests locally

This uses a throwaway database in Docker on your computer. It never touches your hosted project.

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) running. The commands use `npx`, so you don't need to install the Supabase CLI. The first run downloads a few gigabytes of images.

```bash
npx supabase start    # start the local stack and apply the migrations
npx supabase test db  # run all the tests
npx supabase stop     # stop it when you're done
```

The last lines of `test db` should say `All tests successful` and `Result: PASS`.

`06_concurrency.test.sql` opens several extra sessions with `dblink` to add backups and save at the same moment. Those sessions commit for real, so the file uses its own test users and deletes them at the start and end.

After changing a migration, rebuild the local database from scratch before testing:

```bash
npx supabase db reset
npx supabase test db
```

Plantetary's local stack uses ports 55320–55329, not Supabase's default 54320–54329, so it can run alongside another local Supabase project.

## Apply the migrations to your hosted project

Supabase CLI v3 targets your **local** database unless you add `--remote`. Every step below that touches your hosted project has `--remote`.

1. **Find your project ref and database password.** The ref is the 20-letter ID in your dashboard URL: `supabase.com/dashboard/project/<ref>`. The password is the one you set when creating the project. You can reset it in **Project Settings → Database** if needed.

2. **Check the Postgres version.** In the dashboard's **SQL Editor**, run `show server_version;`. It should start with `17`. If it doesn't, change `major_version` in `supabase/config.toml` to match, then rerun the local tests.

3. **Sign in to the CLI.** This opens your browser.

   ```bash
   npx supabase login
   ```

4. **Link this folder to your project.** Enter the database password when asked.

   ```bash
   npx supabase link --project-ref <your-project-ref>
   ```

5. **Preview what will run.** You should see only the migrations your project doesn't have yet.

   ```bash
   npx supabase db push --remote --dry-run
   ```

6. **Apply them.**

   ```bash
   npx supabase db push --remote
   ```

7. **Confirm they're recorded.** Every migration should show in both the Local and Remote columns.

   ```bash
   npx supabase migration list --remote
   ```

Steps 1–4 are only needed once per computer. For a later migration, start at step 5.

Please don't paste the migrations into the SQL Editor instead. The tables would work, but the CLI wouldn't know they'd been applied and would try to apply them again later.

## Run the tests against your hosted project

Optional, but best done while the project has no real users. Each test file runs inside a transaction that's rolled back, so its test users and rows are never kept.

The concurrency tests (`06_concurrency.test.sql`) open extra sessions that commit for real, so they run only on the local stack. On your hosted project they're reported as skipped and never connect.

```bash
npx supabase test db --remote
```

If any test fails here but passes locally, don't connect the app until we've found out why.

## Check the dashboard

1. **Table Editor:** `profiles`, `quest_saves` and `save_backups` appear, and none is labelled as having RLS disabled.
2. **Advisors → Security Advisor:** no warnings about these tables or the `private` functions.
3. **Project Settings → Data API:** `public` is in the exposed schemas, and `private` isn't.

The app uses the project URL and **publishable** key only. The secret key bypasses every rule here and must never be put in the app or committed.

## Applying a new migration to the hosted project

See **Hosted project status** for what's applied and what's next. This is the procedure for each new migration; it's the one Stages 7 and 8 were applied with. Those two, for reference:

| Migration | Stage | What it changes | Without it |
| --- | --- | --- | --- |
| `20261106090000_add_upgrade_backups.sql` | 7 | Allows a new backup reason, `upgrade` (kept once per revision, 5 per account), and adds it to the retention trigger. Changes two check constraints; existing rows already satisfy them. | A cloud save in an older format can't be backed up before it's upgraded, so it fails to load (safely: it's never replaced). |
| `20261107090000_add_browser_import_rpc.sql` | 8 | Adds one function, `public.import_browser_save`, callable only by signed-in users. It runs with the caller's own permissions, so RLS still applies. No table changes. | Importing fails with "Importing isn't set up on the server yet". Nothing is written, and normal saving works. |

`db push` applies pending migrations in order, sorted by name. If the app needs a new migration, apply it **before** deploying the code that uses it, and make the old code keep working with it (add things; don't remove what the deployed app still uses), so a rollback stays safe.

Run these yourself, from the project folder. Every hosted step has `--remote`; nothing here changes `.env.local`. If the project isn't linked on this computer yet, do steps 1–4 of **Apply the migrations to your hosted project** above first.

### 1. Check

1. **Be on the code you'll deploy,** with the new migration reviewed and merged. Check that `supabase/migrations/` lists it after the seven already applied.

2. **Test locally.** Rebuild the local database from every migration and run the tests. They must end with `Result: PASS`.

   ```bash
   npx supabase start
   npx supabase db reset
   npx supabase test db
   ```

   If `start` stops because the `vector` or `studio` container is unhealthy, run `npx supabase start -x vector,studio`. The database tests don't need either.

3. **See what the hosted project has (read-only).** Every migration already applied (through `20261107090000_add_browser_import_rpc`, until the next one is applied) should be in both columns, and only the new one(s) missing from Remote. If anything else differs (a migration missing that should be there, or one on Remote that isn't in the folder), stop and find out why first.

   ```bash
   npx supabase migration list --remote
   ```

### 2. Back up

The project holds players' saves now, so take a copy first, even if the migration changes no rows. Save it outside the project folder so it's never committed, and delete it when you no longer need it: it contains players' data.

```bash
npx supabase db dump --remote --data-only -f ~/plantetary-hosted-data-before-<migration-name>.sql
```

On a paid plan, **Database → Backups** in the dashboard also shows the project's automatic backups.

### 3. Review

1. **Read the new file(s)** if you haven't already, so you know exactly what will run, and whether it deletes or rewrites rows, or locks a busy table for long.
2. **Dry run.** It should list exactly the migrations missing from Remote in step 1.3, in order, and apply nothing.

   ```bash
   npx supabase db push --remote --dry-run
   ```

   If it lists anything else, stop.

### 4. Apply

The CLI asks for confirmation, then applies the migrations in order and stops at the first one that fails.

```bash
npx supabase db push --remote
```

If it fails, don't retry by pasting SQL into the SQL Editor. Run step 1.3 again to see what was recorded, and find out why first.

### 5. Verify

1. **Recorded.** Every migration, including the new one(s), should now be in both columns.

   ```bash
   npx supabase migration list --remote
   ```

2. **Database tests against the hosted project.** Each file runs in a transaction that's rolled back. The concurrency file is skipped there. Expect `Result: PASS`.

   ```bash
   npx supabase test db --remote
   ```

3. **Permissions, if the migration changed any (read-only).** In the dashboard's **SQL Editor**. For `20261108090000_remove_player_delete_permissions`:

   ```sql
   select
     has_table_privilege('authenticated', 'public.quest_saves', 'DELETE') as can_delete_saves,
     has_table_privilege('authenticated', 'public.save_backups', 'DELETE') as can_delete_backups,
     has_table_privilege('authenticated', 'public.save_backups', 'SELECT') as can_read_backups,
     (select count(*) from pg_policies where schemaname = 'public' and cmd = 'DELETE'
        and tablename in ('quest_saves', 'save_backups')) as delete_policies;
   ```

   Expect `false`, `false`, `true` and `0`. `can_read_backups` must stay `true`: imports need it.

   For Stage 8, who can run the import:

   ```sql
   select
     has_function_privilege('anon', 'public.import_browser_save(uuid, bigint, json, integer)', 'execute') as anon_can,
     has_function_privilege('authenticated', 'public.import_browser_save(uuid, bigint, json, integer)', 'execute') as signed_in_can;
   ```

   Expect `anon_can = false` and `signed_in_can = true`.

4. **Dashboard checks.** Repeat **Check the dashboard** above. The Security Advisor should show no new warnings.

5. **Try it by hand** with test accounts only (see **Testing against the hosted project by hand** below).

## Testing against the hosted project by hand

After a migration or a release, check the flows by hand: on https://plantetary.vercel.app itself, or from a dev server on your own computer pointed at the hosted project. Real players' data lives there, so keep it controlled:

1. **Sign in only with your own test addresses,** never a player's. Without custom SMTP, Supabase only emails members of your Supabase organization, a few times an hour (see [supabase-auth.md](supabase-auth.md)).
2. **To use a dev server, point it at the project** by putting the project URL and **publishable** key in `.env.local` (copied from `.env.example`). Never the secret or `service_role` key: Plantetary refuses to start sign-in with one. Restart `npm run dev` after changing it. **Redirect URLs** must include `http://localhost:3000/auth/confirm`.
3. **Don't run the browser tests against that server.** `npm run test:e2e` starts its own server with a fake project, which is safe. `E2E_PORT=3000 npm run test:e2e` would reuse your server, and the tests would sign in and write to the real project.
4. **Try the flows by hand,** with two test addresses (A and B):
   - Play as a guest, then sign in as A: **Start your cloud garden?** appears, and the guest progress is untouched.
   - **Start a fresh cloud garden**, complete a quest, reload: it's still there, and the pill says **Saved**.
   - Open a second tab, change something in each: the second save shows **Your garden changed somewhere else**; **Load latest garden** recovers.
   - Sign in as B in another tab: A's garden disappears from the first tab; B gets the first-time choice. Sign in as A again: A's garden is back.
   - Turn the network off (browser dev tools), make a change: **Retrying…**, then **Not saved**; turn it back on and **Try saving again**.
   - Sign out with a change unsaved: the warning appears.
   - **Importing:** play as a guest, then sign in as a test account with no cloud garden. **Import my browser garden** on the first-time card: the cloud garden now matches, and the guest garden is unchanged (sign out to check).
   - **Replacing:** in **Settings → Account**, change the cloud garden, then **Review and import…** → **Replace my cloud garden**: the message says the previous cloud garden was backed up. Import again: **Your cloud garden already matches this browser**, and no new backup is added.
   - **Signing out during an import:** start one, then sign out from another tab: **Import interrupted**, and the guest garden is unchanged.
   - After importing, complete a quest and reload: it's saved.
5. **Check the dashboard:** **Table Editor → quest_saves** has one row per test account; **save_backups** has `conflict` rows from step 4, `daily` rows from saving, and one `browser_import` row per replacing import (none for an import into an empty account, or one that changed nothing). **Advisors → Security Advisor** has no new warnings.
6. **Clean up** by deleting the test users in **Authentication → Users**. Their `quest_saves`, `save_backups` and `profiles` rows are deleted with them (`on delete cascade`).

## Restoring a cloud garden from a backup (owner only)

Players can't restore backups from the app. If a player asks to undo an import (or to get back an earlier garden), the project owner can do it from the dashboard's **SQL Editor**, which runs as the database owner and bypasses RLS. Be careful: a mistake here can show one player another player's garden. Only the owner should do this; never hand out the secret or `service_role` key to anyone else to do it.

What a restore does: it puts a backup's exact garden back as the account's cloud garden, after keeping a copy of the garden it replaces. The database gives the restored garden a new revision, so any page the player still has open can't save over it: its next save is a conflict, and **Load latest garden** shows the restored one.

Replace every `<…>` placeholder before running anything. Queries 1–3 only read.

### 1. Identify the account

Only act on a request you're sure came from the account's owner, for example one sent from that email address. Look the account up by its exact email:

```sql
select id, email, created_at, last_sign_in_at
from auth.users
where email = '<player@example.com>';
```

There should be exactly one row. Its `id` is the `<user-id>` below.

### 2. Find the backup

```sql
select id, reason, created_at, source_revision, schema_version, octet_length(raw_data) as bytes
from public.save_backups
where user_id = '<user-id>'
order by created_at desc;
```

- **Undoing an import:** the `browser_import` row from just before the import's time is the garden it replaced. Its `source_revision` is the revision that garden had. A `daily` row from the same moment may hold the same garden; either works, but prefer the `browser_import` one.
- Other reasons: `daily` (the garden before the first change of a UTC day), `conflict` (the losing copy when two devices saved at once), and `upgrade` (a garden in an older format, before it was upgraded).
- Only the newest backups are kept (`browser_import` 5, `conflict` 20, `daily` 14, `upgrade` 5 per account), so a very old garden may be gone.

### 3. Compare the backup with the current garden

```sql
with gardens as (
  select 'current' as which, revision as revision, schema_version, data::text as body
  from public.quest_saves
  where user_id = '<user-id>'
  union all
  select 'backup ' || id, source_revision, schema_version, raw_data
  from public.save_backups
  where user_id = '<user-id>' and id = <backup-id>
)
select which, revision, schema_version, octet_length(body) as bytes,
       json_array_length(body::json -> 'questLists' -> 'daily') as daily_quests,
       json_array_length(body::json -> 'questLists' -> 'personal') as personal_quests,
       coalesce(json_array_length(body::json -> 'discoveredPlantIds'), 0) as plants,
       coalesce((body::json ->> 'legacyXpBonus')::int, 0) as legacy_xp_bonus,
       (select max(day) from json_object_keys(coalesce(body::json -> 'completionHistory', '{}'::json)) as day) as last_recorded_day
from gardens;
```

Check, before going on:

- **Two rows**, `current` and `backup <id>`. If the backup row is missing, the ID belongs to another account or doesn't exist: stop.
- **The backup is the garden the player described** (quests, plants, last recorded day).
- **`schema_version` is the same** in both rows. If the backup's is lower, stop: the database won't let a save's format go down, and restoring an older format by hand isn't supported.
- **Note the current `revision`.** That's `<checked-revision>` below. If the player has kept playing since the import, the current garden has progress the restore would replace (it's kept as a backup in step 4, but tell the player first).

### 4. Restore

Ask the player to close Plantetary on every device first, so nothing is saving meanwhile. Then run this as one script. It changes nothing unless every check passes: if the garden has moved past `<checked-revision>`, or the backup isn't this account's or isn't the same format, it stops with an error and rolls everything back.

```sql
do $$
declare
  target_user      uuid   := '<user-id>';
  checked_revision bigint := <checked-revision>;
  restore_id       bigint := <backup-id>;
  restored_revision bigint;
begin
  -- Keep a copy of the garden being replaced. `conflict` is the closest of the fixed backup reasons
  -- (the copy that lost), and keeps the most copies (20; adding one may remove the account's oldest).
  insert into public.save_backups (user_id, reason, raw_data, schema_version, source_revision)
  select user_id, 'conflict', data::text, schema_version, revision
  from public.quest_saves
  where user_id = target_user and revision = checked_revision;
  if not found then
    raise exception 'The cloud garden is no longer at revision %. Nothing was changed: check it again (step 3).', checked_revision;
  end if;

  -- Put the backup back, only over the revision checked, only from this account's own backup, and
  -- only in the same format.
  update public.quest_saves as s
  set data = b.raw_data::json, schema_version = b.schema_version
  from public.save_backups as b
  where s.user_id = target_user
    and s.revision = checked_revision
    and b.id = restore_id
    and b.user_id = target_user
    and b.schema_version = s.schema_version
  returning s.revision into restored_revision;
  if restored_revision is null then
    raise exception 'Backup % is not this account''s, or not in the same format. Nothing was changed.', restore_id;
  end if;

  raise notice 'Restored backup % as revision %.', restore_id, restored_revision;
end $$;
```

The result should end with `NOTICE: Restored backup <backup-id> as revision <n>`, where `<n>` is higher than `<checked-revision>`.

### 5. Confirm

```sql
select s.revision, s.updated_at, s.data::text = b.raw_data as matches_backup
from public.quest_saves as s
join public.save_backups as b on b.user_id = s.user_id and b.id = <backup-id>
where s.user_id = '<user-id>';
```

Expect the new revision and `matches_backup = true`. The replaced garden is the newest `conflict` backup in step 2's list, so this restore can itself be undone the same way.

Then ask the player to open Plantetary and sign in: their cloud garden is the restored one. A page left open shows **Your garden changed somewhere else** on its next save; **Load latest garden** shows the restored garden. Their browser garden (guest progress) is never affected.

## Not done yet

- `profiles` isn't read or written by the app; profile and reminder preferences stay in the browser.
- Nothing merges changes between devices (Stage 9). Importing (Stage 8) replaces the cloud garden; it doesn't merge.
- Backups (`browser_import`, `conflict`, `daily`, `upgrade`) can't be restored from the app. Only the project owner can, from the dashboard.
- Account deletion and cloud reset from the app (Stage 10). Until then, deletion is by email request, handled by hand: [account-deletion.md](account-deletion.md).
- CI doesn't run these database tests. They need Docker, so they could be added as a separate CI job later.
