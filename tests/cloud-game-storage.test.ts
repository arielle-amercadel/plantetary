import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { AuthState } from "../src/app/auth/auth-controller";
import {
  createCloudGameStorage,
  describeCloudError,
  type CloudSaveClient,
  type VerifiedSignIn,
} from "../src/app/cloud-game-storage";
import { latestQuestSaveVersion, readQuestSave } from "../src/app/quest-storage";
import type { StoredQuestData } from "../src/app/quest-types";

const USER_A = "6f1d4c58-0000-4000-8000-00000000000a";
const USER_B = "6f1d4c58-0000-4000-8000-00000000000b";

const signedIn = (id: string): VerifiedSignIn => ({ status: "signed-in", user: { id, email: `${id}@example.com` } });

/** A token shaped like Supabase's, for the given account. Its signature is irrelevant here. */
function tokenFor(userId: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId })}.signature`;
}

/** A save from before XP and plants were tracked. Loading it must upgrade it. */
const legacySave = {
  questLists: {
    daily: [{ id: "water", title: "Drink water", category: "Wellness", repeatSchedule: "Every day", selectedDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], difficulty: "Easy", completed: false }],
    personal: [{ id: "biology", title: "Review notes", category: "Study", difficulty: "Hard", completed: true }],
  },
  categoryLists: { daily: ["Wellness"], personal: ["Study"] },
};

/** The same save in the current format, as this app writes it. */
function currentSave(): StoredQuestData {
  const result = readQuestSave(structuredClone(legacySave));
  if (result.status !== "valid") throw new Error("fixture");
  return JSON.parse(JSON.stringify(result.data));
}

/** The save with one edit, numbered so tests can tell versions apart. It changes nothing an upgrade would. */
function edited(data: StoredQuestData, version: number): StoredQuestData {
  return { ...data, categoryLists: { ...data.categoryLists, personal: [...data.categoryLists.personal, `Edit ${version}`] } };
}

const fallback: StoredQuestData = {
  schemaVersion: latestQuestSaveVersion,
  questLists: { daily: [], personal: [] },
  categoryLists: { daily: ["Fallback"], personal: [] },
};

type Row = { user_id: string; data: unknown; schema_version: number; revision: number };
type Backup = { user_id: string; reason: string; raw_data: string; schema_version: number | null; source_revision: number | null };
type Call = {
  table: string;
  op: "select" | "insert" | "update";
  payload?: Record<string, unknown>;
  columns?: string;
  filters: Array<[string, unknown]>;
  /** The account of the token the request was sent with, as RLS sees it. */
  tokenUser?: string | null;
};
type Reply = { data: unknown; error: { code: string; message?: string } | null; status: number };

const ok = (data: unknown, status = 200): Reply => ({ data, error: null, status });
const fail = (status: number, code = "", message = "failed"): Reply => ({ data: null, error: { code, message }, status });

/** The real database's messages (pinned by supabase/tests/database/07_upgrade_backups.test.sql). */
const messages = {
  formatGuard: (saved: number, attempted: number) => `quest_saves.schema_version cannot decrease (saved: ${saved}, attempted: ${attempted})`,
  check: (table: string, constraint: string) => `new row for relation "${table}" violates check constraint "${constraint}"`,
  unique: (constraint: string) => `duplicate key value violates unique constraint "${constraint}"`,
};
const SAVE_LIMIT_BYTES = 10_485_760;

/** Resolves when the test releases it, to hold a reply back while the test changes something. */
function gate() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { released, release };
}

/**
 * A fake Supabase project with the real tables' rules: RLS limits each request to the token's own
 * account, the database sets revisions (never reused), the primary key allows one save per account,
 * an update matches only the given user and revision, and the format guard refuses a lower version.
 * `intercept` can replace any reply, or throw, to simulate failures.
 */
function createFakeSupabase() {
  const db = { row: null as Row | null, lastRevision: 0, backups: [] as Backup[] };
  const calls: Call[] = [];
  let sessionUserId: string | null = USER_A;
  let intercept: ((call: Call) => Reply | Promise<Reply> | undefined) | undefined;

  function execute(call: Call): Reply | Promise<Reply> {
    // A request carries the token it was sent with, even if the browser's session changes before it's answered.
    call.tokenUser = sessionUserId;
    calls.push(call);
    const injected = intercept?.(call);
    if (injected) return injected;
    return applyToDatabase(call);
  }

  function applyToDatabase(call: Call): Reply {
    const tokenUser = call.tokenUser ?? null;
    const filter = (column: string) => call.filters.find(([name]) => name === column)?.[1];

    if (call.table === "save_backups") {
      const backup = structuredClone(call.payload) as Backup;
      if (backup.user_id !== tokenUser) return fail(403, "42501");
      if (!["browser_import", "conflict", "daily", "upgrade"].includes(backup.reason)) {
        return fail(400, "23514", messages.check("save_backups", "save_backups_reason_check"));
      }
      if (backup.reason === "upgrade" && backup.source_revision === null) {
        return fail(400, "23514", messages.check("save_backups", "save_backups_upgrade_source_revision_check"));
      }
      if (backup.reason === "upgrade" && db.backups.some((other) =>
        other.reason === "upgrade" && other.user_id === backup.user_id && other.source_revision === backup.source_revision)) {
        return fail(409, "23505", messages.unique("save_backups_upgrade_once"));
      }
      db.backups.push(backup);
      return ok(null, 201);
    }

    const dataProblem = (data: unknown) =>
      !data || typeof data !== "object" || Array.isArray(data) || new TextEncoder().encode(JSON.stringify(data)).length > SAVE_LIMIT_BYTES
        ? fail(400, "23514", messages.check("quest_saves", "quest_saves_data_check"))
        : null;

    const visible = db.row && db.row.user_id === tokenUser ? db.row : null;
    if (call.op === "select") {
      const row = visible && filter("user_id") === visible.user_id ? visible : null;
      return ok(row ? { data: JSON.parse(JSON.stringify(row.data)), schema_version: row.schema_version, revision: row.revision } : null);
    }
    if (call.op === "insert") {
      const payload = call.payload as Row;
      if (payload.user_id !== tokenUser) return fail(403, "42501");
      if (db.row && db.row.user_id === payload.user_id) return fail(409, "23505", messages.unique("quest_saves_pkey"));
      const problem = dataProblem(payload.data);
      if (problem) return problem;
      db.lastRevision += 1;
      db.row = { user_id: payload.user_id, data: JSON.parse(JSON.stringify(payload.data)), schema_version: payload.schema_version, revision: db.lastRevision };
      return ok({ revision: db.row.revision }, 201);
    }
    // update
    const payload = call.payload as Pick<Row, "data" | "schema_version">;
    if (!visible || filter("user_id") !== visible.user_id || filter("revision") !== visible.revision) return ok([]);
    const problem = dataProblem(payload.data);
    if (problem) return problem;
    if (payload.schema_version < visible.schema_version) {
      return fail(400, "23514", messages.formatGuard(visible.schema_version, payload.schema_version));
    }
    db.lastRevision += 1;
    db.row = { ...visible, data: JSON.parse(JSON.stringify(payload.data)), schema_version: payload.schema_version, revision: db.lastRevision };
    return ok([{ revision: db.row.revision }]);
  }

  function builder(table: string) {
    const call: Call = { table, op: "select", filters: [] };
    const chain = {
      select(columns: string) {
        if (call.op === "select") call.columns = columns;
        return chain;
      },
      insert(payload: Record<string, unknown>) {
        call.op = "insert";
        call.payload = payload;
        return chain;
      },
      update(payload: Record<string, unknown>) {
        call.op = "update";
        call.payload = payload;
        return chain;
      },
      eq(column: string, value: unknown) {
        call.filters.push([column, value]);
        return chain;
      },
      maybeSingle: () => chain,
      single: () => chain,
      overrideTypes: () => chain,
      then(resolve: (reply: Reply) => unknown, reject: (error: unknown) => unknown) {
        try {
          return Promise.resolve(execute(call)).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      },
    };
    return chain;
  }

  const client = {
    from: vi.fn((table: string) => builder(table)),
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: sessionUserId ? { access_token: tokenFor(sessionUserId) } : null },
        error: null,
      })),
    },
  };

  return {
    client: client as unknown as CloudSaveClient,
    db,
    calls,
    /** Requests to the database, apart from the given tables. */
    requests: (table?: string) => calls.filter((call) => !table || call.table === table),
    /** Which account the browser's session belongs to, as another tab could change it. */
    setSessionUser(userId: string | null) {
      sessionUserId = userId;
    },
    intercept(handler: ((call: Call) => Reply | Promise<Reply> | undefined) | undefined) {
      intercept = handler;
    },
    /** Answers a request as the database would, now. For replies held back by a test. */
    apply: (call: Call) => applyToDatabase(call),
    /**
     * Holds back the reply to the first request `matches` accepts until the test releases it. The
     * database answers when released, so a test can change the account in between.
     */
    hold(matches: (call: Call) => boolean) {
      const held = gate();
      let used = false;
      intercept = (call) => {
        if (used || !matches(call)) return undefined;
        used = true;
        return held.released.then(() => applyToDatabase(call));
      };
      return held;
    },
    /** Another device saves directly, moving the revision on. */
    saveElsewhere(data: StoredQuestData) {
      if (!db.row) throw new Error("no save");
      db.lastRevision += 1;
      db.row = { ...db.row, data: structuredClone(data), revision: db.lastRevision };
    },
    seed(userId: string, data: unknown, schemaVersion = latestQuestSaveVersion) {
      db.lastRevision += 1;
      db.row = { user_id: userId, data: structuredClone(data), schema_version: schemaVersion, revision: db.lastRevision };
    },
  };
}

function setup(options: { userId?: string } = {}) {
  const fake = createFakeSupabase();
  const userId = options.userId ?? USER_A;
  let auth: AuthState = signedIn(userId);
  const storage = createCloudGameStorage({ client: fake.client, signIn: signedIn(userId), getAuth: () => auth });
  return {
    fake,
    storage,
    setAuth(state: AuthState) {
      auth = state;
    },
  };
}

describe("cloud storage fixtures", () => {
  it("use a current save that loads unchanged", () => {
    expect(readQuestSave(currentSave())).toMatchObject({ status: "valid", upgraded: false, newerVersion: false });
  });
});

describe("loading a cloud save", () => {
  it("reports an account with no save as empty, and writes nothing", async () => {
    const { fake, storage } = setup();

    expect(await storage.load(fallback)).toEqual({ status: "empty", data: fallback });
    expect(fake.requests().map((call) => call.op)).toEqual(["select"]);
    expect(fake.db.row).toBeNull();
  });

  it("reads only this account's save, with the columns it needs", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());

    const result = await storage.load(fallback);

    expect(result).toEqual({ status: "ready", data: currentSave(), storedText: JSON.stringify(currentSave()) });
    expect(fake.requests()).toEqual([{
      table: "quest_saves",
      op: "select",
      columns: "data, schema_version, revision",
      filters: [["user_id", USER_A]],
      tokenUser: USER_A,
    }]);
  });

  it("never sees another account's save", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_B, currentSave());

    expect((await storage.load(fallback)).status).toBe("empty");
  });

  it("upgrades an older save after backing up the original as an upgrade backup", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, legacySave, 1);

    const result = await storage.load(fallback);

    expect(result).toEqual({ status: "ready", data: currentSave(), storedText: JSON.stringify(legacySave) });
    expect(fake.db.backups).toEqual([{
      user_id: USER_A,
      reason: "upgrade",
      raw_data: JSON.stringify(legacySave),
      schema_version: 1,
      source_revision: 1,
    }]);
    expect(fake.db.row?.data).toEqual(legacySave);
  });

  it("shows an older save but never replaces it when the backup fails", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, legacySave, 1);
    fake.intercept((call) => (call.table === "save_backups" ? fail(500) : undefined));

    expect(await storage.load(fallback)).toEqual({ status: "failed", data: currentSave(), problem: "backup-failed" });
    fake.intercept(undefined);
    const before = fake.requests().length;

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "backup-failed" });
    expect(fake.requests()).toHaveLength(before);
    expect(fake.db.row?.data).toEqual(legacySave);
  });

  it.each([
    ["not a save at all", { hello: "world" }],
    ["a quest with an unknown difficulty", { ...legacySave, questLists: { daily: [{ ...legacySave.questLists.daily[0], difficulty: "Impossible" }], personal: [] } }],
    ["a list", [1, 2, 3]],
  ])("keeps an invalid save (%s), shows the fallback, and never replaces it", async (_, data) => {
    const { fake, storage } = setup();
    fake.seed(USER_A, data);

    expect(await storage.load(fallback)).toEqual({ status: "failed", data: fallback, problem: "invalid-save" });
    expect(await storage.save(edited(fallback, 5))).toEqual({ status: "failed", problem: "invalid-save" });
    expect(fake.requests().filter((call) => call.op !== "select")).toEqual([]);
    expect(fake.db.row?.data).toEqual(data);
  });

  it.each([
    ["the save's own version", { ...currentSave(), schemaVersion: latestQuestSaveVersion + 1 }, latestQuestSaveVersion + 1],
    ["the row's version", currentSave(), latestQuestSaveVersion + 1],
  ])("shows a save from a newer version (by %s), and never replaces it", async (_, data, rowVersion) => {
    const { fake, storage } = setup();
    fake.seed(USER_A, data, rowVersion);

    const result = await storage.load(fallback);

    expect(result).toEqual({ status: "failed", data, problem: "newer-version" });
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "newer-version" });
    expect(fake.requests().filter((call) => call.op !== "select")).toEqual([]);
    expect(fake.db.row?.data).toEqual(data);
  });

  it.each([
    ["unreachable", fail(0), "network"],
    ["signed out (401)", fail(401, "PGRST301"), "signed-out"],
    ["refused by access rules", fail(403, "42501"), "denied"],
    ["a server error", fail(503), "server"],
    ["rate limited", fail(429), "server"],
    ["an unexpected error", fail(400, "XX000"), "unknown"],
    ["a row without a usable revision", ok({ data: {}, schema_version: 5, revision: "seven" }), "unknown"],
  ] as const)("reports a load that is %s, and then refuses to save blindly", async (_, reply, problem) => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    fake.intercept((call) => (call.op === "select" ? reply : undefined));

    expect(await storage.load(fallback)).toEqual({ status: "failed", data: fallback, problem });
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "not-loaded" });
    expect(fake.requests().filter((call) => call.op !== "select")).toEqual([]);
  });

  it("reports a load that throws as failed", async () => {
    const { fake, storage } = setup();
    fake.intercept(() => { throw new Error("boom"); });

    expect(await storage.load(fallback)).toEqual({ status: "failed", data: fallback, problem: "unknown" });
  });

  it("can load again after a failed load", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    fake.intercept(() => fail(0));
    await storage.load(fallback);
    fake.intercept(undefined);

    expect((await storage.load(fallback)).status).toBe("ready");
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "saved" });
  });
});

describe("saving to the cloud", () => {
  it("creates the account's first save with only the columns users may write", async () => {
    const { fake, storage } = setup();
    await storage.load(fallback);

    expect(await storage.save(currentSave())).toEqual({ status: "saved" });

    const [insert] = fake.requests().filter((call) => call.op === "insert");
    expect(insert).toMatchObject({ table: "quest_saves", payload: { user_id: USER_A, data: currentSave(), schema_version: latestQuestSaveVersion } });
    expect(Object.keys(insert.payload ?? {}).sort()).toEqual(["data", "schema_version", "user_id"]);
    expect(fake.db.row).toMatchObject({ user_id: USER_A, data: currentSave(), revision: 1 });
  });

  it("updates only the revision it loaded, and follows each new revision", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    fake.saveElsewhere(currentSave());
    await storage.load(fallback);
    expect(fake.db.row?.revision).toBe(2);

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "saved" });
    expect(await storage.save(edited(currentSave(), 10))).toEqual({ status: "saved" });

    const updates = fake.requests().filter((call) => call.op === "update");
    expect(updates.map((call) => call.filters)).toEqual([
      [["user_id", USER_A], ["revision", 2]],
      [["user_id", USER_A], ["revision", 3]],
    ]);
    expect(Object.keys(updates[0].payload ?? {}).sort()).toEqual(["data", "schema_version"]);
    expect(fake.db.row).toMatchObject({ data: edited(currentSave(), 10), revision: 4 });
  });

  it("follows a first save with updates to the revision it created", async () => {
    const { fake, storage } = setup();
    await storage.load(fallback);
    await storage.save(currentSave());

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "saved" });
    expect(fake.requests().filter((call) => call.op === "update")[0].filters).toEqual([["user_id", USER_A], ["revision", 1]]);
  });

  it("runs saves one at a time, so back-to-back saves never conflict with each other", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);

    const results = await Promise.all([1, 2, 3].map((xp) => storage.save(edited(currentSave(), xp))));

    expect(results).toEqual([{ status: "saved" }, { status: "saved" }, { status: "saved" }]);
    expect(fake.db.row).toMatchObject({ data: edited(currentSave(), 3), revision: 4 });
  });

  it("refuses to save before anything was loaded", async () => {
    const { fake, storage } = setup();

    expect(await storage.save(currentSave())).toEqual({ status: "failed", problem: "not-loaded" });
    expect(fake.requests()).toEqual([]);
  });

  it.each([
    ["unreachable", fail(0), "network"],
    ["signed out", fail(401, "PGRST303"), "signed-out"],
    ["refused by access rules", fail(403, "42501"), "denied"],
    ["a server error", fail(500), "server"],
    ["an unexpected error", fail(400, "22P02"), "unknown"],
  ] as const)("reports a save that is %s, changes nothing, and can safely try again", async (_, reply, problem) => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.intercept((call) => (call.op === "update" ? reply : undefined));

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem });
    expect(fake.db.row).toMatchObject({ data: currentSave(), revision: 1 });

    fake.intercept(undefined);
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "saved" });
    expect(fake.db.row).toMatchObject({ data: edited(currentSave(), 5), revision: 2 });
  });

  it("reports a failed first save, and can safely try again", async () => {
    const { fake, storage } = setup();
    await storage.load(fallback);
    fake.intercept((call) => (call.op === "insert" ? fail(0) : undefined));

    expect(await storage.save(currentSave())).toEqual({ status: "failed", problem: "network" });
    fake.intercept(undefined);
    expect(await storage.save(currentSave())).toEqual({ status: "saved" });
  });

  it("never overwrites when a save it couldn't confirm did reach the database", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    // The update is applied, but the reply is lost on the way back.
    fake.intercept((call) => {
      if (call.op !== "update") return undefined;
      fake.intercept(undefined);
      fake.saveElsewhere(edited(currentSave(), 5));
      return fail(0);
    });

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "network" });
    expect(await storage.save(edited(currentSave(), 6))).toEqual({ status: "conflict", backup: "saved" });
    expect(fake.db.row?.data).toEqual(edited(currentSave(), 5));
  });

  it("treats a save that throws as failed, without assuming either way", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.intercept((call) => {
      if (call.op === "update") throw new Error("boom");
      return undefined;
    });

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "unknown" });
    fake.intercept(undefined);
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "saved" });
  });

  it("stops saving when the database's format guard refuses an older format", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.intercept((call) => (call.op === "update" ? fail(400, "23514", messages.formatGuard(6, 5)) : undefined));

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "newer-version" });
    fake.intercept(undefined);
    expect(await storage.save(edited(currentSave(), 6))).toEqual({ status: "failed", problem: "newer-version" });
    expect(fake.db.row?.data).toEqual(currentSave());
  });

  it("refuses later saves when a saved revision can't be read back", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    // The update is applied, but the reply has no usable revision.
    fake.intercept((call) => (call.op === "update" ? ok([{ revision: null }]) : undefined));

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "saved" });
    expect(await storage.save(edited(currentSave(), 6))).toEqual({ status: "failed", problem: "not-loaded" });
  });
});

describe("conflicts: the save changed somewhere else", () => {
  it("never overwrites another device's save, and keeps this data as a conflict backup", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.saveElsewhere(edited(currentSave(), 100));

    const unsaved = edited(currentSave(), 5);
    expect(await storage.save(unsaved)).toEqual({ status: "conflict", backup: "saved" });

    expect(fake.db.row).toMatchObject({ data: edited(currentSave(), 100), revision: 2 });
    expect(fake.db.backups).toEqual([{
      user_id: USER_A,
      reason: "conflict",
      raw_data: JSON.stringify(unsaved),
      schema_version: latestQuestSaveVersion,
      source_revision: 1,
    }]);
  });

  it("refuses every later save without writing, until loaded again", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.saveElsewhere(edited(currentSave(), 100));
    await storage.save(edited(currentSave(), 5));

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "conflict", backup: "saved" });
    expect(await storage.save(edited(currentSave(), 6))).toEqual({ status: "conflict", backup: "saved" });

    expect(fake.requests().filter((call) => call.op === "update")).toHaveLength(1);
    // The same data isn't backed up twice; newer unsaved data is.
    expect(fake.db.backups.map((backup) => JSON.parse(backup.raw_data).categoryLists.personal.at(-1))).toEqual(["Edit 5", "Edit 6"]);
    expect(fake.db.row?.data).toEqual(edited(currentSave(), 100));

    // Loading again takes the other device's save, and saving works from there.
    expect(await storage.load(fallback)).toMatchObject({ status: "ready", data: edited(currentSave(), 100) });
    expect(await storage.save(edited(currentSave(), 101))).toEqual({ status: "saved" });
  });

  it("says so when the unsaved data couldn't be backed up", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.saveElsewhere(edited(currentSave(), 100));
    fake.intercept((call) => (call.table === "save_backups" ? fail(0) : undefined));

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "conflict", backup: "failed" });
    expect(fake.db.backups).toEqual([]);

    // Still refused, still not backed up while backups fail, and backed up once they work.
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "conflict", backup: "failed" });
    fake.intercept(undefined);
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "conflict", backup: "saved" });
    expect(fake.db.backups).toHaveLength(1);
    expect(fake.db.row?.data).toEqual(edited(currentSave(), 100));
  });

  it("reports a conflict when a backup request throws, rather than claiming it's backed up", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.saveElsewhere(edited(currentSave(), 100));
    fake.intercept((call) => {
      if (call.table === "save_backups") throw new Error("boom");
      return undefined;
    });

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "conflict", backup: "failed" });
  });

  it("treats a save deleted and recreated elsewhere as a conflict", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.db.row = null;
    fake.seed(USER_A, edited(currentSave(), 50));

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "conflict", backup: "saved" });
    expect(fake.db).toMatchObject({ row: { data: edited(currentSave(), 50) } });
  });

  it("treats a save deleted elsewhere as a conflict, and doesn't recreate it", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.db.row = null;

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "conflict", backup: "saved" });
    expect(fake.db.row).toBeNull();
  });

  it("two tabs creating the first save at once: the second never overwrites the first", async () => {
    const fake = createFakeSupabase();
    const auth = () => signedIn(USER_A);
    const tabOne = createCloudGameStorage({ client: fake.client, signIn: signedIn(USER_A), getAuth: auth });
    const tabTwo = createCloudGameStorage({ client: fake.client, signIn: signedIn(USER_A), getAuth: auth });
    expect((await tabOne.load(fallback)).status).toBe("empty");
    expect((await tabTwo.load(fallback)).status).toBe("empty");

    expect(await tabOne.save(edited(currentSave(), 1))).toEqual({ status: "saved" });
    expect(await tabTwo.save(edited(currentSave(), 2))).toEqual({ status: "conflict", backup: "saved" });

    expect(fake.db.row).toMatchObject({ data: edited(currentSave(), 1), revision: 1 });
    expect(fake.db.backups).toEqual([expect.objectContaining({ reason: "conflict", source_revision: null, raw_data: JSON.stringify(edited(currentSave(), 2)) })]);
    expect(await tabTwo.save(edited(currentSave(), 3))).toMatchObject({ status: "conflict" });
    expect(fake.requests().filter((call) => call.op === "update")).toEqual([]);
  });
});

describe("bound to one verified account", () => {
  it.each([
    ["a guest", { status: "signed-out" }],
    ["an unverified session", { status: "unverified", user: { email: "a@example.com" } }],
    ["an ended session", { status: "session-ended", user: { email: "a@example.com" } }],
    ["a session still loading", { status: "loading" }],
    ["sign-in that isn't set up", { status: "unavailable" }],
    ["a signed-in state without an ID", { status: "signed-in", user: { id: " ", email: "a@example.com" } }],
  ])("can't be created for %s", (_, state) => {
    const fake = createFakeSupabase();
    expect(() => createCloudGameStorage({
      client: fake.client,
      signIn: state as unknown as VerifiedSignIn,
      getAuth: () => state as AuthState,
    })).toThrow("Cloud storage needs a verified sign-in.");
  });

  it("belongs to the account it was created for", () => {
    expect(setup({ userId: USER_B }).storage.userId).toBe(USER_B);
  });

  it.each([
    ["another account signs in", signedIn(USER_B)],
    ["the player signs out", { status: "signed-out" }],
    ["the sign-in can't be confirmed any more", { status: "unverified", user: { email: "a@example.com" } }],
    ["the sign-in ends", { status: "session-ended", user: { email: "a@example.com" } }],
    ["a new session is being checked", { status: "loading" }],
  ] as const)("refuses to save, without any request, when %s, and stays closed", async (_, state) => {
    const { fake, storage, setAuth } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    const before = fake.requests().length;

    setAuth(state as AuthState);
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "identity-changed" });

    // Even if the original account comes back, this storage is never used again.
    setAuth(signedIn(USER_A));
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "identity-changed" });
    expect(await storage.load(fallback)).toEqual({ status: "failed", data: fallback, problem: "identity-changed" });
    expect(fake.requests()).toHaveLength(before);
    expect(fake.db.row?.data).toEqual(currentSave());
  });

  it.each([
    ["another account's session (another tab signed in)", USER_B],
    ["no session (another tab signed out)", null],
  ])("refuses to save when the browser holds %s, even before the auth state catches up", async (_, sessionUser) => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    const before = fake.requests().length;

    fake.setSessionUser(sessionUser);
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "identity-changed" });
    fake.setSessionUser(USER_A);
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "identity-changed" });
    expect(fake.requests()).toHaveLength(before);
  });

  it("refuses to save when the account changes while the session is being read", async () => {
    const { fake, storage, setAuth } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    const getSession = vi.mocked(fake.client.auth.getSession);
    const readSession = getSession.getMockImplementation()!;
    getSession.mockImplementationOnce(async () => {
      const result = await readSession();
      setAuth(signedIn(USER_B));
      return result;
    });

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "identity-changed" });
    expect(fake.requests().filter((call) => call.op === "update")).toEqual([]);
  });

  it("doesn't even read the session once the auth state belongs to someone else", async () => {
    const { fake, storage, setAuth } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    const reads = vi.mocked(fake.client.auth.getSession).mock.calls.length;

    setAuth(signedIn(USER_B));
    await storage.save(edited(currentSave(), 5));

    expect(fake.client.auth.getSession).toHaveBeenCalledTimes(reads);
  });

  it("refuses to load for an account that is no longer signed in", async () => {
    const { fake, storage, setAuth } = setup();
    fake.seed(USER_A, currentSave());
    setAuth(signedIn(USER_B));

    expect(await storage.load(fallback)).toEqual({ status: "failed", data: fallback, problem: "identity-changed" });
    expect(fake.requests()).toEqual([]);
  });

  it("refuses to load when the browser's session belongs to another account", async () => {
    const { fake, storage } = setup();
    fake.setSessionUser(USER_B);
    fake.seed(USER_B, currentSave());

    expect(await storage.load(fallback)).toEqual({ status: "failed", data: fallback, problem: "identity-changed" });
    expect(fake.requests()).toEqual([]);
  });

  it("checks the account before backing up after a conflict, so nothing is written for another account", async () => {
    const { fake, storage, setAuth } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.saveElsewhere(edited(currentSave(), 100));
    await storage.save(edited(currentSave(), 5));
    const backups = fake.db.backups.length;

    setAuth(signedIn(USER_B));
    expect(await storage.save(edited(currentSave(), 6))).toEqual({ status: "failed", problem: "identity-changed" });
    expect(fake.db.backups).toHaveLength(backups);
  });

  it("reports a session that can't be read without closing", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    vi.mocked(fake.client.auth.getSession).mockRejectedValueOnce(new Error("locked"));

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "unknown" });
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "saved" });
  });

  it("is still protected by the database if a request is somehow sent for another account", async () => {
    // The adapter's own checks stop this first; this shows the fake (like RLS) refuses it regardless.
    const fake = createFakeSupabase();
    fake.setSessionUser(USER_B);
    const reply = await (fake.client.from("quest_saves").insert({ user_id: USER_A, data: {}, schema_version: 5 }) as unknown as Promise<Reply>);
    expect(reply).toMatchObject({ status: 403, error: { code: "42501" } });
  });
});

describe("replies that arrive after the account changed (Codex Step 3 finding 1)", () => {
  const isRead = (call: Call) => call.table === "quest_saves" && call.op === "select";
  const isUpdate = (call: Call) => call.op === "update";

  /** The ways the account can change while a reply is on its way. */
  const changes: Array<[string, (env: ReturnType<typeof setup>) => void]> = [
    ["another account signs in", ({ setAuth }) => setAuth(signedIn(USER_B))],
    ["the player signs out", ({ setAuth }) => setAuth({ status: "signed-out" })],
    ["another tab switches the browser's session to another account", ({ fake }) => fake.setSessionUser(USER_B)],
    ["another tab signs the browser out", ({ fake }) => fake.setSessionUser(null)],
  ];

  it.each(changes)("a save read before %s is never returned, and the storage closes", async (_, change) => {
    const env = setup();
    env.fake.seed(USER_A, edited(currentSave(), 1));
    const held = env.fake.hold(isRead);

    const loading = env.storage.load(fallback);
    await Promise.resolve();
    change(env);
    held.release();

    expect(await loading).toEqual({ status: "failed", data: fallback, problem: "identity-changed" });
    const requests = env.fake.requests().length;
    expect(await env.storage.save(edited(currentSave(), 2))).toEqual({ status: "failed", problem: "identity-changed" });
    expect(env.fake.requests()).toHaveLength(requests);
    expect(env.fake.db.row?.data).toEqual(edited(currentSave(), 1));
  });

  it.each(changes)("an older save read before %s isn't backed up or upgraded", async (_, change) => {
    const env = setup();
    env.fake.seed(USER_A, legacySave, 1);
    const held = env.fake.hold(isRead);

    const loading = env.storage.load(fallback);
    await Promise.resolve();
    change(env);
    held.release();

    expect(await loading).toEqual({ status: "failed", data: fallback, problem: "identity-changed" });
    expect(env.fake.db.backups).toEqual([]);
    expect(env.fake.requests("save_backups")).toEqual([]);
  });

  it("an older save whose backup finishes after the account changed is never returned", async () => {
    const env = setup();
    env.fake.seed(USER_A, legacySave, 1);
    const held = env.fake.hold((call) => call.table === "save_backups");

    const loading = env.storage.load(fallback);
    await vi.waitFor(() => expect(env.fake.requests("save_backups")).toHaveLength(1));
    env.setAuth(signedIn(USER_B));
    held.release();

    expect(await loading).toEqual({ status: "failed", data: fallback, problem: "identity-changed" });
  });

  it("an empty account read before the account changed isn't reported as empty, so nothing gets created", async () => {
    const env = setup();
    const held = env.fake.hold(isRead);

    const loading = env.storage.load(fallback);
    await Promise.resolve();
    env.setAuth(signedIn(USER_B));
    held.release();

    expect(await loading).toEqual({ status: "failed", data: fallback, problem: "identity-changed" });
    expect(await env.storage.save(currentSave())).toEqual({ status: "failed", problem: "identity-changed" });
    expect(env.fake.requests().filter((call) => call.op === "insert")).toEqual([]);
  });

  it("a read whose session can't be confirmed afterwards isn't returned", async () => {
    const env = setup();
    env.fake.seed(USER_A, currentSave());
    const getSession = vi.mocked(env.fake.client.auth.getSession);
    const readSession = getSession.getMockImplementation()!;
    getSession
      .mockImplementationOnce(readSession)
      .mockImplementationOnce(async () => { throw new Error("locked"); });

    expect(await env.storage.load(fallback)).toEqual({ status: "failed", data: fallback, problem: "unknown" });
  });

  it.each(changes)("a save that succeeded just before %s is reported as saved, and the storage closes", async (_, change) => {
    const env = setup();
    env.fake.seed(USER_A, currentSave());
    await env.storage.load(fallback);
    const held = env.fake.hold(isUpdate);

    const saving = env.storage.save(edited(currentSave(), 1));
    await vi.waitFor(() => expect(env.fake.requests().filter(isUpdate)).toHaveLength(1));
    change(env);
    held.release();

    // It did reach the original account (RLS only allows that), so it really is saved there.
    expect(await saving).toEqual({ status: "saved" });
    expect(env.fake.db.row?.data).toEqual(edited(currentSave(), 1));
    const requests = env.fake.requests().length;
    expect(await env.storage.save(edited(currentSave(), 2))).toEqual({ status: "failed", problem: "identity-changed" });
    expect(env.fake.requests()).toHaveLength(requests);
  });

  it.each(changes)("a conflict discovered after %s makes no backup", async (_, change) => {
    const env = setup();
    env.fake.seed(USER_A, currentSave());
    await env.storage.load(fallback);
    env.fake.saveElsewhere(edited(currentSave(), 100));
    const held = env.fake.hold(isUpdate);

    const saving = env.storage.save(edited(currentSave(), 1));
    await vi.waitFor(() => expect(env.fake.requests().filter(isUpdate)).toHaveLength(1));
    change(env);
    held.release();

    expect(await saving).toEqual({ status: "failed", problem: "identity-changed" });
    expect(env.fake.requests("save_backups")).toEqual([]);
    expect(env.fake.db.row?.data).toEqual(edited(currentSave(), 100));
  });

  it("a first save refused as a duplicate after the player signed out makes no backup", async () => {
    const tabOne = setup();
    await tabOne.storage.load(fallback);
    tabOne.fake.seed(USER_A, edited(currentSave(), 100));
    const held = tabOne.fake.hold((call) => call.op === "insert");

    const saving = tabOne.storage.save(edited(currentSave(), 1));
    await vi.waitFor(() => expect(tabOne.fake.requests().filter((call) => call.op === "insert")).toHaveLength(1));
    tabOne.setAuth({ status: "signed-out" });
    held.release();

    expect(await saving).toEqual({ status: "failed", problem: "identity-changed" });
    expect(tabOne.fake.requests("save_backups")).toEqual([]);
  });

  it("a conflict backup that finishes after the account changed closes the storage", async () => {
    const env = setup();
    env.fake.seed(USER_A, currentSave());
    await env.storage.load(fallback);
    env.fake.saveElsewhere(edited(currentSave(), 100));
    const held = env.fake.hold((call) => call.table === "save_backups");

    const saving = env.storage.save(edited(currentSave(), 1));
    await vi.waitFor(() => expect(env.fake.requests("save_backups")).toHaveLength(1));
    env.setAuth(signedIn(USER_B));
    held.release();

    expect(await saving).toEqual({ status: "failed", problem: "identity-changed" });
    const requests = env.fake.requests().length;
    expect(await env.storage.save(edited(currentSave(), 2))).toEqual({ status: "failed", problem: "identity-changed" });
    expect(env.fake.requests()).toHaveLength(requests);
  });
});

describe("upgrade backups (Codex Step 3 finding 2)", () => {
  it("backs up an older save once per revision, however often it's loaded", async () => {
    const { fake } = setup();
    fake.seed(USER_A, legacySave, 1);
    const auth = () => signedIn(USER_A);

    for (let load = 0; load < 3; load += 1) {
      const tab = createCloudGameStorage({ client: fake.client, signIn: signedIn(USER_A), getAuth: auth });
      expect(await tab.load(fallback)).toMatchObject({ status: "ready", data: currentSave() });
    }

    expect(fake.db.backups).toEqual([expect.objectContaining({ reason: "upgrade", source_revision: 1, raw_data: JSON.stringify(legacySave) })]);
    expect(fake.requests("save_backups")).toHaveLength(3);
  });

  it("never uses the daily reason, so daily history is left alone", async () => {
    const { fake, storage } = setup();
    const daily = Array.from({ length: 14 }, (_, day) => ({
      user_id: USER_A, reason: "daily", raw_data: `day ${day}`, schema_version: 5, source_revision: day + 1,
    }));
    fake.db.backups.push(...daily);
    fake.seed(USER_A, legacySave, 1);

    await storage.load(fallback);
    await storage.load(fallback);

    expect(fake.db.backups.filter((backup) => backup.reason === "daily")).toEqual(daily);
    expect(fake.requests("save_backups").every((call) => call.payload?.reason === "upgrade")).toBe(true);
  });

  it("backs up a newer revision of an older save again", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, legacySave, 1);
    await storage.load(fallback);
    fake.saveElsewhere(legacySave as unknown as StoredQuestData);

    await storage.load(fallback);

    expect(fake.db.backups.map((backup) => backup.source_revision)).toEqual([1, 2]);
  });

  it("doesn't mistake another duplicate-key error for an existing upgrade backup", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, legacySave, 1);
    fake.intercept((call) => (call.table === "save_backups" ? fail(409, "23505", messages.unique("some_other_index")) : undefined));

    expect(await storage.load(fallback)).toEqual({ status: "failed", data: currentSave(), problem: "backup-failed" });
  });
});

describe("telling check failures apart (Codex Step 3 finding 3)", () => {
  /** A save just over the database's 10 MB limit. */
  function oversized(): StoredQuestData {
    return { ...currentSave(), questLists: { ...currentSave().questLists, personal: [{ ...currentSave().questLists.personal[0], notes: "x".repeat(SAVE_LIMIT_BYTES) }] } };
  }

  it("reports an oversized save as too large, and keeps saving possible", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);

    expect(await storage.save(oversized())).toEqual({ status: "failed", problem: "too-large" });
    expect(fake.db.row?.data).toEqual(currentSave());
    expect(await storage.save(edited(currentSave(), 1))).toEqual({ status: "saved" });
  });

  it("reports an oversized first save as too large, and can still create the save", async () => {
    const { fake, storage } = setup();
    await storage.load(fallback);

    expect(await storage.save(oversized())).toEqual({ status: "failed", problem: "too-large" });
    expect(fake.db.row).toBeNull();
    expect(await storage.save(currentSave())).toEqual({ status: "saved" });
  });

  it("reports a request the server refuses for its size (413) as too large", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.intercept((call) => (call.op === "update" ? fail(413, "", "Payload Too Large") : undefined));

    expect(await storage.save(edited(currentSave(), 1))).toEqual({ status: "failed", problem: "too-large" });
    fake.intercept(undefined);
    expect(await storage.save(edited(currentSave(), 1))).toEqual({ status: "saved" });
  });

  it.each([
    ["another check on quest_saves", messages.check("quest_saves", "quest_saves_schema_version_check")],
    ["a check with no message", "failed"],
  ])("reports %s as rejected, never as a newer version, and keeps saving possible", async (_, message) => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    fake.intercept((call) => (call.op === "update" ? fail(400, "23514", message) : undefined));

    expect(await storage.save(edited(currentSave(), 1))).toEqual({ status: "failed", problem: "rejected" });
    fake.intercept(undefined);
    expect(await storage.save(edited(currentSave(), 1))).toEqual({ status: "saved" });
  });

  it("only the format guard's message means a newer version, and that one stops saving", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave(), latestQuestSaveVersion);
    await storage.load(fallback);
    // Another device on a newer app moves the save to a newer format without changing its revision here.
    fake.intercept((call) => (call.op === "update" ? fail(400, "23514", messages.formatGuard(latestQuestSaveVersion + 1, latestQuestSaveVersion)) : undefined));

    expect(await storage.save(edited(currentSave(), 1))).toEqual({ status: "failed", problem: "newer-version" });
    fake.intercept(undefined);
    expect(await storage.save(edited(currentSave(), 2))).toEqual({ status: "failed", problem: "newer-version" });
  });
});

describe("describeCloudError", () => {
  it.each([
    [0, "", "network"],
    [401, "", "signed-out"],
    [400, "PGRST301", "signed-out"],
    // What the real database answers a request with no sign-in: the status decides.
    [401, "42501", "signed-out"],
    [403, "", "denied"],
    [400, "42501", "denied"],
    [429, "", "server"],
    [500, "", "server"],
    [503, "PGRST000", "server"],
    [409, "23503", "unknown"],
    [413, "", "too-large"],
    [400, "22P02", "unknown"],
  ] as const)("reads status %i, code %s as %s", (status, code, problem) => {
    expect(describeCloudError({ code }, status)).toBe(problem);
  });

  it.each([
    [messages.formatGuard(6, 5), "newer-version"],
    [messages.check("quest_saves", "quest_saves_data_check"), "too-large"],
    [messages.check("quest_saves", "quest_saves_schema_version_check"), "rejected"],
    [messages.check("save_backups", "save_backups_raw_data_check"), "rejected"],
    ["", "rejected"],
    // The guard's text somewhere other than the start isn't the guard.
    [`something else: ${messages.formatGuard(6, 5)}`, "rejected"],
  ])("reads 23514 with message %j as %s", (message, problem) => {
    expect(describeCloudError({ code: "23514", message }, 400)).toBe(problem);
  });
});

describe("a session that can't be refreshed is not an account change (Codex Stage 7 final review P1)", () => {
  /** What supabase-js returns when the access token expired and refreshing it failed offline. */
  const offline = () => ({ data: { session: null }, error: new AuthRetryableFetchError("Failed to fetch", 0) });

  it("an offline refresh failure on save is temporary: nothing is sent, and saving works again once back online", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    const getSession = vi.mocked(fake.client.auth.getSession);
    getSession.mockResolvedValueOnce(offline() as never).mockResolvedValueOnce(offline() as never);
    const writes = fake.requests("quest_saves").filter((call) => call.op !== "select").length;

    // Two edits made while offline: neither is sent, neither closes the storage.
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "network" });
    expect(await storage.save(edited(currentSave(), 6))).toEqual({ status: "failed", problem: "network" });
    expect(fake.requests("quest_saves").filter((call) => call.op !== "select")).toHaveLength(writes);

    // Back online (the refresh works): the newest edit is saved, as a normal conditional update.
    expect(await storage.save(edited(currentSave(), 6))).toEqual({ status: "saved" });
    expect(fake.db.row?.data).toEqual(edited(currentSave(), 6));
    expect(await storage.save(edited(currentSave(), 7))).toEqual({ status: "saved" });
  });

  it("an offline refresh failure on load is a network failure, and loading again works", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    vi.mocked(fake.client.auth.getSession).mockResolvedValueOnce(offline() as never);

    expect(await storage.load(fallback)).toMatchObject({ status: "failed", problem: "network" });
    expect(fake.requests("quest_saves")).toEqual([]);
    expect(await storage.load(fallback)).toMatchObject({ status: "ready", data: currentSave() });
  });

  it("a refresh the server refused isn't treated as a confirmed change either, until the session is really gone", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    vi.mocked(fake.client.auth.getSession).mockResolvedValueOnce(
      { data: { session: null }, error: new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found") } as never,
    );

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "signed-out" });
    // supabase-js then clears the session: no session and no error is a confirmed sign-out, which closes.
    fake.setSessionUser(null);
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "identity-changed" });
    fake.setSessionUser(USER_A);
    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "identity-changed" });
  });

  it("an error never lets a request go out for another account: a token for someone else still closes", async () => {
    const { fake, storage } = setup();
    fake.seed(USER_A, currentSave());
    await storage.load(fallback);
    vi.mocked(fake.client.auth.getSession).mockResolvedValueOnce(
      { data: { session: { access_token: tokenFor(USER_B) } }, error: new AuthRetryableFetchError("Failed to fetch", 0) } as never,
    );

    expect(await storage.save(edited(currentSave(), 5))).toEqual({ status: "failed", problem: "identity-changed" });
    expect(fake.db.row?.data).toEqual(currentSave());
  });
});
