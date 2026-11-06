import { describe, expect, it, vi } from "vitest";
import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { createCloudGameStorage, type CloudSaveClient } from "../src/app/cloud-game-storage";
import type { AuthState } from "../src/app/auth/auth-controller";
import { initialStoredQuestData } from "../src/app/quest-defaults";
import { latestQuestSaveVersion, readQuestSave } from "../src/app/quest-storage";
import type { StoredQuestData } from "../src/app/quest-types";
import { canonicalJson } from "../src/app/unsaved-recovery-store";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const garden = (xp = 5) => ({ ...structuredClone(initialStoredQuestData), legacyXpBonus: xp });
const signIn = (id = A): Extract<AuthState, { status: "signed-in" }> => ({ status: "signed-in", user: { id, email: `${id}@example.com` } });
const token = (id: string) => `e30.${Buffer.from(JSON.stringify({ sub: id })).toString("base64url")}.sig`;
type Reply = { data: unknown; error: { code?: string } | null; status: number };
type Args = { p_user_id: string; p_expected_revision: number | null; p_data: StoredQuestData; p_schema_version: number };
type Row = { data: StoredQuestData; schema_version: number; revision: number };
const ok = (data: unknown): Reply => ({ data, error: null, status: 200 });
const lost = (): Reply => ({ data: null, error: {}, status: 0 });

function setup(existing?: StoredQuestData) {
  let auth: AuthState = signIn();
  let sessionUser: string | null = A;
  let offline = false;
  let row: Row | null = existing ? { data: structuredClone(existing), schema_version: 5, revision: 1 } : null;
  let nextRevision = row?.revision ?? 0;
  const backups: string[] = [];
  let failBackup = false;
  const events: string[] = [];
  const calls: Args[] = [];
  let rpcHandler: ((args: Args, sentAs: string | null) => Promise<Reply> | Reply) | undefined;
  let readHandler: (() => Reply | Promise<Reply>) | undefined;
  const apply = (args: Args, sentAs: string | null = A): Reply => {
    if (args.p_user_id !== sentAs) return { data: null, error: { code: "42501" }, status: 403 };
    if ((row?.revision ?? null) !== args.p_expected_revision) return ok([{ outcome: "conflict", revision: null }]);
    // As the RPC does: an identical garden (compared as jsonb, so key order doesn't matter) is left alone.
    if (row && canonicalJson(row.data) === canonicalJson(args.p_data) && row.schema_version === args.p_schema_version) {
      return ok([{ outcome: "unchanged", revision: row.revision }]);
    }
    if (row && failBackup) return ok([{ outcome: "backup_failed", revision: null }]);
    if (row) backups.push(JSON.stringify(row.data));
    row = { data: structuredClone(args.p_data), schema_version: args.p_schema_version, revision: ++nextRevision };
    return ok([{ outcome: "imported", revision: row.revision }]);
  };
  const client = {
    auth: { getSession: vi.fn(async () => offline
      ? { data: { session: null }, error: new AuthRetryableFetchError("offline", 0) }
      : { data: { session: sessionUser ? { access_token: token(sessionUser) } : null }, error: null }) },
    rpc: vi.fn((name: string, args: Args) => {
      expect(name).toBe("import_browser_save");
      const sentAs = sessionUser;
      calls.push(structuredClone(args));
      events.push("rpc");
      return { abortSignal: (signal: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve().then(() => rpcHandler ? rpcHandler(args, sentAs) : apply(args, sentAs));
      } };
    }),
    from: vi.fn((table: string) => {
      expect(table).toBe("quest_saves");
      let requestedUser: unknown;
      const q = {
        select: () => q,
        eq: (name: string, value: unknown) => { if (name === "user_id") requestedUser = value; return q; },
        abortSignal: (signal: AbortSignal) => { expect(signal).toBeInstanceOf(AbortSignal); return q; },
        maybeSingle: async () => {
          events.push("read");
          if (readHandler) return readHandler();
          return ok(requestedUser === A && sessionUser === A ? structuredClone(row) : null);
        },
      };
      return q;
    }),
  };
  const storage = createCloudGameStorage({ client: client as unknown as CloudSaveClient, signIn: signIn(), getAuth: () => auth });
  return { storage, client, calls, events, backups, apply,
    row: () => row,
    setAuth: (next: AuthState) => { auth = next; },
    setSession: (id: string | null) => { sessionUser = id; },
    setOffline: (value: boolean) => { offline = value; },
    failBackup: () => { failBackup = true; },
    rpc: (handler?: typeof rpcHandler) => { rpcHandler = handler; },
    read: (handler?: typeof readHandler) => { readHandler = handler; },
    saveElsewhere: (data: StoredQuestData) => { row = { data, schema_version: 5, revision: ++nextRevision }; },
  };
}

describe("transactional browser imports", () => {
  it("imports into an empty account, snapshots input and requires a reload before normal saves", async () => {
    const env = setup();
    const data = garden();
    const original = JSON.stringify(data);
    const pending = env.storage.importSave(data, null);
    data.legacyXpBonus = 999;
    expect(await pending).toEqual({ status: "imported", revision: 1, verified: false });
    expect(JSON.stringify(env.row()?.data)).toBe(original);
    expect(env.backups).toEqual([]);
    expect(await env.storage.save(garden(90))).toEqual({ status: "failed", problem: "not-loaded" });
    await env.storage.load(garden());
    expect(env.storage.getLoadedRevision()).toBe(1);
  });

  it("backs up existing progress and sends explicit account and revision to the single RPC", async () => {
    const previous = garden(40);
    const env = setup(previous);
    const browser = garden(10);
    const bytes = JSON.stringify(browser);
    expect(await env.storage.importSave(browser, 1)).toMatchObject({ status: "imported", revision: 2 });
    expect(env.calls[0]).toMatchObject({ p_user_id: A, p_expected_revision: 1, p_schema_version: 5 });
    expect(env.backups).toEqual([JSON.stringify(previous)]);
    expect(env.row()?.data).toEqual(browser);
    expect(JSON.stringify(browser)).toBe(bytes);
  });

  it("serializes duplicate clicks and never sends the same successful import twice", async () => {
    const env = setup(garden(40));
    const results = await Promise.all([env.storage.importSave(garden(), 1), env.storage.importSave(garden(), 1)]);
    expect(results[0]).toMatchObject({ status: "imported" });
    expect(results[1]).toEqual({ status: "conflict" });
    expect(env.calls).toHaveLength(1);
    expect(env.backups).toHaveLength(1);
  });

  it.each([null, 2])("returns a conflict for stale expected revision %s, without a backup", async (expected) => {
    const env = setup(garden(40));
    expect(await env.storage.importSave(garden(), expected)).toEqual({ status: "conflict" });
    expect(env.backups).toEqual([]);
    expect(env.row()?.data.legacyXpBonus).toBe(40);
  });

  it("stops if backup creation fails", async () => {
    const env = setup(garden(40));
    env.failBackup();
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "backup_failed" });
    expect(env.row()?.revision).toBe(1);
    expect(env.backups).toEqual([]);
  });

  it.each(["signed-out", "different auth", "different token"])("refuses import after %s", async (change) => {
    const env = setup();
    if (change === "signed-out") env.setAuth({ status: "signed-out" });
    if (change === "different auth") env.setAuth(signIn(B));
    if (change === "different token") env.setSession(B);
    expect(await env.storage.importSave(garden(), null)).toMatchObject({ status: "failed", problem: "identity-changed" });
    expect(env.calls).toEqual([]);
  });

  it("never sends an import with an offline/expired token, and can try explicitly once online", async () => {
    const env = setup();
    env.setOffline(true);
    expect(await env.storage.importSave(garden(), null)).toMatchObject({ status: "failed", problem: "network", verificationRequired: false });
    expect(env.calls).toHaveLength(0);
    env.setOffline(false);
    expect(await env.storage.importSave(garden(), null)).toMatchObject({ status: "imported" });
  });

  it("does not expose success or continue work if the account changed during the request", async () => {
    const env = setup();
    env.rpc((args, sentAs) => {
      const result = env.apply(args, sentAs);
      env.setAuth(signIn(B));
      env.setSession(B);
      return result;
    });
    expect(await env.storage.importSave(garden(), null)).toMatchObject({ status: "failed", problem: "identity-changed", verificationRequired: true });
    expect(env.calls).toHaveLength(1);
    expect(env.events).toEqual(["rpc"]);
    expect(await env.storage.verifyImport()).toMatchObject({ status: "failed", problem: "identity-changed" });
    expect(env.events).toEqual(["rpc"]);
  });

  it("checks actual state after a committed import's lost reply, without importing twice", async () => {
    const env = setup(garden(40));
    env.rpc((args, sentAs) => { env.apply(args, sentAs); return lost(); });
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "imported", revision: 2, verified: true });
    expect(env.events).toEqual(["rpc", "read"]);
    expect(env.backups).toHaveLength(1);
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "conflict" });
    expect(env.calls).toHaveLength(1);
  });

  it("only retries explicitly, and reads state again BEFORE retrying a lost uncommitted request", async () => {
    const env = setup(garden(40));
    env.rpc(() => lost());
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "failed", problem: "network", verificationRequired: false });
    expect(env.calls).toHaveLength(1);
    expect(await env.storage.save(garden(100))).toMatchObject({ status: "failed", problem: "not-loaded" });
    env.rpc();
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "imported" });
    expect(env.events).toEqual(["rpc", "read", "read", "rpc"]);
  });

  it("keeps the verification gate through failed reads, loads and different requested imports", async () => {
    const env = setup(garden(40));
    env.rpc(() => lost());
    env.read(() => lost());
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "failed", verificationRequired: true });
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "failed", verificationRequired: true });
    expect(env.calls).toHaveLength(1);
    env.read();
    await env.storage.load(garden());
    expect(await env.storage.save(garden(99))).toMatchObject({ status: "failed", problem: "not-loaded" });
    expect(await env.storage.importSave(garden(99), 1)).toMatchObject({ status: "failed", problem: "not-loaded" });
    expect(env.calls).toHaveLength(1);
    env.rpc();
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "imported" });
  });

  it("does not retry over newer cloud progress after a lost reply", async () => {
    const env = setup(garden(40));
    env.rpc((args, sentAs) => { env.apply(args, sentAs); env.saveElsewhere(garden(90)); return lost(); });
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "conflict" });
    expect(env.calls).toHaveLength(1);
    expect(env.row()?.data.legacyXpBonus).toBe(90);
  });

  it("does not mistake identical content at the unchanged expected revision for a committed import", async () => {
    const env = setup(garden());
    env.rpc(() => lost());
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "failed", verificationRequired: false });
    expect(env.row()?.revision).toBe(1);
  });

  it("can verify later after an unavailable verification read, without another RPC", async () => {
    const env = setup();
    env.rpc((args, sentAs) => { env.apply(args, sentAs); throw new Error("timeout"); });
    env.read(() => lost());
    expect(await env.storage.importSave(garden(), null)).toMatchObject({ status: "failed", verificationRequired: true });
    env.read();
    expect(await env.storage.verifyImport()).toEqual({ status: "imported", revision: 1, verified: true });
    expect(env.calls).toHaveLength(1);
    expect(await env.storage.verifyImport()).toBeNull();
  });

  it("checks account identity after a verification read too", async () => {
    const env = setup();
    env.rpc(() => lost());
    env.read(() => { env.setAuth(signIn(B)); return ok(null); });
    expect(await env.storage.importSave(garden(), null)).toMatchObject({ status: "failed", problem: "identity-changed", verificationRequired: true });
    expect(env.calls).toHaveLength(1);
  });

  it("treats malformed success replies as ambiguous", async () => {
    const env = setup();
    env.rpc((args, sentAs) => { env.apply(args, sentAs); return ok([{ outcome: "imported", revision: "bad" }]); });
    expect(await env.storage.importSave(garden(), null)).toMatchObject({ status: "imported", verified: true });
  });

  it("does not trust a success reply that didn't advance the expected revision", async () => {
    const env = setup(garden(40));
    env.rpc(() => ok([{ outcome: "imported", revision: 1 }]));
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "failed", verificationRequired: false });
    expect(env.events).toEqual(["rpc", "read"]);
    expect(env.row()?.data.legacyXpBonus).toBe(40);
  });

  it("a definitive PostgreSQL rollback does not leave an unnecessary verification gate", async () => {
    const env = setup(garden(40));
    env.rpc(() => ({ data: null, error: { code: "23514" }, status: 400 }));
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "failed", problem: "rejected", verificationRequired: false });
    expect(env.events).toEqual(["rpc"]);
    expect(await env.storage.verifyImport()).toBeNull();
    env.rpc();
    expect(await env.storage.importSave(garden(10), 1)).toMatchObject({ status: "imported" });
  });

  it("a retry's backup failure cannot release the earlier uncertain transaction's gate", async () => {
    const env = setup(garden(40));
    env.rpc(() => lost());
    await env.storage.importSave(garden(), 1);
    env.rpc(() => ok([{ outcome: "backup_failed", revision: null }]));
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "failed", verificationRequired: false });
    await env.storage.load(garden());
    expect(await env.storage.save(garden(99))).toMatchObject({ status: "failed", problem: "not-loaded" });
  });

  it("an identical garden at an older revision is a conflict, not proof of import success", async () => {
    const env = setup(garden());
    env.rpc(() => lost());
    expect(await env.storage.importSave(garden(), 100)).toEqual({ status: "conflict" });
  });

  it.each([null, { questLists: "bad" }, { ...garden(), schemaVersion: "5" }, { ...garden(), schemaVersion: latestQuestSaveVersion + 1 }])(
    "refuses invalid/unsupported input before sending %j", async (data) => {
      const env = setup();
      expect(await env.storage.importSave(data as never, null)).toMatchObject({ status: "failed" });
      expect(env.calls).toHaveLength(0);
    },
  );

  it("refuses oversized data and invalid expected revisions before sending", async () => {
    const env = setup();
    const data = garden();
    data.questLists.personal[0].notes = "x".repeat(10485760);
    expect(await env.storage.importSave(data, null)).toMatchObject({ status: "failed", problem: "too-large" });
    expect(await env.storage.importSave(garden(), -1)).toMatchObject({ status: "failed", problem: "rejected" });
    expect(env.calls).toHaveLength(0);
  });

  it("supports an actual legacy garden by validation/migration in memory only", async () => {
    const env = setup();
    const data = garden();
    delete data.schemaVersion;
    const raw = JSON.stringify(data);
    expect(await env.storage.importSave(data, null)).toMatchObject({ status: "imported" });
    expect(env.row()?.data).toEqual((readQuestSave(data) as { data: StoredQuestData }).data);
    expect(JSON.stringify(data)).toBe(raw);
  });

  it("a retried uncertain import that sees a conflict checks the cloud: a late-committing original is reported as imported", async () => {
    const env = setup(garden(40));
    // The first request is lost before the server answers; the verification read sees revision 1.
    env.rpc(() => lost());
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "failed", verificationRequired: false });
    // The original transaction commits late, just before the explicit retry reaches the server.
    env.rpc((args, sentAs) => {
      env.apply({ ...args }, sentAs);
      return env.apply(args, sentAs);
    });
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "imported", revision: 2, verified: true });
    expect(env.backups).toHaveLength(1);
    expect(await env.storage.save(garden(99))).toMatchObject({ status: "failed", problem: "not-loaded" });
  });

  it("a retried uncertain import that sees a conflict from someone else's save reports the conflict", async () => {
    const env = setup(garden(40));
    env.rpc(() => lost());
    await env.storage.importSave(garden(), 1);
    env.rpc((args, sentAs) => {
      env.saveElsewhere(garden(90));
      return env.apply(args, sentAs);
    });
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "conflict" });
    expect(env.row()?.data.legacyXpBonus).toBe(90);
    expect(env.backups).toEqual([]);
  });

  it("an identical garden is left unchanged: no backup, no new revision, and a load is still required", async () => {
    const env = setup(garden(5));
    expect(await env.storage.importSave(garden(5), 1)).toEqual({ status: "unchanged", revision: 1 });
    expect(env.backups).toEqual([]);
    expect(env.row()?.revision).toBe(1);
    expect(await env.storage.verifyImport()).toBeNull();
    expect(await env.storage.save(garden(99))).toMatchObject({ status: "failed", problem: "not-loaded" });
    await env.storage.load(garden());
    expect(env.storage.getLoadedRevision()).toBe(1);
  });

  it("an 'unchanged' reply for a different revision than expected is not trusted", async () => {
    const env = setup(garden(40));
    env.rpc(() => ok([{ outcome: "unchanged", revision: 7 }]));
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "failed" });
    expect(env.events).toEqual(["rpc", "read"]);
  });

  it("a transport error with a short code (no HTTP status) is still treated as uncertain", async () => {
    const env = setup(garden(40));
    env.rpc((args, sentAs) => { env.apply(args, sentAs); return { data: null, error: { code: "EPIPE" }, status: 0 }; });
    expect(await env.storage.importSave(garden(), 1)).toEqual({ status: "imported", revision: 2, verified: true });
    expect(env.events).toEqual(["rpc", "read"]);
  });

  it("reports whether an import is unresolved, so a controller keeps this storage to verify or retry it", async () => {
    const env = setup(garden(40));
    expect(env.storage.hasUnresolvedImport()).toBe(false);
    env.rpc(() => lost());
    await env.storage.importSave(garden(), 1);
    expect(env.storage.hasUnresolvedImport()).toBe(true);
    env.rpc();
    expect(await env.storage.importSave(garden(), 1)).toMatchObject({ status: "imported" });
    expect(env.storage.hasUnresolvedImport()).toBe(false);
  });
});
