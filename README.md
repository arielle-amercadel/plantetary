# Plantetary

A cozy, plant-themed gamified quest and habit tracker. Complete small daily and personal quests to earn XP, keep your streak going, and grow a collection of pixel-art plants.

## Features

- **Daily quests:** recurring habits that run every day or on the days you choose, and reset each day.
- **Personal quests:** one-time goals with optional due dates and past-due indicators.
- **XP and levels:** Easy, Medium, and Hard quests earn 5, 10, and 20 XP.
- **Streaks:** count the days you finish every scheduled daily quest. Days with nothing scheduled don't break a streak.
- **Categories:** built-in categories, plus your own custom ones.
- **Plant rewards:** earn wrapped plant gifts at XP milestones and unwrap them to add to your collection.
- **Plant Journal:** browse all 16 collectible plants and see your progress toward the next one.
- **Progress tracking:** today's and overall completion counts, plus a dated completion history.
- **Settings:** set your display name and avatar, save reminder preferences, export your data as JSON, or reset your progress. Reminder preferences are only saved for now; Plantetary doesn't send notifications yet.
- **Optional sign-in and cloud saves:** sign in with an emailed link, with no password, and keep your garden in your account. Guest mode works without an account, and signing in never changes or uploads your browser progress.

## Tech Stack

- [Next.js 16](https://nextjs.org) and [React 19](https://react.dev)
- [TypeScript](https://www.typescriptlang.org)
- [Tailwind CSS 4](https://tailwindcss.com)
- [Vitest](https://vitest.dev) for unit tests
- [Playwright](https://playwright.dev) for browser tests

## Data Storage

- **Guests** play with progress saved in this browser's `localStorage`, exactly as before accounts existed.
- **Signed in,** a player can start a **cloud garden** saved to their account in Supabase, or keep playing with this browser's progress. Nothing is uploaded automatically: a new cloud garden starts fresh, and importing browser progress comes in a later version.
- Cloud saves are protected against overwriting: if another tab or device saved first, Plantetary pauses saving, keeps a backup, and lets the player download their changes and load the latest garden. A small indicator in the top bar shows whether changes are saved.

See [docs/game-storage.md](docs/game-storage.md) for how saving, conflicts and recovery work, [docs/supabase-auth.md](docs/supabase-auth.md) for sign-in, and [docs/supabase-database.md](docs/supabase-database.md) for the database, its migrations and its tests.

## Getting Started

You'll need [Node.js](https://nodejs.org) 20.19 or newer and npm.

```bash
git clone https://github.com/arielle-amercadel/plantetary.git
cd plantetary
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000). If that port is in use, Next.js picks another one and shows it in the terminal.

To turn on sign-in, copy `.env.example` to `.env.local` and add your Supabase project's URL and publishable key. Without them, Plantetary runs in guest mode only. See [docs/supabase-auth.md](docs/supabase-auth.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the development server |
| `npm test` | Runs the unit tests |
| `npm run test:e2e` | Runs the browser tests |
| `npm run lint` | Checks the code with ESLint |
| `npm run build` | Creates a production build |
| `npm start` | Serves the production build |

## Browser Tests

Browser tests live in `e2e/` and run in Chromium. Install the browser once:

```bash
npx playwright install chromium
```

Then run the tests:

```bash
npm run test:e2e
```

Playwright makes a production build of the app (in `.next/e2e`, so it never replaces your own build in `.next`), serves it on port 3100, and stops it when the tests finish, so you don't need to start anything yourself. A production build is used because the development server's hot reloading can interrupt page navigations while several tests run at once. To debug against the development server instead, run `E2E_DEV=1 npm run test:e2e`.

The browser tests never use a real Supabase project: Playwright's server points the app at a fake project that the tests answer themselves.

With `E2E_DEV=1`, stop your own development server first: Next.js allows only one per project. You can point the tests at a running server instead with `E2E_PORT=3000 npm run test:e2e`, but **only if that server has no Supabase values in `.env.local`**: a reused server keeps its own settings, so the tests would sign in to, and write to, your real project.

## Database Tests

The database's access rules and triggers have their own tests, which run in a throwaway local Supabase stack in Docker:

```bash
npx supabase start
npx supabase test db
npx supabase stop
```

See [docs/supabase-database.md](docs/supabase-database.md), which also explains how to apply migrations to a hosted project.
