/**
 * Reads the Supabase project URL and browser key. Only the publishable key (or the older anon key)
 * belongs in the browser. A secret or service-role key bypasses every database rule.
 *
 * The main protection is next.config.ts, which stops `next dev` and `next build` before such a key
 * is built into the app (see privileged-key-guard.ts). This check is a second line of defence: if one
 * ever slips through, sign-in stays off instead of using it.
 */
import { isPrivilegedSupabaseKey, readSupabaseJwtRole } from "./privileged-key-guard";

export type SupabaseBrowserConfig = { url: string; key: string };

export type SupabaseConfigResult =
  | { ok: true; config: SupabaseBrowserConfig }
  | { ok: false; reason: "missing" | "invalid-url" | "url-has-path" | "secret-key" | "invalid-key" };

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

  if (isPrivilegedSupabaseKey(trimmedKey)) return { ok: false, reason: "secret-key" };
  if (trimmedKey.startsWith("sb_publishable_")) {
    return { ok: true, config: { url: projectUrl.url, key: trimmedKey } };
  }

  const role = readSupabaseJwtRole(trimmedKey);
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

/** A message for the developer, naming the setting but never including its value. */
export function describeConfigProblem(reason: Exclude<SupabaseConfigResult, { ok: true }>["reason"]): string | undefined {
  return configMessages[reason];
}
