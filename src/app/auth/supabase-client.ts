import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseBrowserConfig } from "./supabase-config";

let client: SupabaseClient | null | undefined;

/**
 * The browser's Supabase client, or null when sign-in isn't configured. It keeps the session in
 * cookies, separate from the `localStorage` keys that hold game saves.
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  if (typeof window === "undefined") return null;

  const config = getSupabaseBrowserConfig();
  client = config
    ? createBrowserClient(config.url, config.key, {
      auth: {
        // Sign-in links are handled only by /auth/confirm, never by whichever page happens to load.
        detectSessionInUrl: false,
      },
    })
    : null;
  return client;
}
