# Deploying Plantetary (Vercel + Supabase)

How to put Plantetary online with sign-in and cloud saves. Nothing here has been done yet. Without the Supabase variables, the deployed app works in guest mode only, as before.

No secret belongs anywhere in this setup. The app uses the project URL and the **publishable** key, both public. The secret key (`sb_secret_…`) and the `service_role` key bypass every database rule: never put them in Vercel, `.env.local`, or the repository.

## Deployment order

Each step depends on the one before it. Don't deploy the app with sign-in turned on before the database and Auth settings are ready.

1. **Merge the finished work into `main`**, with CI passing (unit tests, type check, lint). Stage 8 Step 5 must be in `main`: it makes a missing import function fail plainly instead of leaving an import unresolved.
2. **Check `main` locally:** `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run test:e2e`, and `npx supabase db reset && npx supabase test db` (see [game-storage.md](game-storage.md#testing) and [supabase-database.md](supabase-database.md#run-the-tests-locally)).
3. **Apply the database migrations** to the hosted project, with a dry run first: [supabase-database.md → Stages 7 and 8](supabase-database.md#stages-7-and-8-applying-the-new-migrations-not-done-yet).
4. **Configure Supabase Auth** for the production address (below).
5. **Try it by hand from your own computer** against the hosted project, with test accounts: [supabase-database.md → Controlled hosted testing](supabase-database.md#controlled-hosted-testing-before-inviting-players).
6. **Set the Vercel environment variables** (below), then **deploy** `main`.
7. **Check the live site** (below).
8. **Before inviting players:** set up custom SMTP in Supabase ([supabase-auth.md](supabase-auth.md#supabase-dashboard-settings), step 4). Until then, sign-in emails only reach members of your Supabase organization.

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

The full steps are in [supabase-auth.md → Supabase Dashboard settings](supabase-auth.md#supabase-dashboard-settings). For Vercel, use your production address (your custom domain, or `https://<project>.vercel.app`):

- **Authentication → URL Configuration:**
  - **Site URL:** `https://<your-production-address>`
  - **Redirect URLs:** `https://<your-production-address>/auth/confirm`. Add each domain the site is served from (for example both the custom domain and the `vercel.app` one), and keep `http://localhost:3000/auth/confirm` for local development.
  - Sign-in links return to the address the player requested them from, plus `/auth/confirm`. An address that isn't listed is sent to the Site URL instead.
  - Don't add a wildcard for preview addresses while previews have no Supabase variables (above).
- **Email templates:** paste `supabase/templates/magic-link.html` and `confirmation.html` into the Dashboard, as described there, so links work from any browser and can't be used up by email scanners.
- **Anonymous sign-ins:** keep them off.

## After deploying

With a test account (not a player's):

1. The site loads as a guest, with existing guest progress unchanged.
2. **Settings → Account:** request a sign-in link. The email's link opens `https://<your-production-address>/auth/confirm`, and **Finish signing in** signs you in.
3. The first-time card appears for a new account. Start a fresh cloud garden, complete a quest, reload: it's still there, and the status says **Saved**.
4. With guest progress in this browser and a test account: **Import my browser garden** works, and the guest garden is unchanged.
5. Sign out: the guest garden is shown again.
6. Supabase dashboard: **Table Editor → quest_saves** has the test account's row; **Advisors → Security Advisor** shows no new warnings.

Delete the test users afterwards (**Authentication → Users**); their saves and backups are deleted with them.

## If something goes wrong

- **The app:** use Vercel's **Instant Rollback** to the previous deployment. Both new migrations only add things (a backup reason, a function), so an earlier version of the app keeps working with them.
- **Sign-in only:** removing the two variables and redeploying turns sign-in off. Everyone plays in guest mode; cloud saves stay in the database, untouched.
- **The database:** don't edit or re-run migrations by hand. Check `npx supabase migration list --remote` and find out what happened first.
