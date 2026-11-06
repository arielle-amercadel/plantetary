import { assertNoExposedPrivilegedKeys } from "./privileged-key-guard";
import { describeConfigProblem, readSupabaseConfig, type SupabaseBrowserConfig } from "./supabase-config";

/**
 * Server only: reads the Supabase settings for the browser, called by the root layout on every render
 * (at build time for static pages).
 *
 * Browser code never reads `process.env.NEXT_PUBLIC_SUPABASE_*` itself, so Next.js never builds these
 * values into JavaScript. They reach the browser only as props, and only after this check passes.
 * That still holds when the dev server reloads a changed .env file without re-running next.config.ts.
 *
 * Variable names are looked up dynamically on purpose: Next.js inlines `process.env.NEXT_PUBLIC_X`
 * written out in full, but not a lookup by a variable name, so this always sees the current values.
 */
export function getSupabaseConfigForBrowser(): SupabaseBrowserConfig | null {
  const env = process.env;
  // Refuses to render anything if any NEXT_PUBLIC_ variable holds a secret or service-role key.
  assertNoExposedPrivilegedKeys(env);

  const urlName = "NEXT_PUBLIC_SUPABASE_URL";
  const keyName = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
  const result = readSupabaseConfig(env[urlName], env[keyName]);
  if (result.ok) return result.config;

  const message = describeConfigProblem(result.reason);
  if (message) console.error(message);
  return null;
}
