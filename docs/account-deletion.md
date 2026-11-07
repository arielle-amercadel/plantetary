# Handling an account deletion request (owner only)

How to handle a request to delete a Plantetary account, as the [Privacy Notice](../src/app/privacy/privacy-notice.md) describes: requested by email, checked, then deleted by hand in the Supabase Dashboard. There's no deletion in the app.

Never put a player's email address, user ID, messages or data in this repository, an issue, a commit, or a chat with anyone else. Keep request records in your own private notes. Replace every `<…>` below; it's a placeholder.

## 1. Receive the request

Requests arrive at **hello.plantetary@gmail.com**. Note privately the date it arrived and the address it came from.

## 2. Check that it's the account's owner

- The request should come **from the email address of the account to be deleted**. A request from a different address isn't enough on its own.
- An email's "From" can be faked. Before deleting, **reply to the account's address** (not "reply all" to anything else), asking them to confirm, and go ahead only when the confirmation comes back from that address.
- If someone can't confirm from the account's address (for example, a parent asking about a child's account, or someone who's lost access to the address), don't delete it straight away. There's no written policy for these cases yet; decide what proof you'd accept before acting, and consider asking for advice.

## 3. Find the account

In the Supabase Dashboard for the **plantetary** project: **Authentication → Users**, then search for the exact address. There must be exactly one match. Note its **User UID**: that's `<user-id>` below.

To see what's stored before deleting (read-only), in the **SQL Editor**:

```sql
select
  (select count(*) from public.quest_saves where user_id = '<user-id>') as saves,
  (select count(*) from public.save_backups where user_id = '<user-id>') as backups,
  (select count(*) from public.profiles where user_id = '<user-id>') as profiles,
  (select count(*) from private.quest_save_revisions where user_id = '<user-id>') as revision_counters;
```

A player who never used a cloud garden has `0` saves and backups; that's fine.

## 4. Delete the account

**Authentication → Users**, open the account found in step 3, then **Delete user**, and confirm. Check the address and UID once more first: this can't be undone.

Deleting the user removes, in the same step, everything Plantetary's database holds for them: their save, all backups, any profile row, and their revision counter (every table's `user_id` is `on delete cascade`; see [supabase-database.md](supabase-database.md)). Players can't delete their save or backups themselves; only deleting the account (or the owner) can.

Don't delete rows table by table instead, and don't use the `service_role` or secret key from anywhere outside the dashboard.

## 5. Check that it's gone

1. **Authentication → Users:** searching for the address finds nothing.
2. Run the query from step 3 again with the same `<user-id>`. Expect `0` in every column.

## 6. Reply to the player

From hello.plantetary@gmail.com, to the account's address. Keep it to what's true, for example:

> Your Plantetary account has been deleted. This removed your sign-in account, your cloud garden and all of its backups from Plantetary's database.
>
> A few copies are outside Plantetary's database: your browser garden and settings stay on your devices until you reset them in Settings or clear your browser's data, and files you downloaded stay where you saved them. A maintenance copy of the database made before today may still include your information until it's deleted, within 30 days. Our providers, Supabase and Vercel, may keep backups or logs for a time under their own policies.

Don't promise anything the Privacy Notice doesn't, such as a time by which every copy is gone.

## 7. Maintenance copies of the database (30-day practice)

The notice says copies made for maintenance are deleted by hand within 30 days. They're never deleted automatically, so:

- **Where:** keep them outside the repository, or in `backups/` in the project folder, which is ignored by Git (`.gitignore`). Never commit, upload or share one: they contain players' email addresses and gardens.
- **Name them with their date,** for example `backups/<yyyy-mm-dd>-before-<change>.sql`, so their age is obvious.
- **Delete them by hand within 30 days** of when they were made. Set yourself a reminder when you make one. To see what's there and how old it is: `ls -l backups/`.
- **After a deletion request,** nothing extra is needed: copies made earlier still contain that player until they're deleted on schedule, as the notice and the reply say.

## Things to check in the Supabase Dashboard

These aren't controlled by Plantetary and can't be verified from this repository:

- How long your plan keeps Supabase's own backups and logs.
- Whether Supabase's sign-in audit log keeps entries (which can include an IP address) after a user is deleted.

If you find out, consider making the Privacy Notice more specific; until then it says only that Supabase and Vercel "may keep backups or logs for a time under their own policies".
