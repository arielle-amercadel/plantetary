# Deploying Plantetary (Vercel + Supabase)

How Plantetary is put online with sign-in and cloud saves, and how to release changes. Without the Supabase variables, the deployed app works in guest mode only.

## Current status

Plantetary is live at **https://plantetary.vercel.app**, deployed by Vercel from `main`.

**Done:**

- **Database:** the first seven migrations applied to the hosted Supabase project **plantetary**, through Stage 8 (see [supabase-database.md → Hosted project status](supabase-database.md#hosted-project-status)). The eighth, which removes players' delete permissions, is next to apply.
- **Vercel:** the two Supabase variables set for Production (below), and the site redeployed with them.
- **Supabase Auth:** Site URL and Redirect URLs set for https://plantetary.vercel.app.
- **Checked by hand on the live site:** sign-in, cloud saving and loading, guest progress staying in the browser, and the mobile layout.
- **Checked from outside (read-only):** the live pages receive the publishable key and project URL; no secret key is in any JavaScript sent to browsers; anonymous requests to the game tables are refused.
- **Security headers** (from `next.config.ts`): clickjacking protection (`frame-ancestors 'none'` and `X-Frame-Options: DENY`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy`. Vercel adds `Strict-Transport-Security`. They reach the live site with the first deployment after they're merged.

**To confirm** (dashboard settings this repository can't check):

- **Email templates:** **Magic Link** and **Confirm signup** use the repository's `{{ .TokenHash }}` versions (below). With Supabase's defaults, sign-in still works, but only in the browser that asked for the link, and email scanners can use links up.

**Before inviting players:**

1. **Custom SMTP** in Supabase ([supabase-auth.md](supabase-auth.md#supabase-dashboard-settings), step 4), then review **Rate Limits**. Until then, sign-in emails only reach members of your Supabase organization, a few an hour.
2. **Publish the privacy notice.** The page is built (`/privacy`, from `src/app/privacy/privacy-notice.md`, linked from the sidebar, the mobile menu, the sign-in form and Settings → Your data), but two things block publishing it: a **legal review** of the wording, and the **effective date**, which is still a placeholder (`[DATE — to be set when published]`). Requests to see, correct or delete information go to hello.plantetary@gmail.com and are handled by hand: [account-deletion.md](account-deletion.md). There's no account deletion in the app yet (Stage 10). Players confirm they're at least 13 before asking for a sign-in link (an acknowledgment, not age verification). If something goes wrong, see [security-incident-response.md](security-incident-response.md).
3. **Your Supabase plan:** free projects pause after a period without activity, and their automatic backups can't be downloaded. Consider a paid plan, or take regular copies (`npx supabase db dump --remote --data-only`, kept outside the repository).

No secret belongs anywhere in this setup. The app uses the project URL and the **publishable** key, both public. The secret key (`sb_secret_…`) and the `service_role` key bypass every database rule: never put them in Vercel, `.env.local`, or the repository.

## Releasing a change

The first deployment followed these steps in this order; later releases use the same order. Merging to `main` deploys it, so everything before step 4 happens first.

1. **Check the branch locally:** `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run test:e2e`, and, if it touches the database, `npx supabase db reset && npx supabase test db` (see [game-storage.md](game-storage.md#testing) and [supabase-database.md](supabase-database.md#run-the-tests-locally)). CI only runs the unit tests, type check and lint.
2. **If it includes a migration, apply it to the hosted project first,** with a backup and a dry run: [supabase-database.md → Applying a new migration](supabase-database.md#applying-a-new-migration-to-the-hosted-project). The deployed code must keep working with it until the new code is live.
3. **If it needs new Supabase Auth or Vercel settings,** change them first (below).
4. **Merge to `main`.** Vercel deploys it to https://plantetary.vercel.app.
5. **Check the live site** (below), with test accounts: [supabase-database.md → Testing against the hosted project by hand](supabase-database.md#testing-against-the-hosted-project-by-hand).

## Vercel project settings

- **Framework preset:** Next.js (detected automatically). Keep the default build command (`npm run build`) and output settings.
- **Node.js version:** 24.x, the version CI uses (**Settings → Build and Deployment → Node.js Version**).
- **Production branch:** `main`.

## Vercel environment variables

Set these in **Settings → Environment Variables**:

| Variable | Value | Environments |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL, `https://<project-ref>.supabase.co` (Dashboard → **Project Settings → Data API**) | Production |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key, `sb_publishable_…` (Dashboard → **Project Settings → API Keys**) | Production |

- **Only these two.** The app needs no other variables. Variables the browser tests use (`E2E_*`, `PLANTETARY_DIST_DIR`) must not be set on Vercel.
- **A secret key stops the build.** If any `NEXT_PUBLIC_` variable holds a secret or `service_role` key, `npm run build` fails with an error that names the variable but never shows its value.
- **Redeploy after changing them.** Pages rendered at build time keep the old values until the next deployment.
- **Preview deployments: leave the variables unset** (Production only, as in the table). Previews then run in guest mode, so code that hasn't been reviewed yet can't sign in to the real project or write players' saves. If you later want sign-in on previews, use a separate Supabase project for them rather than the production one.

## Supabase Auth settings for production

The full steps are in [supabase-auth.md → Supabase Dashboard settings](supabase-auth.md#supabase-dashboard-settings). The production address is https://plantetary.vercel.app; if you add a custom domain, add it alongside:

- **Authentication → URL Configuration:**
  - **Site URL:** `https://plantetary.vercel.app`
  - **Redirect URLs:** `https://plantetary.vercel.app/auth/confirm`, plus `/auth/confirm` on any custom domain, and `http://localhost:3000/auth/confirm` for local development.
  - Sign-in links return to the address the player requested them from, plus `/auth/confirm`. An address that isn't listed is sent to the Site URL instead.
  - Don't add a wildcard for preview addresses while previews have no Supabase variables (above).
- **Email templates:** paste `supabase/templates/magic-link.html` and `confirmation.html` into the Dashboard, as described there, so links work from any browser and can't be used up by email scanners.
- **Anonymous sign-ins:** keep them off.

## After deploying

After each release, with a test account (not a player's):

1. The site loads as a guest, with existing guest progress unchanged.
2. **Settings → Account:** request a sign-in link. The email's link opens `https://plantetary.vercel.app/auth/confirm?token_hash=…`, and **Finish signing in** signs you in.
3. The first-time card appears for a new account. Start a fresh cloud garden, complete a quest, reload: it's still there, and the status says **Saved**.
4. With guest progress in this browser and a test account: **Import my browser garden** works, and the guest garden is unchanged.
5. Sign out: the guest garden is shown again.
6. Supabase dashboard: **Table Editor → quest_saves** has the test account's row; **Advisors → Security Advisor** shows no new warnings.
7. The security headers are there: in the browser's developer tools, **Network** → the page request → **Response Headers** include `content-security-policy: frame-ancestors 'none'; …` and `x-frame-options: DENY`.

Delete the test users afterwards (**Authentication → Users**); their saves and backups are deleted with them.

## If something goes wrong

- **The app:** use Vercel's **Instant Rollback** to the previous deployment. Every migration so far only adds things, or removes permissions the app never used (players deleting saves or backups), so an earlier version of the app keeps working with them; keep it that way for new ones (see **Releasing a change**).
- **Sign-in only:** removing the two variables and redeploying turns sign-in off. Everyone plays in guest mode; cloud saves stay in the database, untouched.
- **The database:** don't edit or re-run migrations by hand. Check `npx supabase migration list --remote` and find out what happened first.
