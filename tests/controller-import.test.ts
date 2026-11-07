import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../src/app/auth/auth-controller";
import { inspectBrowserGarden } from "../src/app/browser-save-preview";
import { createCloudGameStorage } from "../src/app/cloud-game-storage";
import { cloudSessionOptions, createGameDataSession } from "../src/app/game-data-session";
import type { GameStorage } from "../src/app/game-storage";
import { createGameStorageController, isGardenPlayable, type BrowserImportPlan } from "../src/app/game-storage-controller";
import { initialStoredQuestData } from "../src/app/quest-defaults";
import { latestQuestSaveVersion, questStorageKey, readQuestSave } from "../src/app/quest-storage";
import type { StoredQuestData } from "../src/app/quest-types";
import { createFakeCloud, gate, lostReply, type FakeReply } from "./support/fake-cloud";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const signedIn = (id: string): Extract<AuthState, { status: "signed-in" }> => ({ status: "signed-in", user: { id, email: `${id.slice(0, 1)}@example.com` } });

/** A garden told apart by its XP bonus, in the current format (so loading it needs no upgrade backup). */
function garden(xp: number): StoredQuestData {
  const save = readQuestSave({ ...structuredClone(initialStoredQuestData), legacyXpBonus: xp });
  if (save.status !== "valid") throw new Error("invalid test garden");
  return save.data;
}
const xpOf = (data: unknown) => (data as { legacyXpBonus?: number } | null | undefined)?.legacyXpBonus;

/** The guest's browser garden: 30 XP of progress. */
const BROWSER_TEXT = JSON.stringify(garden(30));

function setup(options: { browser?: string | null } = {}) {
  const cloud = createFakeCloud();
  const browserItems = new Map<string, string>();
  const browserText = options.browser === undefined ? BROWSER_TEXT : options.browser;
  if (browserText !== null) browserItems.set(questStorageKey, browserText);
  // Read-only on purpose: the import must never write the browser garden.
  const browserReader = { getItem: (key: string) => browserItems.get(key) ?? null };
  const guestWrites: StoredQuestData[] = [];
  const guestStorage: GameStorage = {
    load: async () => ({ status: "ready", data: garden(30), storedText: JSON.stringify(garden(30)) }),
    save: async (data) => { guestWrites.push(data); return { status: "saved" }; },
  };
  let auth: AuthState = { status: "loading" };
  const deviceChoices = new Set<string>();
  const controller = createGameStorageController({
    fallbackData: initialStoredQuestData,
    createBrowserSession: () => createGameDataSession(guestStorage),
    createCloudSession: (signIn, getAuth) => {
      const storage = createCloudGameStorage({ client: cloud.client, signIn, getAuth });
      return { session: createGameDataSession(storage, cloudSessionOptions), importer: storage };
    },
    deviceChoices: { has: (id) => deviceChoices.has(id), add: (id) => deviceChoices.add(id), remove: (id) => deviceChoices.delete(id) },
    readBrowserGarden: () => inspectBrowserGarden(() => browserReader),
  });
  const snap = () => controller.getSnapshot();
  return {
    cloud,
    controller,
    browserItems,
    guestWrites,
    snap,
    /** The browser garden as the import would read it. */
    browserData: () => {
      const preview = inspectBrowserGarden(() => browserReader);
      if (preview.status !== "ready") throw new Error("no browser garden");
      return preview.data;
    },
    signIn(id: string) {
      cloud.setSessionUser(id);
      auth = signedIn(id);
      controller.setAuth(auth);
    },
    signOut() {
      cloud.setSessionUser(null);
      auth = { status: "signed-out" };
      controller.setAuth(auth);
    },
    /** Saves as the quest store does: tagged with the generation of the data on screen. */
    play: (data: StoredQuestData) => controller.requestSave(snap().generation, data),
    playable: () => isGardenPlayable(snap(), snap().generation),
  };
}

/** Lets loads and writes finish, including the cloud's short pause before writing. */
async function settle() {
  await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs + 10);
}

async function prepared(env: ReturnType<typeof setup>): Promise<BrowserImportPlan> {
  const preparation = await env.controller.prepareBrowserImport();
  if (preparation.status !== "ready") throw new Error(`not ready: ${preparation.reason}`);
  return preparation.plan;
}

/** Account A signed in, with a cloud garden of `xp` XP (or none), loaded. */
async function signedInAs(cloudXp: number | null, options: { browser?: string | null } = {}) {
  const env = setup(options);
  if (cloudXp !== null) env.cloud.saveElsewhere(A, garden(cloudXp));
  env.signIn(A);
  await settle();
  return env;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("importing into an account without a cloud garden", () => {
  it("creates the cloud garden from the browser garden, reloads it fresh, and saves normally afterwards", async () => {
    const env = await signedInAs(null);
    expect(env.snap().phase).toBe("choose");

    const plan = await prepared(env);
    const originalGeneration = env.snap().generation;
    expect(plan).toMatchObject({ expectedRevision: null, summary: { totalXp: 30 } });
    const held = gate();
    env.cloud.onImport(async (_, apply) => { await held.released; return apply(); });
    const importing = env.controller.importBrowserGarden(plan);
    await vi.advanceTimersByTimeAsync(0);
    // Off the screen while importing: nothing can be played or saved.
    expect(env.snap()).toMatchObject({ phase: "importing", loaded: null });
    expect(env.playable()).toBe(false);
    expect(env.play(garden(99))).toBe("blocked");
    held.release();

    expect(await importing).toEqual({ status: "imported", revision: 1 });
    await settle();
    expect(env.snap()).toMatchObject({ phase: "ready", mode: "cloud", account: { id: A } });
    expect(env.snap().loaded?.data).toEqual(env.browserData());
    expect(env.controller.requestSave(originalGeneration, garden(99))).toBe("blocked");
    expect(env.cloud.backups).toEqual([]);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);

    // Autosave works on the fresh session: the next change is a normal conditional update.
    expect(env.play({ ...env.browserData(), legacyXpBonus: 31 })).not.toBe("blocked");
    await settle();
    expect(env.snap().save).toMatchObject({ status: "saved", hasUnsavedChanges: false });
    expect(env.cloud.rows.get(A)?.revision).toBe(2);
    expect(xpOf(env.cloud.gardenOf(A))).toBe(31);
  });
});

describe("replacing an existing cloud garden", () => {
  it("a fresh download cannot advance the confirmed revision or authorize replacing newer data", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    env.cloud.saveElsewhere(A, garden(90));
    expect(await env.controller.readCloudGardenForDownload()).toMatchObject({ status: "ready", data: { legacyXpBonus: 90 }, revision: 2 });
    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "conflict" });
    await settle();
    expect(xpOf(env.cloud.gardenOf(A))).toBe(90);
    expect(env.cloud.backups).toEqual([]);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);
  });

  it("a download in flight is refused after the controller switches account", async () => {
    const env = await signedInAs(40);
    const held = gate();
    env.cloud.onRead(async (apply) => { await held.released; return apply(); });
    const pending = env.controller.readCloudGardenForDownload();
    await vi.advanceTimersByTimeAsync(0);
    env.signIn(B);
    held.release();
    expect(await pending).toMatchObject({ status: "failed", problem: "identity-changed" });
    await settle();
    expect(env.snap()).toMatchObject({ phase: "choose", account: { id: B } });
    expect(env.cloud.rpcCalls).toEqual([]);
  });

  it("backs up the exact cloud garden, imports, reloads, and saves normally afterwards", async () => {
    const env = await signedInAs(40);
    const before = env.cloud.rows.get(A)!.text;
    const plan = await prepared(env);
    expect(plan.expectedRevision).toBe(1);

    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "imported", revision: 2 });
    await settle();

    expect(env.cloud.backups).toEqual([{ user_id: A, reason: "browser_import", raw_data: before, source_revision: 1 }]);
    expect(xpOf(env.snap().loaded?.data)).toBe(30);
    expect(env.playable()).toBe(true);
    env.play({ ...env.browserData(), legacyXpBonus: 35 });
    await settle();
    expect(env.cloud.rows.get(A)?.revision).toBe(3);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);
  });

  it("an identical garden is left unchanged: no backup, same revision, reloaded and playable", async () => {
    const env = setup();
    env.cloud.saveElsewhere(A, env.browserData());
    env.signIn(A);
    await settle();

    expect(await env.controller.importBrowserGarden(await prepared(env))).toEqual({ status: "unchanged", revision: 1 });
    await settle();
    expect(env.cloud.backups).toEqual([]);
    expect(env.cloud.rows.get(A)?.revision).toBe(1);
    expect(env.playable()).toBe(true);
  });

  it("writes waiting changes before preparing, so the plan has the cloud's real revision", async () => {
    const env = await signedInAs(40);
    env.play(garden(41));
    expect(env.cloud.rows.get(A)?.revision).toBe(1);

    const plan = await prepared(env);
    expect(plan.expectedRevision).toBe(2);
    expect(xpOf(env.cloud.gardenOf(A))).toBe(41);
    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "imported", revision: 3 });
    expect(env.cloud.backups[0]?.source_revision).toBe(2);
  });
});

describe("refusing to import while cloud changes aren't saved", () => {
  it("does not send an import if accounts change while flushing confirmation-time edits", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    const held = gate();
    env.cloud.onWrite(async (apply) => { await held.released; return apply(); });
    env.play(garden(41));
    const pending = env.controller.importBrowserGarden(plan);
    await vi.advanceTimersByTimeAsync(0);
    env.signIn(B);
    held.release();
    expect(await pending).toEqual({ status: "refused", reason: "stale" });
    await settle();
    expect(env.snap()).toMatchObject({ phase: "choose", account: { id: B } });
    expect(env.cloud.rpcCalls).toEqual([]);
    expect(env.cloud.rows.has(B)).toBe(false);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);
  });

  it("does not publish a plan if accounts change while flushing preparation-time edits", async () => {
    const env = await signedInAs(40);
    const held = gate();
    env.cloud.onWrite(async (apply) => { await held.released; return apply(); });
    env.play(garden(41));
    const pending = env.controller.prepareBrowserImport();
    await vi.advanceTimersByTimeAsync(0);
    env.signOut();
    held.release();
    expect(await pending).toEqual({ status: "unavailable", reason: "stale" });
    await settle();
    expect(env.snap()).toMatchObject({ phase: "ready", mode: "browser" });
    expect(env.cloud.rpcCalls).toEqual([]);
  });

  it("refuses while a save is failing, and sends nothing", async () => {
    const env = await signedInAs(40);
    env.cloud.onWrite(() => ({ data: null, error: { code: "PGRST000", message: "unavailable" }, status: 503 }));
    env.play(garden(41));
    await settle();

    expect(await env.controller.prepareBrowserImport()).toMatchObject({ status: "unavailable", reason: "unsaved", save: { status: "error" } });
    expect(env.cloud.rpcCalls).toEqual([]);
    expect(env.playable()).toBe(true);
  });

  it("refuses during a conflict", async () => {
    const env = await signedInAs(40);
    env.cloud.saveElsewhere(A, garden(90));
    env.play(garden(41));
    await settle();

    expect(await env.controller.prepareBrowserImport()).toMatchObject({ status: "unavailable", reason: "unsaved", save: { status: "conflict" } });
    expect(env.cloud.rpcCalls).toEqual([]);
  });

  it("refuses when a change made during the confirmation can't be saved, leaving the garden as it was", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    const generation = env.snap().generation;
    env.cloud.onWrite(() => lostReply());
    env.play(garden(41));

    expect(await env.controller.importBrowserGarden(plan)).toMatchObject({ status: "refused", reason: "unsaved" });
    expect(env.cloud.rpcCalls).toEqual([]);
    expect(env.snap()).toMatchObject({ phase: "ready", generation });
    expect(env.playable()).toBe(true);
  });

  it("refuses a plan once this tab's own save has moved the revision on, until prepared again", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    env.play(garden(41));
    await settle();

    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "refused", reason: "stale" });
    expect(env.cloud.rpcCalls).toEqual([]);
    const again = await prepared(env);
    expect(again.expectedRevision).toBe(2);
    expect(await env.controller.importBrowserGarden(again)).toMatchObject({ status: "imported" });
  });

  it("refuses when the browser garden changed after the plan was prepared", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    env.browserItems.set(questStorageKey, JSON.stringify(garden(55)));

    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "refused", reason: "browser-changed" });
    expect(env.cloud.rpcCalls).toEqual([]);
    expect(env.playable()).toBe(true);
  });
});

describe("what can't be imported", () => {
  it.each([
    ["no browser garden", null, "browser-empty"],
    ["only the starter quests", JSON.stringify(initialStoredQuestData), "no-progress"],
    ["an unreadable browser save", "{not json", "browser-unreadable"],
    ["a browser save from a newer version", JSON.stringify({ ...garden(30), schemaVersion: latestQuestSaveVersion + 1 }), "browser-newer-version"],
  ] as const)("%s", async (_, browser, reason) => {
    const env = await signedInAs(40, { browser });
    expect(await env.controller.prepareBrowserImport()).toEqual({ status: "unavailable", reason });
  });

  it("a guest, with no verified account", async () => {
    const env = setup();
    env.signOut();
    await settle();
    expect(await env.controller.prepareBrowserImport()).toEqual({ status: "unavailable", reason: "not-cloud" });
  });

  it("a garden that's still loading", async () => {
    const env = setup();
    env.cloud.saveElsewhere(A, garden(40));
    const held = gate();
    env.cloud.onRead(async (apply) => { await held.released; return apply(); });
    env.signIn(A);
    await vi.advanceTimersByTimeAsync(0);
    expect(await env.controller.prepareBrowserImport()).toEqual({ status: "unavailable", reason: "not-loaded" });
    held.release();
  });
});

describe("imports that don't go through", () => {
  it("reloads a fresh writable session after a definitive database failure", async () => {
    const env = await signedInAs(40);
    env.cloud.onImport(() => ({ data: null, error: { code: "23514", message: "rejected" }, status: 400 }));
    expect(await env.controller.importBrowserGarden(await prepared(env))).toEqual({ status: "failed", problem: "rejected" });
    await settle();
    expect(env.snap()).toMatchObject({ phase: "ready", unresolvedImport: null });
    expect(xpOf(env.snap().loaded?.data)).toBe(40);
    expect(env.playable()).toBe(true);
    env.play(garden(41));
    await settle();
    expect(env.snap().save).toMatchObject({ status: "saved", hasUnsavedChanges: false });
    expect(xpOf(env.cloud.gardenOf(A))).toBe(41);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);
  });

  it("a missing import function (migration not applied) fails definitely: no unresolved card, saves continue", async () => {
    const env = await signedInAs(40);
    env.cloud.onImport(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 }));
    expect(await env.controller.importBrowserGarden(await prepared(env))).toEqual({ status: "failed", problem: "server-outdated" });
    await settle();
    expect(env.snap()).toMatchObject({ phase: "ready", unresolvedImport: null });
    expect(env.cloud.rpcCalls).toHaveLength(1);
    expect(env.cloud.backups).toEqual([]);
    expect(xpOf(env.snap().loaded?.data)).toBe(40);
    expect(env.playable()).toBe(true);
    env.play(garden(41));
    await settle();
    expect(env.snap().save).toMatchObject({ status: "saved", hasUnsavedChanges: false });
    expect(xpOf(env.cloud.gardenOf(A))).toBe(41);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);
  });

  it("does not show stale playable data when the fresh load after success fails", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    env.cloud.onRead(() => lostReply());
    expect(await env.controller.importBrowserGarden(plan)).toMatchObject({ status: "imported" });
    await settle();
    expect(env.snap()).toMatchObject({ phase: "cloud-failed", loaded: null });
    expect(env.playable()).toBe(false);
    expect(env.play(garden(99))).toBe("blocked");
    expect(xpOf(env.cloud.gardenOf(A))).toBe(30);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);
    env.cloud.onRead();
    await env.controller.retryLoad();
    await settle();
    expect(xpOf(env.snap().loaded?.data)).toBe(30);
    expect(env.playable()).toBe(true);
  });

  it("a backup failure replaces nothing, and the cloud garden is reloaded and playable", async () => {
    const env = await signedInAs(40);
    env.cloud.failBackups();

    expect(await env.controller.importBrowserGarden(await prepared(env))).toEqual({ status: "backup-failed" });
    await settle();
    expect(env.cloud.rows.get(A)?.revision).toBe(1);
    expect(xpOf(env.snap().loaded?.data)).toBe(40);
    expect(env.playable()).toBe(true);
    env.play(garden(42));
    await settle();
    expect(xpOf(env.cloud.gardenOf(A))).toBe(42);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);
  });

  it("another device's save in between is a conflict: nothing imported, the latest garden is loaded", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    env.cloud.saveElsewhere(A, garden(90));

    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "conflict" });
    await settle();
    expect(xpOf(env.snap().loaded?.data)).toBe(90);
    expect(env.cloud.backups).toEqual([]);
    expect(env.playable()).toBe(true);
  });

  it("offline before sending: nothing sent; nothing is playable until the garden loads again", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    env.cloud.setOffline(true);

    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "failed", problem: "network" });
    await settle();
    expect(env.cloud.rpcCalls).toEqual([]);
    expect(env.snap().phase).toBe("cloud-failed");
    expect(env.playable()).toBe(false);

    env.cloud.setOffline(false);
    await env.controller.retryLoad();
    await settle();
    expect(xpOf(env.snap().loaded?.data)).toBe(40);
    expect(env.playable()).toBe(true);
  });
});

describe("lost replies and late commits", () => {
  it("a lost reply after the import committed is verified as imported", async () => {
    const env = await signedInAs(40);
    env.cloud.onImport((_, apply) => { apply(); return lostReply(); });

    expect(await env.controller.importBrowserGarden(await prepared(env))).toEqual({ status: "imported", revision: 2 });
    await settle();
    expect(xpOf(env.snap().loaded?.data)).toBe(30);
    expect(env.cloud.rpcCalls).toHaveLength(1);
  });

  it("a lost reply before it committed is unresolved; nothing is playable; the same import can be retried", async () => {
    const env = await signedInAs(40);
    env.cloud.onImport(() => lostReply());

    expect(await env.controller.importBrowserGarden(await prepared(env))).toMatchObject({ status: "unresolved", canRetry: true });
    expect(env.snap()).toMatchObject({ phase: "import-unresolved", unresolvedImport: { canRetry: true }, loaded: null });
    expect(env.playable()).toBe(false);
    expect(env.play(garden(99))).toBe("blocked");
    // Existing load/choice actions must not replace the storage that owns the verification gate.
    expect(await env.controller.reloadLatest()).toBeNull();
    await env.controller.retryLoad();
    expect(env.controller.startFreshCloudGarden()).toBe(false);
    expect(env.controller.keepPlayingOnDevice()).toBe(false);
    expect(await env.controller.prepareBrowserImport()).toMatchObject({ status: "unavailable", reason: "not-loaded" });
    expect(env.snap().phase).toBe("import-unresolved");

    env.cloud.onImport();
    expect(await env.controller.retryBrowserImport()).toEqual({ status: "imported", revision: 2 });
    // Exactly the same import both times: same garden, same expected revision.
    expect(env.cloud.rpcCalls).toHaveLength(2);
    expect(env.cloud.rpcCalls[1]).toEqual(env.cloud.rpcCalls[0]);
    await settle();
    expect(env.playable()).toBe(true);
  });

  it("when the cloud can't be read either, nothing can be resent until it's verified; a delayed commit is then found", async () => {
    const env = await signedInAs(40);
    let commitLater: () => FakeReply = () => lostReply();
    env.cloud.onImport((_, apply) => { commitLater = apply; return lostReply(); });
    env.cloud.onRead(() => lostReply());

    expect(await env.controller.importBrowserGarden(await prepared(env))).toMatchObject({ status: "unresolved", canRetry: false });
    expect(await env.controller.retryBrowserImport()).toEqual({ status: "refused", reason: "not-loaded" });
    expect(env.cloud.rpcCalls).toHaveLength(1);

    // The original transaction commits late; then the cloud can be read again.
    commitLater();
    env.cloud.onRead();
    expect(await env.controller.verifyBrowserImport()).toEqual({ status: "imported", revision: 2 });
    expect(env.cloud.rpcCalls).toHaveLength(1);
    expect(env.cloud.backups).toHaveLength(1);
    await settle();
    expect(xpOf(env.snap().loaded?.data)).toBe(30);
  });

  it("an original that commits just before its retry is reported as imported, not as a conflict", async () => {
    const env = await signedInAs(40);
    let original: (() => FakeReply) | null = null;
    env.cloud.onImport((_, apply) => {
      if (!original) {
        original = apply;
        return lostReply();
      }
      original();
      return apply();
    });

    expect(await env.controller.importBrowserGarden(await prepared(env))).toMatchObject({ status: "unresolved", canRetry: true });
    expect(await env.controller.retryBrowserImport()).toEqual({ status: "imported", revision: 2 });
    expect(env.cloud.backups).toHaveLength(1);
  });

  it("leaving an unresolved import reloads fresh; a late commit then makes the next save a conflict, never an overwrite", async () => {
    const env = await signedInAs(40);
    let commitLater: () => FakeReply = () => lostReply();
    env.cloud.onImport((_, apply) => { commitLater = apply; return lostReply(); });
    await env.controller.importBrowserGarden(await prepared(env));

    expect(env.controller.leaveUnresolvedImport()).toBe(true);
    await settle();
    expect(env.playable()).toBe(true);
    expect(xpOf(env.snap().loaded?.data)).toBe(40);

    commitLater();
    env.play(garden(41));
    await settle();
    expect(env.snap().save).toMatchObject({ status: "conflict" });
    expect(xpOf(env.cloud.gardenOf(A))).toBe(30);
  });
});

describe("duplicate requests", () => {
  it("a caller cannot retarget a confirmed plan to this tab's newer revision", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    env.play(garden(41));
    await settle();
    // Plans can cross JavaScript boundaries where TypeScript readonly isn't enforced.
    Reflect.set(plan, "expectedRevision", 2);
    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "refused", reason: "stale" });
    expect(env.cloud.rpcCalls).toEqual([]);
    expect(xpOf(env.cloud.gardenOf(A))).toBe(41);
  });

  it("only one import runs; a second request, or another preparation, is refused while it does", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    const held = gate();
    env.cloud.onImport(async (_, apply) => { await held.released; return apply(); });

    const first = env.controller.importBrowserGarden(plan);
    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "refused", reason: "busy" });
    expect(await env.controller.prepareBrowserImport()).toEqual({ status: "unavailable", reason: "busy" });
    held.release();
    expect(await first).toMatchObject({ status: "imported" });

    // The plan is used up.
    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "refused", reason: "stale" });
    expect(env.cloud.rpcCalls).toHaveLength(1);
    expect(env.cloud.backups).toHaveLength(1);
  });
});

describe("account changes during an import", () => {
  it("a delayed verification cannot resolve or reload another account's garden", async () => {
    const env = await signedInAs(40);
    env.cloud.onImport(() => lostReply());
    await env.controller.importBrowserGarden(await prepared(env));
    const held = gate();
    env.cloud.onRead(async (apply) => { await held.released; return apply(); });
    const pending = env.controller.verifyBrowserImport();
    await vi.advanceTimersByTimeAsync(0);
    env.signIn(B);
    held.release();
    expect(await pending).toEqual({ status: "cancelled" });
    await settle();
    expect(env.snap()).toMatchObject({ phase: "choose", account: { id: B }, unresolvedImport: null });
    expect(env.cloud.rows.has(B)).toBe(false);
    expect(env.cloud.rpcCalls).toHaveLength(1);
  });

  it("a retired adapter cannot send a delayed import after the same account signs back in", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    const held = gate();
    const original = env.cloud.client.auth.getSession.bind(env.cloud.client.auth);
    vi.spyOn(env.cloud.client.auth, "getSession").mockImplementationOnce(async () => {
      await held.released;
      return original();
    });
    const pending = env.controller.importBrowserGarden(plan);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.snap().phase).toBe("importing");
    env.signOut();
    env.signIn(A);
    await settle();
    held.release();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(env.cloud.rpcCalls).toEqual([]);
    expect(xpOf(env.cloud.gardenOf(A))).toBe(40);
    expect(env.playable()).toBe(true);
  });

  it("switching to B mid-import: nothing of A's is shown for B, and B's account is untouched", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    const held = gate();
    env.cloud.onImport(async (_, apply) => { await held.released; return apply(); });
    const importing = env.controller.importBrowserGarden(plan);
    await vi.advanceTimersByTimeAsync(0);

    env.signIn(B);
    held.release();
    expect(await importing).toEqual({ status: "cancelled" });
    await settle();

    expect(env.snap()).toMatchObject({ phase: "choose", account: { id: B }, loaded: null });
    expect(env.cloud.rows.has(B)).toBe(false);
    // The import was sent with A's token, so it could only ever reach A's account.
    expect(env.cloud.rpcCalls[0]?.p_user_id).toBe(A);
  });

  it("signing out mid-import: the guest garden comes back, unchanged", async () => {
    const env = await signedInAs(40);
    const plan = await prepared(env);
    const held = gate();
    env.cloud.onImport(async (_, apply) => { await held.released; return apply(); });
    const importing = env.controller.importBrowserGarden(plan);
    await vi.advanceTimersByTimeAsync(0);

    env.signOut();
    held.release();
    expect(await importing).toEqual({ status: "cancelled" });
    await settle();

    expect(env.snap()).toMatchObject({ phase: "ready", mode: "browser", account: null });
    expect(env.guestWrites).toEqual([]);
    expect(env.browserItems.get(questStorageKey)).toBe(BROWSER_TEXT);
  });

  it("a plan prepared for A can't be used once B is signed in", async () => {
    const env = setup();
    env.cloud.saveElsewhere(A, garden(40));
    env.signIn(A);
    await settle();
    const plan = await prepared(env);
    env.signIn(B);
    await settle();

    expect(await env.controller.importBrowserGarden(plan)).toEqual({ status: "refused", reason: "stale" });
    expect(env.cloud.rpcCalls).toEqual([]);
  });

  it("an unresolved import belongs to its account: after switching, it can't be verified or retried", async () => {
    const env = await signedInAs(40);
    env.cloud.onImport(() => lostReply());
    await env.controller.importBrowserGarden(await prepared(env));
    expect(env.snap().phase).toBe("import-unresolved");

    env.signIn(B);
    await settle();
    expect(env.snap()).toMatchObject({ account: { id: B }, unresolvedImport: null });
    expect(await env.controller.verifyBrowserImport()).toEqual({ status: "refused", reason: "not-loaded" });
    expect(await env.controller.retryBrowserImport()).toEqual({ status: "refused", reason: "not-loaded" });
    expect(env.cloud.rpcCalls).toHaveLength(1);
  });
});
