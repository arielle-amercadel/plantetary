import type { AuthState } from "./auth/auth-controller";
import type { VerifiedSignIn } from "./cloud-game-storage";
import type { GameDataSession, ReloadOutcome, SaveRequestOutcome, SaveSnapshot } from "./game-data-session";
import type { GameStorageProblem } from "./game-storage";
import type { StoredQuestData } from "./quest-types";
import { canonicalJson, type PersistedRecovery, type PersistedRecoveryStore } from "./unsaved-recovery-store";

/**
 * Where the game save comes from, for whoever is playing:
 * - `waiting`: who's signed in isn't known yet (the session is being checked), so nothing is read.
 * - `browser`: this browser's save. Guests, sign-ins that couldn't be verified, sign-ins that ended, and
 *   signed-in players who chose to keep playing on this device.
 * - `cloud`: the save in a verified account. Only a verified sign-in has an account ID.
 */
export type StorageTarget =
  | { kind: "waiting" }
  | { kind: "browser"; account: VerifiedSignIn["user"] | null }
  | { kind: "cloud"; signIn: VerifiedSignIn };

/**
 * - `waiting`: checking who's signed in.
 * - `loading`: reading the save.
 * - `ready`: `loaded` is the data to play. For browser storage, `loaded.status` may be `failed`: the
 *   save couldn't be read safely, so it's shown but never written over (see `loaded.problem`).
 * - `choose`: a verified account with no cloud save. Nothing is shown or written until the player
 *   chooses to start a fresh cloud garden or to keep playing on this device.
 * - `cloud-failed`: the cloud save couldn't be loaded. Nothing is shown or written: never starter data
 *   in its place. `problem` says why.
 */
export type StoragePhase = "waiting" | "loading" | "ready" | "choose" | "cloud-failed";

export type StorageControllerSnapshot = {
  /**
   * Bumped whenever the data to play is replaced: a new account, a new storage, or a reload. A save is
   * only accepted for the current generation, so data from an earlier one can never be written.
   */
  generation: number;
  phase: StoragePhase;
  mode: "browser" | "cloud" | null;
  /** The signed-in account this storage belongs to (cloud), or that chose this device (browser), or null. */
  account: VerifiedSignIn["user"] | null;
  /** The data to play, once `phase` is `ready`. */
  loaded: { status: "ready" | "failed"; data: StoredQuestData; problem?: GameStorageProblem } | null;
  /** Why loading failed (`cloud-failed`, or a browser load that failed). */
  problem: GameStorageProblem | null;
  /** Where saving stands, for the current storage. */
  save: SaveSnapshot | null;
  /**
   * Changes that couldn't be saved and that the player hasn't agreed to leave behind, oldest first:
   * one entry per session closed because the storage changed (for example, the account changed in another
   * tab), and, with a `recoveryStore`, cloud changes kept when this tab last left the page unsaved. Entries
   * are only removed when the player dismisses them (or a write already sent turns out to have saved
   * them). They're for download only: nothing here is ever written to any storage.
   *
   * Only the entries that may be shown now (see `ownerId`). Others are kept, hidden, until their owner is
   * back or the page closes.
   */
  unsavedRecoveries: UnsavedRecovery[];
  /**
   * Whether some kept changes, listed or hidden, exist only on this page: not in `recoveryStore` (a guest's,
   * or the store was missing, full or refused). Leaving the page would lose them. Says nothing of whose.
   */
  recoveriesAtRisk: boolean;
};

/** Unsaved changes kept from one closed session. */
export type UnsavedRecovery = {
  /** Unique within this page, for dismissing this entry only. */
  id: string;
  /**
   * - `account-changed`: the storage changed on this page (for example, another tab signed in).
   * - `page-left`: a cloud garden's changes that weren't saved when this tab last hid or left the page.
   */
  reason: "account-changed" | "page-left";
  /**
   * Who the changes belong to, for every entry, whatever its reason. An account's (a verified sign-in's
   * cloud garden, or its garden on this device) is listed, downloadable and dismissable only while that
   * account is the verified sign-in and its garden is the current one. Null means this browser's own
   * garden, played without a verified account (a guest, or a sign-in that ended or couldn't be verified):
   * listed only while that's what's playing again, never while any account is signed in.
   */
  ownerId: string | null;
  /** Which account they belong to, partly hidden (for example "mi•••@example.com"), or null for this browser's save. */
  accountLabel: string | null;
  /** When the session closed, in milliseconds since 1970. */
  closedAt: number;
  data: StoredQuestData;
};

/**
 * Proof of which session a sign-out (or other account change) was prepared for. Confirming with it only
 * works while that same session, generation and account are still current.
 */
export type AccountChangeTicket = { readonly ticketId: number };

/**
 * - `ready`: nothing is unsaved; the change can go ahead (if the ticket is still current).
 * - `unsaved`: changes are unsaved; the player must decide, with this ticket.
 * - `stale`: the session changed while saving, so this preparation no longer applies.
 */
export type AccountChangePreparation = {
  outcome: "ready" | "unsaved" | "stale";
  ticket: AccountChangeTicket | null;
  save: SaveSnapshot | null;
};

/**
 * Whether the garden on screen can be played: the controller's current generation has loaded data, and
 * that same generation is what's on screen. Until then (checking who's signed in, loading, the first-time
 * choice, a failed cloud load, or the moment before new data is shown), nothing may change it.
 * A browser save that couldn't be read safely is playable, as it always has been, but never saved.
 */
export function isGardenPlayable(storage: StorageControllerSnapshot, shownGeneration: number): boolean {
  return storage.phase === "ready" && storage.loaded !== null && shownGeneration === storage.generation;
}

/** An email with most of its name hidden: enough for its owner to recognise, not to read off a shared screen. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

export type GameStorageControllerOptions = {
  /** Starter data, used before anything loads and for a fresh cloud garden. */
  fallbackData: StoredQuestData;
  createBrowserSession: () => GameDataSession;
  /** A cloud session for this verified sign-in, or null if cloud saving isn't available. */
  createCloudSession: (signIn: VerifiedSignIn, getAuth: () => AuthState) => GameDataSession | null;
  /** Accounts whose player chose to keep playing on this device instead of the cloud. */
  deviceChoices: { has: (userId: string) => boolean; add: (userId: string) => void; remove: (userId: string) => void };
  /**
   * Where a cloud garden's unsaved changes are kept when the page is hidden or left (see
   * `setPageVisible`), so a reload can offer them for download. Without it, nothing is kept.
   */
  recoveryStore?: PersistedRecoveryStore;
  /** Names this page's entry in `recoveryStore`. Must differ from every earlier page's. */
  pageId?: string;
};

export type GameStorageController = {
  getSnapshot: () => StorageControllerSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Tells the controller who's signed in now. Storage changes only when the target does. */
  setAuth: (auth: AuthState) => void;
  /** Saves `data` if it belongs to the current generation; anything older is refused. */
  requestSave: (generation: number, data: StoredQuestData) => SaveRequestOutcome;
  /** `choose` only: creates the account's cloud save from starter data. Never replaces an existing one. */
  startFreshCloudGarden: () => boolean;
  /** `choose` or `cloud-failed` only: plays this browser's save for this account instead. Uploads nothing. */
  keepPlayingOnDevice: () => boolean;
  /** For a signed-in player on this device: goes back to the account's cloud garden. */
  useCloudGarden: () => boolean;
  /** `cloud-failed` only: tries loading the cloud save again. */
  retryLoad: () => Promise<void>;
  /** After a conflict: loads the latest save in place of this screen's. Nothing changes if it's cancelled. */
  reloadLatest: () => Promise<ReloadOutcome | null>;
  /** After a save error: tries again now. */
  retrySave: () => boolean;
  /** The current session's newest unsaved change, for download, or null. */
  getUnsavedData: () => StoredQuestData | null;
  /** Writes a change waiting for the short pause at once (for example, when the page is about to close). */
  flushPendingSave: () => void;
  /**
   * The page was hidden (`false`) or shown again (`true`). While hidden, a cloud garden's unsaved changes
   * are kept in `recoveryStore`, kept up to date until they're saved; shown again, they're removed, since
   * this page still has them. Hiding also writes a change waiting for the short pause at once.
   */
  setPageVisible: (visible: boolean) => void;
  /**
   * Before signing out or switching: writes waiting changes and reports what's still unsaved, for the
   * session current when it was called. A finished flush isn't assumed to be a successful save. If the
   * session changed meanwhile, the outcome is `stale` and nothing should go ahead.
   */
  prepareForAccountChange: () => Promise<AccountChangePreparation>;
  /** Whether a ticket's session, generation and account are still the current ones. */
  isTicketCurrent: (ticket: AccountChangeTicket | null) => boolean;
  /**
   * The player chose to leave the unsaved changes the ticket's warning showed (for example, "Sign out
   * anyway"). Refused, returning false, unless the ticket is still current.
   */
  acknowledgeUnsavedLoss: (ticket: AccountChangeTicket | null) => boolean;
  /** Removes a listed entry, here and in `recoveryStore`. Entries not listed now (hidden) can't be dismissed. */
  dismissUnsavedRecovery: (id: string) => void;
  /**
   * A listed entry's changes, for download, or null if it isn't listed right now (for example, its account
   * signed out after the notice was drawn). Checked at the moment of the call, never from an older snapshot.
   */
  getRecoveryData: (id: string) => StoredQuestData | null;
  /**
   * Closes the session while the app isn't mounted (React may unmount and mount again, as it does in
   * development). `resume` picks the storage for the current auth state again.
   */
  suspend: () => void;
  resume: () => void;
};

function targetKey(target: StorageTarget): string {
  if (target.kind === "cloud") return `cloud:${target.signIn.user.id}`;
  if (target.kind === "browser") return `browser:${target.account?.id ?? ""}`;
  return "waiting";
}

/**
 * Chooses the game save's storage from the auth state, and owns its one session.
 *
 * When the target changes (signing in or out, another account, a choice on the first-time card), the
 * old session is closed before the new one is created, and every reply from the old one is ignored.
 * The data to play is tagged with a generation, and saves are refused for any other generation, so
 * one account's data never reaches another's storage. Unsaved changes from a closed session are kept
 * in `unsavedRecoveries` unless the player agreed to leave them.
 */
export function createGameStorageController(options: GameStorageControllerOptions): GameStorageController {
  const { fallbackData } = options;
  let auth: AuthState = { status: "loading" };
  let target: StorageTarget = { kind: "waiting" };
  let session: GameDataSession | null = null;
  let unsubscribeSession: () => void = () => {};
  /** The unsaved changes the player agreed to leave behind: only these exact ones, in this exact session. */
  let acknowledgedLoss: { session: GameDataSession; data: StoredQuestData | null } | null = null;
  let nextRecoveryId = 1;
  let nextTicketId = 1;
  /** What each ticket was issued for. */
  const tickets = new Map<number, { session: GameDataSession | null; generation: number; accountId: string | null }>();
  let snapshot: StorageControllerSnapshot = {
    generation: 0,
    phase: "waiting",
    mode: null,
    account: null,
    loaded: null,
    problem: null,
    save: null,
    unsavedRecoveries: [],
    recoveriesAtRisk: false,
  };
  const listeners = new Set<() => void>();
  const { recoveryStore } = options;
  const pageId = options.pageId ?? `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let pageHidden = false;
  /** Every kept entry, hidden or not. `snapshot.unsavedRecoveries` is the part that may be shown now. */
  let recoveries: UnsavedRecovery[] = [];
  /**
   * Entries that may be shown once their owner is current: every entry made on this page, and an earlier
   * page's once it has been compared with its account's loaded cloud garden.
   */
  const checkedRecoveryIds = new Set<string>();

  /** The one ownership rule for every entry: listing, downloading and dismissing all go through it. */
  function isRecoveryVisible(entry: UnsavedRecovery): boolean {
    if (!checkedRecoveryIds.has(entry.id)) return false;
    if (entry.ownerId === null) {
      // This browser's own garden: only while it's what's playing, with no account signed in.
      return auth.status !== "loading" && auth.status !== "signed-in" && snapshot.mode === "browser" && snapshot.account === null;
    }
    return auth.status === "signed-in" && auth.user.id === entry.ownerId && snapshot.account?.id === entry.ownerId;
  }

  function computeRecoveriesAtRisk(): boolean {
    if (recoveries.length === 0) return false;
    const stored = new Set(recoveryStore?.read().map((entry) => entry.id) ?? []);
    return recoveries.some((entry) => !stored.has(entry.id));
  }

  /** The entries to list now: the same array as before if nothing about them changed. */
  function visibleRecoveries(): UnsavedRecovery[] {
    const visible = recoveries.filter(isRecoveryVisible);
    const current = snapshot.unsavedRecoveries;
    return visible.length === current.length && visible.every((entry, index) => entry === current[index]) ? current : visible;
  }

  function update(changes: Partial<Omit<StorageControllerSnapshot, "unsavedRecoveries" | "recoveriesAtRisk">>) {
    snapshot = { ...snapshot, ...changes };
    snapshot = { ...snapshot, unsavedRecoveries: visibleRecoveries(), recoveriesAtRisk: computeRecoveriesAtRisk() };
    listeners.forEach((listener) => listener());
  }

  /**
   * Lists or hides entries after the auth state or the entries changed. Tells listeners only if
   * something they can see changed.
   */
  function refreshRecoveries() {
    const visible = visibleRecoveries();
    const atRisk = computeRecoveriesAtRisk();
    if (visible === snapshot.unsavedRecoveries && atRisk === snapshot.recoveriesAtRisk) return;
    snapshot = { ...snapshot, unsavedRecoveries: visible, recoveriesAtRisk: atRisk };
    listeners.forEach((listener) => listener());
  }

  /** Removes one entry, and only that one, here and in the tab. */
  function removeRecovery(id: string) {
    checkedRecoveryIds.delete(id);
    writePersisted((entries) => entries.filter((entry) => entry.id !== id));
    setRecoveries(recoveries.filter((entry) => entry.id !== id));
  }

  function setRecoveries(next: UnsavedRecovery[]) {
    recoveries = next;
    refreshRecoveries();
  }

  function isTicketCurrent(ticket: AccountChangeTicket | null): boolean {
    const issued = ticket ? tickets.get(ticket.ticketId) : undefined;
    return Boolean(issued) &&
      issued!.session === session &&
      issued!.generation === snapshot.generation &&
      issued!.accountId === (snapshot.account?.id ?? null);
  }

  function targetFor(state: AuthState): StorageTarget {
    if (state.status === "loading") return { kind: "waiting" };
    if (state.status !== "signed-in") return { kind: "browser", account: null };
    if (options.deviceChoices.has(state.user.id)) return { kind: "browser", account: state.user };
    return { kind: "cloud", signIn: state };
  }

  /** Closes the current session, keeping its unsaved changes unless the player agreed to leave them. */
  function closeSession() {
    if (!session) return;
    const closing = session;
    session = null;
    unsubscribeSession();
    unsubscribeSession = () => {};
    closing.close("identity-changed");
    const unsaved = closing.getUnsavedData();
    const account = snapshot.account;
    const acknowledged = acknowledgedLoss?.session === closing && acknowledgedLoss.data === unsaved;
    acknowledgedLoss = null;
    if (!unsaved || acknowledged) return;
    // Added beside any earlier entries, never in place of them. The ID names this page too, so it's
    // unique among entries kept in the tab by earlier pages.
    const recovery: UnsavedRecovery = {
      id: `${pageId}-recovery-${nextRecoveryId++}`,
      reason: "account-changed",
      ownerId: account?.id ?? null,
      accountLabel: maskEmail(account?.email ?? null),
      closedAt: Date.now(),
      data: unsaved,
    };
    checkedRecoveryIds.add(recovery.id);
    // An account's are also kept in the tab, so a reload while they're hidden doesn't lose them.
    if (account) {
      writePersisted((entries) => [...entries, {
        id: recovery.id,
        reason: "account-changed",
        userId: account.id,
        accountLabel: recovery.accountLabel,
        closedAt: recovery.closedAt,
        data: unsaved,
      }]);
    }
    setRecoveries([...recoveries, recovery]);
    // A write already sent may still succeed; if it does, those changes were saved after all. Only this
    // entry is removed: never another account's, nor another entry of the same account.
    void closing.whenIdle().then(() => {
      if (!closing.getUnsavedData()) removeRecovery(recovery.id);
    });
  }

  /**
   * Changes the tab's kept entries. The store may keep fewer than asked (its limit evicts the oldest, or it
   * may be full or refused), so whether any entry now exists only on this page is worked out again from
   * what it actually kept, and published.
   */
  function writePersisted(change: (entries: PersistedRecovery[]) => PersistedRecovery[]) {
    if (!recoveryStore) return;
    const entries = recoveryStore.read();
    const next = change(entries);
    if (next.length === entries.length && next.every((entry, index) => entry === entries[index])) return;
    recoveryStore.write(next);
    refreshRecoveries();
  }

  /**
   * While the page is hidden: keeps this page's entry in step with the cloud garden's unsaved changes.
   * Only a cloud garden's, for its verified account: browser changes are already in this browser.
   */
  function keepPageRecovery() {
    if (!recoveryStore || !pageHidden) return;
    const unsaved = snapshot.mode === "cloud" && snapshot.account ? session?.getUnsavedData() ?? null : null;
    const account = snapshot.account;
    writePersisted((entries) => {
      const others = entries.filter((entry) => entry.id !== pageId);
      if (!unsaved || !account) return others;
      return [...others, { id: pageId, reason: "page-left", userId: account.id, accountLabel: maskEmail(account.email), closedAt: Date.now(), data: unsaved }];
    });
  }

  /**
   * Earlier pages' kept changes (`page-left` and `account-changed`). All are read in, but each is only
   * listed while its own account is the verified sign-in and that account's storage is current (see
   * `isRecoveryVisible`); for anyone else, including guests and unverified sign-ins, it stays hidden and
   * kept, here and in the tab, so signing out or switching accounts never loses it and never shows it. Before an entry is first listed, it's
   * compared with its account's loaded cloud garden: changes already saved there (a write that finished
   * as the page closed) are dropped, unseen.
   */
  function syncPersistedRecoveries() {
    if (recoveryStore) {
      const known = new Set(recoveries.map((entry) => entry.id));
      const added: UnsavedRecovery[] = recoveryStore.read()
        .filter((entry) => entry.id !== pageId && !known.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          reason: entry.reason ?? "page-left",
          ownerId: entry.userId,
          accountLabel: entry.accountLabel,
          closedAt: entry.closedAt,
          data: entry.data,
        }));
      let next = added.length > 0 ? [...recoveries, ...added].sort((a, b) => a.closedAt - b.closedAt) : recoveries;

      const userId = auth.status === "signed-in" ? auth.user.id : null;
      const settled = userId !== null && snapshot.account?.id === userId && snapshot.phase !== "waiting" && snapshot.phase !== "loading";
      if (settled) {
        const loaded = snapshot.mode === "cloud" && snapshot.loaded?.status === "ready" ? canonicalJson(snapshot.loaded.data) : null;
        const unchecked = next.filter((entry) => entry.ownerId === userId && !checkedRecoveryIds.has(entry.id));
        const alreadySaved = new Set(unchecked.filter((entry) => loaded !== null && canonicalJson(entry.data) === loaded).map((entry) => entry.id));
        unchecked.forEach((entry) => {
          if (!alreadySaved.has(entry.id)) checkedRecoveryIds.add(entry.id);
        });
        if (alreadySaved.size > 0) {
          next = next.filter((entry) => !alreadySaved.has(entry.id));
          writePersisted((entries) => entries.filter((entry) => !alreadySaved.has(entry.id)));
        }
      }
      recoveries = next;
    }
    refreshRecoveries();
  }

  /**
   * The current session closed on its own (its storage reported that the account changed, or couldn't be
   * confirmed), while the auth state still points at it. It writes nothing more, so the garden must not
   * stay playable: changes made from here would be shown but never saved. Its unsaved changes are kept
   * as a recovery for their own account, the garden is taken off the screen (a new generation), and
   * **Try again** (`retryLoad`) starts a fresh session, which checks the account again before loading.
   * A real account change also changes the auth state, which replaces the storage as usual.
   */
  function stopClosedSession(problem: GameStorageProblem) {
    closeSession();
    update({ generation: snapshot.generation + 1, phase: "cloud-failed", loaded: null, problem, save: null });
  }

  /** Reads the session's load result into the snapshot, unless a newer generation has started. */
  function applyLoad(owner: GameDataSession, generation: number, data: StoredQuestData, problem: GameStorageProblem | undefined) {
    if (session !== owner || snapshot.generation !== generation) return;
    applyLoadedState(owner, data, problem);
    syncPersistedRecoveries();
  }

  function applyLoadedState(owner: GameDataSession, data: StoredQuestData, problem: GameStorageProblem | undefined) {
    const save = owner.getSnapshot();
    const mode = snapshot.mode;
    switch (save.status) {
      case "saved":
        update({ phase: "ready", loaded: { status: "ready", data }, problem: null, save });
        return;
      case "empty":
        update({ phase: "choose", loaded: null, problem: null, save });
        return;
      case "load-failed":
        if (mode === "browser") {
          // As always for browser saves: shown, so the player can keep playing, but never written over.
          update({ phase: "ready", loaded: { status: "failed", data, ...(problem ? { problem } : {}) }, problem: problem ?? null, save });
        } else {
          update({ phase: "cloud-failed", loaded: null, problem: save.problem ?? problem ?? "unknown", save });
        }
        return;
      default:
        // Closed during the load (the account changed): the next auth change replaces this session.
        update({ phase: "cloud-failed", loaded: null, problem: "identity-changed", save });
    }
  }

  /** Replaces the session with a fresh one for the current target, and loads it. */
  function start() {
    closeSession();
    const generation = snapshot.generation + 1;
    if (target.kind === "waiting") {
      update({ generation, phase: "waiting", mode: null, account: null, loaded: null, problem: null, save: null });
      return;
    }

    const next = target.kind === "cloud"
      ? options.createCloudSession(target.signIn, () => auth)
      : options.createBrowserSession();
    const account = target.kind === "cloud" ? target.signIn.user : target.account;
    if (!next) {
      update({ generation, phase: "cloud-failed", mode: "cloud", account, loaded: null, problem: "unknown", save: null });
      syncPersistedRecoveries();
      return;
    }
    session = next;
    unsubscribeSession = next.subscribe(() => {
      if (session !== next) return;
      const save = next.getSnapshot();
      if (save.status === "closed") {
        stopClosedSession(save.problem);
        return;
      }
      update({ save });
      keepPageRecovery();
    });
    update({
      generation,
      phase: "loading",
      mode: target.kind,
      account,
      loaded: null,
      problem: null,
      save: next.getSnapshot(),
    });
    void next.load(fallbackData).then((outcome) => applyLoad(next, generation, outcome.data, outcome.problem));
  }

  function retarget(next: StorageTarget) {
    const changed = targetKey(next) !== targetKey(target);
    target = next;
    if (changed) start();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAuth(next) {
      const previousTarget = targetKey(target);
      auth = next;
      retarget(targetFor(next));
      // The same verified account announced again: its token was just refreshed and checked. A save that
      // failed because the sign-in couldn't be refreshed (offline, or within supabase-js's cooldown after a
      // failed refresh) can go now. `retry` does nothing unless a save failed and changes are unsaved.
      if (next.status === "signed-in" && target.kind === "cloud" && targetKey(target) === previousTarget) session?.retry();
      syncPersistedRecoveries();
    },
    requestSave(generation, data) {
      if (!session || generation !== snapshot.generation || snapshot.phase !== "ready") return "blocked";
      return session.requestSave(data);
    },
    startFreshCloudGarden() {
      if (!session || snapshot.phase !== "choose" || snapshot.mode !== "cloud") return false;
      if (!session.beginFirstSave()) return false;
      // Starter data, never this browser's progress: importing that is a separate, explicit step.
      update({ generation: snapshot.generation + 1, phase: "ready", loaded: { status: "ready", data: fallbackData }, save: session.getSnapshot() });
      return true;
    },
    keepPlayingOnDevice() {
      if (target.kind !== "cloud" || (snapshot.phase !== "choose" && snapshot.phase !== "cloud-failed")) return false;
      options.deviceChoices.add(target.signIn.user.id);
      retarget(targetFor(auth));
      return true;
    },
    useCloudGarden() {
      if (target.kind !== "browser" || !target.account || auth.status !== "signed-in" || auth.user.id !== target.account.id) return false;
      options.deviceChoices.remove(target.account.id);
      retarget(targetFor(auth));
      return true;
    },
    async retryLoad() {
      if (snapshot.phase !== "cloud-failed") return;
      const current = session;
      // A session that closed (its account changed) can't load again; a fresh one is made for the target.
      if (!current || current.getSnapshot().status === "closed") {
        start();
        return;
      }
      const generation = snapshot.generation + 1;
      update({ generation, phase: "loading", problem: null });
      const outcome = await current.reload(fallbackData);
      if (outcome.cancelled) return;
      applyLoad(current, generation, outcome.data, outcome.problem);
    },
    async reloadLatest() {
      const current = session;
      if (!current || snapshot.phase !== "ready") return null;
      const generation = snapshot.generation + 1;
      // A new generation at once, so nothing on screen now can be saved over the latest save.
      update({ generation, phase: "loading", loaded: null });
      const outcome = await current.reload(fallbackData);
      if (outcome.cancelled) return outcome;
      applyLoad(current, generation, outcome.data, outcome.problem);
      return outcome;
    },
    retrySave: () => session?.retry() ?? false,
    getUnsavedData: () => session?.getUnsavedData() ?? null,
    flushPendingSave() {
      void session?.flush();
    },
    setPageVisible(visible) {
      pageHidden = !visible;
      if (pageHidden) {
        void session?.flush();
        keepPageRecovery();
      } else {
        writePersisted((entries) => entries.filter((entry) => entry.id !== pageId));
      }
    },
    async prepareForAccountChange() {
      const owner = session;
      const ticketId = nextTicketId++;
      tickets.set(ticketId, { session: owner, generation: snapshot.generation, accountId: snapshot.account?.id ?? null });
      const ticket: AccountChangeTicket = { ticketId };
      const save = owner ? await owner.flush() : null;
      // Anything that changed while saving (another account, signing out elsewhere, a reload) makes this
      // preparation meaningless: its result must not be acted on.
      if (!isTicketCurrent(ticket)) {
        tickets.delete(ticketId);
        return { outcome: "stale", ticket: null, save };
      }
      return { outcome: save?.hasUnsavedChanges ? "unsaved" : "ready", ticket, save };
    },
    isTicketCurrent,
    acknowledgeUnsavedLoss(ticket) {
      if (!isTicketCurrent(ticket) || !session) return false;
      // Covers only what's unsaved right now. A change made after this is warned about again.
      acknowledgedLoss = { session, data: session.getUnsavedData() };
      return true;
    },
    dismissUnsavedRecovery(id) {
      // Only an entry listed right now: a hidden one belongs to someone who isn't playing.
      if (!recoveries.some((entry) => entry.id === id && isRecoveryVisible(entry))) return;
      removeRecovery(id);
    },
    getRecoveryData(id) {
      return recoveries.find((entry) => entry.id === id && isRecoveryVisible(entry))?.data ?? null;
    },
    suspend() {
      target = { kind: "waiting" };
      start();
    },
    resume() {
      retarget(targetFor(auth));
    },
  };
}
