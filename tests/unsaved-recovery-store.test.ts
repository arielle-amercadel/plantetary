import { describe, expect, it } from "vitest";
import type { StoredQuestData } from "../src/app/quest-types";
import {
  canonicalJson,
  createRecoveryStore,
  maxPersistedRecoveries,
  recoveryStorageKey,
  type PersistedRecovery,
} from "../src/app/unsaved-recovery-store";

const garden: StoredQuestData = {
  schemaVersion: 5,
  questLists: { daily: [], personal: [] },
  categoryLists: { daily: ["Mine"], personal: [] },
};

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const entry = (id: string, closedAt = 1, data: StoredQuestData = garden): PersistedRecovery =>
  ({ id, userId: "user-a", accountLabel: "mi•••@example.com", closedAt, data });

describe("the tab's kept unsaved changes", () => {
  it("reads back what was written", () => {
    const storage = memoryStorage();
    const store = createRecoveryStore(() => storage);
    store.write([entry("page-1")]);

    expect(store.read()).toEqual([entry("page-1")]);
  });

  it("removes the stored value when nothing is left", () => {
    const storage = memoryStorage();
    const store = createRecoveryStore(() => storage);
    store.write([entry("page-1")]);
    store.write([]);

    expect(storage.items.has(recoveryStorageKey)).toBe(false);
  });

  it(`keeps only the newest ${maxPersistedRecoveries}`, () => {
    const storage = memoryStorage();
    const store = createRecoveryStore(() => storage);
    store.write([entry("f", 6), entry("d", 4), entry("a", 1), entry("c", 3), entry("e", 5), entry("b", 2)]);

    expect(store.read().map((kept) => kept.id)).toEqual(["b", "c", "d", "e", "f"]);
  });

  it.each([
    ["text that isn't JSON", "{not json"],
    ["something other than a list", JSON.stringify({ id: "page-1" })],
  ])("reads %s as nothing, without changing it", (_, text) => {
    const storage = memoryStorage();
    storage.setItem(recoveryStorageKey, text);

    expect(createRecoveryStore(() => storage).read()).toEqual([]);
    expect(storage.getItem(recoveryStorageKey)).toBe(text);
  });

  it("skips entries that aren't complete, or whose garden isn't a valid save", () => {
    const storage = memoryStorage();
    const noUser: Partial<PersistedRecovery> = entry("no-user");
    delete noUser.userId;
    storage.setItem(recoveryStorageKey, JSON.stringify([
      entry("good"),
      noUser,
      { ...entry("bad-time"), closedAt: "yesterday" },
      { ...entry("bad-garden"), data: { questLists: "nope" } },
      { ...entry("bad-reason"), reason: "whatever" },
      { ...entry("account-change"), reason: "account-changed" },
      null,
    ]));

    expect(createRecoveryStore(() => storage).read().map((kept) => kept.id)).toEqual(["good", "account-change"]);
  });

  it("never throws when storage is missing, full or refuses access", () => {
    const refusing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    const missing = createRecoveryStore(() => null);
    const refused = createRecoveryStore(() => refusing);

    expect(missing.read()).toEqual([]);
    expect(() => missing.write([entry("page-1")])).not.toThrow();
    expect(refused.read()).toEqual([]);
    expect(() => refused.write([entry("page-1")])).not.toThrow();
    expect(() => refused.write([])).not.toThrow();
  });
});

describe("canonicalJson", () => {
  it("is the same for the same content in any key order, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } }))
      .toBe(canonicalJson({ a: { c: 3, d: [{ x: 2, y: 1 }] }, b: 1 }));
  });

  it("differs for different content, and keeps list order", () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
