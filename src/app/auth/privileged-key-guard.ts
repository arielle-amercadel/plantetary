/**
 * Stops privileged Supabase keys from reaching the browser.
 *
 * Next.js builds every `NEXT_PUBLIC_` variable into the browser's JavaScript, where anyone can read
 * it. A secret key or a `service_role` key there would let anyone bypass Row Level Security. This
 * runs from next.config.ts, so `next dev` and `next build` stop before anything is compiled.
 *
 * Messages name the variable but never include its value.
 */

/** Roles in a legacy Supabase JWT key that bypass Row Level Security. */
const privilegedJwtRoles = new Set(["service_role", "supabase_admin"]);

function readJwtPayload(value: string): Record<string, unknown> | undefined {
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The `role` in a legacy Supabase JWT key, or undefined if the value isn't one. */
export function readSupabaseJwtRole(value: string): string | undefined {
  const role = readJwtPayload(value.trim())?.role;
  return typeof role === "string" ? role : undefined;
}

/**
 * True for a Supabase secret key (`sb_secret_…`, anywhere in the value) or a legacy JWT key whose
 * role bypasses Row Level Security, such as `service_role`.
 */
export function isPrivilegedSupabaseKey(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes("sb_secret_")) return true;
  const payload = readJwtPayload(trimmed);
  if (!payload) return false;
  const role = payload.role;
  if (typeof role !== "string") return false;
  if (privilegedJwtRoles.has(role)) return true;
  // Any other non-anon role issued by Supabase (for example a signed-in user's token) is private too.
  const issuer = payload.iss;
  return role !== "anon" && typeof issuer === "string" && issuer.includes("supabase");
}

/** Names of `NEXT_PUBLIC_` variables that hold a privileged Supabase key. Never their values. */
export function findExposedPrivilegedKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith("NEXT_PUBLIC_"))
    .filter((name) => {
      const value = env[name];
      return typeof value === "string" && isPrivilegedSupabaseKey(value);
    })
    .sort();
}

export class PrivilegedKeyExposedError extends Error {
  constructor(readonly variableNames: string[]) {
    super(
      `Plantetary stopped before building or serving the app: ${variableNames.join(", ")} ` +
        `${variableNames.length === 1 ? "holds" : "hold"} a Supabase secret or service-role key. ` +
        "Variables starting with NEXT_PUBLIC_ are built into the browser app, where anyone can read them. " +
        "Remove it from your .env files and hosting settings, and use the publishable key (sb_publishable_…) instead. " +
        "If the secret key was ever shared or deployed, rotate it in the Supabase Dashboard under Project Settings → API Keys.",
    );
    this.name = "PrivilegedKeyExposedError";
  }
}

/** Throws, naming only the variables, if any `NEXT_PUBLIC_` variable holds a privileged key. */
export function assertNoExposedPrivilegedKeys(env: Record<string, string | undefined>): void {
  const names = findExposedPrivilegedKeys(env);
  if (names.length > 0) throw new PrivilegedKeyExposedError(names);
}
