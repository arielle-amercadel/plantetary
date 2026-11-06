import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseConfig, type SupabaseBrowserConfig } from "./supabase-config";

let cached: { url: string; key: string; client: SupabaseClient } | undefined;

/**
 * The browser's Supabase client for the config the server passed down, or null when sign-in isn't
 * configured. The config is checked again here as a second line of defence, so a secret or
 * service-role key is never used even if one got this far.
 *
 * The client keeps the session in cookies, separate from the `localStorage` keys that hold game saves.
 */
export function getSupabaseBrowserClient(config: SupabaseBrowserConfig | null): SupabaseClient | null {
  if (!config || typeof window === "undefined") return null;
  const checked = readSupabaseConfig(config.url, config.key);
  if (!checked.ok) return null;

  const { url, key } = checked.config;
  if (cached && cached.url === url && cached.key === key) return cached.client;

  const client = createBrowserClient(url, key, {
    // Only these settings, so a second call with the same project returns this same client.
    isSingleton: false,
    auth: {
      // Sign-in links are handled only by /auth/confirm, never by whichever page happens to load.
      detectSessionInUrl: false,
    },
  });
  cached = { url, key, client };
  return client;
}
