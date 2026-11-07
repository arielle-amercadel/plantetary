# Supabase database

Plantetary's database tables, access rules and tests (built in Stage 4, extended in Stages 7–8). Since Stage 7, a verified sign-in saves its garden in `quest_saves`, with `conflict` and `upgrade` copies in `save_backups` (see [game-storage.md](game-storage.md)). Stage 8 Step 2 adds an explicit transactional import RPC and adapter; its UI/controller aren't wired yet. Imports back up the existing cloud garden as `browser_import`. `profiles` isn't used by the app yet. Guests never touch the database.

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
| `supabase/tests/database/*.test.sql` | 197 pgTAP tests across 9 files |

Migrations run in filename order. Never edit one after it has been applied to your hosted project; add a new migration instead.

## The tables

All three tables belong to a user through `user_id`, which points at Supabase's `auth.users`. Deleting an account deletes that user's rows.

| Table | Rows | Holds |
| --- | --- | --- |
| `quest_saves` | One per user | The whole game save as JSON (`StoredQuestData`), plus `schema_version` and `revision` |
| `profiles` | One per user | Display name, avatar and reminder preferences |
| `save_backups` | Many per user | Read-only copies of saves, with a reason: `browser_import`, `conflict`, `daily` or `upgrade` |

## Who can do what

Row Level Security (RLS) is on for every table. The database checks every request.

| | Logged-out visitor | Signed-in user, own rows | Signed-in user, someone else's rows |
| --- | --- | --- | --- |
| `quest_saves` | Nothing | Read, create, update, delete | Nothing |
| `profiles` | Nothing | Read, create, update, delete | Nothing |
| `save_backups` | Nothing | Read, create, delete (never edit) | Nothing |

Signed-in users can only write the columns they're meant to. `user_id`, `revision`, `created_at` and `updated_at` are set by the database.

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

This new migration is **not applied to the hosted project** as part of Step 2. Apply it through the
usual reviewed migration process before enabling the import feature there. Existing migrations must
not be edited or reapplied manually.

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

## Stage 7: applying the new migration (not done yet)

Stage 7 adds one migration: `20261106090000_add_upgrade_backups.sql`. It has been reviewed and passes the local tests, but hasn't been applied to the hosted project. Without it, a cloud save in an older format can't be backed up before it's upgraded, so it fails to load (safely: it's never replaced). The app should not be pointed at the hosted project for cloud saves until it's applied.

Run these yourself, in order, from the project folder. Every hosted step has `--remote`; nothing here changes `.env.local`.

1. **Check locally first.** Rebuild the local database from every migration and run the tests. They must end with `Result: PASS`.

   ```bash
   npx supabase start
   npx supabase db reset
   npx supabase test db
   ```

2. **See what the hosted project has (read-only).** Every migration up to `20261105223950_…` should be in both columns, and only `20261106090000_add_upgrade_backups` missing from Remote. If anything else differs, stop and find out why before going further.

   ```bash
   npx supabase migration list --remote
   ```

3. **Optional: keep a copy of the hosted data**, if it holds anything you care about. Save it outside the project folder so it's never committed.

   ```bash
   npx supabase db dump --remote --data-only -f ~/plantetary-hosted-data-before-stage7.sql
   ```

4. **Dry run.** It should list exactly one migration, `20261106090000_add_upgrade_backups.sql`, and apply nothing.

   ```bash
   npx supabase db push --remote --dry-run
   ```

5. **Apply it** (later, when you're ready for hosted testing). The CLI asks for confirmation.

   ```bash
   npx supabase db push --remote
   ```

6. **Confirm.** Every migration, including `20261106090000_add_upgrade_backups`, should now be in both columns.

   ```bash
   npx supabase migration list --remote
   ```

7. **Optional: run the database tests against the hosted project.** Each file is rolled back, and the concurrency file is skipped there.

   ```bash
   npx supabase test db --remote
   ```

If the project isn't linked on this computer yet, do steps 3–4 of **Apply the migrations to your hosted project** above first.

## Controlled hosted testing (before inviting players)

Once the migration is applied, you can try cloud saves against the hosted project on your own computer. Keep it controlled:

1. **Use the hosted project only while it has no real players**, and sign in only with your own test addresses. Without custom SMTP, Supabase only emails members of your Supabase organization, a few times an hour (see [supabase-auth.md](supabase-auth.md)).
2. **Point the dev server at it** by putting the project URL and **publishable** key in `.env.local` (copied from `.env.example`). Never the secret or `service_role` key: Plantetary refuses to start sign-in with one. Restart `npm run dev` after changing it. **Redirect URLs** must include `http://localhost:3000/auth/confirm`.
3. **Don't run the browser tests against that server.** `npm run test:e2e` starts its own server with a fake project, which is safe. `E2E_PORT=3000 npm run test:e2e` would reuse your server, and the tests would sign in and write to the real project.
4. **Try the flows by hand,** with two test addresses (A and B):
   - Play as a guest, then sign in as A: **Start your cloud garden?** appears, and the guest progress is untouched.
   - **Start a fresh cloud garden**, complete a quest, reload: it's still there, and the pill says **Saved**.
   - Open a second tab, change something in each: the second save shows **Your garden changed somewhere else**; **Load latest garden** recovers.
   - Sign in as B in another tab: A's garden disappears from the first tab; B gets the first-time choice. Sign in as A again: A's garden is back.
   - Turn the network off (browser dev tools), make a change: **Retrying…**, then **Not saved**; turn it back on and **Try saving again**.
   - Sign out with a change unsaved: the warning appears.
5. **Check the dashboard:** **Table Editor → quest_saves** has one row per test account; **save_backups** has `conflict` rows from step 4. **Advisors → Security Advisor** has no new warnings.
6. **Clean up** by deleting the test users in **Authentication → Users**. Their `quest_saves`, `save_backups` and `profiles` rows are deleted with them (`on delete cascade`).

## Not done yet

- `profiles` isn't read or written by the app; profile and reminder preferences stay in the browser.
- Nothing imports browser progress into an account (Stage 8), or merges changes between devices (Stage 9).
- Account deletion and cloud reset from the app (Stage 10).
- CI doesn't run these database tests. They need Docker, so they could be added as a separate CI job later.
