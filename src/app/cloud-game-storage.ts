import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthState } from "./auth/auth-controller";
import { describeAuthError, readUnverifiedTokenSubject, readUserId } from "./auth/auth-session";
import type { GameSaveResult, GameStorage, GameStorageLoadResult, GameStorageProblem } from "./game-storage";
import { latestQuestSaveVersion, readQuestSave } from "./quest-storage";
import type { StoredQuestData } from "./quest-types";

/** The parts of the Supabase client this adapter uses, so tests can supply a fake. */
export type CloudSaveClient = Pick<SupabaseClient, "from"> & Partial<Pick<SupabaseClient, "rpc">> & { auth: Pick<SupabaseClient["auth"], "getSession"> };

export type CloudImportResult =
  | { status: "imported"; revision: number; verified: boolean }
  /** The cloud already held exactly this garden at the expected revision: nothing was written or backed up. */
  | { status: "unchanged"; revision: number }
  | { status: "conflict" }
  | { status: "backup_failed" }
  | { status: "failed"; problem: GameStorageProblem; verificationRequired: boolean };

export type CloudGardenDownload =
  | { status: "ready"; data: unknown; revision: number; schemaVersion: number }
  | { status: "failed"; problem: GameStorageProblem };

/** Only a verified sign-in has a user ID (see AuthState), so only it can own cloud storage. */
export type VerifiedSignIn = Extract<AuthState, { status: "signed-in" }>;

export type CloudGameStorageOptions = {
  client: CloudSaveClient;
  /** The verified sign-in this storage belongs to, for its whole life. */
  signIn: VerifiedSignIn;
  /** The current auth state. It's checked before and after every request, so a changed account is never used. */
  getAuth: () => AuthState;
};

export type CloudGameStorage = GameStorage & {
  /** Fresh persisted JSON, without migrations, backups or changing the adapter's loaded revision. */
  readForDownload: () => Promise<CloudGardenDownload>;
  /** The account this storage belongs to. It never changes; a different account needs new storage. */
  readonly userId: string;
  /** null means loaded empty; undefined means no usable loaded revision. */
  getLoadedRevision: () => number | null | undefined;
  /** Explicit import only. null expects an empty account. Success requires a fresh load before saves. */
  importSave: (data: StoredQuestData, expectedRevision: number | null) => Promise<CloudImportResult>;
  /** Read-only resolution of a lost response. null means there is no uncertain import. */
  verifyImport: () => Promise<CloudImportResult | null>;
  /**
   * Whether an import was sent whose outcome isn't known yet (or is known not to have happened, but only
   * the same import may be retried). While true, normal saves are refused and only this storage may
   * verify or retry it, so a controller must keep this storage rather than start a fresh one.
   */
  hasUnresolvedImport: () => boolean;
};

type SaveRow = { data: unknown; schema_version: unknown; revision: unknown };
/** The parts of a PostgREST error this adapter reads. */
type DatabaseError = { code?: string | null; message?: string | null } | null;

/**
 * - `unloaded`: nothing has been read, so nothing may be written.
 * - `ready`: writes are allowed. `revision` is the save's revision as loaded or last saved here, or null
 *   when the account has no save yet, so the next write creates it.
 * - `read-only`: the save is shown but must never be replaced (it's invalid, newer, or couldn't be backed up).
 * - `conflict`: the save changed somewhere else. Nothing is written until it's loaded again.
 * - `closed`: the signed-in account changed. This storage is never used again.
 */
type CloudState =
  | { phase: "unloaded" }
  | { phase: "ready"; revision: number | null }
  | { phase: "read-only"; problem: GameStorageProblem }
  | { phase: "conflict"; sourceRevision: number | null; backedUpText: string | null }
  | { phase: "closed" };

/** Revisions and format versions are positive whole numbers. */
function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function readSchemaVersion(data: StoredQuestData): number {
  const version = data.schemaVersion;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1 ? version : latestQuestSaveVersion;
}

/**
 * Names the database puts in its error messages. Each comes from this project's migrations, and
 * supabase/tests/database/07_upgrade_backups.test.sql pins them, so a change there fails a test.
 */
const databaseNames = {
  /** quest_saves_before_write() raises 23514 with this message when schema_version would go down. */
  formatGuardMessage: "quest_saves.schema_version cannot decrease",
  /** The check that limits a save to a JSON object of at most 10 MB. */
  saveDataCheck: "\"quest_saves_data_check\"",
  /** The unique index allowing one upgrade backup per user and source revision. */
  upgradeBackupIndex: "\"save_backups_upgrade_once\"",
};

/**
 * What a failed request means. supabase-js reports a request that never reached the server with
 * status 0, and anything else with the HTTP status and a Postgres or PostgREST error code.
 *
 * 23514 (a check failed) is told apart by which check it was, from the error's message: the format
 * guard means the saved format is newer, the data check means the save is too large (or not an object),
 * and any other check means the database refused this data.
 */
export function describeCloudError(error: DatabaseError, status: number): GameStorageProblem {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (status === 0) return "network";
  if (isMissingFunction(error, status)) return "server-outdated";
  // PGRST301–303: the access token is missing, expired or otherwise not accepted.
  if (status === 401 || /^PGRST30\d$/.test(code)) return "signed-out";
  // 42501: the access rules (RLS or grants) refused it.
  if (status === 403 || code === "42501") return "denied";
  // 413: the request was too large for the server to accept at all.
  if (status === 413) return "too-large";
  if (code === "23514") {
    if (message.startsWith(databaseNames.formatGuardMessage)) return "newer-version";
    if (message.includes(databaseNames.saveDataCheck)) return "too-large";
    return "rejected";
  }
  if (status === 429 || status >= 500) return "server";
  return "unknown";
}

/**
 * The database doesn't have the function that was called: PostgREST's PGRST202 ("Could not find the
 * function ... in the schema cache", HTTP 404), or PostgreSQL's 42883 (undefined_function). Either way
 * the call was refused before anything ran, so nothing was written. A pending migration, for example.
 */
export function isMissingFunction(error: DatabaseError, status: number): boolean {
  if (status < 400 || status >= 600) return false;
  return (error?.code === "PGRST202" && status === 404) || error?.code === "42883";
}

/** 23505 on the primary key: the account already has a save. */
function isDuplicateSave(error: DatabaseError): boolean {
  return error?.code === "23505";
}

/** 23505 on the upgrade backup index: this revision is already backed up. */
function isExistingUpgradeBackup(error: DatabaseError): boolean {
  return error?.code === "23505" && (error.message ?? "").includes(databaseNames.upgradeBackupIndex);
}

/**
 * The game save in the signed-in player's account: one `quest_saves` row, protected by RLS.
 *
 * Every save is conditional on the revision this storage last loaded or saved, which the database bumps
 * on every write. If someone else (another tab or device) saved in between, nothing matches and nothing
 * is overwritten: that's a conflict. The unsaved data is then kept as a `conflict` backup, and every
 * later save is refused until the save is loaded again. The first save of an account is an insert, and
 * if another device created the save first, the insert fails on the primary key: also a conflict.
 *
 * It belongs to one verified account for its whole life. Before every request, and again after every
 * reply, it checks that the auth state and the session's token still belong to that account. A reply
 * that arrives after the account changed (signed out, or switched, here or in another tab) is never
 * used: its data isn't returned and nothing is written because of it, and the storage closes for good.
 * RLS checks the token itself on the server either way.
 *
 * Saves are checked with the same rules as browser saves (`readQuestSave`). A save that's invalid, or
 * made by a newer version of Plantetary, is never replaced. An older save is kept as an `upgrade` backup
 * (once per revision) before it's upgraded, and isn't replaced if that backup fails. Requests run one at
 * a time, in order.
 */
export function createCloudGameStorage({ client, signIn, getAuth }: CloudGameStorageOptions): CloudGameStorage {
  const userId = signIn.status === "signed-in" ? readUserId(signIn.user.id) : null;
  if (!userId) throw new Error("Cloud storage needs a verified sign-in.");

  let state: CloudState = { phase: "unloaded" };
  let queue: Promise<unknown> = Promise.resolve();
  type ImportAttempt = { data: StoredQuestData; text: string; expected: number | null; key: string; problem: GameStorageProblem };
  let uncertainImport: ImportAttempt | null = null;
  const completedImports = new Set<string>();
  const importTimeoutMs = 15_000;

  const importFailure = (problem: GameStorageProblem, verificationRequired = false): CloudImportResult =>
    ({ status: "failed", problem, verificationRequired });

  function imported(attempt: ImportAttempt, revision: number, verified: boolean): CloudImportResult {
    uncertainImport = null;
    completedImports.add(attempt.key);
    // The game session may still hold the pre-import garden. Require an explicit reload, rather
    // than allowing a queued normal save to write that old garden over the import.
    state = { phase: "unloaded" };
    return { status: "imported", revision, verified };
  }

  /** Never treats a failed verification read as proof that an uncertain write didn't happen. */
  async function reconcileImport(): Promise<CloudImportResult | null> {
    const attempt = uncertainImport;
    if (!attempt) return null;
    const before = await checkIdentity();
    if (before) return importFailure(before, true);
    try {
      const { data: row, error, status } = await client.from("quest_saves")
        .select("data, schema_version, revision").eq("user_id", userId)
        .abortSignal(AbortSignal.timeout(importTimeoutMs)).maybeSingle<SaveRow>();
      const after = await checkIdentity();
      if (after) return importFailure(after, true);
      if (error) return importFailure(describeCloudError(error, status), true);
      const revision = row ? readPositiveInteger(row.revision) : null;
      if (row && revision === null) return importFailure("unknown", true);
      if (row && (attempt.expected === null || revision! > attempt.expected) && row.schema_version === readSchemaVersion(attempt.data) &&
        JSON.stringify(row.data) === attempt.text) return imported(attempt, revision!, true);
      if (revision !== attempt.expected) {
        uncertainImport = null;
        completedImports.add(attempt.key);
        state = { phase: "unloaded" };
        return { status: "conflict" };
      }
      // The expected state still exists. An explicit retry with the SAME revision is safe even if
      // the original transaction is still running: the row lock/PK allows at most one to commit.
      // Keep the gate until that retry resolves; normal saves and different imports stay blocked.
      return importFailure(attempt.problem, false);
    } catch {
      return importFailure("network", true);
    }
  }

  async function runImport(attempt: ImportAttempt): Promise<CloudImportResult> {
    const before = await checkIdentity();
    if (before) return importFailure(before, uncertainImport !== null);
    let retryingUncertain = false;
    if (uncertainImport) {
      const same = uncertainImport.key === attempt.key;
      const resolved = await reconcileImport();
      if (!same) return importFailure("not-loaded", uncertainImport !== null);
      if (!resolved || resolved.status !== "failed" || resolved.verificationRequired) return resolved ?? importFailure("unknown", true);
      retryingUncertain = true;
    }
    if (completedImports.has(attempt.key)) return { status: "conflict" };
    if (!client.rpc) return importFailure("unknown");
    // Set before sending: throws, timeouts, malformed responses and even post-write identity-check
    // failures must leave a verification gate. No retry happens inside this call.
    uncertainImport = attempt;
    try {
      const { data, error, status } = await client.rpc("import_browser_save", {
        p_user_id: userId, p_expected_revision: attempt.expected,
        p_data: attempt.data, p_schema_version: readSchemaVersion(attempt.data),
      }).abortSignal(AbortSignal.timeout(importTimeoutMs));
      const after = await checkIdentity();
      if (after) return importFailure(after, true);
      const reply = Array.isArray(data) && data.length === 1 ? data[0] as { outcome?: unknown; revision?: unknown } : null;
      const importedRevision = readPositiveInteger(reply?.revision);
      if (!error && reply?.outcome === "imported" && importedRevision !== null &&
        (attempt.expected === null || importedRevision > attempt.expected)) {
        return imported(attempt, importedRevision, false);
      }
      if (!error && reply?.outcome === "unchanged" && importedRevision !== null && importedRevision === attempt.expected) {
        // Nothing was written, so nothing is uncertain. Like an import, it needs a load before saving.
        uncertainImport = null;
        completedImports.add(attempt.key);
        state = { phase: "unloaded" };
        return { status: "unchanged", revision: importedRevision };
      }
      if (!error && (reply?.outcome === "conflict" || reply?.outcome === "backup_failed")) {
        // A retry's refusal says nothing about the earlier uncertain request, which may have committed
        // after the verification read (a conflict is then exactly what the retry sees). Check the cloud
        // again rather than reporting a conflict for an import that actually happened.
        if (retryingUncertain) {
          return (await reconcileImport()) ?? importFailure("unknown", true);
        }
        uncertainImport = null;
        if (reply.outcome === "conflict") {
          completedImports.add(attempt.key);
          state = { phase: "unloaded" };
        }
        return { status: reply.outcome };
      }
      attempt.problem = error ? describeCloudError(error, status) : "unknown";
      // An explicit PostgreSQL statement error guarantees rollback. Unlike a transport error, it
      // doesn't need a verification gate (unless an earlier request was already uncertain).
      // Only an answer from PostgREST itself (an HTTP error status) carries a PostgreSQL SQLSTATE; a
      // transport error can also have a short code (for example from the network stack), so the
      // status is checked too. A missing function (PGRST202, before a migration is applied) is refused by
      // PostgREST before any transaction starts, so it's just as certain.
      const definite = error?.code && status >= 400 && status < 600 &&
        (/^[A-Z0-9]{5}$/.test(error.code) || isMissingFunction(error, status));
      if (!retryingUncertain && definite) {
        uncertainImport = null;
        return importFailure(attempt.problem);
      }
    } catch {
      attempt.problem = "network";
    }
    return (await reconcileImport()) ?? importFailure("unknown", true);
  }

  /** Runs requests one at a time, so two saves can never race each other's revisions. */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  /** Null if this storage's account is still the signed-in one; otherwise why not, closing it if it changed. */
  async function checkIdentity(): Promise<GameStorageProblem | null> {
    if (state.phase === "closed") return "identity-changed";
    const close = () => {
      state = { phase: "closed" };
      return "identity-changed" as const;
    };
    const before = getAuth();
    if (before.status !== "signed-in" || before.user.id !== userId) return close();

    let token: string | null;
    try {
      const { data, error } = await client.auth.getSession();
      token = data.session?.access_token ?? null;
      // No session *and* an error: the session couldn't be read or refreshed (for example, its token
      // expired while offline, so supabase-js returns no session with a retryable fetch error). That
      // isn't a confirmed account change, so this storage stays open and the save can be tried again.
      // Nothing is sent without a token. If the sign-in really ended, supabase-js clears the session and
      // the auth state changes, which closes this storage then.
      if (!token && error) return describeAuthError(error) === "network" ? "network" : "signed-out";
    } catch {
      return "unknown";
    }
    // Requests are sent with this token, and RLS uses its account. If it's gone (with no error) or for
    // another account, the player has signed out or switched accounts, possibly in another tab.
    if (!token || readUnverifiedTokenSubject(token) !== userId) return close();
    const after = getAuth();
    if (after.status !== "signed-in" || after.user.id !== userId) return close();
    return null;
  }

  /** Adds a backup copy. Resolves false, rather than rejecting, if it couldn't be added. */
  async function addBackup(
    reason: "conflict" | "upgrade",
    rawText: string,
    schemaVersion: number | null,
    sourceRevision: number | null,
  ): Promise<boolean> {
    try {
      const { error } = await client.from("save_backups").insert({
        user_id: userId,
        reason,
        raw_data: rawText,
        schema_version: schemaVersion,
        source_revision: sourceRevision,
      });
      // An upgrade backup of this revision already exists, from an earlier load: it's kept, which is the point.
      return !error || (reason === "upgrade" && isExistingUpgradeBackup(error));
    } catch {
      return false;
    }
  }

  /** Keeps the unsaved data as a backup when the save changed elsewhere, and refuses later writes. */
  async function conflict(data: StoredQuestData, text: string, sourceRevision: number | null): Promise<GameSaveResult> {
    const previous = state.phase === "conflict" ? state : null;
    // Each different version of the unsaved data is backed up once; the database keeps the newest 20.
    let backedUp = previous?.backedUpText === text;
    if (!backedUp) {
      // The account was confirmed just before this; the backup request carries its token.
      backedUp = await addBackup("conflict", text, readSchemaVersion(data), sourceRevision);
    }
    state = {
      phase: "conflict",
      sourceRevision,
      backedUpText: backedUp ? text : previous?.backedUpText ?? null,
    };
    // Checked again, so a changed account closes this storage now rather than at the next save.
    const identityProblem = await checkIdentity();
    if (identityProblem === "identity-changed") return { status: "failed", problem: identityProblem };
    return { status: "conflict", backup: backedUp ? "saved" : "failed" };
  }

  async function load(fallbackData: StoredQuestData): Promise<GameStorageLoadResult> {
    if (state.phase === "closed") return { status: "failed", data: fallbackData, problem: "identity-changed" };
    // Loading again starts over, which is how a conflict is resolved: by taking the latest save.
    state = { phase: "unloaded" };
    const failed = (problem: GameStorageProblem, data = fallbackData): GameStorageLoadResult => ({ status: "failed", data, problem });

    const before = await checkIdentity();
    if (before) return failed(before);

    const { data: row, error, status } = await client
      .from("quest_saves")
      .select("data, schema_version, revision")
      .eq("user_id", userId)
      .maybeSingle<SaveRow>();

    // The reply may have arrived after the account changed. If so, nothing in it is used.
    const afterRead = await checkIdentity();
    if (afterRead) return failed(afterRead);

    if (error) return failed(describeCloudError(error, status));
    if (!row) {
      state = { phase: "ready", revision: null };
      return { status: "empty", data: fallbackData };
    }

    const revision = readPositiveInteger(row.revision);
    if (revision === null) return failed("unknown");

    const save = readQuestSave(row.data);
    if (save.status === "invalid") {
      state = { phase: "read-only", problem: "invalid-save" };
      return failed("invalid-save");
    }
    const storedVersion = readPositiveInteger(row.schema_version);
    if (save.newerVersion || (storedVersion !== null && storedVersion > latestQuestSaveVersion)) {
      state = { phase: "read-only", problem: "newer-version" };
      return failed("newer-version", save.data);
    }

    const storedText = JSON.stringify(row.data);
    if (save.upgraded) {
      // As for browser saves: the original is kept before anything replaces it, or it isn't replaced.
      // The account was confirmed just above, after the read; the backup request carries its token.
      const backedUp = await addBackup("upgrade", storedText, storedVersion, revision);
      const afterBackup = await checkIdentity();
      if (afterBackup) return failed(afterBackup);
      if (!backedUp) {
        state = { phase: "read-only", problem: "backup-failed" };
        return failed("backup-failed", save.data);
      }
    }

    state = { phase: "ready", revision };
    return { status: "ready", data: save.data, storedText };
  }

  async function save(data: StoredQuestData): Promise<GameSaveResult> {
    if (uncertainImport) return { status: "failed", problem: "not-loaded" };
    switch (state.phase) {
      case "unloaded":
        return { status: "failed", problem: "not-loaded" };
      case "read-only":
        return { status: "failed", problem: state.problem };
      case "closed":
        return { status: "failed", problem: "identity-changed" };
    }

    const before = await checkIdentity();
    if (before) return { status: "failed", problem: before };

    const text = JSON.stringify(data);
    if (state.phase === "conflict") return conflict(data, text, state.sourceRevision);

    const schemaVersion = readSchemaVersion(data);
    const loadedRevision: number | null = state.revision;

    let reply: { revision: number | null; error: DatabaseError; status: number; matched: boolean };
    if (loadedRevision === null) {
      // The account's first save. If another device created one meanwhile, the primary key refuses this.
      const { data: row, error, status } = await client
        .from("quest_saves")
        .insert({ user_id: userId, data, schema_version: schemaVersion })
        .select("revision")
        .single<{ revision: unknown }>();
      reply = { revision: readPositiveInteger(row?.revision), error, status, matched: !isDuplicateSave(error) };
    } else {
      // Only replaces the save this storage last saw. Any other write since has a different revision.
      const { data: rows, error, status } = await client
        .from("quest_saves")
        .update({ data, schema_version: schemaVersion })
        .eq("user_id", userId)
        .eq("revision", loadedRevision)
        .select("revision")
        .overrideTypes<Array<{ revision: unknown }>, { merge: false }>();
      reply = { revision: readPositiveInteger(rows?.[0]?.revision), error, status, matched: Boolean(error) || (rows?.length ?? 0) > 0 };
    }

    // A write that succeeded was made with this account's token (RLS allows nothing else), so it is saved.
    const written = !reply.error && reply.matched;
    if (written) state = reply.revision === null ? { phase: "unloaded" } : { phase: "ready", revision: reply.revision };

    // The reply may have arrived after the account changed. If so, this storage closes, and nothing more
    // is written because of the reply: no conflict backup, no next save.
    // If the account can't be confirmed, nothing more is written either.
    const after = await checkIdentity();
    if (written) {
      // Saved (and, if the revision couldn't be read back, later saves are refused). If the account has
      // changed since, this storage is now closed, but this save itself did reach the original account.
      return { status: "saved" };
    }
    if (after) return { status: "failed", problem: after };
    if (!reply.matched) return conflict(data, text, loadedRevision);

    const problem = describeCloudError(reply.error, reply.status);
    // Only the format guard means the stored save is newer. Other refusals leave saving possible.
    if (problem === "newer-version") state = { phase: "read-only", problem };
    return { status: "failed", problem };
  }

  return {
    userId,
    readForDownload: () => serialize(async () => {
      const before = await checkIdentity();
      if (before) return { status: "failed", problem: before };
      try {
        const { data: row, error, status } = await client.from("quest_saves")
          .select("data, schema_version, revision").eq("user_id", userId)
          .abortSignal(AbortSignal.timeout(importTimeoutMs)).maybeSingle<SaveRow>();
        const after = await checkIdentity();
        if (after) return { status: "failed", problem: after };
        if (error) return { status: "failed", problem: describeCloudError(error, status) };
        const revision = readPositiveInteger(row?.revision);
        const schemaVersion = readPositiveInteger(row?.schema_version);
        if (!row || revision === null || schemaVersion === null) return { status: "failed", problem: "not-loaded" };
        // Export even newer or damaged garden formats exactly as stored. This is a safety copy,
        // not playable data, and must never run migrations or create upgrade backups.
        return { status: "ready", data: row.data, revision, schemaVersion };
      } catch {
        return { status: "failed", problem: "network" };
      }
    }),
    getLoadedRevision: () => state.phase === "ready" ? state.revision : undefined,
    importSave(data, expectedRevision) {
      // Snapshot and validate before queueing, so caller edits cannot change the operation mid-flight.
      let attempt: ImportAttempt;
      try {
        if (expectedRevision !== null && readPositiveInteger(expectedRevision) === null) return Promise.resolve(importFailure("rejected"));
        const snapshot = JSON.parse(JSON.stringify(data)) as StoredQuestData;
        if (snapshot.schemaVersion !== undefined &&
          (!Number.isSafeInteger(snapshot.schemaVersion) || snapshot.schemaVersion < 0)) return Promise.resolve(importFailure("invalid-save"));
        const valid = readQuestSave(snapshot);
        if (valid.status !== "valid") return Promise.resolve(importFailure("invalid-save"));
        if (valid.newerVersion) return Promise.resolve(importFailure("newer-version"));
        const text = JSON.stringify(valid.data);
        if (new TextEncoder().encode(text).length > 10485760) return Promise.resolve(importFailure("too-large"));
        attempt = { data: valid.data, text, expected: expectedRevision,
          key: JSON.stringify([expectedRevision, text]), problem: "unknown" };
      } catch {
        return Promise.resolve(importFailure("invalid-save"));
      }
      return serialize(() => runImport(attempt));
    },
    verifyImport: () => serialize(reconcileImport),
    hasUnresolvedImport: () => uncertainImport !== null,
    load: (fallbackData) => serialize(async () => {
      try {
        return await load(fallbackData);
      } catch {
        if (state.phase !== "closed") state = { phase: "unloaded" };
        return { status: "failed", data: fallbackData, problem: "unknown" };
      }
    }),
    save: (data) => serialize(async () => {
      try {
        return await save(data);
      } catch {
        // The request may or may not have reached the database. Nothing is assumed: if it did, the
        // revision moved on, and the next save reports a conflict instead of overwriting it.
        return { status: "failed", problem: "unknown" };
      }
    }),
  };
}
