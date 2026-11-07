import type { NextConfig } from "next";
import { assertNoExposedPrivilegedKeys } from "./src/app/auth/privileged-key-guard";

// Next.js loads .env files before this config, so this stops `next dev` and `next build` before a
// Supabase secret or service-role key in a NEXT_PUBLIC_ variable can be built into browser code.
// The error names the variable, never its value.
assertNoExposedPrivilegedKeys(process.env);

/**
 * Sent with every response. Vercel already adds Strict-Transport-Security.
 *
 * - Clickjacking: no other site may show Plantetary in a frame, so nobody can trick a player into
 *   pressing "Finish signing in" or "Replace my cloud garden" behind a disguise. `frame-ancestors` is the
 *   modern rule; `X-Frame-Options` covers older browsers.
 * - The policy only covers framing, `<base>`, plugins and form targets, none of which the app uses. It
 *   doesn't restrict scripts: that would need a nonce per request, which would stop pages being prerendered.
 * - `nosniff`: files are only ever treated as the type the server says they are.
 * - Referrer: other sites see only the origin (https://plantetary.vercel.app), never a path or query, such
 *   as a sign-in link's token on /auth/confirm.
 * - Permissions: the app uses no camera, microphone, location or payment features, so no page may.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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
