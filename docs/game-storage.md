# Game storage

The garden (quests, XP, streaks, history and plants) is saved in one of two places:

- **This browser** (`localStorage`), for guests, exactly as before accounts existed.
- **The player's account** (Supabase `quest_saves`), for a verified sign-in that chose a cloud garden.

Both go through the same asynchronous `GameStorage` interface, the same validation and upgrades (`readQuestSave`), and the same save session, so the quest store doesn't know which one it's using. Profile and reminder preferences stay in this browser for now.

This page starts with an overview, then documents each part in the order it was built (Stage 5 and Stage 7 Steps 1–6). Database tables and migrations are in [supabase-database.md](supabase-database.md); sign-in is in [supabase-auth.md](supabase-auth.md).

## Overview

### Where the garden is saved

| Who's playing | Where | What the player sees |
| --- | --- | --- |
| Still checking who's signed in | Nothing is read or written | "Your quests will appear once your garden has loaded" |
| Guest, sign-in not set up, ended or unverified sign-in | This browser | The browser garden, as before. No save status unless a save fails |
| Verified sign-in, account has no cloud save yet | Nothing until the player chooses | **Start your cloud garden?** — a fresh cloud garden, or keep playing on this device |
| Verified sign-in with a cloud save | The account | The cloud garden, with a save-status pill in the top bar |
| Verified sign-in that chose this device | This browser | The browser garden; Settings → Account offers to switch back |

- **Only a verified sign-in has an account ID** (see [supabase-auth.md](supabase-auth.md)), so only it can reach a cloud save. An unverified session (for example, offline) plays the browser garden and never touches the cloud.
- **Nothing is uploaded automatically.** Signing in never copies browser progress to the account, and a fresh cloud garden starts from the starter quests. Importing browser progress is Stage 8.
- **Signing in or out never changes the browser save.**
- **Account changes are isolated.** When the account changes (here or in another tab), the old save session closes before the new one starts, the data on screen is replaced, and nothing from one account can be shown for or saved to another.

### How a cloud save is written

1. Each change waits 750 ms, so a burst of changes is one write.
2. The write is an update `where user_id = <this account> and revision = <the last revision seen here>`. The database bumps the revision on every write.
3. If it fails for a temporary reason (network, server), it's retried after 2, 5 and 15 seconds, then waits for **Try saving again** or the next change.
4. If the revision doesn't match, another tab or device saved first: that's a **conflict**. Nothing is overwritten; this tab's unsaved data is kept as a `conflict` backup in the account, and saving pauses until the player loads the latest garden.

### Conflicts and recovery, for the player

- **Save status** in the top bar: Saving…, Saved, Retrying…, Not saved, Saving paused.
- **A conflict** offers **Download my changes** and **Load latest garden** (which always asks first while anything is unsaved).
- **A save that keeps failing** offers **Try saving again** and **Download my changes**.
- **Signing out with unsaved changes** warns first (**Try saving again**, **Sign out anyway**, **Cancel**).
- **Leaving the page** with unsaved changes shows the browser's "Leave site?" prompt.
- **Changes left behind** (by an account change, or by closing or reloading the page before they were saved) are offered as **Some changes weren't saved**, for download only, and only to the account they belong to.

Downloads are JSON files of the whole garden. Nothing downloaded or kept for recovery is ever put back into a garden automatically.

## The pieces

| File | Role |
| --- | --- |
| `src/app/game-storage.ts` | The `GameStorage` interface (`load` and `save`, both async) and the browser adapter |
| `src/app/cloud-game-storage.ts` | The cloud adapter: one verified account's `quest_saves` row, conditional updates, conflict and upgrade backups, identity checks |
| `src/app/game-data-session.ts` | One storage's save session: load status, blocked writes, the pause, retries, conflicts, `flush`, `reload`, `close` |
| `src/app/game-storage-controller.ts` | Picks the storage from the auth state, owns the one session, tags data with a generation, keeps recoveries and their owners |
| `src/app/unsaved-recovery-store.ts` | Download-only copies of unsaved changes, kept in this tab's `sessionStorage` |
| `src/app/quest-storage.ts` | Reads, validates, upgrades and backs up the browser save. The checks and upgrades are in `readQuestSave`, shared with cloud saves |
| `src/app/quest-store.tsx` | The React provider: shows the controller's data, asks it to save after every change, page-visibility and leave-page handling |
| `src/app/storage-messages.ts` | Wording for problems, the save status and the leave-page rule |
| `src/app/save-status-indicator.tsx`, `src/app/storage-notices.tsx` | The save-status pill, and the notices (first-time choice, failed load, conflict, failing save, recoveries) |
| `src/app/settings/account-section.tsx` | Sign-out with unsaved changes, and switching back to the cloud garden |

## Loading states

The store exposes `storageStatus`. `hasRestored` is still available, and is true once the status isn't `loading`.

| Status | Meaning | Writes |
| --- | --- | --- |
| `loading` | The save hasn't been read yet | Blocked |
| `ready` | The save was read, or there wasn't one yet | Allowed |
| `failed` | Storage couldn't be read, or the save couldn't be backed up before it was upgraded | Blocked for the rest of the session |

After a failed load the app still shows what it could load, or the starter quests, and the player can keep playing. Nothing is saved, so the real save underneath is never replaced. This is how the app already behaved; the status now makes it explicit.

## When a save is written

- Only when the status is `ready`.
- Only when the data differs from what storage already has, compared as JSON text. Reloading without changes writes nothing.
- One write at a time. If changes arrive while a write is running, only the newest is written next.
- If a write is refused, for example because storage is full, the data isn't treated as saved. An error is logged, and the next change tries again. An adapter that throws, even before returning a promise, counts as a refused write, and later saves still run.

The browser adapter writes synchronously inside `save`, so a change is in `localStorage` before the next reload, as before.

## Cloud saves (Stage 7 Steps 1–3)

`createCloudGameStorage` implements the same interface for one verified account (`signed-in` only; no other auth state has a user ID).

- **Loading:** no row means `empty`, and nothing is created until the player chooses to. A save is checked with `readQuestSave`, like a browser save. An invalid save, or one from a newer version of Plantetary, is never replaced. An older save is kept as an `upgrade` backup (once per revision, separate from daily history) before it's upgraded, and isn't replaced if that backup fails.
- **Saving:** the first save inserts the row. Every later save updates only `where user_id = <this account> and revision = <the revision last loaded or saved here>`.
- **Conflicts:** if nothing matches, or the insert finds a row already there, another tab or device saved first. Nothing is overwritten. The unsaved data is stored as a `conflict` backup, and the result says whether that worked. Every later save reports the same conflict, without writing, until the save is loaded again.
- **Failures** (network, server, sign-in, access rules) leave the save unchanged, so trying again is safe. A save whose reply was lost may have reached the database; if so, the next save is a conflict, never an overwrite.
- **Identity:** before every request and after every reply, the auth state and the browser session's token must both still belong to the account. A session that **couldn't be read or refreshed** (`getSession()` returns no session *with an error*, as supabase-js does when the token expired while offline) isn't an account change: nothing is sent, the save fails as `network` (or `signed-out` for a refresh the server refused), and the adapter stays open, so saving resumes once the token can be refreshed. If the auth state changes, or the session is gone with no error, or its token is for another account, the adapter closes for good: a reply that arrives afterwards is never returned as data and causes no further writes (no backup, no next save). A write that did succeed is still reported as saved, because RLS only lets it reach the original account. RLS checks the token on the server either way.
- **Check failures (23514)** are told apart by the check named in the error: the format guard means `newer-version` (saving stops), `quest_saves_data_check` means `too-large`, and anything else is `rejected`. Neither of the last two stops later saves.

Save results are `saved`, `failed` (with a reason) or `conflict` (with whether the backup worked).

## Save states (Stage 7 Step 4)

The session publishes a save state (`getSnapshot` and `subscribe`, ready for React's `useSyncExternalStore`): `loading`, `load-failed`, `empty`, `saving`, `saved`, `error`, `conflict` or `closed`, plus `hasUnsavedChanges`. Step 6 shows it (see below).

| | Browser (default options) | Cloud (`cloudSessionOptions`) |
| --- | --- | --- |
| When a change is written | At once, synchronously, as before | After a 750 ms pause, with the newest change by then |
| Automatic retries | None, as before: the next change tries again | Up to 3 for temporary failures (network, server, unknown), after 2, 5 and 15 seconds, then it waits |

- **`retry()`** writes the newest unsaved change after an error. A new change also replaces a waiting retry and starts the count over, so retries are always limited.
- **Conflicts** stop all writing, automatic or manual. New changes are kept (and reported as unsaved) but not written. The conflict state's `backup` describes the newest unsaved change exactly: `saved` only if that exact data was backed up, `outdated` if the backup holds earlier changes, `failed` if none was made. **`reload()`** is the explicit way out: it reads the latest save and starts over from it. Unsaved changes are dropped only once that read succeeds, and the result says whether any were. If the session closes during a reload, or a newer reload replaces it, nothing changes and the result is `cancelled`.
- **`flush()`** writes a change waiting for the pause at once and resolves with the result, so a sign-out can check `hasUnsavedChanges` first and warn.
- **`close()`**, or storage reporting that the account changed (on a save or a load), ends the session the same way: listeners hear `closed` once, nothing more is written or announced after that, timers stop, and late replies change nothing visible. Unsaved changes stay readable through `getUnsavedData()`, so they're never silently lost.


## Choosing the storage (Stage 7 Step 5)

`game-storage-controller.ts` decides where the save lives from the auth state, and the quest store follows it. It owns one session at a time.

| Who's playing | Storage |
| --- | --- |
| Still checking who's signed in | Nothing is read or written yet |
| Guest, sign-in not set up, ended or unverified sign-in | This browser, as before |
| Verified sign-in | The account's cloud save |
| Verified sign-in that chose "Keep playing on this device" | This browser (remembered for this tab) |

- **First-time choice.** An account with no cloud save shows **Start your cloud garden?** Nothing is shown as its garden and nothing is written until the player picks. **Start a fresh cloud garden** saves starter data, never this browser's progress; if a save appeared meanwhile, that's a conflict, never an overwrite. **Keep playing on this device** plays the browser save and uploads nothing. Settings → Account can switch back to the cloud garden.
- **A cloud save that can't be loaded** shows **Your cloud garden couldn't be loaded**, with **Try again** and **Play on this device instead**. Starter data is never shown in its place, and nothing is written.
- **A browser save that can't be read safely** is shown with a warning that changes won't be saved this visit (this is the Stage 5 warning that was deferred to Stage 7).
- **Switching accounts or signing out** closes the old session first. The data on screen is tagged with a generation, and saves are refused for any other generation, so one account's garden is never shown for, or saved to, another.
- **Nothing can be played until the garden has loaded.** While checking who's signed in, loading, before the first-time choice, or after a failed cloud load, the quest lists are replaced by "Your quests will appear once your garden has loaded", and every change to the garden is refused by the quest store itself (`canPlay`, from `isGardenPlayable`), not only by hidden buttons.
- **Signing out** first writes waiting changes. If anything is still unsaved, Settings says what and why, and offers **Try saving again** (when it can help), **Sign out anyway** or **Cancel**. The preparation and the warning belong to the session and account that started them (a ticket): if the account or session changes while saving or while the warning is open, the sign-out is cancelled and says so, and **Sign out anyway** can only confirm the changes it showed.
- **A session that closes on its own** (its storage reported the account changed while the auth state didn't) takes the garden off the screen at once (**Your cloud garden couldn't be loaded**, **Try again**), so no later edit can be shown and silently lost. Its unsaved changes become a recovery notice for that account, and **Try again** starts a fresh session, which checks the account before loading.
- **The same account announced again** (supabase-js refreshed its token, and the auth controller checked it) retries a save that failed and is waiting, so saving resumes by itself after a sign-in refresh that failed offline. supabase-js won't retry a failed refresh for 60 seconds, so this can take up to about a minute and a half after reconnecting; **Try saving again** and the next change also retry.
- **Unsaved changes when the account changes elsewhere** (for example, another tab signs in as someone else) are never written to any storage. Each closed session's changes get their own notice, labelled with a partly hidden email (for example `mi•••@example.com`), offering a download. Notices stay until dismissed one by one; a later one never replaces an earlier one. Since the Step 6 follow-up, each notice is shown only to its own account (see **Recovery ownership** below).
- **Reset** is turned off while the garden is in the cloud, because it can only clear this browser.
- A save request with exactly the data already requested is never a new attempt, so renders can't cause retries.

## Save status and unsaved progress (Stage 7 Step 6)

- **Save-status indicator** (`save-status-indicator.tsx`, top bar; wording in `describeSaveStatus`). A cloud garden shows **Saving…**, **Saved**, **Retrying…** (an automatic retry is waiting), **Not saved** (no retry waiting) or **Saving paused** (conflict). A browser garden saves at once, so it only shows something when a save failed. The full sentence is in a live region for screen readers. Under 480 px wide, "Saving…" and "Saved" shrink to their dot.
- **A save that keeps failing** (no automatic retry left, or a failure that retrying won't fix, such as `too-large`) shows **Your latest changes haven't been saved**, with **Try saving again** and **Download my changes**.
- **A conflict** shows **Your garden changed somewhere else**, says what the conflict backup holds, and offers **Download my changes** and **Load latest garden**. Loading always asks first (**Load latest anyway** / **Cancel**) while anything is unsaved, even after a download, because changes made since aren't in that copy. **Cancel** changes nothing. If loading the latest fails, the failed-load card offers **Download unsaved changes**, because those changes are then off the screen and only in the session.
- **Leaving the page** (`shouldWarnBeforeLeaving`): the browser's own "Leave site?" prompt appears while anything is unsaved (including a change waiting for the 750 ms pause), while a notice about changes from an account change hasn't been dismissed, or while kept changes (shown or hidden) exist only on this page (`recoveriesAtRisk`: a guest's, or ones the tab couldn't store). The prompt is the browser's own, so it says nothing about whose changes they are. Leaving also starts writing a waiting change at once.
- **Emergency recovery** (`unsaved-recovery-store.ts`), **best effort**. When the page is hidden or closed with unsaved **cloud** changes, a copy is kept in **sessionStorage** (this tab only; at most 5 entries, shared with account-change entries, oldest dropped first), kept up to date while hidden, and removed once saved or when the page is shown again. On a later page in that tab it's offered as **Some changes weren't saved**, for **download only**: never written to, uploaded to or restored into any garden.
  - **Only for its own account:** see **Recovery ownership** below.
  - Before it's first listed, it's compared with its account's loaded cloud garden; if that already holds exactly those changes (a write that finished as the page closed), it's dropped unseen. Otherwise it stays until dismissed.
  - **Not guaranteed.** It covers reloads and in-tab navigation. Closing the tab normally ends sessionStorage (a browser's "reopen closed tab" may restore it); a crash, a mobile browser killing the tab without `pagehide`/`visibilitychange`, a full or blocked sessionStorage, or a 6th entry can each lose it. The "Leave site?" prompt is the main protection.
  - *Why so small:* sessionStorage limits how long account data outlives the visit on a shared device, and download-only means no merging or uploading, which belong to Stage 8 (importing) and Stage 9 (synchronization).
- **Recovery ownership** (Codex Step 6 follow-up). Every kept entry, whether `account-changed` (Step 5) or `page-left`, records its owner (`ownerId`), in memory and in the tab, and one rule (`isRecoveryVisible`) decides whether it's listed, downloadable (`getRecoveryData`, checked at the moment of the click, so a notice drawn earlier can't download anything later) or dismissable:
  - **An account's** changes (its cloud garden, or its garden on this device): only while that account is the verified sign-in and its garden is the current one. Not for another account, a guest, a sign-in that's still being checked, ended or can't be verified (even the same email).
  - **This browser's own** changes (a guest, or an ended or unverified sign-in, playing the browser garden): only while the browser garden is playing with no account signed in. Never for a signed-in account, even one playing on this device.
  - Hidden entries are **kept**, never deleted, across sign-out and account switches, and listed again when their owner is back (A → B → A). An account's `account-changed` entries are also kept in the tab, like `page-left` ones, so a reload while they're hidden doesn't lose them; a guest's stay in memory only, so leaving the page warns. Whether any entry exists only on this page is worked out again after every write to the tab, from what the tab actually kept, so an entry evicted by the 5-entry limit still makes leaving warn.
  - A write that finishes late (after the account changed) and turns out to have saved clears only its own entry. Nothing is ever uploaded or restored to any garden.

## Known limitations

- **One device's changes at a time.** There's no merging: after a conflict, the player keeps one version (the latest, after downloading their own if they want). Synchronizing or merging changes is Stage 9.
- **Saving after an offline token expiry waits for supabase-js.** While the token can't be refreshed, every save fails as `network` without sending anything; once it refreshes, the waiting save goes. That can take up to about 90 seconds after reconnecting.
- **A lost reply looks like a conflict.** If a write reaches the database but the reply never arrives, the retry finds a newer revision and reports a conflict, even though the newer revision is the player's own change. Nothing is lost or written twice; **Load latest garden** shows it. After a reload, the kept copy matches the cloud save and is dropped silently.
- **Emergency recovery is best effort** (see Step 6): it lives in one tab's `sessionStorage`, holds at most 5 entries, and can be lost to closing the tab, a crash, a mobile browser killing the tab, or blocked storage. The "Leave site?" prompt is the main protection. A guest's recoveries are kept in memory only.
- **Downloaded recovery files can't be imported yet.** They're plain JSON of the garden; importing comes with Stage 8.
- **Reset is turned off for a cloud garden**, because it can only clear this browser. Account deletion and cloud reset are Stage 10.
- **Profile and reminder preferences** still read and write `localStorage` directly from `settings-logic.ts`, for every player.
- **Reset** (browser garden) still clears `localStorage` directly, then reloads the page.
- **No React-level unit tests of the provider.** There's no DOM test environment. The provider is covered by the browser tests, which now include slow and failed cloud loads, unmounting, account changes and multiple tabs.

## Testing

| Command | Covers | Needs |
| --- | --- | --- |
| `npm test` | Unit tests. For storage: `tests/game-storage.test.ts`, `cloud-game-storage.test.ts`, `game-data-session.test.ts`, `game-storage-controller.test.ts`, `unsaved-recovery-store.test.ts`, `save-status.test.ts`, `quest-storage.test.ts` | Nothing |
| `npm run test:e2e` | Browser tests. For cloud saves: `e2e/cloud-save.spec.ts` (first-time choice, loading, saving, reloads, A → B → A, two tabs, retries, conflicts, sign-out, recoveries, leave-page prompt, interrupted saves). Auth: `e2e/auth*.spec.ts` | Chromium (`npx playwright install chromium`). No Supabase project |
| `npx supabase test db` | Database rules, triggers and concurrency (pgTAP), on a local stack | Docker; see [supabase-database.md](supabase-database.md) |

The browser tests never use a real Supabase project. Playwright starts its own dev server on port 3100 with `NEXT_PUBLIC_SUPABASE_URL` pointing at a closed local port, and answers every Auth and database request itself with a fake that follows the real rules (RLS by token, revisions, one save per account). **Don't run them against a dev server you started yourself** (`E2E_PORT`) if that server uses a real project in `.env.local`: the fake only answers requests to its own address, so the app would talk to the real project.
