import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../src/app/auth/auth-controller";
import type { VerifiedSignIn } from "../src/app/cloud-game-storage";
import { cloudSessionOptions, createGameDataSession } from "../src/app/game-data-session";
import { createGameStorageController, isGardenPlayable, maskEmail } from "../src/app/game-storage-controller";
import type { GameSaveResult, GameStorage, GameStorageLoadResult } from "../src/app/game-storage";
import type { StoredQuestData } from "../src/app/quest-types";
import { createRecoveryStore, recoveryStorageKey, type PersistedRecovery } from "../src/app/unsaved-recovery-store";
import { shouldWarnBeforeLeaving } from "../src/app/storage-messages";

const starter: StoredQuestData = {
  schemaVersion: 5,
  questLists: { daily: [], personal: [] },
  categoryLists: { daily: ["Starter"], personal: [] },
};

/** A garden, labelled so tests can tell whose it is. */
function garden(label: string): StoredQuestData {
  return { ...starter, categoryLists: { daily: [label], personal: [] } };
}
const labelOf = (data: StoredQuestData | null | undefined) => data?.categoryLists.daily[0] ?? null;

const signedIn = (id: string): VerifiedSignIn => ({ status: "signed-in", user: { id, email: `${id}@example.com` } });
const ready = (data: StoredQuestData): GameStorageLoadResult => ({ status: "ready", data, storedText: JSON.stringify(data) });

/**
 * A fake storage: loads answer with `loadResult` (or wait until `releaseLoad`), and writes are recorded
 * and answered with `saveResult`.
 */
type FakeStorage = {
  name: string;
  writes: StoredQuestData[];
  loadResult: GameStorageLoadResult;
  saveResult: GameSaveResult | (() => Promise<GameSaveResult>);
  loads: number;
  holdNextLoad: () => () => void;
  storage: GameStorage;
};

function fakeStorage(name: string, loadResult: GameStorageLoadResult): FakeStorage {
  const writes: StoredQuestData[] = [];
  let hold: Promise<void> | null = null;
  let releaseLoad = () => {};
  const fake: FakeStorage = {
    name,
    writes,
    loadResult,
    saveResult: { status: "saved" },
    loads: 0,
    holdNextLoad() {
      hold = new Promise((resolve) => { releaseLoad = resolve; });
      return () => releaseLoad();
    },
    storage: {
      load: async () => {
        fake.loads += 1;
        if (hold) {
          const waiting = hold;
          hold = null;
          await waiting;
        }
        return fake.loadResult;
      },
      save: async (data: StoredQuestData) => {
        writes.push(data);
        return typeof fake.saveResult === "function" ? fake.saveResult() : fake.saveResult;
      },
    },
  };
  return fake;
}

/** sessionStorage for one tab, shared by every page (controller) given the same one. */
function memoryTab() {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  const entries = (): PersistedRecovery[] => JSON.parse(items.get(recoveryStorageKey) ?? "[]");
  return { storage, items, entries };
}

function setup(options: {
  browser?: GameStorageLoadResult;
  cloud?: Record<string, GameStorageLoadResult>;
  cloudAvailable?: boolean;
  /** The tab's sessionStorage, for kept unsaved changes. */
  tab?: ReturnType<typeof memoryTab>;
  pageId?: string;
} = {}) {
  const browser = fakeStorage("browser", options.browser ?? ready(garden("guest")));
  const clouds = new Map<string, ReturnType<typeof fakeStorage>>();
  for (const [id, result] of Object.entries(options.cloud ?? {})) clouds.set(id, fakeStorage(`cloud:${id}`, result));
  const cloudFor = (id: string) => {
    if (!clouds.has(id)) clouds.set(id, fakeStorage(`cloud:${id}`, { status: "empty", data: starter }));
    return clouds.get(id)!;
  };
  const deviceChoices = new Set<string>();
  const created: string[] = [];
  const authSeenByCloud: Array<() => AuthState> = [];
  const controller = createGameStorageController({
    fallbackData: starter,
    createBrowserSession: () => {
      created.push("browser");
      return createGameDataSession(browser.storage);
    },
    createCloudSession: (signIn, getAuth) => {
      if (options.cloudAvailable === false) return null;
      created.push(`cloud:${signIn.user.id}`);
      authSeenByCloud.push(getAuth);
      return createGameDataSession(cloudFor(signIn.user.id).storage, cloudSessionOptions);
    },
    deviceChoices: {
      has: (id) => deviceChoices.has(id),
      add: (id) => deviceChoices.add(id),
      remove: (id) => deviceChoices.delete(id),
    },
    ...(options.tab ? { recoveryStore: createRecoveryStore(() => options.tab!.storage), pageId: options.pageId ?? "page-1" } : {}),
  });
  const snap = () => controller.getSnapshot();
  /** Saves as the quest store does: tagged with the generation of the data on screen. */
  const play = (data: StoredQuestData) => controller.requestSave(snap().generation, data);
  return { controller, browser, cloudFor, deviceChoices, created, authSeenByCloud, snap, play };
}

/** Lets loads and writes finish, including the cloud's short pause before writing. */
async function settle() {
  await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs + 10);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("choosing the storage from the auth state", () => {
  it("reads nothing while it's still checking who's signed in", async () => {
    const env = setup();
    env.controller.setAuth({ status: "loading" });
    await settle();

    expect(env.snap()).toMatchObject({ phase: "waiting", mode: null, loaded: null });
    expect(env.created).toEqual([]);
    expect(env.play(garden("anything"))).toBe("blocked");
  });

  it.each([
    ["a guest", { status: "signed-out" }],
    ["sign-in that isn't set up", { status: "unavailable" }],
    ["an ended sign-in", { status: "session-ended", user: { email: "a@example.com" } }],
    ["an unverified sign-in", { status: "unverified", user: { email: "a@example.com" } }],
  ] as const)("uses browser storage for %s, and never the cloud", async (_, auth) => {
    const env = setup();
    env.controller.setAuth(auth);
    await settle();

    expect(env.snap()).toMatchObject({ phase: "ready", mode: "browser", account: null, loaded: { status: "ready", data: garden("guest") } });
    expect(env.created).toEqual(["browser"]);
  });

  it("uses the cloud for a verified sign-in, and doesn't touch browser storage", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.snap()).toMatchObject({ phase: "ready", mode: "cloud", account: { id: "a" }, loaded: { status: "ready", data: garden("cloud a") } });
    expect(env.created).toEqual(["cloud:a"]);
    expect(env.browser.loads).toBe(0);
  });

  it("gives the cloud adapter the newest auth state, so it can refuse a changed account", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    env.controller.setAuth({ status: "signed-in", user: { id: "a", email: "new@example.com" } });

    expect(env.authSeenByCloud[0]()).toEqual({ status: "signed-in", user: { id: "a", email: "new@example.com" } });
  });

  it("keeps the same session when the same account is announced again (a token refresh)", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    const { generation } = env.snap();

    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.created).toEqual(["cloud:a"]);
    expect(env.snap().generation).toBe(generation);
  });

  it("saves to the cloud for a verified account", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    env.play(garden("cloud a, edited"));
    await settle();

    expect(env.cloudFor("a").writes.map(labelOf)).toEqual(["cloud a, edited"]);
    expect(env.browser.writes).toEqual([]);
  });

  it("reports cloud saving as unavailable when there's no client, without falling back silently", async () => {
    const env = setup({ cloudAvailable: false });
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.snap()).toMatchObject({ phase: "cloud-failed", mode: "cloud", loaded: null, problem: "unknown" });
    expect(env.created).toEqual([]);
  });
});

describe("a verified account without a cloud save: the first-time choice", () => {
  it("asks first, showing nothing and writing nothing", async () => {
    const env = setup();
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.snap()).toMatchObject({ phase: "choose", mode: "cloud", loaded: null });
    expect(env.play(garden("guest"))).toBe("blocked");
    await settle();
    expect(env.cloudFor("a").writes).toEqual([]);
  });

  it("starting fresh creates the cloud save from starter data, never the browser's progress", async () => {
    const env = setup();
    env.controller.setAuth(signedIn("a"));
    await settle();
    const before = env.snap().generation;

    expect(env.controller.startFreshCloudGarden()).toBe(true);

    expect(env.snap()).toMatchObject({ phase: "ready", mode: "cloud", loaded: { status: "ready", data: starter } });
    expect(env.snap().generation).toBe(before + 1);
    env.play(starter);
    await settle();
    expect(env.cloudFor("a").writes).toEqual([starter]);
    expect(env.browser.loads).toBe(0);
    expect(env.browser.writes).toEqual([]);
  });

  it("starting fresh never replaces a save created meanwhile: that's a conflict", async () => {
    const env = setup();
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.controller.startFreshCloudGarden();
    env.cloudFor("a").saveResult = { status: "conflict", backup: "saved" };

    env.play(starter);
    await settle();

    expect(env.snap().save).toMatchObject({ status: "conflict" });
    env.play(garden("more"));
    await settle();
    expect(env.cloudFor("a").writes).toHaveLength(1);
  });

  it("keeping on this device plays the browser save and uploads nothing", async () => {
    const env = setup();
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.controller.keepPlayingOnDevice()).toBe(true);
    await settle();

    expect(env.snap()).toMatchObject({ phase: "ready", mode: "browser", account: { id: "a" }, loaded: { data: garden("guest") } });
    env.play(garden("guest, edited"));
    await settle();
    expect(env.browser.writes.map(labelOf)).toEqual(["guest, edited"]);
    expect(env.cloudFor("a").writes).toEqual([]);
    expect(env.deviceChoices.has("a")).toBe(true);
  });

  it("remembers the device choice for that account, and can go back to the cloud", async () => {
    const env = setup();
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.controller.keepPlayingOnDevice();
    await settle();

    env.controller.setAuth(signedIn("a"));
    expect(env.snap().mode).toBe("browser");

    expect(env.controller.useCloudGarden()).toBe(true);
    await settle();
    expect(env.snap()).toMatchObject({ phase: "choose", mode: "cloud" });
    expect(env.deviceChoices.has("a")).toBe(false);
  });

  it("only offers the choices where they make sense", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.controller.startFreshCloudGarden()).toBe(false);
    expect(env.controller.keepPlayingOnDevice()).toBe(false);
    expect(env.controller.useCloudGarden()).toBe(false);
    expect(env.cloudFor("a").writes).toEqual([]);
  });

  it("a guest can't start a cloud garden", async () => {
    const env = setup();
    env.controller.setAuth({ status: "signed-out" });
    await settle();

    expect(env.controller.startFreshCloudGarden()).toBe(false);
    expect(env.created).toEqual(["browser"]);
  });
});

describe("failed loads", () => {
  it("never shows starter data in place of a cloud save that failed to load", async () => {
    const env = setup({ cloud: { a: { status: "failed", data: starter, problem: "network" } } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.snap()).toMatchObject({ phase: "cloud-failed", loaded: null, problem: "network" });
    expect(env.play(starter)).toBe("blocked");
    await settle();
    expect(env.cloudFor("a").writes).toEqual([]);
  });

  it("tries the cloud again on request", async () => {
    const env = setup({ cloud: { a: { status: "failed", data: starter, problem: "network" } } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").loadResult = ready(garden("cloud a"));

    await env.controller.retryLoad();

    expect(env.snap()).toMatchObject({ phase: "ready", loaded: { data: garden("cloud a") } });
  });

  it("can play on this device instead after a failed cloud load", async () => {
    const env = setup({ cloud: { a: { status: "failed", data: starter, problem: "network" } } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.controller.keepPlayingOnDevice()).toBe(true);
    await settle();
    expect(env.snap()).toMatchObject({ mode: "browser", loaded: { data: garden("guest") } });
  });

  it("blocks a browser garden it could not read safely without showing fallback data", async () => {
    const env = setup({ browser: { status: "failed", data: garden("unreadable"), problem: "storage" } });
    env.controller.setAuth({ status: "signed-out" });
    await settle();

    expect(env.snap()).toMatchObject({ phase: "browser-failed", mode: "browser", loaded: null });
    expect(env.play(garden("unreadable, edited"))).toBe("blocked");
    expect(env.browser.writes).toEqual([]);
  });
});

describe("switching accounts and signing out", () => {
  it("never shows or saves one account's garden for another, even with a slow load", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) } });
    const releaseA = env.cloudFor("a").holdNextLoad();
    env.controller.setAuth(signedIn("a"));
    const generationA = env.snap().generation;

    env.controller.setAuth(signedIn("b"));
    await settle();
    releaseA();
    await settle();

    expect(env.snap()).toMatchObject({ mode: "cloud", account: { id: "b" }, loaded: { data: garden("cloud b") } });
    // Data still tagged with A's generation is refused.
    expect(env.controller.requestSave(generationA, garden("cloud a"))).toBe("blocked");
    await settle();
    expect(env.cloudFor("b").writes).toEqual([]);
  });

  it("signing out closes the cloud session and goes back to the browser save", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    const cloudGeneration = env.snap().generation;

    env.controller.setAuth({ status: "signed-out" });
    await settle();

    expect(env.snap()).toMatchObject({ mode: "browser", account: null, loaded: { data: garden("guest") } });
    expect(env.controller.requestSave(cloudGeneration, garden("cloud a, edited"))).toBe("blocked");
    await settle();
    expect(env.cloudFor("a").writes).toEqual([]);
    expect(env.browser.writes).toEqual([]);
  });

  it("closes the session while a new sign-in is being checked", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    env.controller.setAuth({ status: "loading" });

    expect(env.snap()).toMatchObject({ phase: "waiting", mode: null, loaded: null });
    expect(env.play(garden("x"))).toBe("blocked");
  });

  it("keeps unsaved changes from an account that changed, and never writes them elsewhere", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    env.play(garden("cloud a, unsaved"));
    env.controller.setAuth(signedIn("b"));
    await settle();
    // Kept, but never listed for B.
    expect(env.snap().unsavedRecoveries).toEqual([]);
    expect(env.snap().recoveriesAtRisk).toBe(true);

    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries).toEqual([
      { id: expect.any(String), reason: "account-changed", ownerId: "a", accountLabel: "a•••@example.com", closedAt: expect.any(Number), data: garden("cloud a, unsaved") },
    ]);
    expect(env.cloudFor("a").writes).toEqual([]);
    expect(env.cloudFor("b").writes).toEqual([]);
    env.controller.dismissUnsavedRecovery(env.snap().unsavedRecoveries[0].id);
    expect(env.snap().unsavedRecoveries).toEqual([]);
  });

  it("forgets the notice when a write already sent did save those changes after all", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    let finish: (result: GameSaveResult) => void = () => {};
    env.cloudFor("a").saveResult = () => new Promise((resolve) => { finish = resolve; });
    env.play(garden("cloud a, sending"));
    await settle();

    env.controller.setAuth({ status: "signed-out" });
    expect(env.snap().unsavedRecoveries).toEqual([]);
    expect(env.snap().recoveriesAtRisk).toBe(true);
    finish({ status: "saved" });
    await settle();

    expect(env.snap().recoveriesAtRisk).toBe(false);
    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries).toEqual([]);
  });

  it("doesn't raise the notice for exactly the changes the player chose to leave behind", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud a, unsaved"));
    await settle();

    const { ticket } = await env.controller.prepareForAccountChange();
    expect(env.controller.acknowledgeUnsavedLoss(ticket)).toBe(true);
    env.controller.setAuth({ status: "signed-out" });

    expect(env.snap().unsavedRecoveries).toEqual([]);
  });

  it("still raises the notice for changes made after the player agreed to leave earlier ones", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "signed-out" };
    env.play(garden("cloud a, first"));
    await settle();
    const { ticket } = await env.controller.prepareForAccountChange();
    env.controller.acknowledgeUnsavedLoss(ticket);

    env.play(garden("cloud a, second"));
    env.controller.setAuth({ status: "signed-out" });
    await settle();
    expect(env.snap().unsavedRecoveries).toEqual([]);
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.snap().unsavedRecoveries.map((entry) => labelOf(entry.data))).toEqual(["cloud a, second"]);
  });
});

describe("before signing out", () => {
  it("writes waiting changes, and reports nothing unsaved once they're saved", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.play(garden("cloud a, edited"));

    const result = await env.controller.prepareForAccountChange();

    expect(result).toMatchObject({ outcome: "ready", save: { status: "saved" } });
    expect(env.controller.isTicketCurrent(result.ticket)).toBe(true);
    expect(env.cloudFor("a").writes.map(labelOf)).toEqual(["cloud a, edited"]);
  });

  it("reports unsaved changes when the write fails, rather than assuming a finished flush saved them", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud a, edited"));

    const result = await env.controller.prepareForAccountChange();

    expect(result).toMatchObject({ outcome: "unsaved", save: { status: "error", problem: "network", hasUnsavedChanges: true } });
    env.cloudFor("a").saveResult = { status: "saved" };
    expect(env.controller.retrySave()).toBe(true);
    expect(await env.controller.prepareForAccountChange()).toMatchObject({ outcome: "ready" });
  });

  it("reports unsaved changes in a conflict, with what was backed up", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "conflict", backup: "saved" };
    env.play(garden("cloud a, edited"));
    await settle();

    expect(await env.controller.prepareForAccountChange()).toMatchObject({ outcome: "unsaved", save: { status: "conflict", backup: "saved" } });
    expect(env.controller.retrySave()).toBe(false);
  });

  it("has nothing to report with no session", async () => {
    const env = setup();
    expect(await env.controller.prepareForAccountChange()).toMatchObject({ outcome: "ready", save: null });
  });
});

describe("after a conflict", () => {
  it("loading the latest replaces the screen's data with a new generation", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "conflict", backup: "saved" };
    env.play(garden("cloud a, mine"));
    await settle();
    const before = env.snap().generation;
    env.cloudFor("a").loadResult = ready(garden("cloud a, theirs"));

    const outcome = await env.controller.reloadLatest();

    expect(outcome).toMatchObject({ status: "ready", cancelled: false, discardedUnsavedChanges: true });
    expect(env.snap()).toMatchObject({ phase: "ready", loaded: { data: garden("cloud a, theirs") } });
    expect(env.snap().generation).toBeGreaterThan(before);
    expect(env.controller.requestSave(before, garden("cloud a, mine"))).toBe("blocked");
  });

  it("applies nothing from a reload cancelled by an account change", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "conflict", backup: "failed" };
    env.play(garden("cloud a, mine"));
    await settle();
    const release = env.cloudFor("a").holdNextLoad();

    const reloading = env.controller.reloadLatest();
    await vi.advanceTimersByTimeAsync(0);
    env.controller.setAuth({ status: "signed-out" });
    release();
    const outcome = await reloading;

    expect(outcome?.cancelled).toBe(true);
    expect(env.snap()).toMatchObject({ mode: "browser", loaded: { data: garden("guest") } });
    // A's changes are kept, but only A sees them.
    expect(env.snap().unsavedRecoveries).toEqual([]);
    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries.map((entry) => labelOf(entry.data))).toEqual(["cloud a, mine"]);
  });
});

describe("mounting again", () => {
  it("suspend closes the session; resume picks the storage again", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    env.controller.suspend();
    expect(env.snap()).toMatchObject({ phase: "waiting", loaded: null });
    env.controller.resume();
    await settle();

    expect(env.snap()).toMatchObject({ phase: "ready", loaded: { data: garden("cloud a") } });
    expect(env.created).toEqual(["cloud:a", "cloud:a"]);
  });
});

describe("only a loaded garden can be played (Codex Step 5 finding 1)", () => {
  type Situation = { holdCloud?: boolean; cloudFails?: boolean };
  it.each<[string, AuthState, Situation]>([
    ["checking who's signed in", { status: "loading" }, {}],
    ["loading the cloud save", signedIn("a"), { holdCloud: true }],
    ["before the first-time choice", signedIn("a"), {}],
    ["after a failed cloud load", signedIn("a"), { cloudFails: true }],
  ])("isn't playable while %s", async (_, auth, options) => {
    const env = setup(options.cloudFails ? { cloud: { a: { status: "failed", data: starter, problem: "network" } } } : {});
    const release = options.holdCloud ? env.cloudFor("a").holdNextLoad() : () => {};
    env.controller.setAuth(auth);
    await settle();

    // Even with the generation the screen would claim to show.
    expect(isGardenPlayable(env.snap(), env.snap().generation)).toBe(false);
    expect(env.play(starter)).toBe("blocked");
    release();
  });

  it("is playable once loaded, only for the generation on screen", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(isGardenPlayable(env.snap(), env.snap().generation)).toBe(true);
    expect(isGardenPlayable(env.snap(), env.snap().generation - 1)).toBe(false);
  });

  it("is not playable after a browser load failure and never writes over it", async () => {
    const env = setup({ browser: { status: "failed", data: garden("unreadable"), problem: "storage" } });
    env.controller.setAuth({ status: "signed-out" });
    await settle();

    expect(isGardenPlayable(env.snap(), env.snap().generation)).toBe(false);
    expect(env.play(garden("unreadable, edited"))).toBe("blocked");
  });

  it("becomes playable after starting a fresh cloud garden, not before", async () => {
    const env = setup();
    env.controller.setAuth(signedIn("a"));
    await settle();
    const before = env.snap().generation;
    expect(isGardenPlayable(env.snap(), before)).toBe(false);

    env.controller.startFreshCloudGarden();

    expect(isGardenPlayable(env.snap(), before)).toBe(false);
    expect(isGardenPlayable(env.snap(), env.snap().generation)).toBe(true);
  });
});

describe("unsaved changes from several closed sessions (Codex Step 5 finding 2)", () => {
  it("keeps a separate entry for each account, across consecutive switches", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")), c: ready(garden("cloud c")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.play(garden("cloud a, unsaved"));

    env.controller.setAuth(signedIn("b"));
    await settle();
    env.play(garden("cloud b, unsaved"));

    env.controller.setAuth(signedIn("c"));
    await settle();
    // C sees neither.
    expect(env.snap().unsavedRecoveries).toEqual([]);

    env.controller.setAuth(signedIn("a"));
    await settle();
    const aEntries = env.snap().unsavedRecoveries;
    expect(aEntries.map((entry) => [entry.accountLabel, labelOf(entry.data)])).toEqual([["a•••@example.com", "cloud a, unsaved"]]);
    env.controller.setAuth(signedIn("b"));
    await settle();
    const bEntries = env.snap().unsavedRecoveries;
    expect(bEntries.map((entry) => [entry.accountLabel, labelOf(entry.data)])).toEqual([["b•••@example.com", "cloud b, unsaved"]]);
    expect(aEntries[0].id).not.toBe(bEntries[0].id);
    // Neither was written anywhere: not to its own account after closing, and never to another.
    expect(env.cloudFor("a").writes).toEqual([]);
    expect(env.cloudFor("b").writes).toEqual([]);
    expect(env.cloudFor("c").writes).toEqual([]);
  });

  it("keeps entries through later switches until each one is dismissed", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.play(garden("cloud a, unsaved"));
    env.controller.setAuth(signedIn("b"));
    await settle();
    env.controller.setAuth({ status: "signed-out" });
    await settle();
    env.controller.setAuth(signedIn("a"));
    await settle();

    const [first] = env.snap().unsavedRecoveries;
    expect(labelOf(first.data)).toBe("cloud a, unsaved");
    // Back on account A, the entry is still only for download: A's garden is A's cloud save.
    expect(env.snap().loaded?.data).toEqual(garden("cloud a"));
    expect(env.cloudFor("a").writes).toEqual([]);

    env.controller.dismissUnsavedRecovery("not-an-entry");
    expect(env.snap().unsavedRecoveries).toHaveLength(1);
    env.controller.dismissUnsavedRecovery(first.id);
    expect(env.snap().unsavedRecoveries).toEqual([]);
  });

  it("labels entries without showing whole email addresses", () => {
    expect(maskEmail("mira@example.com")).toBe("mi•••@example.com");
    expect(maskEmail("a@example.com")).toBe("a•••@example.com");
    expect(maskEmail("not-an-email")).toBe("•••");
    expect(maskEmail(null)).toBeNull();
  });

  it("labels this browser's own unsaved changes without an account", async () => {
    const env = setup();
    env.controller.setAuth({ status: "signed-out" });
    await settle();
    env.browser.saveResult = { status: "failed", problem: "storage" };
    env.play(garden("guest, unsaved"));
    await settle();

    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries).toEqual([]);
    env.controller.setAuth({ status: "signed-out" });
    await settle();

    expect(env.snap().unsavedRecoveries).toMatchObject([{ ownerId: null, accountLabel: null, data: garden("guest, unsaved") }]);
  });
});

describe("sign-out preparation belongs to its session (Codex Step 5 finding 3)", () => {
  /** Account A with a change whose write is held until the test answers it. */
  async function writeHeld() {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    let answer: (result: GameSaveResult) => void = () => {};
    env.cloudFor("a").saveResult = () => new Promise((resolve) => { answer = resolve; });
    env.play(garden("cloud a, edited"));
    return { ...env, answer: (result: GameSaveResult) => answer(result) };
  }

  it.each([
    ["another account signs in", signedIn("b")],
    ["the player is signed out elsewhere", { status: "signed-out" } as AuthState],
    ["a new sign-in is being checked", { status: "loading" } as AuthState],
  ] as const)("is stale when %s during the flush, whatever the write's result", async (_, next) => {
    for (const result of [{ status: "saved" }, { status: "failed", problem: "network" }] as GameSaveResult[]) {
      const env = await writeHeld();
      const preparing = env.controller.prepareForAccountChange();
      await vi.advanceTimersByTimeAsync(0);

      env.controller.setAuth(next);
      env.answer(result);
      const preparation = await preparing;

      expect(preparation).toMatchObject({ outcome: "stale", ticket: null });
      expect(env.controller.acknowledgeUnsavedLoss(preparation.ticket)).toBe(false);
    }
  });

  it("is stale when the garden is reloaded during the flush", async () => {
    const env = await writeHeld();
    env.cloudFor("a").saveResult = { status: "conflict", backup: "saved" };
    env.play(garden("cloud a, edited again"));
    const { ticket } = await env.controller.prepareForAccountChange();
    expect(env.controller.isTicketCurrent(ticket)).toBe(true);

    await env.controller.reloadLatest();

    expect(env.controller.isTicketCurrent(ticket)).toBe(false);
    expect(env.controller.acknowledgeUnsavedLoss(ticket)).toBe(false);
  });

  it("a warning's ticket stops working when the account changes while it's open", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud a, unsaved"));
    const preparation = await env.controller.prepareForAccountChange();
    expect(preparation.outcome).toBe("unsaved");

    env.controller.setAuth(signedIn("b"));
    await settle();

    expect(env.controller.isTicketCurrent(preparation.ticket)).toBe(false);
    // Confirming with it is refused, so A's changes are still kept for recovery.
    expect(env.controller.acknowledgeUnsavedLoss(preparation.ticket)).toBe(false);
    expect(env.snap().unsavedRecoveries).toEqual([]);
    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries.map((entry) => labelOf(entry.data))).toEqual(["cloud a, unsaved"]);
  });

  it("a ticket from one account never confirms anything for the next, even the same account signing in again", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    const { ticket } = await env.controller.prepareForAccountChange();

    env.controller.setAuth({ status: "signed-out" });
    await settle();
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.controller.isTicketCurrent(ticket)).toBe(false);
    expect(env.controller.isTicketCurrent(null)).toBe(false);
  });
});

describe("the current session's unsaved changes (Step 6)", () => {
  it("are readable for download, and gone once saved", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "conflict", backup: "failed" };
    env.play(garden("cloud a, mine"));
    await settle();

    expect(labelOf(env.controller.getUnsavedData())).toBe("cloud a, mine");
  });

  it("flushPendingSave writes a change waiting for the short pause at once", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.play(garden("cloud a, quick"));
    expect(env.cloudFor("a").writes).toEqual([]);

    env.controller.flushPendingSave();
    await vi.advanceTimersByTimeAsync(0);

    expect(env.cloudFor("a").writes.map(labelOf)).toEqual(["cloud a, quick"]);
    expect(env.controller.getUnsavedData()).toBeNull();
  });
});

describe("unsaved cloud changes kept when the page is hidden or left (Step 6)", () => {
  /** Account A on page 1 of `tab`, with a change that can't be saved. */
  async function leaveWithUnsavedChange(tab: ReturnType<typeof memoryTab>) {
    const env = setup({ cloud: { a: ready(garden("cloud a")) }, tab, pageId: "page-1" });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud a, unsaved"));
    env.controller.setPageVisible(false);
    await vi.advanceTimersByTimeAsync(0);
    return env;
  }

  it("keeps them in the tab while hidden, writing the waiting change at once", async () => {
    const tab = memoryTab();
    const env = await leaveWithUnsavedChange(tab);

    expect(env.cloudFor("a").writes.map(labelOf)).toEqual(["cloud a, unsaved"]);
    expect(tab.entries()).toEqual([
      { id: "page-1", reason: "page-left", userId: "a", accountLabel: "a•••@example.com", closedAt: expect.any(Number), data: garden("cloud a, unsaved") },
    ]);
  });

  it("removes them when the page is shown again, since it still has them", async () => {
    const tab = memoryTab();
    const env = await leaveWithUnsavedChange(tab);

    env.controller.setPageVisible(true);

    expect(tab.items.has(recoveryStorageKey)).toBe(false);
  });

  it("removes them once a save, even while hidden, succeeds", async () => {
    const tab = memoryTab();
    const env = await leaveWithUnsavedChange(tab);
    env.cloudFor("a").saveResult = { status: "saved" };

    await vi.advanceTimersByTimeAsync(cloudSessionOptions.retryDelaysMs[0] + 10);

    expect(env.controller.getUnsavedData()).toBeNull();
    expect(tab.entries()).toEqual([]);
  });

  it("keeps nothing for a browser garden, nor when everything is saved", async () => {
    const tab = memoryTab();
    const guest = setup({ tab });
    guest.controller.setAuth({ status: "signed-out" });
    await settle();
    guest.browser.saveResult = { status: "failed", problem: "storage" };
    guest.play(garden("guest, unsaved"));
    guest.controller.setPageVisible(false);

    const saved = setup({ cloud: { a: ready(garden("cloud a")) }, tab, pageId: "page-2" });
    saved.controller.setAuth(signedIn("a"));
    await settle();
    saved.play(garden("cloud a, saved"));
    await settle();
    saved.controller.setPageVisible(false);
    await settle();

    expect(tab.items.has(recoveryStorageKey)).toBe(false);
  });

  it("offers them to the same account on the next page, for download only, once its garden has loaded", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);

    const next = setup({ cloud: { a: ready(garden("cloud a")) }, tab, pageId: "page-2" });
    const release = next.cloudFor("a").holdNextLoad();
    next.controller.setAuth({ status: "loading" });
    expect(next.snap().unsavedRecoveries).toEqual([]);
    next.controller.setAuth(signedIn("a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(next.snap().unsavedRecoveries).toEqual([]);
    release();
    await settle();

    expect(next.snap().unsavedRecoveries).toEqual([
      { id: "page-1", reason: "page-left", ownerId: "a", accountLabel: "a•••@example.com", closedAt: expect.any(Number), data: garden("cloud a, unsaved") },
    ]);
    // Never written anywhere.
    expect(next.cloudFor("a").writes).toEqual([]);
    expect(next.browser.writes).toEqual([]);
  });

  it("keeps offering them after another reload, until they're dismissed", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);
    const second = setup({ cloud: { a: ready(garden("cloud a")) }, tab, pageId: "page-2" });
    second.controller.setAuth(signedIn("a"));
    await settle();

    const third = setup({ cloud: { a: ready(garden("cloud a")) }, tab, pageId: "page-3" });
    third.controller.setAuth(signedIn("a"));
    await settle();
    expect(third.snap().unsavedRecoveries.map((entry) => entry.id)).toEqual(["page-1"]);

    third.controller.dismissUnsavedRecovery("page-1");
    expect(third.snap().unsavedRecoveries).toEqual([]);
    expect(tab.items.has(recoveryStorageKey)).toBe(false);
  });

  it("never offers them to another account, and keeps them, hidden, for their own", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);

    const next = setup({ cloud: { b: ready(garden("cloud b")) }, tab, pageId: "page-2" });
    next.controller.setAuth(signedIn("b"));
    await settle();

    expect(next.snap().unsavedRecoveries).toEqual([]);
    expect(next.controller.getRecoveryData("page-1")).toBeNull();
    expect(tab.entries().map((entry) => entry.id)).toEqual(["page-1"]);
  });

  it("keeps them, hidden, after signing out", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);

    const next = setup({ tab, pageId: "page-2" });
    next.controller.setAuth({ status: "signed-out" });
    await settle();

    expect(next.snap().unsavedRecoveries).toEqual([]);
    expect(next.controller.getRecoveryData("page-1")).toBeNull();
    expect(tab.entries().map((entry) => entry.id)).toEqual(["page-1"]);
  });

  it.each([
    ["an unverified sign-in", { status: "unverified", user: { email: "a@example.com" } }],
    ["an ended sign-in", { status: "session-ended", user: { email: "a@example.com" } }],
  ] as const)("keeps them, unseen, during %s", async (_, auth) => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);

    const next = setup({ tab, pageId: "page-2" });
    next.controller.setAuth(auth);
    await settle();

    expect(next.snap().unsavedRecoveries).toEqual([]);
    expect(tab.entries().map((entry) => entry.id)).toEqual(["page-1"]);
  });

  it("drops them unseen when the cloud save already has exactly those changes", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);
    // The write sent as the page closed reached the database after all.
    const { categoryLists, ...rest } = garden("cloud a, unsaved");
    const reordered: StoredQuestData = { categoryLists, ...rest };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(garden("cloud a, unsaved")));

    const next = setup({ cloud: { a: ready(reordered) }, tab, pageId: "page-2" });
    next.controller.setAuth(signedIn("a"));
    await settle();

    expect(next.snap().unsavedRecoveries).toEqual([]);
    expect(tab.items.has(recoveryStorageKey)).toBe(false);
  });

  it("A → B → A before they're shown: hidden for B, then offered to A", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);
    const next = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) }, tab, pageId: "page-2" });

    next.controller.setAuth(signedIn("b"));
    await settle();
    expect(next.snap().unsavedRecoveries).toEqual([]);

    next.controller.setAuth(signedIn("a"));
    await settle();
    expect(next.snap().unsavedRecoveries.map((entry) => entry.id)).toEqual(["page-1"]);
    expect(labelOf(next.controller.getRecoveryData("page-1"))).toBe("cloud a, unsaved");
    // Never written to either account.
    expect(next.cloudFor("a").writes).toEqual([]);
    expect(next.cloudFor("b").writes).toEqual([]);
  });

  it("A → B → A after they're shown: hidden and not downloadable for B, offered to A again", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);
    const next = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) }, tab, pageId: "page-2" });
    next.controller.setAuth(signedIn("a"));
    await settle();
    expect(next.snap().unsavedRecoveries.map((entry) => entry.id)).toEqual(["page-1"]);

    next.controller.setAuth(signedIn("b"));
    // Hidden at once, before B's garden has even loaded.
    expect(next.snap().unsavedRecoveries).toEqual([]);
    await settle();
    expect(next.snap().unsavedRecoveries).toEqual([]);
    // A stale notice can neither download nor dismiss it.
    expect(next.controller.getRecoveryData("page-1")).toBeNull();
    next.controller.dismissUnsavedRecovery("page-1");
    expect(tab.entries().map((entry) => entry.id)).toEqual(["page-1"]);

    next.controller.setAuth(signedIn("a"));
    await settle();
    expect(next.snap().unsavedRecoveries.map((entry) => entry.id)).toEqual(["page-1"]);
    expect(labelOf(next.controller.getRecoveryData("page-1"))).toBe("cloud a, unsaved");
    expect(next.cloudFor("b").writes).toEqual([]);
  });

  it("hides them while the owner's sign-in can't be verified, even on the same page", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);
    const next = setup({ cloud: { a: ready(garden("cloud a")) }, tab, pageId: "page-2" });
    next.controller.setAuth(signedIn("a"));
    await settle();

    next.controller.setAuth({ status: "unverified", user: { email: "a@example.com" } });
    await settle();

    expect(next.snap().unsavedRecoveries).toEqual([]);
    expect(next.controller.getRecoveryData("page-1")).toBeNull();
  });

  it("with several accounts' entries, each account sees only its own, and signing out hides all and deletes none", async () => {
    const tab = memoryTab();
    const now = Date.now();
    const kept = (id: string, userId: string, closedAt: number): PersistedRecovery =>
      ({ id, userId, accountLabel: `${userId}•••@example.com`, closedAt, data: garden(`${id} changes`) });
    tab.storage.setItem(recoveryStorageKey, JSON.stringify([kept("old-a", "a", now - 3), kept("old-c", "c", now - 2), kept("newer-a", "a", now - 1)]));
    const env = setup({ cloud: { a: ready(garden("cloud a")), c: ready(garden("cloud c")) }, tab, pageId: "page-9" });
    const listed = () => env.snap().unsavedRecoveries.map((entry) => entry.id);

    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(listed()).toEqual(["old-a", "newer-a"]);

    env.controller.setAuth({ status: "signed-out" });
    await settle();
    expect(listed()).toEqual([]);
    expect(["old-a", "old-c", "newer-a"].map((id) => env.controller.getRecoveryData(id))).toEqual([null, null, null]);

    env.controller.setAuth(signedIn("c"));
    await settle();
    expect(listed()).toEqual(["old-c"]);

    // A dismissal removes only that entry, for good.
    env.controller.dismissUnsavedRecovery("old-c");
    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(listed()).toEqual(["old-a", "newer-a"]);
    expect(tab.entries().map((entry) => entry.id)).toEqual(["old-a", "newer-a"]);
    expect(env.cloudFor("a").writes).toEqual([]);
    expect(env.cloudFor("c").writes).toEqual([]);
  });

  it("switching to another account on the page keeps the first account's kept changes, hidden", async () => {
    const tab = memoryTab();
    await leaveWithUnsavedChange(tab);
    const next = setup({ cloud: { a: ready(garden("cloud a")), c: ready(garden("cloud c")) }, tab, pageId: "page-2" });
    next.controller.setAuth(signedIn("c"));
    await settle();
    expect(tab.entries().map((entry) => entry.id)).toEqual(["page-1"]);

    next.play(garden("cloud c, unsaved"));
    next.controller.setAuth(signedIn("a"));
    await settle();
    // Only A's own: C's changes from the switch are kept, hidden, for C.
    expect(next.snap().unsavedRecoveries.map((entry) => [entry.reason, entry.ownerId])).toEqual([["page-left", "a"]]);
    next.controller.setAuth(signedIn("c"));
    await settle();
    expect(next.snap().unsavedRecoveries.map((entry) => [entry.reason, entry.ownerId])).toEqual([["account-changed", "c"]]);
  });
});

describe("every kept entry belongs to its owner (Codex Step 6 follow-up)", () => {
  /** A's change can't be saved; then B signs in on the page, so A's changes become an account-change entry. */
  async function aThenB(options: { tab?: ReturnType<typeof memoryTab> } = {}) {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) }, ...options });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud a, unsaved"));
    await settle();
    env.controller.setAuth(signedIn("b"));
    await settle();
    return env;
  }

  it("A → B → A: B can't list, download or dismiss A's entry; A can, again", async () => {
    const env = await aThenB();
    env.controller.setAuth(signedIn("a"));
    await settle();
    const [entry] = env.snap().unsavedRecoveries;
    expect(entry).toMatchObject({ reason: "account-changed", ownerId: "a" });

    env.controller.setAuth(signedIn("b"));
    // Hidden at once, before B's garden has even loaded, so a notice drawn for A is gone.
    expect(env.snap().unsavedRecoveries).toEqual([]);
    await settle();
    // A stale callback from that notice gets nothing, and changes nothing.
    expect(env.controller.getRecoveryData(entry.id)).toBeNull();
    env.controller.dismissUnsavedRecovery(entry.id);

    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries.map((kept) => kept.id)).toEqual([entry.id]);
    expect(labelOf(env.controller.getRecoveryData(entry.id))).toBe("cloud a, unsaved");
    env.controller.dismissUnsavedRecovery(entry.id);
    expect(env.snap().unsavedRecoveries).toEqual([]);
    expect(env.controller.getRecoveryData(entry.id)).toBeNull();
    // Never written to either account.
    expect(env.cloudFor("b").writes).toEqual([]);
  });

  it.each([
    ["signed out", { status: "signed-out" }],
    ["unverified, even as A", { status: "unverified", user: { email: "a@example.com" } }],
    ["with an ended sign-in, even A's", { status: "session-ended", user: { email: "a@example.com" } }],
    ["still checking who's signed in", { status: "loading" }],
  ] as const)("hides A's entry, and refuses its download and dismissal, while %s", async (_, auth) => {
    const env = await aThenB();
    env.controller.setAuth(signedIn("a"));
    await settle();
    const [entry] = env.snap().unsavedRecoveries;

    env.controller.setAuth(auth);
    await settle();

    expect(env.snap().unsavedRecoveries).toEqual([]);
    expect(env.controller.getRecoveryData(entry.id)).toBeNull();
    env.controller.dismissUnsavedRecovery(entry.id);
    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries.map((kept) => kept.id)).toEqual([entry.id]);
  });

  it("A's entry is listed while A plays on this device too, since it's still A's account", async () => {
    const env = await aThenB();
    env.deviceChoices.add("a");
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.snap()).toMatchObject({ mode: "browser", account: { id: "a" } });
    expect(env.snap().unsavedRecoveries.map((entry) => entry.ownerId)).toEqual(["a"]);
  });

  it("a guest's entry is only for the guest's own browser garden: never for an account, even on this device", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth({ status: "signed-out" });
    await settle();
    env.browser.saveResult = { status: "failed", problem: "storage" };
    env.play(garden("guest, unsaved"));
    await settle();

    env.controller.setAuth(signedIn("a"));
    await settle();
    const hidden = () => {
      expect(env.snap().unsavedRecoveries).toEqual([]);
    };
    hidden();
    // A playing this browser's garden on this device is still A, not the guest.
    env.deviceChoices.add("a");
    env.controller.setAuth({ status: "signed-out" });
    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap()).toMatchObject({ mode: "browser", account: { id: "a" } });
    hidden();

    // The guest's garden is playing again (signed out): listed, downloadable, dismissable.
    env.controller.setAuth({ status: "signed-out" });
    await settle();
    const [entry] = env.snap().unsavedRecoveries;
    expect(entry).toMatchObject({ ownerId: null, accountLabel: null });
    expect(labelOf(env.controller.getRecoveryData(entry.id))).toBe("guest, unsaved");

    // Browser garden of an unverified sign-in is still this browser's own garden.
    env.controller.setAuth({ status: "unverified", user: { email: "a@example.com" } });
    await settle();
    expect(env.snap().unsavedRecoveries.map((kept) => kept.id)).toEqual([entry.id]);

    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.controller.getRecoveryData(entry.id)).toBeNull();
    env.controller.dismissUnsavedRecovery(entry.id);
    env.controller.setAuth({ status: "signed-out" });
    await settle();
    env.controller.dismissUnsavedRecovery(entry.id);
    expect(env.snap().unsavedRecoveries).toEqual([]);
  });

  it("a guest's entry, which can't be kept in the tab, makes leaving the page warn", async () => {
    const tab = memoryTab();
    const env = setup({ tab });
    env.controller.setAuth({ status: "signed-out" });
    await settle();
    env.browser.saveResult = { status: "failed", problem: "storage" };
    env.play(garden("guest, unsaved"));
    await settle();
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.snap().unsavedRecoveries).toEqual([]);
    expect(env.snap().recoveriesAtRisk).toBe(true);
    expect(tab.items.has(recoveryStorageKey)).toBe(false);
  });

  it("a late successful save clears only its own entry, never another account's", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")), c: ready(garden("cloud c")) } });
    // B first leaves an entry of its own.
    env.controller.setAuth(signedIn("b"));
    await settle();
    env.cloudFor("b").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud b, unsaved"));
    await settle();
    env.controller.setAuth(signedIn("a"));
    await settle();
    // A's write is held, then the account switches to C mid-write.
    let finish: (result: GameSaveResult) => void = () => {};
    env.cloudFor("a").saveResult = () => new Promise((resolve) => { finish = resolve; });
    env.play(garden("cloud a, sending"));
    await settle();
    env.controller.setAuth(signedIn("c"));
    await settle();

    finish({ status: "saved" });
    await settle();

    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries).toEqual([]);
    env.controller.setAuth(signedIn("b"));
    await settle();
    expect(env.snap().unsavedRecoveries.map((entry) => labelOf(entry.data))).toEqual(["cloud b, unsaved"]);
    expect(env.cloudFor("c").writes).toEqual([]);
  });

  it("an account's entry is kept in the tab, so a reload while it's hidden doesn't lose it, and only A sees it after", async () => {
    const tab = memoryTab();
    await aThenB({ tab });
    expect(tab.entries()).toMatchObject([{ reason: "account-changed", userId: "a", data: garden("cloud a, unsaved") }]);

    // The next page, still B: hidden, kept.
    const next = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) }, tab, pageId: "page-2" });
    next.controller.setAuth(signedIn("b"));
    await settle();
    expect(next.snap().unsavedRecoveries).toEqual([]);
    expect(next.snap().recoveriesAtRisk).toBe(false);

    next.controller.setAuth(signedIn("a"));
    await settle();
    expect(next.snap().unsavedRecoveries).toMatchObject([{ reason: "account-changed", ownerId: "a", data: garden("cloud a, unsaved") }]);
    next.controller.dismissUnsavedRecovery(next.snap().unsavedRecoveries[0].id);
    expect(tab.items.has(recoveryStorageKey)).toBe(false);
  });

  it("entries from different pages never share an ID", async () => {
    const tab = memoryTab();
    await aThenB({ tab });
    const next = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) }, tab, pageId: "page-2" });
    next.controller.setAuth(signedIn("a"));
    await settle();
    next.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    next.play(garden("cloud a, again"));
    await settle();
    next.controller.setAuth(signedIn("b"));
    await settle();
    next.controller.setAuth(signedIn("a"));
    await settle();

    const ids = next.snap().unsavedRecoveries.map((entry) => entry.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(next.snap().unsavedRecoveries.map((entry) => labelOf(entry.data))).toEqual(["cloud a, unsaved", "cloud a, again"]);
  });
});

describe("leaving the page stays protected when the tab's store evicts an entry (Codex Step 6 follow-up 2)", () => {
  it("eviction by a newer entry, then a successful save, still reports A's evicted entry as at risk", async () => {
    const tab = memoryTab();
    const now = Date.now();
    // Five earlier entries of A's: the store is full.
    tab.storage.setItem(recoveryStorageKey, JSON.stringify(["a1", "a2", "a3", "a4", "a5"].map((id, index): PersistedRecovery =>
      ({ id, reason: "page-left", userId: "a", accountLabel: "a•••@example.com", closedAt: now - 10 + index, data: garden(`${id} changes`) }))));
    const env = setup({ cloud: { b: ready(garden("cloud b")) }, tab, pageId: "page-b" });
    env.controller.setAuth(signedIn("b"));
    await settle();
    expect(env.snap()).toMatchObject({ unsavedRecoveries: [], recoveriesAtRisk: false });

    // B's change is still waiting when the page is hidden: B's entry is kept, evicting A's oldest.
    let finish: (result: GameSaveResult) => void = () => {};
    env.cloudFor("b").saveResult = () => new Promise((resolve) => { finish = resolve; });
    env.play(garden("cloud b, pending"));
    env.controller.setPageVisible(false);
    expect(tab.entries().map((entry) => entry.id)).toEqual(["a2", "a3", "a4", "a5", "page-b"]);
    expect(env.snap().recoveriesAtRisk).toBe(true);

    // B's save succeeds, so B's entry goes; A's "a1" now exists only on this page.
    finish({ status: "saved" });
    await settle();

    expect(tab.entries().map((entry) => entry.id)).toEqual(["a2", "a3", "a4", "a5"]);
    expect(env.snap()).toMatchObject({ save: { hasUnsavedChanges: false }, unsavedRecoveries: [], recoveriesAtRisk: true });
    expect(shouldWarnBeforeLeaving(env.snap())).toBe(true);

    // A, back, sees all five, including the evicted one; dismissing it ends the risk.
    env.controller.setPageVisible(true);
    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries.map((entry) => entry.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    env.controller.dismissUnsavedRecovery("a1");
    expect(env.snap().recoveriesAtRisk).toBe(false);
  });
});

describe("saving that stops or stalls never leaves edits silently unsaved (Codex Stage 7 final review P1)", () => {
  it("temporary failures keep the garden playable; more edits are kept and the newest is saved on reconnection", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };

    env.play(garden("cloud a, offline 1"));
    await settle();
    expect(env.snap()).toMatchObject({ phase: "ready", save: { status: "error", problem: "network", hasUnsavedChanges: true } });
    // Another edit while still offline is accepted and kept as the newest unsaved change.
    expect(env.play(garden("cloud a, offline 2"))).not.toBe("blocked");
    await settle();
    expect(labelOf(env.controller.getUnsavedData())).toBe("cloud a, offline 2");
    expect(isGardenPlayable(env.snap(), env.snap().generation)).toBe(true);

    // Back online: the next automatic retry saves the newest edit.
    env.cloudFor("a").saveResult = { status: "saved" };
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.retryDelaysMs[0] + 10);
    expect(env.snap().save).toMatchObject({ status: "saved", hasUnsavedChanges: false });
    expect(labelOf(env.cloudFor("a").writes.at(-1))).toBe("cloud a, offline 2");
    expect(env.snap().unsavedRecoveries).toEqual([]);
  });

  it("once retries run out, the same account's refreshed sign-in tries the save again", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud a, offline"));
    await settle();
    for (const delay of cloudSessionOptions.retryDelaysMs) await vi.advanceTimersByTimeAsync(delay + 10);
    expect(env.snap().save).toMatchObject({ status: "error", nextRetryAt: null, hasUnsavedChanges: true });

    // Back online: supabase-js refreshes the token, and the auth controller announces A again.
    env.cloudFor("a").saveResult = { status: "saved" };
    env.controller.setAuth(signedIn("a"));
    await settle();

    expect(env.snap().save).toMatchObject({ status: "saved", hasUnsavedChanges: false });
    expect(labelOf(env.cloudFor("a").writes.at(-1))).toBe("cloud a, offline");
    // Same session: nothing reloaded, nothing taken off the screen.
    expect(env.created.filter((name) => name === "cloud:a")).toHaveLength(1);
  });

  it("another account's sign-in never retries the first account's save", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")), b: ready(garden("cloud b")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud a, offline"));
    await settle();
    const attempts = env.cloudFor("a").writes.length;
    env.cloudFor("a").saveResult = { status: "saved" };

    env.controller.setAuth(signedIn("b"));
    await settle();

    expect(env.cloudFor("a").writes).toHaveLength(attempts);
    expect(env.cloudFor("b").writes).toEqual([]);
  });

  it("a session whose storage closes on its own takes the garden off the screen and keeps its changes for that account", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    const shown = env.snap().generation;
    env.cloudFor("a").saveResult = { status: "failed", problem: "identity-changed" };

    env.play(garden("cloud a, unsaved"));
    await settle();

    // Not playable, so no later edit can be shown and lost.
    expect(env.snap()).toMatchObject({ phase: "cloud-failed", problem: "identity-changed", loaded: null, save: null });
    expect(isGardenPlayable(env.snap(), shown)).toBe(false);
    expect(env.controller.requestSave(shown, garden("cloud a, later"))).toBe("blocked");
    // The unsaved edit is kept, for A only.
    const [entry] = env.snap().unsavedRecoveries;
    expect(entry).toMatchObject({ ownerId: "a", data: garden("cloud a, unsaved") });
    expect(env.snap().recoveriesAtRisk).toBe(true);

    // Try again: a fresh session checks the account and loads; the recovery stays for download.
    await env.controller.retryLoad();
    await settle();
    expect(env.created.filter((name) => name === "cloud:a")).toHaveLength(2);
    expect(env.snap()).toMatchObject({ phase: "ready", loaded: { data: garden("cloud a") } });
    expect(labelOf(env.controller.getRecoveryData(entry.id))).toBe("cloud a, unsaved");
    expect(env.cloudFor("a").writes.map(labelOf)).toEqual(["cloud a, unsaved"]);

    // Another account never sees it.
    env.controller.setAuth(signedIn("b"));
    await settle();
    expect(env.snap().unsavedRecoveries).toEqual([]);
    expect(env.controller.getRecoveryData(entry.id)).toBeNull();
  });

  it("a confirmed sign-out still closes A's session and returns to the browser garden, with A's changes kept for A", async () => {
    const env = setup({ cloud: { a: ready(garden("cloud a")) } });
    env.controller.setAuth(signedIn("a"));
    await settle();
    env.cloudFor("a").saveResult = { status: "failed", problem: "network" };
    env.play(garden("cloud a, unsaved"));
    await settle();

    env.controller.setAuth({ status: "signed-out" });
    await settle();

    expect(env.snap()).toMatchObject({ phase: "ready", mode: "browser", loaded: { data: garden("guest") } });
    expect(env.snap().unsavedRecoveries).toEqual([]);
    expect(env.browser.writes).toEqual([]);
    env.controller.setAuth(signedIn("a"));
    await settle();
    expect(env.snap().unsavedRecoveries.map((entry) => labelOf(entry.data))).toEqual(["cloud a, unsaved"]);
  });
});
