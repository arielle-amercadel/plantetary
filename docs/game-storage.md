# Game storage

The game save loads and saves through an asynchronous storage interface, so a cloud adapter can be added later without changing the quest store. Today the only adapter is browser storage, which uses the same `localStorage` keys and save format as before.

## The pieces

| File | Role |
| --- | --- |
| `src/app/game-storage.ts` | The `GameStorage` interface (`load` and `save`, both async) and the browser adapter |
| `src/app/game-data-session.ts` | Tracks the load status, blocks unsafe writes, skips unchanged saves and runs saves in order |
| `src/app/quest-storage.ts` | Reads, validates, upgrades and backs up the browser save, unchanged from before |
| `src/app/quest-store.tsx` | Loads through the session once, then asks it to save after every change |

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
- If a write is refused, for example because storage is full, the data isn't treated as saved. An error is logged, and the next change tries again.

The browser adapter writes synchronously inside `save`, so a change is in `localStorage` before the next reload, as before.

## Not covered yet

- Profile and reminder preferences still read and write `localStorage` directly from `settings-logic.ts`.
- Reset still clears `localStorage` directly, then reloads the page.
- There's no visible save status or error message. Failures are logged to the console, as before.
