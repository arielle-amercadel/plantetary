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
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    // Sign-in talks to a fake Supabase project on a closed local port. The auth tests answer its requests
    // themselves (e2e/auth-support.ts), and anything they don't answer fails without leaving this machine.
    // These override any real values in .env.local.
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54999",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_plantetary-e2e",
    },
  },
});
