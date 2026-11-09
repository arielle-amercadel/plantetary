import type { StoredQuestData } from "./quest-types";
import type { GameSaveResult, GameStorage, GameStorageProblem, StorageStatus } from "./game-storage";

export type GameDataLoadOutcome = {
  status: Exclude<StorageStatus, "loading">;
  data: StoredQuestData;
  /** Why a load failed, when storage said. */
  problem?: GameStorageProblem;
};

/**
 * - `blocked`: nothing was written, because loading hasn't finished or failed, the save is in conflict,
 *   or the session is closed.
 * - `unchanged`: nothing was written, because storage already has (or is about to have) this data.
 * - `saving`: a write started.
 * - `scheduled`: a write starts after a short pause, with the newest data by then.
 * - `queued`: a write is already running; this data is written after it, replacing any older queued data.
 */
export type SaveRequestOutcome = "blocked" | "unchanged" | "saving" | "scheduled" | "queued";

/**
 * Where the save stands, for the player to see.
 *
 * - `loading`: the save is being read. Nothing is written.
 * - `load-failed`: the save couldn't be read (or mustn't be replaced). Nothing is written this session.
 * - `empty`: cloud only. The account has no save yet. Nothing is written until the player chooses.
 * - `saved`: storage has every change made so far.
 * - `saving`: a change is being written, or is about to be.
 * - `error`: the latest change couldn't be written. `nextRetryAt` is when it's tried again on its own
 *   (a timestamp), or null if it waits for `retry()` or the next change.
 * - `conflict`: the save changed in another tab or on another device. Nothing more is written until the
 *   player chooses `reload()`. `backup` describes the newest unsaved change, exactly:
 *   - `saved`: that exact data was kept as a backup copy.
 *   - `outdated`: a backup copy was kept, but of earlier changes; newer ones exist only on this screen.
 *   - `failed`: the backup copy couldn't be made; the unsaved changes exist only on this screen.
 * - `closed`: this session ended (the account changed, or it was closed). Nothing more is written.
 *
 * `hasUnsavedChanges` is true whenever a change exists that storage doesn't have, in any state.
 */
export type SaveState =
  | { status: "loading" }
  | { status: "load-failed"; problem: GameStorageProblem | null }
  | { status: "empty" }
  | { status: "saved" }
  | { status: "saving" }
  | { status: "error"; problem: GameStorageProblem; failedAttempts: number; nextRetryAt: number | null }
  | { status: "conflict"; backup: "saved" | "outdated" | "failed" }
  | { status: "closed"; problem: GameStorageProblem };

export type SaveSnapshot = SaveState & { hasUnsavedChanges: boolean };

export type ReloadOutcome = GameDataLoadOutcome & {
  discardedUnsavedChanges: boolean;
  /** True if this reload didn't take effect: the session closed, or a newer reload replaced it. */
  cancelled: boolean;
};

export type GameDataSessionOptions = {
  /**
   * How long to wait after a change before writing it, so a burst of changes is one write. 0 writes at
   * once, synchronously, as browser storage always has, so a change survives an immediate reload.
   */
  debounceMs?: number;
  /**
   * Waits before each automatic retry of a temporary failure (network, server, unknown). Its length is
   * the most automatic retries in a row; after that, a save waits for `retry()` or the next change.
   * Empty means no automatic retries, as browser storage always has been.
   */
  retryDelaysMs?: readonly number[];
};

/** For cloud saves: a short pause to group changes, and three retries spread over about 20 seconds. */
export const cloudSessionOptions: Required<GameDataSessionOptions> = {
  debounceMs: 750,
  retryDelaysMs: [2_000, 5_000, 15_000],
};

/** Failures that may pass on their own, so retrying automatically can help. */
const temporaryProblems: ReadonlySet<GameStorageProblem> = new Set(["network", "server", "unknown"]);

export type GameDataSession = {
  readonly status: StorageStatus;
  /** Loads once. Calling it again returns the same result, which suits React's development double effects. */
  load: (fallbackData: StoredQuestData) => Promise<GameDataLoadOutcome>;
  requestSave: (data: StoredQuestData) => SaveRequestOutcome;
  /** Resolves once nothing is being written or waiting for the pause before a write. Retries waiting on a timer don't count. */
  whenIdle: () => Promise<void>;

  /** Where the save stands now. The same object until something changes, so React can subscribe to it. */
  getSnapshot: () => SaveSnapshot;
  /** Calls `listener` after every change to the snapshot, until unsubscribed or the session closes. */
  subscribe: (listener: () => void) => () => void;
  /** The newest change storage doesn't have, or null. Still available after the session closes. */
  getUnsavedData: () => StoredQuestData | null;
  /**
   * Only after the player chose to start a fresh save, for an account with none (`empty`): allows
   * writing, starting from nothing. The first write creates the save; if one appeared meanwhile, storage
   * reports a conflict rather than replacing it. Returns false in any other state.
   */
  beginFirstSave: () => boolean;
  /** After an error: writes the newest unsaved change now. Returns whether a write started. */
  retry: () => boolean;
  /** Writes a change waiting for the pause now, and resolves when idle (for example, before signing out). */
  flush: () => Promise<SaveSnapshot>;
  /**
   * The explicit way out of a conflict, or another try after a failed load: reads the save again and
   * starts over from it. Only once that read succeeds are unsaved changes dropped (after a conflict, the
   * conflict state's `backup` says what was kept); `discardedUnsavedChanges` says whether any were.
   * If the session closes meanwhile, or a newer reload replaces this one, nothing changes and the
   * outcome is `cancelled`, with the fallback data.
   */
  reload: (fallbackData: StoredQuestData) => Promise<ReloadOutcome>;
  /**
   * Ends the session, for example when the account changes. Nothing more is written or announced, and
   * any write already sent finishes on its own. Unsaved changes stay readable with `getUnsavedData`.
   */
  close: (problem?: GameStorageProblem) => void;
  /** Stop queued browser writes. A retained garden also invalidates the saved baseline after an unverified reset. */
  pauseForConflict?: (retainedGarden?: StoredQuestData) => void;
};

/**
 * Guards the save for one app session, and one account. Nothing is written until a load succeeds, so a
 * slow or failed load can never replace a real save with starter data. Writes run one at a time, in
 * order, with only the newest waiting change written next.
 *
 * Temporary failures are retried a limited number of times (see `retryDelaysMs`). A conflict stops all
 * writing until `reload()`. A session that's closed, or whose storage reports the account changed,
 * writes and announces nothing more, so it can never affect the next account's session.
 */
export function createGameDataSession(storage: GameStorage, options: GameDataSessionOptions = {}): GameDataSession {
  const debounceMs = options.debounceMs ?? 0;
  const retryDelaysMs = options.retryDelaysMs ?? [];

  let status: StorageStatus = "loading";
  let loadPromise: Promise<GameDataLoadOutcome> | undefined;
  /** Bumped by every load, so a reply to an older load is ignored. */
  let loadGeneration = 0;
  /** What storage holds, as far as this session knows. */
  let savedText: string | null = null;
  /** The newest change requested, saved or not. */
  let latest: { data: StoredQuestData; text: string } | undefined;
  let inFlight: { text: string; done: Promise<void> } | undefined;
  /** The next change to write: waiting for the pause, for a running write, or for a retry. */
  let pending: { data: StoredQuestData; text: string } | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Failed writes since the last new change, which limits automatic retries. */
  let failedAttempts = 0;
  let closed = false;
  /** After a conflict: whether the conflict backup worked, and exactly which data it holds. */
  let conflictBackup: { result: "saved" | "failed"; text: string } | undefined;
  let state: SaveState = { status: "loading" };
  let snapshot: SaveSnapshot = { ...state, hasUnsavedChanges: false };
  const listeners = new Set<() => void>();
  /** Waiters for the session to go idle. */
  let idleWaiters: Array<() => void> = [];

  function unsavedChange() {
    return latest && latest.text !== savedText ? latest : undefined;
  }

  function isIdle() {
    return !inFlight && debounceTimer === undefined;
  }

  /** Updates the snapshot and tells listeners, if anything they can see changed. */
  function publish(next: SaveState = state) {
    // The backup is described against the newest unsaved change, which may have moved on since.
    if (next.status === "conflict") next = { status: "conflict", backup: describeConflictBackup() };
    state = next;
    const nextSnapshot: SaveSnapshot = { ...next, hasUnsavedChanges: Boolean(unsavedChange()) };
    const same = Object.keys(nextSnapshot).length === Object.keys(snapshot).length &&
      (Object.keys(nextSnapshot) as Array<keyof SaveSnapshot>).every((key) => nextSnapshot[key] === snapshot[key]);
    if (!same) {
      snapshot = nextSnapshot;
      if (!closed) listeners.forEach((listener) => listener());
    }
    if (isIdle()) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  function describeConflictBackup(): "saved" | "outdated" | "failed" {
    if (!conflictBackup || conflictBackup.result === "failed") return "failed";
    return latest?.text === conflictBackup.text ? "saved" : "outdated";
  }

  function closedProblem(): GameStorageProblem {
    return state.status === "closed" ? state.problem : "identity-changed";
  }

  function clearTimers() {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    debounceTimer = undefined;
    retryTimer = undefined;
  }

  function canWrite() {
    return !closed && status === "ready" && state.status !== "conflict";
  }

  /**
   * Reads the save. `applied` is false when the reply arrived after the session closed or a newer load
   * started, in which case nothing changed. With `discardUnsaved`, a successful read also drops unsaved
   * changes (for reload), in the same step, so they're never dropped unless the read worked.
   */
  async function loadNow(fallbackData: StoredQuestData, discardUnsaved = false): Promise<{ outcome: GameDataLoadOutcome; applied: boolean }> {
    const generation = ++loadGeneration;
    status = "loading";
    publish({ status: "loading" });
    let outcome: GameDataLoadOutcome;
    let next: SaveState;
    let nextSavedText: string | null = null;
    try {
      const result = await storage.load(fallbackData);
      if (result.status === "ready") {
        nextSavedText = result.storedText;
        outcome = { status: "ready", data: result.data };
        next = { status: "saved" };
      } else if (result.status === "empty") {
        // An account with no cloud save yet: nothing is created until the player chooses to.
        outcome = { status: "failed", data: result.data };
        next = { status: "empty" };
      } else {
        outcome = { status: "failed", data: result.data, ...(result.problem ? { problem: result.problem } : {}) };
        next = result.problem === "identity-changed"
          ? { status: "closed", problem: "identity-changed" }
          : { status: "load-failed", problem: result.problem ?? null };
      }
    } catch {
      console.error("Plantetary could not load saved data. Changes will not be saved this session.");
      outcome = { status: "failed", data: fallbackData };
      next = { status: "load-failed", problem: null };
    }

    // A newer load, or closing, makes this reply irrelevant.
    if (generation !== loadGeneration || closed) return { outcome, applied: false };
    status = outcome.status;
    savedText = nextSavedText;
    if (next.status === "closed") {
      // The same way out as close(): listeners hear "closed" once, then nothing more.
      close(next.problem);
      return { outcome, applied: true };
    }
    if (discardUnsaved && (next.status === "saved" || next.status === "empty")) {
      latest = undefined;
      conflictBackup = undefined;
    }
    publish(next);
    return { outcome, applied: true };
  }

  /** What to show while nothing is being written. */
  function settledState(): SaveState {
    return { status: "saved" };
  }

  function startSave() {
    if (!pending || !canWrite()) return;
    const { data, text } = pending;
    pending = undefined;
    clearTimers();

    // Recorded before the adapter is called. An adapter can throw synchronously, which finishes the
    // save below before it ever awaits; recording it afterwards would leave it marked as running forever.
    const save: { text: string; done: Promise<void> } = { text, done: Promise.resolve() };
    inFlight = save;
    publish({ status: "saving" });

    // The adapter is called synchronously, so the browser write happens immediately, as before.
    save.done = (async () => {
      let result: GameSaveResult;
      try {
        result = (await storage.save(data)) ?? { status: "failed", problem: "unknown" };
      } catch {
        result = { status: "failed", problem: "unknown" };
      }
      if (inFlight === save) inFlight = undefined;
      finishSave({ data, text }, result);
    })();
  }

  function finishSave(written: { data: StoredQuestData; text: string }, result: GameSaveResult) {
    // Closed, or reloading: only what storage now holds is recorded. Nothing more is written or shown.
    if (closed || status !== "ready") {
      if (result.status === "saved") savedText = written.text;
      publish();
      return;
    }

    if (result.status === "saved") {
      savedText = written.text;
      failedAttempts = 0;
      // A change made while this one was being written goes next.
      if (pending && pending.text !== savedText && canWrite()) {
        startSave();
        return;
      }
      pending = undefined;
      publish(settledState());
      return;
    }

    if (result.status === "conflict") {
      // Nothing more is written until the player reloads: retrying could only conflict again, and the
      // other change must never be overwritten.
      clearTimers();
      // A change queued behind this write is dropped from the write queue, but stays unsaved (`latest`).
      pending = undefined;
      conflictBackup = { result: result.backup, text: written.text };
      publish({ status: "conflict", backup: result.backup });
      return;
    }

    console.error("Plantetary could not save your latest changes.");
    if (result.problem === "identity-changed") {
      // The account changed: this session is over. Its unsaved changes stay readable.
      close("identity-changed");
      return;
    }
    failedAttempts += 1;
    // The newest unsaved change is what any retry writes: a change made meanwhile, or this one.
    pending = pending ?? (written.text !== savedText ? written : undefined);
    if (!pending) return publish(settledState());

    // A change made while this write was running hasn't been tried yet, so it goes now.
    if (pending.text !== written.text) {
      startSave();
      return;
    }

    const delay = temporaryProblems.has(result.problem) ? retryDelaysMs[failedAttempts - 1] : undefined;
    if (delay === undefined) {
      // Not temporary, or out of automatic retries: it waits for retry() or the next change.
      return publish({ status: "error", problem: result.problem, failedAttempts, nextRetryAt: null });
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      startSave();
    }, delay);
    publish({ status: "error", problem: result.problem, failedAttempts, nextRetryAt: Date.now() + delay });
  }

  function close(problem: GameStorageProblem = "identity-changed") {
    if (closed) return;
    clearTimers();
    pending = undefined;
    publish({ status: "closed", problem });
    // Tell listeners once that it's closed, then nothing more.
    closed = true;
    listeners.clear();
    loadGeneration += 1;
  }

  return {
    get status() {
      return status;
    },
    load(fallbackData) {
      loadPromise ??= loadNow(fallbackData).then(({ outcome, applied }) =>
        // A reply that came too late is never handed out as playable data.
        applied ? outcome : { status: "failed", data: fallbackData, ...(closed ? { problem: closedProblem() } : {}) });
      return loadPromise;
    },
    requestSave(data) {
      if (closed || status !== "ready") return "blocked";

      const text = JSON.stringify(data);
      const latestText = pending?.text ?? inFlight?.text ?? savedText;
      if (state.status === "conflict") {
        // Not written, but kept, so the player can be told there are unsaved changes.
        latest = { data, text };
        publish();
        return "blocked";
      }
      // The same data as the newest change is never a new attempt, whatever happened to it. React may
      // ask again on every render (including the renders a save-status change causes), and treating
      // that as a retry would retry forever. Retries come from a different change, retry(), or the
      // limited automatic retries.
      if (text === (latest?.text ?? latestText)) return "unchanged";
      if (text === savedText && !inFlight) {
        // Back to what storage already has: nothing to write, and nothing left unsaved.
        latest = { data, text };
        pending = undefined;
        clearTimers();
        failedAttempts = 0;
        publish(settledState());
        return "unchanged";
      }

      latest = { data, text };
      pending = { data, text };
      // A new change: automatic retries start over, and a waiting retry is replaced by this write.
      failedAttempts = 0;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }

      if (inFlight) {
        publish();
        return "queued";
      }
      if (debounceMs > 0) {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined;
          startSave();
          if (!inFlight) publish();
        }, debounceMs);
        publish({ status: "saving" });
        return "scheduled";
      }
      startSave();
      return "saving";
    },
    async whenIdle() {
      if (isIdle()) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUnsavedData: () => unsavedChange()?.data ?? null,
    beginFirstSave() {
      if (closed || state.status !== "empty") return false;
      status = "ready";
      savedText = null;
      publish({ status: "saved" });
      return true;
    },
    retry() {
      if (!canWrite() || state.status !== "error" || inFlight) return false;
      const change = unsavedChange();
      if (!change) return false;
      pending = change;
      failedAttempts = 0;
      startSave();
      return true;
    },
    async flush() {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
        if (!inFlight) startSave();
      }
      if (!isIdle()) await new Promise<void>((resolve) => idleWaiters.push(resolve));
      return snapshot;
    },
    async reload(fallbackData) {
      const cancelled = (): ReloadOutcome => ({
        status: "failed",
        data: fallbackData,
        ...(closed ? { problem: closedProblem() } : {}),
        discardedUnsavedChanges: false,
        cancelled: true,
      });
      if (closed) return cancelled();
      clearTimers();
      pending = undefined;
      // Nothing new is written from here. A write already sent finishes first, so the reload reads what it left.
      status = "loading";
      publish({ status: "loading" });
      if (inFlight) await inFlight.done;
      // Closed while that write finished: nothing is cleared and nothing more is loaded.
      if (closed) return cancelled();

      failedAttempts = 0;
      const hadUnsavedChanges = Boolean(unsavedChange());
      const run = loadNow(fallbackData, true);
      loadPromise = run.then(({ outcome }) => outcome);
      const { outcome, applied } = await run;
      if (!applied || closed) return cancelled();
      const discardedUnsavedChanges = hadUnsavedChanges && !unsavedChange();
      return { ...outcome, discardedUnsavedChanges, cancelled: false };
    },
    pauseForConflict(retainedGarden) {
      if (retainedGarden) {
        latest = latest ?? { data: retainedGarden, text: JSON.stringify(retainedGarden) };
        savedText = null;
      }
      clearTimers();
      pending = undefined;
      conflictBackup = undefined;
      publish({ status: "conflict", backup: "failed" });
    },
    close,
  };
}
