# Optional sign-in (Stage 6)

Players can sign in with an emailed link, with no password. Signing in is optional, and it doesn't change the game: progress is still saved only in the browser, exactly as for a guest. Signing in or out never reads, writes, uploads or resets a game save.

Cloud saves, importing browser saves, and account deletion come in later stages.

## How it works

1. The player enters an email address in **Settings → Account**.
2. Supabase emails a link to `<this site>/auth/confirm`.
3. The confirm page removes the token from the address bar and shows **Finish signing in**. Nothing is checked until the player presses it, so an email provider that opens links ahead of time can't use the link up.
4. Pressing it verifies the link with Supabase. The player is then signed in and taken back to Settings.

After that:

- **Sessions** are stored in `sb-…` cookies, not in `localStorage`, so they're kept apart from game saves.
- **On each visit** the saved session is checked:
  - **How:** tokens signed with an asymmetric key are verified locally against the project's public keys. Older HS256 tokens are checked with Supabase's `/auth/v1/user`. Neither check can change the stored session.
  - **Rejected,** for example because the account was deleted: the session is cleared and the player becomes a guest.
  - **Unreachable:** the session is kept and checked again on the next visit.
- **A newer change always wins.** If the player signs in or out, here or in another tab, while that check is still running, the check's result is dropped. A rejected session is cleared only if it's still the current one, never a session that replaced it. Finishing a sign-in waits briefly for the check, so the two never overlap in one tab.
- **Sign out** affects this browser only. If the server can't be reached, the player is still signed out here, and the server session expires on its own.

| Problem | What the player sees |
| --- | --- |
| Expired or already-used link | "This link has expired", and a way back to Settings |
| Malformed link, or a visit with no link | "This sign-in link isn't valid" or "no link was found" |
| Link opened in a different browser (Supabase's default email only) | How to fix it |
| No connection while finishing | A **Try again** button that reuses the same link |
| Too many emails requested, or another email error | A specific message |

A sign-in always ends on `/settings`. Links can't choose where they send people, so there's no open redirect.

## Files

| File | Role |
| --- | --- |
| `src/app/auth/privileged-key-guard.ts` | Detects secret and service-role keys in `NEXT_PUBLIC_` variables. Used by `next.config.ts` and the server. |
| `src/app/auth/server-config.ts` | Server only: reads and checks the two variables on every render, and passes them to the browser |
| `src/app/auth/supabase-config.ts` | Checks a URL and key, and the browser checks them again before use |
| `src/app/auth/supabase-client.ts` | The browser's Supabase client |
| `src/app/auth/auth-session.ts` | Requesting links, reading and finishing them, checking tokens and stored sessions, signing out, error messages |
| `src/app/auth/auth-controller.ts` | Tracks who's signed in, and makes sure an outdated session check can't override a newer sign-in or sign-out |
| `src/app/auth/auth-provider.tsx` | `AuthProvider` and `useAuth()`, separate from the quest store |
| `src/app/auth/confirm/page.tsx` | The `/auth/confirm` page |
| `src/app/settings/account-section.tsx` | The Account card in Settings |
| `supabase/templates/*.html` | Email templates, used by the local stack and pasted into the Dashboard |

There's no `proxy.ts`. Supabase's Next.js guide uses one so that server code can read and refresh the session. In Plantetary, only the browser uses the session, and the browser client refreshes its own tokens. It will be added when server code needs the session, such as account deletion in Stage 10.

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Where to find it |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Dashboard → **Project Settings → Data API** → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Dashboard → **Project Settings → API Keys** → Publishable key (`sb_publishable_…`). An older `anon` key also works. |

- **Both values are public.** They're built into the browser app, and Row Level Security protects the data.
- **Never use a secret key (`sb_secret_…`) or the `service_role` key.** If any `NEXT_PUBLIC_` variable holds one, `npm run dev` and `npm run build` stop with an error that names the variable but never shows its value. If one is added while the dev server is running, pages stop rendering instead.
- **How the values reach the browser:** browser code never reads these variables itself, so Next.js never builds them into JavaScript. The server checks them and passes them to the page.
- **Rebuild after changing them** for production, because static pages are rendered when the app is built. The dev server picks up changes on the next page load.
- **Hosting:** set the same two variables in your hosting provider's environment settings.
- **Without them:** the Account card says sign-in isn't set up, and guest mode works as usual.

## Supabase Dashboard settings

Replace `https://your-site.example` with the address Plantetary is served from.

1. **Authentication → Sign In / Providers → Email.** Leave the Email provider on. "Confirm email" can stay on: new players then get the "Confirm signup" email, which step 3 updates too.

2. **Authentication → URL Configuration.**
   - **Site URL:** `https://your-site.example`
   - **Redirect URLs:** add each address that may receive sign-in links:
     - `https://your-site.example/auth/confirm`
     - `http://localhost:3000/auth/confirm`, for local development
     - `http://127.0.0.1:3000/auth/confirm`, if you open the dev server that way

   If a link's address isn't listed, Supabase sends it to the Site URL instead. Plantetary forwards it to `/auth/confirm`, but list every address you use so links go straight there.

3. **Authentication → Email Templates.** Update these two templates:

   | Template | Subject | Body |
   | --- | --- | --- |
   | **Magic Link** | `Your Plantetary sign-in link` | Contents of `supabase/templates/magic-link.html` |
   | **Confirm signup** | `Confirm your Plantetary account` | Contents of `supabase/templates/confirmation.html` |

   Both send `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email`. That works from any browser or device, and it only signs in when the player presses the button.

   Skipping this step still works, but the link only works in the browser where it was requested, and an email scanner can use it up.

4. **Authentication → Emails → SMTP Settings.** Supabase's built-in email service only sends to members of your Supabase organization, and only a few emails an hour. That's enough for testing. Before inviting players, add your own SMTP provider. Until then, other addresses see "Sign-in emails can't be sent to that address yet."

5. **Authentication → Rate Limits.** Review the email limit once SMTP is set up. By default, a player can request a link once a minute, and each link expires after an hour.

6. **Keep anonymous sign-ins off.** Guest mode doesn't use them.

## Testing

| Command | What it checks |
| --- | --- |
| `npm test` | `tests/auth.test.ts` covers the config checks, link parsing, error messages and sign-out. `tests/auth-restore.test.ts` covers token checks, including real ES256 signatures, and sign-ins and sign-outs during a session check. `tests/privileged-key-guard.test.ts` covers secret-key detection and `next.config.ts`. All use fakes and dummy keys. |
| `npm run test:e2e` | `e2e/auth-race.spec.ts` covers signing in, and signing out in another tab, while a session check is pending, and asymmetric-key sessions. `e2e/auth.spec.ts` covers guest mode, requesting a link, finishing sign-in, expired and invalid links, restoring after a refresh, rejected sessions, sign-out and its failures, and proof that game saves don't change |

The browser tests point the app at a fake project on a closed local port, set in `playwright.config.ts`. They answer its Auth requests themselves, so no real project is used and nothing leaves the computer.

To try the real flow locally:

```bash
npx supabase start
npx supabase status    # copy API_URL and PUBLISHABLE_KEY into .env.local
npm run dev            # on port 3000, which config.toml allows
```

Request a link in Settings, then open the email in the local mail viewer at <http://127.0.0.1:55324>.
