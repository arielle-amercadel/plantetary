import { defineConfig, devices } from "@playwright/test";

// A dedicated port keeps these tests from reaching another app on Next's default port, 3000.
// Next allows one dev server per project, so to test while Plantetary's dev server is already
// running, set E2E_PORT to its port and Playwright will reuse that server.
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // A production build by default. The dev server's hot reloading sends "rebuilding" messages to every
    // open page whenever it builds something, and the page then refreshes its router, which can drop a
    // navigation already under way (for example, the redirect after finishing a sign-in). With several
    // workers that happens often enough to fail tests that pass on their own. Production has no hot
    // reloading, and it's what players use. E2E_DEV=1 uses the dev server instead, for debugging.
    // The build goes to .next/e2e (next.config.ts), never replacing the real production build in .next.
    command: process.env.E2E_DEV
      ? `npm run dev -- --port ${port}`
      : `npx next build && npx next start --port ${port}`,
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 240_000,
    // Sign-in talks to a fake Supabase project on a closed local port. The auth tests answer its requests
    // themselves (e2e/auth-support.ts), and anything they don't answer fails without leaving this machine.
    // These override any real values in .env.local.
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54999",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_plantetary-e2e",
      PLANTETARY_DIST_DIR: process.env.E2E_DEV ? ".next" : ".next/e2e",
    },
  },
});
