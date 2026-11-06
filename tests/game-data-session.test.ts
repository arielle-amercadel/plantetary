import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudSessionOptions, createGameDataSession, type GameDataSessionOptions } from "../src/app/game-data-session";
import type { GameSaveResult, GameStorage, GameStorageLoadResult } from "../src/app/game-storage";
import type { StoredQuestData } from "../src/app/quest-types";

const base: StoredQuestData = {
  schemaVersion: 5,
  questLists: { daily: [], personal: [] },
  categoryLists: { daily: ["Wellness"], personal: [] },
};

/** The save with one edit, numbered so tests can tell versions apart. */
function edit(version: number): StoredQuestData {
  return { ...base, categoryLists: { ...base.categoryLists, personal: [`Edit ${version}`] } };
}

const saved: GameSaveResult = { status: "saved" };
const failed = (problem: Extract<GameSaveResult, { status: "failed" }>["problem"]): GameSaveResult => ({ status: "failed", problem });
const ready: GameStorageLoadResult = { status: "ready", data: base, storedText: JSON.stringify(base) };

/**
 * Storage whose writes finish only when the test answers them, oldest first. Unanswered writes are
 * visible in `writes`, so tests can see what was sent, and that only one runs at a time.
 */
function controlledStorage(loadResults: GameStorageLoadResult[] = [ready]) {
  const writes: Array<{ data: StoredQuestData; answer: (result: GameSaveResult) => void; answered: boolean }> = [];
  let running = 0;
  let mostAtOnce = 0;
  const loads = [...loadResults];
  const storage: GameStorage = {
    load: vi.fn(async () => loads.shift() ?? ready),
    save: vi.fn((data: StoredQuestData) => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      return new Promise<GameSaveResult>((resolve) => {
        const write = {
          data,
          answered: false,
          answer: (result: GameSaveResult) => {
            write.answered = true;
            running -= 1;
            resolve(result);
          },
        };
        writes.push(write);
      });
    }),
  };
  return {
    storage,
    writes,
    /** The most writes that were ever running at the same time. */
    mostAtOnce: () => mostAtOnce,
    /** What each write sent, as the edit number. */
    sent: () => writes.map((write) => write.data.categoryLists.personal[0] ?? "base"),
    /** Answers the oldest unanswered write, then lets the session react. */
    async answer(result: GameSaveResult) {
      const write = writes.find((candidate) => !candidate.answered);
      if (!write) throw new Error("No write is waiting for an answer");
      write.answer(result);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

async function loadedSession(options: GameDataSessionOptions = cloudSessionOptions, loadResults?: GameStorageLoadResult[]) {
  const controlled = controlledStorage(loadResults);
  const session = createGameDataSession(controlled.storage, options);
  await session.load(base);
  const seen: string[] = [];
  session.subscribe(() => seen.push(session.getSnapshot().status));
  return { ...controlled, session, seen };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00Z") });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("save states", () => {
  it("goes from loading to saved, and is observable", async () => {
    const controlled = controlledStorage();
    const session = createGameDataSession(controlled.storage, cloudSessionOptions);
    const listener = vi.fn();
    session.subscribe(listener);
    expect(session.getSnapshot()).toEqual({ status: "loading", hasUnsavedChanges: false });

    await session.load(base);

    expect(session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the same snapshot object until something changes, as React's useSyncExternalStore needs", async () => {
    const { session } = await loadedSession();
    const first = session.getSnapshot();

    expect(session.requestSave(base)).toBe("unchanged");
    expect(session.getSnapshot()).toBe(first);
    session.requestSave(edit(1));
    expect(session.getSnapshot()).not.toBe(first);
  });

  it.each([
    ["a failed load", { status: "failed", data: base, problem: "network" } as GameStorageLoadResult, { status: "load-failed", problem: "network" }],
    ["a failed load without a reason", { status: "failed", data: base } as GameStorageLoadResult, { status: "load-failed", problem: null }],
    ["an account with no save yet", { status: "empty", data: base } as GameStorageLoadResult, { status: "empty" }],
    ["a load refused because the account changed", { status: "failed", data: base, problem: "identity-changed" } as GameStorageLoadResult, { status: "closed", problem: "identity-changed" }],
  ])("reports %s, and writes nothing", async (_, loadResult, expected) => {
    const { session, storage } = await loadedSession(cloudSessionOptions, [loadResult]);

    expect(session.getSnapshot()).toEqual({ ...expected, hasUnsavedChanges: false });
    expect(session.requestSave(edit(1))).toBe("blocked");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("reports a load that throws as failed", async () => {
    const storage: GameStorage = { load: vi.fn(async () => { throw new Error("boom"); }), save: vi.fn() };
    const session = createGameDataSession(storage, cloudSessionOptions);

    expect(await session.load(base)).toEqual({ status: "failed", data: base });
    expect(session.getSnapshot()).toEqual({ status: "load-failed", problem: null, hasUnsavedChanges: false });
  });

  it("shows saving with unsaved changes, then saved without", async () => {
    const { session, answer } = await loadedSession();

    session.requestSave(edit(1));
    expect(session.getSnapshot()).toEqual({ status: "saving", hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    expect(session.getSnapshot()).toEqual({ status: "saving", hasUnsavedChanges: true });

    await answer(saved);
    expect(session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });
    expect(session.getUnsavedData()).toBeNull();
  });
});

describe("a short pause groups changes into one write", () => {
  it("writes a burst of changes once, with the newest", async () => {
    const { session, storage, sent } = await loadedSession();

    for (let version = 1; version <= 5; version += 1) {
      expect(session.requestSave(edit(version))).toBe("scheduled");
      await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs - 100);
    }
    expect(storage.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(sent()).toEqual(["Edit 5"]);
  });

  it("writes nothing when a change is undone before the pause ends", async () => {
    const { session, storage } = await loadedSession();

    session.requestSave(edit(1));
    expect(session.requestSave(base)).toBe("unchanged");
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs * 2);

    expect(storage.save).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });
  });

  it("whenIdle waits for the pause and the write", async () => {
    const { session, answer } = await loadedSession();
    session.requestSave(edit(1));
    let idle = false;
    void session.whenIdle().then(() => { idle = true; });

    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    expect(idle).toBe(false);
    await answer(saved);
    expect(idle).toBe(true);
  });

  it("flush writes a waiting change at once, and resolves with the result", async () => {
    const { session, sent, answer } = await loadedSession();
    session.requestSave(edit(1));

    const flushing = session.flush();
    expect(sent()).toEqual(["Edit 1"]);
    await answer(saved);

    expect(await flushing).toEqual({ status: "saved", hasUnsavedChanges: false });
  });

  it("flush reports unsaved changes when the write fails, so a sign-out can warn first", async () => {
    const { session, answer } = await loadedSession();
    session.requestSave(edit(1));

    const flushing = session.flush();
    await answer(failed("network"));

    expect(await flushing).toMatchObject({ status: "error", problem: "network", hasUnsavedChanges: true });
    expect(session.getUnsavedData()).toEqual(edit(1));
  });

  it("browser sessions keep writing at once, synchronously, with no pause", async () => {
    const { session, sent } = await loadedSession({});

    expect(session.requestSave(edit(1))).toBe("saving");
    expect(sent()).toEqual(["Edit 1"]);
  });
});

describe("one write at a time", () => {
  it("never runs two writes at once, and writes only the newest change made meanwhile", async () => {
    const { session, sent, answer } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);

    expect(session.requestSave(edit(2))).toBe("queued");
    expect(session.requestSave(edit(3))).toBe("queued");
    await answer(saved);
    expect(sent()).toEqual(["Edit 1", "Edit 3"]);
    await answer(saved);

    expect(session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });
  });

  it("handles a slow write followed by changes and failures in order", async () => {
    const controlled = await loadedSession();
    const { session, answer, sent } = controlled;
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    session.requestSave(edit(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await answer(failed("server"));
    // Edit 2 hadn't been tried, so it goes at once.
    expect(sent()).toEqual(["Edit 1", "Edit 2"]);
    await answer(saved);

    expect(controlled.mostAtOnce()).toBe(1);
    expect(session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });
  });
});

describe("automatic retries for temporary failures", () => {
  it.each(["network", "server", "unknown"] as const)("retries a %s failure three times, then waits for the player", async (problem) => {
    const { session, sent, answer } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);

    const delays = cloudSessionOptions.retryDelaysMs;
    for (let attempt = 1; attempt <= delays.length; attempt += 1) {
      await answer(failed(problem));
      expect(session.getSnapshot()).toEqual({
        status: "error", problem, failedAttempts: attempt, nextRetryAt: Date.now() + delays[attempt - 1], hasUnsavedChanges: true,
      });
      await vi.advanceTimersByTimeAsync(delays[attempt - 1] - 1);
      expect(sent()).toHaveLength(attempt);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent()).toHaveLength(attempt + 1);
    }
    await answer(failed(problem));

    expect(session.getSnapshot()).toEqual({ status: "error", problem, failedAttempts: 4, nextRetryAt: null, hasUnsavedChanges: true });
    // No more automatic attempts, however long it waits.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(sent()).toHaveLength(4);
  });

  it("is saved once a retry works, and the count starts over", async () => {
    const { session, answer } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await answer(failed("network"));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.retryDelaysMs[0]);
    await answer(saved);
    expect(session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });

    session.requestSave(edit(2));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await answer(failed("network"));
    expect(session.getSnapshot()).toMatchObject({ failedAttempts: 1 });
  });

  it.each(["signed-out", "denied", "too-large", "rejected", "storage"] as const)("doesn't retry a %s failure on its own", async (problem) => {
    const { session, sent, answer } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await answer(failed(problem));

    expect(session.getSnapshot()).toEqual({ status: "error", problem, failedAttempts: 1, nextRetryAt: null, hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sent()).toHaveLength(1);
  });

  it("a new change replaces a waiting retry and starts the count over", async () => {
    const { session, sent, answer } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await answer(failed("network"));

    session.requestSave(edit(2));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    expect(sent()).toEqual(["Edit 1", "Edit 2"]);
    await answer(failed("network"));
    expect(session.getSnapshot()).toMatchObject({ failedAttempts: 1 });

    // The old retry timer is gone: only the new one fires.
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.retryDelaysMs[0]);
    expect(sent()).toEqual(["Edit 1", "Edit 2", "Edit 2"]);
  });

  it("a write that throws counts as a temporary failure", async () => {
    const storage: GameStorage = { load: async () => ready, save: vi.fn(async () => { throw new Error("boom"); }) };
    const session = createGameDataSession(storage, cloudSessionOptions);
    await session.load(base);

    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);

    expect(session.getSnapshot()).toMatchObject({ status: "error", problem: "unknown", failedAttempts: 1 });
  });

  it("browser sessions don't retry on their own, as before; the next change tries again", async () => {
    const { session, sent, answer } = await loadedSession({});
    session.requestSave(edit(1));
    await answer(failed("storage"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sent()).toEqual(["Edit 1"]);

    expect(session.requestSave(edit(1))).toBe("unchanged");
    expect(session.requestSave(edit(2))).toBe("saving");
    expect(sent()).toEqual(["Edit 1", "Edit 2"]);
  });

  it("never retries because the same data is asked for again, as React does on every render", async () => {
    // A listener that asks again on every change, like the quest store's save effect re-rendering
    // after each save-status change. Before this rule, that retried forever.
    for (const options of [{}, cloudSessionOptions]) {
      const { session, sent, answer } = await loadedSession(options);
      session.subscribe(() => { session.requestSave(edit(1)); });
      session.requestSave(edit(1));
      await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
      await answer(failed(options === cloudSessionOptions ? "signed-out" : "storage"));
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(sent()).toEqual(["Edit 1"]);
      expect(session.getSnapshot()).toMatchObject({ status: "error", failedAttempts: 1 });
    }
  });

  it("asking again during automatic retries doesn't restart their count", async () => {
    const { session, sent, answer } = await loadedSession();
    session.subscribe(() => { session.requestSave(edit(1)); });
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    for (const delay of cloudSessionOptions.retryDelaysMs) {
      await answer(failed("network"));
      await vi.advanceTimersByTimeAsync(delay);
    }
    await answer(failed("network"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(sent()).toHaveLength(1 + cloudSessionOptions.retryDelaysMs.length);
    expect(session.getSnapshot()).toMatchObject({ status: "error", nextRetryAt: null });
  });
});

describe("manual retry", () => {
  it("writes the newest unsaved change at once", async () => {
    const { session, sent, answer } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await answer(failed("signed-out"));

    expect(session.retry()).toBe(true);
    expect(sent()).toEqual(["Edit 1", "Edit 1"]);
    await answer(saved);
    expect(session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });
  });

  it("replaces a waiting automatic retry instead of adding one", async () => {
    const { session, sent, answer } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await answer(failed("network"));

    session.retry();
    await answer(saved);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent()).toEqual(["Edit 1", "Edit 1"]);
  });

  it("does nothing unless there's an error to retry", async () => {
    const { session, answer } = await loadedSession();
    expect(session.retry()).toBe(false);

    session.requestSave(edit(1));
    expect(session.retry()).toBe(false);
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    expect(session.retry()).toBe(false);
    await answer(saved);
    expect(session.retry()).toBe(false);
  });
});

describe("conflicts stop saving until the player reloads", () => {
  async function inConflict(backup: "saved" | "failed" = "saved") {
    const env = await loadedSession(cloudSessionOptions, [ready, { status: "ready", data: edit(100), storedText: JSON.stringify(edit(100)) }]);
    env.session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await env.answer({ status: "conflict", backup });
    return env;
  }

  it("reports the conflict and whether the unsaved changes were backed up", async () => {
    expect((await inConflict("saved")).session.getSnapshot()).toEqual({ status: "conflict", backup: "saved", hasUnsavedChanges: true });
    expect((await inConflict("failed")).session.getSnapshot()).toEqual({ status: "conflict", backup: "failed", hasUnsavedChanges: true });
  });

  it("writes nothing more, automatically or otherwise, but keeps the newest unsaved change", async () => {
    const { session, sent } = await inConflict();

    expect(session.requestSave(edit(2))).toBe("blocked");
    expect(session.retry()).toBe(false);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await session.flush();

    expect(sent()).toEqual(["Edit 1"]);
    expect(session.getUnsavedData()).toEqual(edit(2));
    expect(session.getSnapshot()).toMatchObject({ status: "conflict", hasUnsavedChanges: true });
  });

  it("reload is the way out: it takes the latest save and saving resumes from it", async () => {
    const { session, storage, sent, answer } = await inConflict();

    const outcome = await session.reload(base);

    expect(outcome).toEqual({ status: "ready", data: edit(100), discardedUnsavedChanges: true, cancelled: false });
    expect(storage.load).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });
    expect(session.requestSave(edit(100))).toBe("unchanged");
    session.requestSave(edit(101));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await answer(saved);
    expect(sent()).toEqual(["Edit 1", "Edit 101"]);
  });

  it("reload waits for a write already sent, and that write can't change what's shown", async () => {
    const { session, answer } = await loadedSession(cloudSessionOptions, [ready, ready]);
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getSnapshot().status));

    const reloading = session.reload(base);
    expect(session.getSnapshot().status).toBe("loading");
    expect(session.requestSave(edit(2))).toBe("blocked");
    await answer(saved);
    await reloading;

    // Only "loading" until the reload finishes (it's announced again when the sent write's result clears
    // the unsaved changes), then "saved" from the reload itself.
    expect(seen.at(-1)).toBe("saved");
    expect(seen.slice(0, -1).every((status) => status === "loading")).toBe(true);
  });

  it("reload after a failed load tries loading again", async () => {
    const { session } = await loadedSession(cloudSessionOptions, [{ status: "failed", data: base, problem: "network" }, ready]);

    expect(await session.reload(base)).toEqual({ status: "ready", data: base, discardedUnsavedChanges: false, cancelled: false });
    expect(session.status).toBe("ready");
  });
});

describe("closing: an old session never affects the next account", () => {
  it("stops writing and announcing, and keeps unsaved changes readable", async () => {
    const { session, storage, seen } = await loadedSession();
    session.requestSave(edit(1));

    session.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(storage.save).not.toHaveBeenCalled();
    expect(session.requestSave(edit(2))).toBe("blocked");
    expect(session.getUnsavedData()).toEqual(edit(1));
    expect(session.getSnapshot()).toEqual({ status: "closed", problem: "identity-changed", hasUnsavedChanges: true });
    expect(seen).toEqual(["saving", "closed"]);
  });

  it("a write that finishes after closing announces nothing, but its result is still known", async () => {
    const { session, answer, seen } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    session.close();
    seen.length = 0;

    await answer(saved);

    expect(seen).toEqual([]);
    expect(session.getUnsavedData()).toBeNull();
    await expect(session.whenIdle()).resolves.toBeUndefined();
  });

  it("a write that fails after closing announces nothing and is never retried", async () => {
    const { session, answer, sent, seen } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    session.close();
    seen.length = 0;

    await answer(failed("network"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(seen).toEqual([]);
    expect(sent()).toHaveLength(1);
    expect(session.getUnsavedData()).toEqual(edit(1));
  });

  it("a waiting retry never fires after closing", async () => {
    const { session, answer, sent } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await answer(failed("network"));

    session.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent()).toHaveLength(1);
  });

  it("a load that finishes after closing changes nothing", async () => {
    let finishLoad: (result: GameStorageLoadResult) => void = () => {};
    const storage: GameStorage = {
      load: vi.fn(() => new Promise<GameStorageLoadResult>((resolve) => { finishLoad = resolve; })),
      save: vi.fn(),
    };
    const session = createGameDataSession(storage, cloudSessionOptions);
    const listener = vi.fn();
    session.subscribe(listener);
    const loading = session.load(base);

    session.close();
    listener.mockClear();
    finishLoad(ready);
    await loading;

    expect(listener).not.toHaveBeenCalled();
    expect(session.status).toBe("loading");
    expect(session.requestSave(edit(1))).toBe("blocked");
  });

  it("closes itself when storage says the account changed, keeping the unsaved change", async () => {
    const { session, answer, sent, seen } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);

    await answer(failed("identity-changed"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.getSnapshot()).toEqual({ status: "closed", problem: "identity-changed", hasUnsavedChanges: true });
    expect(session.getUnsavedData()).toEqual(edit(1));
    expect(sent()).toHaveLength(1);
    expect(seen.at(-1)).toBe("closed");
  });

  it("the next account's session hears nothing from the old one", async () => {
    const old = await loadedSession();
    old.session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    const next = await loadedSession();
    const nextListener = vi.fn();
    next.session.subscribe(nextListener);

    old.session.close();
    await old.answer(saved);

    expect(nextListener).not.toHaveBeenCalled();
    expect(next.session.getSnapshot()).toEqual({ status: "saved", hasUnsavedChanges: false });
  });

  it("subscribing after closing does nothing", async () => {
    const { session } = await loadedSession();
    session.close();
    const listener = vi.fn();
    session.subscribe(listener)();
    session.close();
    expect(listener).not.toHaveBeenCalled();
  });

  it("reload after closing loads nothing", async () => {
    const { session, storage } = await loadedSession();
    session.close();

    expect(await session.reload(base)).toEqual({ status: "failed", data: base, problem: "identity-changed", discardedUnsavedChanges: false, cancelled: true });
    expect(storage.load).toHaveBeenCalledTimes(1);
  });
});

describe("conflict backups describe the newest unsaved change exactly (Codex Step 4 finding 1)", () => {
  /** Edit 1 is being written; the test decides what happens meanwhile, then the write conflicts. */
  async function conflictWhileWriting(backup: "saved" | "failed", meanwhile: (session: ReturnType<typeof createGameDataSession>) => void = () => {}) {
    const env = await loadedSession();
    env.session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    meanwhile(env.session);
    await env.answer({ status: "conflict", backup });
    return env;
  }

  it("reports saved when the backup holds exactly the newest change", async () => {
    const { session } = await conflictWhileWriting("saved");

    expect(session.getSnapshot()).toEqual({ status: "conflict", backup: "saved", hasUnsavedChanges: true });
    expect(session.getUnsavedData()).toEqual(edit(1));
  });

  it("reports outdated when a newer change was queued while the conflicting write was running", async () => {
    const { session, sent } = await conflictWhileWriting("saved", (s) => {
      expect(s.requestSave(edit(2))).toBe("queued");
    });

    expect(session.getSnapshot()).toEqual({ status: "conflict", backup: "outdated", hasUnsavedChanges: true });
    // The queued change was never written, and is still kept.
    expect(sent()).toEqual(["Edit 1"]);
    expect(session.getUnsavedData()).toEqual(edit(2));
  });

  it("becomes outdated when changes are made after the conflict, and saved again only for that exact data", async () => {
    const { session } = await conflictWhileWriting("saved");
    const seen: string[] = [];
    session.subscribe(() => {
      const snapshot = session.getSnapshot();
      if (snapshot.status === "conflict") seen.push(snapshot.backup);
    });

    session.requestSave(edit(2));
    expect(session.getSnapshot()).toEqual({ status: "conflict", backup: "outdated", hasUnsavedChanges: true });
    expect(session.getUnsavedData()).toEqual(edit(2));

    session.requestSave(edit(3));
    expect(session.getSnapshot()).toMatchObject({ backup: "outdated" });
    expect(session.getUnsavedData()).toEqual(edit(3));

    // Back to exactly what the backup holds.
    session.requestSave(edit(1));
    expect(session.getSnapshot()).toMatchObject({ backup: "saved" });
    expect(seen).toEqual(["outdated", "saved"]);
  });

  it("stays failed whatever changes follow when the backup couldn't be made", async () => {
    const { session } = await conflictWhileWriting("failed", (s) => { s.requestSave(edit(2)); });

    expect(session.getSnapshot()).toMatchObject({ status: "conflict", backup: "failed" });
    session.requestSave(edit(1));
    expect(session.getSnapshot()).toMatchObject({ backup: "failed" });
  });

  it("flush in a conflict reports the conflict and the unsaved change, writing nothing", async () => {
    const { session, sent } = await conflictWhileWriting("saved");
    session.requestSave(edit(2));

    expect(await session.flush()).toEqual({ status: "conflict", backup: "outdated", hasUnsavedChanges: true });
    expect(sent()).toEqual(["Edit 1"]);
  });
});

describe("closing during a reload (Codex Step 4 finding 2)", () => {
  it("start reload, close, let the in-flight save fail: unsaved data stays and the session stays closed", async () => {
    const { session, storage, answer, seen } = await loadedSession();
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);

    const reloading = session.reload(base);
    session.close();
    seen.length = 0;
    await answer(failed("network"));
    const outcome = await reloading;

    expect(outcome).toEqual({ status: "failed", data: base, problem: "identity-changed", discardedUnsavedChanges: false, cancelled: true });
    expect(session.getUnsavedData()).toEqual(edit(1));
    expect(session.getSnapshot()).toEqual({ status: "closed", problem: "identity-changed", hasUnsavedChanges: true });
    expect(storage.load).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it("closing while the reload's read is running keeps unsaved data and never applies the read", async () => {
    let finishReload: (result: GameStorageLoadResult) => void = () => {};
    const controlled = controlledStorage();
    const load = vi.mocked(controlled.storage.load);
    load.mockImplementationOnce(async () => ready)
      .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));
    const session = createGameDataSession(controlled.storage, cloudSessionOptions);
    await session.load(base);
    session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await controlled.answer({ status: "conflict", backup: "saved" });

    const reloading = session.reload(base);
    await vi.advanceTimersByTimeAsync(0);
    session.close();
    finishReload({ status: "ready", data: edit(100), storedText: JSON.stringify(edit(100)) });

    expect(await reloading).toMatchObject({ status: "failed", data: base, cancelled: true, discardedUnsavedChanges: false });
    expect(session.getUnsavedData()).toEqual(edit(1));
    expect(session.getSnapshot()).toEqual({ status: "closed", problem: "identity-changed", hasUnsavedChanges: true });
  });

  it("a reload that fails to read keeps the unsaved changes", async () => {
    const env = await loadedSession(cloudSessionOptions, [ready, { status: "failed", data: base, problem: "network" }]);
    env.session.requestSave(edit(1));
    await vi.advanceTimersByTimeAsync(cloudSessionOptions.debounceMs);
    await env.answer({ status: "conflict", backup: "failed" });

    const outcome = await env.session.reload(base);

    expect(outcome).toEqual({ status: "failed", data: base, problem: "network", discardedUnsavedChanges: false, cancelled: false });
    expect(env.session.getUnsavedData()).toEqual(edit(1));
    expect(env.session.getSnapshot()).toEqual({ status: "load-failed", problem: "network", hasUnsavedChanges: true });
  });

  it("a reload replaced by a newer one is cancelled and changes nothing", async () => {
    const resolvers: Array<(result: GameStorageLoadResult) => void> = [];
    const controlled = controlledStorage();
    vi.mocked(controlled.storage.load)
      .mockImplementationOnce(async () => ready)
      .mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
    const session = createGameDataSession(controlled.storage, cloudSessionOptions);
    await session.load(base);

    const first = session.reload(base);
    await vi.advanceTimersByTimeAsync(0);
    const second = session.reload(base);
    await vi.advanceTimersByTimeAsync(0);
    resolvers[1]({ status: "ready", data: edit(2), storedText: JSON.stringify(edit(2)) });
    resolvers[0]({ status: "ready", data: edit(1), storedText: JSON.stringify(edit(1)) });

    expect(await second).toMatchObject({ status: "ready", data: edit(2), cancelled: false });
    expect(await first).toMatchObject({ status: "failed", data: base, cancelled: true });
    expect(session.requestSave(edit(2))).toBe("unchanged");
  });

  it("an initial load that finishes after closing hands out the fallback, never the stale save", async () => {
    let finishLoad: (result: GameStorageLoadResult) => void = () => {};
    const storage: GameStorage = {
      load: vi.fn(() => new Promise<GameStorageLoadResult>((resolve) => { finishLoad = resolve; })),
      save: vi.fn(),
    };
    const session = createGameDataSession(storage, cloudSessionOptions);
    const loading = session.load(base);

    session.close();
    finishLoad({ status: "ready", data: edit(9), storedText: JSON.stringify(edit(9)) });

    expect(await loading).toEqual({ status: "failed", data: base, problem: "identity-changed" });
  });
});

describe("a load that closes the session announces it (Codex Step 4 finding 3)", () => {
  it("tells subscribers once that the session closed, then nothing more", async () => {
    const controlled = controlledStorage([{ status: "failed", data: base, problem: "identity-changed" }]);
    const session = createGameDataSession(controlled.storage, cloudSessionOptions);
    const listener = vi.fn(() => session.getSnapshot());
    session.subscribe(listener);

    await session.load(base);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.results[0].value).toEqual({ status: "closed", problem: "identity-changed", hasUnsavedChanges: false });
    session.requestSave(edit(1));
    session.close();
    await session.reload(base);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controlled.storage.load).toHaveBeenCalledTimes(1);
  });

  it("matches close(): the same final snapshot, and later subscribers hear nothing", async () => {
    const closedByLoad = createGameDataSession(controlledStorage([{ status: "failed", data: base, problem: "identity-changed" }]).storage, cloudSessionOptions);
    await closedByLoad.load(base);
    const closedByCall = createGameDataSession(controlledStorage().storage, cloudSessionOptions);
    await closedByCall.load(base);
    closedByCall.close("identity-changed");

    expect(closedByLoad.getSnapshot()).toEqual(closedByCall.getSnapshot());
    const late = vi.fn();
    closedByLoad.subscribe(late);
    closedByLoad.close();
    expect(late).not.toHaveBeenCalled();
  });
});
