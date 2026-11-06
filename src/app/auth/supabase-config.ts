/**
 * Reads the Supabase project URL and browser key. Only the publishable key (or the older anon key)
 * belongs in the browser. A secret or service-role key bypasses every database rule, so one is
 * refused here, and sign-in stays off, rather than being shipped to players.
 */

export type SupabaseBrowserConfig = { url: string; key: string };

export type SupabaseConfigResult =
  | { ok: true; config: SupabaseBrowserConfig }
  | { ok: false; reason: "missing" | "invalid-url" | "url-has-path" | "secret-key" | "invalid-key" };

function decodeJwtRole(key: string): string | undefined {
  const parts = key.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accepts only a project's base URL, such as https://<ref>.supabase.co. The client adds /auth/v1 and
 * /rest/v1 itself, so a URL that already has a path would send every request to the wrong place.
 * Returns the URL without any trailing slash, or why it was refused.
 */
function checkProjectUrl(value: string): { ok: true; url: string } | { ok: false; reason: "invalid-url" | "url-has-path" } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.username || url.password) return { ok: false, reason: "invalid-url" };
  const isHttps = url.protocol === "https:";
  // Plain HTTP is only for a Supabase stack running on this computer.
  const isLocalHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (!isHttps && !isLocalHttp) return { ok: false, reason: "invalid-url" };

  if (url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash || /[?#]/.test(value)) {
    return { ok: false, reason: "url-has-path" };
  }
  return { ok: true, url: url.origin };
}

export function readSupabaseConfig(url: string | undefined, key: string | undefined): SupabaseConfigResult {
  const trimmedUrl = url?.trim() ?? "";
  const trimmedKey = key?.trim() ?? "";
  if (!trimmedUrl || !trimmedKey) return { ok: false, reason: "missing" };
  const projectUrl = checkProjectUrl(trimmedUrl);
  if (!projectUrl.ok) return { ok: false, reason: projectUrl.reason };

  if (trimmedKey.startsWith("sb_secret_")) return { ok: false, reason: "secret-key" };
  if (trimmedKey.startsWith("sb_publishable_")) {
    return { ok: true, config: { url: projectUrl.url, key: trimmedKey } };
  }

  const role = decodeJwtRole(trimmedKey);
  if (role === "anon") return { ok: true, config: { url: projectUrl.url, key: trimmedKey } };
  if (role !== undefined) return { ok: false, reason: "secret-key" };
  return { ok: false, reason: "invalid-key" };
}

const configMessages: Record<Exclude<SupabaseConfigResult, { ok: true }>["reason"], string | undefined> = {
  missing: undefined,
  "invalid-url": "Plantetary sign-in is off: NEXT_PUBLIC_SUPABASE_URL isn't a valid https URL.",
  "url-has-path":
    "Plantetary sign-in is off: NEXT_PUBLIC_SUPABASE_URL should be just the project URL, like " +
    "https://your-project-ref.supabase.co, with nothing after it (no /rest/v1, /auth/v1 or other path).",
  "secret-key":
    "Plantetary sign-in is off: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY looks like a secret or service-role key. " +
    "Use the publishable key, and rotate the secret key if it was ever shared.",
  "invalid-key": "Plantetary sign-in is off: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY isn't a publishable or anon key.",
};

let cachedConfig: SupabaseConfigResult | undefined;

/** The project's config, read once. Next.js inlines these two values when the app is built. */
export function getSupabaseBrowserConfig(): SupabaseBrowserConfig | null {
  if (!cachedConfig) {
    cachedConfig = readSupabaseConfig(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    );
    if (!cachedConfig.ok) {
      const message = configMessages[cachedConfig.reason];
      if (message) console.error(message);
    }
  }
  return cachedConfig.ok ? cachedConfig.config : null;
}
