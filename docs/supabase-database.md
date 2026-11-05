# Supabase database (Stage 4)

This stage adds Plantetary's database tables, access rules and tests, and nothing else. The app doesn't connect to Supabase yet. Guest mode and browser storage work exactly as before, and there's no login.

## What's in this folder

| Path | What it is |
| --- | --- |
| `supabase/config.toml` | Supabase CLI settings for the local test database |
| `supabase/migrations/20261105220000_create_private_helpers.sql` | A `private` schema and the shared `updated_at` trigger function |
| `supabase/migrations/20261105220100_create_profiles.sql` | `profiles` table, its triggers and access rules |
| `supabase/migrations/20261105220200_create_quest_saves.sql` | `quest_saves` table, its triggers and access rules |
| `supabase/migrations/20261105220300_create_save_backups.sql` | `save_backups` table, backup limits, the daily backup trigger and access rules |
| `supabase/migrations/20261105223950_fix_revision_reuse_and_backup_retention.sql` | Review fixes: revisions never repeat, and backup limits hold under concurrent inserts |
| `supabase/tests/database/*.test.sql` | 125 pgTAP tests across 7 files |

Migrations run in filename order. Never edit one after it has been applied to your hosted project; add a new migration instead.

## The tables

All three tables belong to a user through `user_id`, which points at Supabase's `auth.users`. Deleting an account deletes that user's rows.

| Table | Rows | Holds |
| --- | --- | --- |
| `quest_saves` | One per user | The whole game save as JSON (`StoredQuestData`), plus `schema_version` and `revision` |
| `profiles` | One per user | Display name, avatar and reminder preferences |
| `save_backups` | Many per user | Read-only copies of saves, with a reason: `browser_import`, `conflict` or `daily` |

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
| Backup limits | `save_backups` | Keeps the newest 14 `daily`, 20 `conflict` and 5 `browser_import` backups per user, and removes older ones. Backups added at the same time for one user and reason take turns, so the limits hold. |

The UTC day only spaces out backups. Game days still come from the player's own device, as before.

To save without overwriting another device's change, the app will send `where revision = <the revision it loaded>`. If no row changes, another device saved first, or the save was deleted and recreated, which is a conflict. That's Stage 7's job; the tests here prove the database supports it.

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

You don't need the API keys yet. When Stage 6 connects the app, it will use the project URL and **publishable** key only. The secret key bypasses every rule here and must never be put in the app or committed.

## Not done yet

- The app doesn't read or write these tables (Stages 5–7).
- There's no login (Stage 6).
- Nothing imports browser data or handles conflicts yet (Stages 8–9).
- CI doesn't run these database tests. They need Docker, so they could be added as a separate CI job later.
