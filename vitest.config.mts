import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Browser tests live in e2e/ and run through Playwright, not Vitest.
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
