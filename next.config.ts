import type { NextConfig } from "next";
import { assertNoExposedPrivilegedKeys } from "./src/app/auth/privileged-key-guard";

// Next.js loads .env files before this config, so this stops `next dev` and `next build` before a
// Supabase secret or service-role key in a NEXT_PUBLIC_ variable can be built into browser code.
// The error names the variable, never its value.
assertNoExposedPrivilegedKeys(process.env);

const nextConfig: NextConfig = {
  /* config options here */
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
