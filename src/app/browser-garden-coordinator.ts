import { questStorageKey, browserResetStorageKey } from "./quest-storage";

/** One editor for the origin's browser garden. No localStorage leases or time-based lock stealing. */
export const browserGardenLock = "plantetary-browser-garden";
export type BrowserAccess = "follower" | "editor" | "unsupported" | "conflict";
export type BrowserCoordinationEvent = "acquired" | "changed" | "unavailable";
export type BrowserLockManager = Pick<LockManager, "request">;

export function createBrowserGardenCoordinator(
  getLocks: () => BrowserLockManager | undefined = () => typeof navigator === "undefined" ? undefined : navigator.locks,
  readText: () => string | null = () => window.localStorage.getItem(questStorageKey),
  readResetToken: () => string | null = () => window.localStorage.getItem(browserResetStorageKey),
) {
  let expectedText: string | null | undefined;
  let access: BrowserAccess = "follower";
  let active: { abort: AbortController; release?: () => void } | null = null;
  let notify: (event: BrowserCoordinationEvent) => void = () => {};
  return {
    getAccess: () => access,
    getResetToken() { try { return readResetToken(); } catch { return undefined; } },
    remember(text: string | null) { expectedText = text; },
    hasExternalChange() {
      try { return expectedText !== undefined && readText() !== expectedText; }
      catch { return true; }
    },
    canWrite: () => active !== null && access === "editor",
    start(onChange: (event: BrowserCoordinationEvent) => void) {
      notify = onChange;
      if (active) return;
      const lifetime = { abort: new AbortController(), release: undefined as (() => void) | undefined };
      active = lifetime;
      access = "follower";
      expectedText = undefined;
      try {
        const locks = getLocks();
        if (!locks) { access = "unsupported"; return; }
        void locks.request(browserGardenLock, { mode: "exclusive", signal: lifetime.abort.signal }, async () => {
          if (active !== lifetime || lifetime.abort.signal.aborted) return;
          await new Promise<void>((resolve) => {
            lifetime.release = resolve;
            access = "editor";
            notify("acquired");
          });
        }).catch(() => {
          if (active !== lifetime) return;
          access = "unsupported";
          notify("unavailable");
        });
      } catch {
        access = "unsupported";
      }
    },
    changed() { if (active) notify("changed"); },
    pause() { if (active && access === "editor") access = "conflict"; },
    /** Only called by an explicit reload, while the same lock is still held. */
    acknowledgeConflict() { if (active && access === "conflict") access = "editor"; },
    stop() {
      const previous = active;
      active = null;
      access = "follower";
      previous?.abort.abort();
      previous?.release?.();
    },
  };
}
export type BrowserGardenCoordinator = ReturnType<typeof createBrowserGardenCoordinator>;
