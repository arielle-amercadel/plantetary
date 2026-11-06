import type { StoredQuestData } from "./quest-types";
import type { GameStorage, StorageStatus } from "./game-storage";

export type GameDataLoadOutcome = {
  status: Exclude<StorageStatus, "loading">;
  data: StoredQuestData;
};

/**
 * - `blocked`: nothing was written, because loading hasn't finished or it failed.
 * - `unchanged`: nothing was written, because storage already has (or is about to have) this data.
 * - `saving`: a write started.
 * - `queued`: a write is already running; this data is written after it, replacing any older queued data.
 */
export type SaveRequestOutcome = "blocked" | "unchanged" | "saving" | "queued";

export type GameDataSession = {
  readonly status: StorageStatus;
  /** Loads once. Calling it again returns the same result, which suits React's development double effects. */
  load: (fallbackData: StoredQuestData) => Promise<GameDataLoadOutcome>;
  requestSave: (data: StoredQuestData) => SaveRequestOutcome;
  /** Resolves once every requested save has finished. */
  whenIdle: () => Promise<void>;
};

/**
 * Guards the save for one app session. Nothing is written until a load succeeds, so a slow or failed
 * load can never replace a real save with starter data. Writes run one at a time, in order.
 */
export function createGameDataSession(storage: GameStorage): GameDataSession {
  let status: StorageStatus = "loading";
  let loadPromise: Promise<GameDataLoadOutcome> | undefined;
  /** What storage holds, as far as this session knows. */
  let savedText: string | null = null;
  let inFlight: { text: string; done: Promise<void> } | undefined;
  let queued: { data: StoredQuestData; text: string } | undefined;

  async function loadOnce(fallbackData: StoredQuestData): Promise<GameDataLoadOutcome> {
    try {
      const result = await storage.load(fallbackData);
      if (result.status === "ready") {
        savedText = result.storedText;
        status = "ready";
        return { status: "ready", data: result.data };
      }
      // `empty` (an account with no cloud save yet) is treated as failed until the player chooses to
      // start a cloud save, so nothing is created automatically.
      status = "failed";
      return { status: "failed", data: result.data };
    } catch {
      console.error("Plantetary could not load saved data. Changes will not be saved this session.");
      status = "failed";
      return { status: "failed", data: fallbackData };
    }
  }

  function startSave(data: StoredQuestData, text: string) {
    // Recorded before the adapter is called. An adapter can throw synchronously, which finishes the
    // save below before it ever awaits; recording it afterwards would leave it marked as running forever.
    const save: { text: string; done: Promise<void> } = { text, done: Promise.resolve() };
    inFlight = save;

    // The adapter is called synchronously, so the browser write happens immediately, as before.
    save.done = (async () => {
      let saved = false;
      try {
        // Only "saved" counts. A conflict is reported like a failure here, and the cloud adapter refuses
        // every later write after one, so retrying can never overwrite the other change.
        saved = (await storage.save(data))?.status === "saved";
      } catch {
        saved = false;
      }

      if (saved) {
        savedText = text;
      } else {
        // savedText still describes what storage holds, so the next change tries again.
        console.error("Plantetary could not save your latest changes. It will try again after your next change.");
      }

      if (inFlight === save) inFlight = undefined;
      const next = queued;
      queued = undefined;
      if (next && next.text !== savedText) startSave(next.data, next.text);
    })();
  }

  return {
    get status() {
      return status;
    },
    load(fallbackData) {
      loadPromise ??= loadOnce(fallbackData);
      return loadPromise;
    },
    requestSave(data) {
      if (status !== "ready") return "blocked";

      const text = JSON.stringify(data);
      const latestText = queued?.text ?? inFlight?.text ?? savedText;
      if (text === latestText) return "unchanged";

      if (inFlight) {
        queued = { data, text };
        return "queued";
      }
      startSave(data, text);
      return "saving";
    },
    async whenIdle() {
      while (inFlight) {
        const current = inFlight;
        await current.done;
        // A finished save always clears itself; stopping here keeps a future bug from looping forever.
        if (inFlight === current) return;
      }
    },
  };
}
