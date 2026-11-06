import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrivilegedKeyExposedError,
  assertNoExposedPrivilegedKeys,
  findExposedPrivilegedKeys,
  isPrivilegedSupabaseKey,
} from "../src/app/auth/privileged-key-guard";
import { readSupabaseConfig } from "../src/app/auth/supabase-config";

// Every key here is a dummy made up for these tests. None belongs to a real project.
const DUMMY_SECRET = "sb_secret_DUMMYnotARealKey0000000000";
const DUMMY_PUBLISHABLE = "sb_publishable_DUMMYnotARealKey0000";

function dummyJwt(payload: object) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.dummy-signature`;
}

const DUMMY_SERVICE_ROLE = dummyJwt({ iss: "supabase", ref: "dummyref", role: "service_role" });
const DUMMY_ANON = dummyJwt({ iss: "supabase", ref: "dummyref", role: "anon" });

// These tests reload modules, so errors are matched by name and message rather than with instanceof.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("recognising privileged Supabase keys", () => {
  it.each([
    ["a secret key", DUMMY_SECRET],
    ["a secret key with spaces around it", `  ${DUMMY_SECRET}\n`],
    ["a secret key inside another value", `https://example.com/?apikey=${DUMMY_SECRET}`],
    ["a service_role JWT", DUMMY_SERVICE_ROLE],
    ["a supabase_admin JWT", dummyJwt({ iss: "supabase", role: "supabase_admin" })],
    ["a signed-in user's token", dummyJwt({ iss: "https://dummyref.supabase.co/auth/v1", role: "authenticated" })],
  ])("flags %s", (_label, value) => {
    expect(isPrivilegedSupabaseKey(value)).toBe(true);
  });

  it.each([
    ["a publishable key", DUMMY_PUBLISHABLE],
    ["a legacy anon JWT", DUMMY_ANON],
    ["a project URL", "https://dummyref.supabase.co"],
    ["an unrelated JWT", dummyJwt({ iss: "other-service", role: "user" })],
    ["plain text", "hello"],
    ["an empty value", ""],
  ])("allows %s", (_label, value) => {
    expect(isPrivilegedSupabaseKey(value)).toBe(false);
  });
});

describe("checking the environment before building", () => {
  it("names every NEXT_PUBLIC_ variable that holds a privileged key", () => {
    expect(findExposedPrivilegedKeys({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_SECRET,
      NEXT_PUBLIC_SUPABASE_URL: "https://dummyref.supabase.co",
      NEXT_PUBLIC_ANALYTICS_KEY: DUMMY_SERVICE_ROLE,
    })).toEqual(["NEXT_PUBLIC_ANALYTICS_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
  });

  it("ignores server-only variables, which Next.js never sends to the browser", () => {
    expect(findExposedPrivilegedKeys({
      SUPABASE_SECRET_KEY: DUMMY_SECRET,
      SUPABASE_SERVICE_ROLE_KEY: DUMMY_SERVICE_ROLE,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE,
    })).toEqual([]);
  });

  it("allows valid publishable and anon keys", () => {
    expect(() => assertNoExposedPrivilegedKeys({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE })).not.toThrow();
    expect(() => assertNoExposedPrivilegedKeys({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_ANON })).not.toThrow();
    expect(() => assertNoExposedPrivilegedKeys({})).not.toThrow();
  });

  it("stops with a message that names the variable but never shows the key", () => {
    let thrown: unknown;
    try {
      assertNoExposedPrivilegedKeys({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_SECRET, NEXT_PUBLIC_OTHER: DUMMY_SERVICE_ROLE });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PrivilegedKeyExposedError);
    const error = thrown as PrivilegedKeyExposedError;
    expect(error.variableNames).toEqual(["NEXT_PUBLIC_OTHER", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
    const everything = `${error.message}\n${error.stack ?? ""}`;
    expect(everything).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(everything).toContain("publishable key");
    for (const secret of [DUMMY_SECRET, DUMMY_SERVICE_ROLE, "DUMMYnotARealKey", DUMMY_SERVICE_ROLE.split(".")[1]]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("next.config.ts", () => {
  it("refuses to load, so dev and build stop, when a NEXT_PUBLIC_ variable holds a secret key", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", DUMMY_SECRET);

    await expect(import("../next.config")).rejects.toMatchObject({ name: "PrivilegedKeyExposedError" });
  });

  it("refuses to load with a service-role key", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", DUMMY_SERVICE_ROLE);

    await expect(import("../next.config")).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret/);
  });

  it("loads normally with a publishable key", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://dummyref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", DUMMY_PUBLISHABLE);

    const config = (await import("../next.config")).default;
    expect(config.turbopack).toBeDefined();
  });
});

describe("the settings the server passes to the browser", () => {
  it("are refused outright when a secret key is set, so nothing is rendered", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://dummyref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", DUMMY_SECRET);
    const { getSupabaseConfigForBrowser } = await import("../src/app/auth/server-config");

    expect(() => getSupabaseConfigForBrowser()).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret/);
  });

  it("read the current environment on every call, so a changed .env file is checked again", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://dummyref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", DUMMY_PUBLISHABLE);
    const { getSupabaseConfigForBrowser } = await import("../src/app/auth/server-config");
    expect(getSupabaseConfigForBrowser()).toEqual({ url: "https://dummyref.supabase.co", key: DUMMY_PUBLISHABLE });

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", DUMMY_SECRET);
    expect(() => getSupabaseConfigForBrowser()).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a Supabase secret/);
  });

  it("are null, leaving guest mode, when nothing is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const { getSupabaseConfigForBrowser } = await import("../src/app/auth/server-config");

    expect(getSupabaseConfigForBrowser()).toBeNull();
  });

  it("keep the browser-side check as a second line of defence", () => {
    expect(readSupabaseConfig("https://dummyref.supabase.co", DUMMY_SECRET)).toEqual({ ok: false, reason: "secret-key" });
    expect(readSupabaseConfig("https://dummyref.supabase.co", DUMMY_SERVICE_ROLE)).toEqual({ ok: false, reason: "secret-key" });
    expect(readSupabaseConfig("https://dummyref.supabase.co", DUMMY_PUBLISHABLE).ok).toBe(true);
  });
});
