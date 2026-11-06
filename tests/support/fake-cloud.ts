import { AuthRetryableFetchError } from "@supabase/supabase-js";
import type { CloudSaveClient } from "../../src/app/cloud-game-storage";
import { canonicalJson } from "../../src/app/unsaved-recovery-store";

/**
 * A fake Supabase project for integration tests that run the real cloud adapter and save session. It
 * keeps the database rules that matter here: each request only reaches its token's own account (RLS),
 * revisions are set by the database and never reused, one save per account, conditional updates, and
 * `import_browser_save` as the migration defines it (`conflict`, `unchanged`, `backup_failed`, `imported`,
 * with the replaced garden's exact text backed up in the same step).
 */

export type FakeRow = { text: string; schema_version: number; revision: number };
export type FakeBackup = { user_id: string; reason: string; raw_data: string; source_revision: number | null };
export type FakeReply = { data: unknown; error: { code?: string; message?: string } | null; status: number };
export type ImportArgs = { p_user_id: string; p_expected_revision: number | null; p_data: unknown; p_schema_version: number };

/** A reply that never arrives, as when the connection drops: the request may or may not have been applied. */
export const lostReply = (): FakeReply => ({ data: null, error: { message: "TypeError: Failed to fetch" }, status: 0 });

/** A token whose subject is the account, as the adapter reads it. Its signature is irrelevant here. */
const tokenFor = (userId: string) => `e30.${Buffer.from(JSON.stringify({ sub: userId })).toString("base64url")}.sig`;

export function createFakeCloud() {
  const rows = new Map<string, FakeRow>();
  const lastRevision = new Map<string, number>();
  const backups: FakeBackup[] = [];
  const rpcCalls: ImportArgs[] = [];
  let sessionUser: string | null = null;
  let offline = false;
  let failBackups = false;
  /** Replaces the answer to the next import RPCs; `apply` answers as the database would. */
  let rpcHandler: ((args: ImportArgs, apply: () => FakeReply) => FakeReply | Promise<FakeReply>) | undefined;
  /** Replaces the answer to normal saves (updates and inserts). */
  let writeHandler: ((apply: () => FakeReply) => FakeReply | Promise<FakeReply>) | undefined;
  let readHandler: ((apply: () => FakeReply) => FakeReply | Promise<FakeReply>) | undefined;

  const ok = (data: unknown, status = 200): FakeReply => ({ data, error: null, status });
  const nextRevision = (userId: string) => {
    const revision = (lastRevision.get(userId) ?? 0) + 1;
    lastRevision.set(userId, revision);
    return revision;
  };

  function applyImport(args: ImportArgs, tokenUser: string | null): FakeReply {
    if (!tokenUser || args.p_user_id !== tokenUser) return { data: null, error: { code: "42501", message: "Import account does not match" }, status: 403 };
    const own = rows.get(tokenUser);
    const text = JSON.stringify(args.p_data);
    if (args.p_expected_revision === null) {
      if (own) return ok([{ outcome: "conflict", revision: null }]);
      const revision = nextRevision(tokenUser);
      rows.set(tokenUser, { text, schema_version: args.p_schema_version, revision });
      return ok([{ outcome: "imported", revision }]);
    }
    if (!own || own.revision !== args.p_expected_revision) return ok([{ outcome: "conflict", revision: null }]);
    if (canonicalJson(JSON.parse(own.text)) === canonicalJson(args.p_data) && own.schema_version === args.p_schema_version) {
      return ok([{ outcome: "unchanged", revision: own.revision }]);
    }
    if (failBackups) return ok([{ outcome: "backup_failed", revision: null }]);
    backups.push({ user_id: tokenUser, reason: "browser_import", raw_data: own.text, source_revision: own.revision });
    const revision = nextRevision(tokenUser);
    rows.set(tokenUser, { text, schema_version: args.p_schema_version, revision });
    return ok([{ outcome: "imported", revision }]);
  }

  type Call = { table: string; op: "select" | "insert" | "update"; filters: Record<string, unknown>; payload?: Record<string, unknown> };

  function applyTable(call: Call, tokenUser: string | null): FakeReply {
    if (!tokenUser) return { data: null, error: { code: "42501" }, status: 401 };
    if (call.table === "save_backups") {
      const backup = call.payload as unknown as FakeBackup;
      if (backup.user_id !== tokenUser) return { data: null, error: { code: "42501" }, status: 403 };
      backups.push({ ...backup });
      return ok(null, 201);
    }
    const own = rows.get(tokenUser);
    if (call.op === "select") {
      const row = own && call.filters.user_id === tokenUser ? own : null;
      return ok(row ? { data: JSON.parse(row.text), schema_version: row.schema_version, revision: row.revision } : null);
    }
    if (call.op === "insert") {
      const payload = call.payload as { user_id: string; data: unknown; schema_version: number };
      if (payload.user_id !== tokenUser) return { data: null, error: { code: "42501" }, status: 403 };
      if (own) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"quest_saves_pkey\"" }, status: 409 };
      const revision = nextRevision(tokenUser);
      rows.set(tokenUser, { text: JSON.stringify(payload.data), schema_version: payload.schema_version, revision });
      return ok({ revision }, 201);
    }
    const payload = call.payload as { data: unknown; schema_version: number };
    if (!own || call.filters.user_id !== tokenUser || call.filters.revision !== own.revision) return ok([]);
    const revision = nextRevision(tokenUser);
    rows.set(tokenUser, { text: JSON.stringify(payload.data), schema_version: payload.schema_version, revision });
    return ok([{ revision }]);
  }

  function builder(table: string) {
    const call: Call = { table, op: "select", filters: {} };
    const chain = {
      select: () => chain,
      insert(payload: Record<string, unknown>) { call.op = "insert"; call.payload = payload; return chain; },
      update(payload: Record<string, unknown>) { call.op = "update"; call.payload = payload; return chain; },
      eq(column: string, value: unknown) { call.filters[column] = value; return chain; },
      abortSignal: () => chain,
      maybeSingle: () => chain,
      single: () => chain,
      overrideTypes: () => chain,
      then(resolve: (reply: FakeReply) => unknown, reject: (error: unknown) => unknown) {
        // A request carries the token it was sent with, even if the session changes before it's answered.
        const tokenUser = sessionUser;
        const apply = () => applyTable(call, tokenUser);
        const handler = call.table === "quest_saves" ? (call.op === "select" ? readHandler : writeHandler) : undefined;
        return Promise.resolve().then(() => (handler ? handler(apply) : apply())).then(resolve, reject);
      },
    };
    return chain;
  }

  const client = {
    auth: {
      getSession: async () => offline
        ? { data: { session: null }, error: new AuthRetryableFetchError("Failed to fetch", 0) }
        : { data: { session: sessionUser ? { access_token: tokenFor(sessionUser) } : null }, error: null },
    },
    from: (table: string) => builder(table),
    rpc(name: string, args: ImportArgs) {
      if (name !== "import_browser_save") throw new Error(`Unexpected RPC ${name}`);
      const tokenUser = sessionUser;
      const snapshot = structuredClone(args);
      rpcCalls.push(snapshot);
      const apply = () => applyImport(snapshot, tokenUser);
      return { abortSignal: () => Promise.resolve().then(() => (rpcHandler ? rpcHandler(snapshot, apply) : apply())) };
    },
  };

  return {
    client: client as unknown as CloudSaveClient,
    rows,
    backups,
    rpcCalls,
    /** The account's garden as stored, parsed. */
    gardenOf: (userId: string) => {
      const row = rows.get(userId);
      return row ? JSON.parse(row.text) as Record<string, unknown> : undefined;
    },
    /** Which account the browser's session token belongs to (as another tab could change it). */
    setSessionUser: (userId: string | null) => { sessionUser = userId; },
    setOffline: (value: boolean) => { offline = value; },
    failBackups: (value = true) => { failBackups = value; },
    onImport: (handler?: typeof rpcHandler) => { rpcHandler = handler; },
    onWrite: (handler?: typeof writeHandler) => { writeHandler = handler; },
    onRead: (handler?: typeof readHandler) => { readHandler = handler; },
    /** Another device saves this garden into the account, moving the revision on. */
    saveElsewhere(userId: string, data: unknown, schemaVersion = 5) {
      rows.set(userId, { text: JSON.stringify(data), schema_version: schemaVersion, revision: nextRevision(userId) });
    },
  };
}

/** Resolves when the test releases it, to hold a reply back while the test changes something. */
export function gate() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { released, release };
}
