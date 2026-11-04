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

## Tech Stack

- [Next.js 16](https://nextjs.org) and [React 19](https://react.dev)
- [TypeScript](https://www.typescriptlang.org)
- [Tailwind CSS 4](https://tailwindcss.com)
- [Vitest](https://vitest.dev) for unit tests
- [Playwright](https://playwright.dev) for browser tests

## Data Storage

Your progress is currently saved only in your browser's `localStorage`, so it stays on that browser and device. Accounts and database storage are planned for a future version.

## Getting Started

You'll need [Node.js](https://nodejs.org) 20.19 or newer and npm.

```bash
git clone https://github.com/arielle-amercadel/plantetary.git
cd plantetary
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000). If that port is in use, Next.js picks another one and shows it in the terminal.

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

Playwright starts a development server on port 3100 and stops it when the tests finish, so you don't need to start one yourself.

Next.js allows only one development server per project. If Plantetary's is already running, either stop it first or point the tests at its port, replacing `3000` if yours is different:

```bash
E2E_PORT=3000 npm run test:e2e
```
