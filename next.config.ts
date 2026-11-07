import type { NextConfig } from "next";
import { assertNoExposedPrivilegedKeys } from "./src/app/auth/privileged-key-guard";

// Next.js loads .env files before this config, so this stops `next dev` and `next build` before a
// Supabase secret or service-role key in a NEXT_PUBLIC_ variable can be built into browser code.
// The error names the variable, never its value.
assertNoExposedPrivilegedKeys(process.env);

const nextConfig: NextConfig = {
  // Normally `.next`. The browser tests build into `.next/e2e` (see playwright.config.ts), so their
  // build, made with a fake Supabase project, never replaces the real production build.
  distDir: process.env.PLANTETARY_DIST_DIR || ".next",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
