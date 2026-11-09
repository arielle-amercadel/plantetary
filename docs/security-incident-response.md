# Security incident response (owner only)

What to do if Plantetary's data, accounts or keys may have been exposed or misused: for example, a leaked Supabase key, unexpected changes to saves, an account accessed by someone else, or a report from a player or a provider.

This is a checklist, not legal advice. Whether and how to notify anyone depends on the facts and on the law where affected players live; get qualified advice for that step. Never put players' data, keys or incident notes in this repository.

## 1. Investigate and assess

- Write down **when it was noticed, by whom, and what was seen**. Start a private timeline and keep adding to it.
- Work out what may be affected: the Supabase project (accounts, `quest_saves`, `save_backups`), the Vercel deployment, the repository, or your own accounts (GitHub, Supabase, Vercel, the hello.plantetary@gmail.com mailbox).
- Decide how serious it looks: could players' email addresses or gardens have been read or changed by someone who shouldn't have? If you can't rule it out, treat it as possible and keep going.

## 2. Contain it

Use what fits; most steps can be undone later.

- **A key may have leaked:** in the Supabase Dashboard, rotate it (**Project Settings → API Keys**, or the JWT signing keys, which also signs everyone out). Then update the Vercel variable if it was the publishable key, and redeploy. The secret key must never be in the app; if it was anywhere it shouldn't be, rotate it.
- **Turn sign-in off quickly:** remove the two Supabase variables in Vercel and redeploy. Everyone then plays as a guest; cloud saves stay in the database, untouched (see [deployment.md](deployment.md)).
- **A bad release:** use Vercel's **Instant Rollback** to the previous deployment.
- **A compromised account of yours:** change its password, end its other sessions, check its recovery settings, and turn on two-factor authentication.
- Don't delete data or logs while containing it; they may be needed (step 3).

## 3. Preserve logs and evidence

Providers keep logs for a short time, depending on the plan (on some plans an hour to a day), so do this early:

- **Supabase:** in the Dashboard's **Logs** (API, database and auth), find the relevant period and save what you need (export or copy the entries, and take screenshots).
- **Vercel:** the deployment's runtime and request logs, and the list of recent deployments and who made them.
- **GitHub:** recent commits and pushes, and the repository's security alerts.
- Keep everything in a private folder outside the repository, alongside your timeline. Note where each item came from and when you saved it.

## 4. Work out what data and which players are affected

- Use **read-only** queries in the SQL Editor to see what changed and when (for example, `updated_at` and `revision` in `quest_saves`, `created_at` in `save_backups`), and which accounts are involved.
- List what kinds of information may be involved: email addresses, gardens (which can include whatever players wrote in quest titles and notes), backups, sign-in records.
- Count the affected players, and note where they may live if you know; that matters for notifications.
- Don't copy more players' data than you need to answer these questions, and delete working copies afterwards.

## 5. Document it

In your private notes: the timeline, what was affected, how it happened (once known), what you did and when, who you told and when, and what you decided not to do and why. Keep these notes privately even after it's resolved.

## 6. Notifications that may be legally required

- **Get qualified legal advice** on whether, when and how to notify. U.S. states each have their own breach-notification laws, with different definitions of the information that counts and different deadlines. Some also require notifying a state official (for example, see the California Attorney General's [data breach reporting page](https://oag.ca.gov/privacy/databreach/reporting)).
- Ask your advisor too whether any other rule applies given what Plantetary holds (for example, if players' notes include health information).
- If players are told, keep the message factual: what happened, what information was involved, what you've done, and what they can do. Send it from hello.plantetary@gmail.com.
- Tell the providers if their service was involved (Supabase or Vercel support).

## 7. Follow up

- Fix the cause, and check the fix (tests, and the read-only checks in [supabase-database.md](supabase-database.md)).
- Review what would have caught it sooner or limited it.
- If Plantetary's practices change as a result, update the Privacy Notice and its effective date.
- Note the date you closed the incident.
