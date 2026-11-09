# Handling privacy requests: access, correction and deletion (owner only)

How to handle a player's request to see, correct or delete their information, as the [Privacy Notice](../src/app/privacy/privacy-notice.md) describes: requested by email to **hello.plantetary@gmail.com**, checked, then handled by hand. Nothing here is automated, and the app has no deletion feature.

Never put a player's email address, user ID, messages or data in this repository, an issue, a commit, or a chat with anyone else. Keep request records in your own private notes. Replace every `<…>` below; it's a placeholder. All SQL here only reads; deleting is done in the Dashboard (section 6).

## Keep a private log of requests

For each request, note privately:

- the date it arrived, and the address it came from;
- what's asked: **access**, **correction** or **deletion** (or a concern about a child, section 7);
- when ownership was confirmed, and how;
- the **target date**: 30 days after it was verified (the notice's aim), or sooner if a law requires it. Check with an advisor if unsure;
- when it was completed, and what was sent or done.

Reply soon after a request arrives, even just to say it's being looked at and that you'll confirm it's theirs. Once it's done, delete any copies of the player's data you made while handling it (for example, an access export on your computer).

## 1. Check that it's the account's owner

- The request should come **from the email address of the account**. A request from a different address isn't enough on its own.
- An email's "From" can be faked. **Reply to the account's address** (not "reply all" to anything else), ask them to confirm, and go ahead only when the confirmation comes back from that address.
- **An account created with someone else's address:** asking for a sign-in link creates an account even if the link is never used, so someone may have typed another person's address. If the owner of that address confirms (from it) that they never wanted an account, delete it as in section 6.
- If someone can't confirm from the account's address (for example, they've lost access to it), don't act straight away. There's no written policy for these cases yet; decide what proof you'd accept before acting, and consider asking for advice. For a concern about a child, see section 7.

## 2. Find the account

First verify the intended project name and reference. Production uses **plantetary**; staging uses **plantetary-staging** (`rfivrsnzzhgximesvnyz`). Never use production for a staging test. In that project's Supabase Dashboard: **Authentication → Users**, then search for the exact address. There must be exactly one match. Note its **User UID**: that's `<user-id>` below. An account whose sign-in link was never used still appears here (not yet confirmed).

To see what's stored (read-only), in the **SQL Editor**:

```sql
select
  (select count(*) from auth.users where id = '<user-id>') as accounts,
  (select count(*) from public.quest_saves where user_id = '<user-id>') as saves,
  (select count(*) from public.save_backups where user_id = '<user-id>') as backups,
  (select count(*) from public.profiles where user_id = '<user-id>') as profiles,
  (select count(*) from private.quest_save_revisions where user_id = '<user-id>') as revision_counters,
  (select count(*) from private.save_backup_retention_locks where user_id = '<user-id>') as retention_locks;
```

A player who never used a cloud garden has `0` saves and backups; that's fine.

## 3. Access requests: a copy of their information

What Plantetary's database holds for an account, read-only, in the **SQL Editor**:

```sql
select email, created_at, email_confirmed_at, last_sign_in_at
from auth.users where id = '<user-id>';

select data, schema_version, revision, created_at, updated_at
from public.quest_saves where user_id = '<user-id>';

select reason, created_at, schema_version, source_revision, raw_data
from public.save_backups where user_id = '<user-id>' order by created_at;
```

Send the results only to the verified account address, for example as a file attached to your reply. Explain that:

- their **browser garden**, profile and reminder settings are only on their own devices, so you can't see them; **Settings → Data management → Export data as JSON** gives them a copy;
- Supabase's own sign-in records and logs are kept by Supabase under its policies, and may not all be visible to you.

Then delete your local copy of what you sent.

## 4. Correction requests

- **Quests, profile and settings:** the player can change these in the app at any time. Point them there; don't edit their save by hand.
- **The email address itself:** Plantetary has no way to change an account's address, and there's no safe way yet to move a cloud garden to a new address. Explain the options to the player (for example, keep the current account, or have it deleted and start again with the new address) and let them choose. Don't edit database rows by hand to do it.
- Anything else they believe is inaccurate: look at what's stored (section 3), and reply with what can and can't be changed.

## 5. Deletion requests

Confirm ownership (section 1) and find the account (section 2), then delete it (section 6) and check it's gone. Aim to finish within 30 days of verifying the request, or sooner if a law requires it.

## 6. Delete the account

**Authentication → Users**, open the account found in section 2, then **Delete user**, and confirm. Check the address and UID once more first: this can't be undone. If the Dashboard offers both soft deletion and permanent deletion, choose permanent deletion for the documented account-deletion cascade test. Soft deletion does not exercise removal of the account row and its cascading foreign keys.

Deleting the user removes, in the same step, everything Plantetary's database holds for them: their save, all backups, any profile row, their revision counter, and backup-retention lock rows (every table's `user_id` is `on delete cascade`; see [supabase-database.md](supabase-database.md)). Players can't delete their save or backups themselves; only deleting the account (or the owner) can.

Production's five cascade relationships were verified through read-only metadata
inspection on November 8, 2026; this did not exercise an actual production
deletion. See [the production verification record](supabase-database.md#production-metadata-verification--november-8-2026).
The staging deletion test below remains separate behavioral evidence.

Don't delete rows table by table instead, and don't use the `service_role` or secret key from anywhere outside the dashboard.

**Check that it's gone:**

1. **Authentication → Users:** searching for the address finds nothing.
2. Run the count query from section 2 again with the same `<user-id>`. Expect `0` in every column.

## 7. An account that may belong to a child under 13

Plantetary accounts are for people 13 and older. Players confirm this before asking for a sign-in link; it's an acknowledgment, not age verification.

If you learn that an account may belong to a child under 13 (a report from a parent, something the player wrote to you, or anything else), **act promptly; don't wait for the 30-day target**:

1. Note privately when and how you learned it.
2. Look into it: if the report came from someone other than the account's owner, you may write to the account's address. Don't ask for more personal information than you need.
3. If it's confirmed, or seems likely, delete the account (section 6) and tell whoever raised it, without sharing the child's information with anyone else.
4. Plantetary doesn't collect parental consent, so the step is deletion. If you're unsure what's required, get legal advice.

## 8. Replying to the player

From hello.plantetary@gmail.com, to the account's address only. Keep it to what's true. After a deletion, for example:

> Your Plantetary account has been deleted. This removed your sign-in account, your cloud garden and all of its backups from Plantetary's database.
>
> A few copies are outside Plantetary's database: your browser garden and settings stay on your devices until you reset them in Settings or clear your browser's data, and files you downloaded stay where you saved them. A maintenance copy of the database made before today may still include your information until it's deleted, within 30 days. Our providers, Supabase and Vercel, may keep information for a time in their own backups, security logs or other systems, under their own retention practices.

Don't promise anything the Privacy Notice doesn't, such as a time by which every copy is gone.

## 9. Maintenance copies of the database (30-day practice)

The notice says copies made for maintenance are deleted by hand within 30 days. They're never deleted automatically, so:

- **Where:** keep them outside the repository, or in `backups/` in the project folder, which is ignored by Git (`.gitignore`). Never commit, upload or share one: they contain players' email addresses and gardens.
- **Name them with their date,** for example `backups/<yyyy-mm-dd>-before-<change>.sql`, so their age is obvious.
- **Delete them by hand within 30 days** of when they were made. Set yourself a reminder when you make one. To see what's there and how old it is: `ls -l backups/`.
- **After a deletion request,** copies made earlier still contain that player until they're deleted on schedule, as the notice and the reply say.

## 10. What may remain with providers

These aren't controlled by Plantetary and can't be verified from this repository. Retention depends on the provider's own practices and your plan, and their published figures change:

- Supabase's own backups (the Free plan has no automatic backups; paid plans keep them for a period), logs, and sign-in audit records, which can include IP addresses and may outlive a deleted user.
- Vercel's request and runtime logs.

The Privacy Notice says only that providers "may keep information for a time in their own backups, security logs or other systems". If you learn their exact practices for your plans, consider making the notice more specific.

## Staging account-deletion test record

This first test used only the separate **plantetary-staging** project
(`rfivrsnzzhgximesvnyz`) from the `plantetary-staging` checkout. Production was
not accessed for this test.

The owner created one account through Plantetary's normal email sign-in flow,
started a fresh cloud garden, added two test quests, and completed one. Settings
showed **9 quests and 5 XP**. Codex's read-only staging queries independently
confirmed one confirmed authentication account, its saved cloud garden with
9 quests and 5 XP, a matching revision counter, and one daily backup.

Codex verified the baseline counts below using read-only queries. The owner then
reported permanently deleting the account through **Supabase Dashboard →
Authentication → Users** and reported that all six post-deletion counts were zero.
**Codex did not execute the deletion or independently query the post-deletion
state.**

| Table | Before (Codex verified) | After (owner reported) |
| --- | ---: | ---: |
| `auth.users` | 1 | 0 |
| `public.quest_saves` | 1 | 0 |
| `public.save_backups` | 1 | 0 |
| `public.profiles` | 0 | 0 |
| `private.quest_save_revisions` | 1 | 0 |
| `private.save_backup_retention_locks` | 1 | 0 |

Before the test, Codex also verified that all eight existing migrations appeared
in staging's remote history, RLS was enabled on the three public application
tables, and all five application/helper tables had account foreign keys with
`ON DELETE CASCADE`. These findings establish staging state only.

### Limits of this test

- Only one staging account was used; multi-account isolation was not tested.
- `profiles` was empty before deletion, so its cascade was not exercised.
- Only a daily backup was present; conflict, browser-import and upgrade backup
  deletion were not exercised.
- Browser-local gardens and settings are separate from cloud data. This test
  does not establish their removal or immediate browser-session invalidation.
- Production account deletion and an in-app account-deletion flow were not tested.
- This does not verify provider backup/log retention, maintenance-copy deletion,
  or all Privacy Notice obligations. It does not clear the
  [Privacy Notice publication blockers](deployment.md#privacy-notice-publication-blockers).
