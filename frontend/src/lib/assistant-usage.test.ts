import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("./firebase-admin", () => ({ getAdminDb: mock.db }));
import { finishAssistantUsage, reserveAssistantUsage } from "./assistant-usage";
const config = { apiKey: "synthetic", model: "gemini-synthetic", perMinute: 2, perDay: 3, globalPerDay: 4, maxOutputTokens: 1024, maxContextBytes: 20000, timeoutMs: 15000 };
let store: Map<string, Record<string, unknown>>;
let lock: Promise<unknown>;
beforeEach(() => {
  store = new Map();
  lock = Promise.resolve();
  const db = {
    collection: (collection: string) => ({ doc: (id: string) => ({ path: `${collection}/${id}`, update: async (data: Record<string, unknown>) => { store.set(`${collection}/${id}`, { ...store.get(`${collection}/${id}`), ...data }); } }) }),
    runTransaction: (action: (transaction: object) => Promise<void>) => {
      const task = lock.then(async () => {
        const writes = new Map<string, Record<string, unknown>>();
        await action({
          getAll: async (...refs: { path: string }[]) => refs.map(ref => ({ exists: store.has(ref.path), data: () => store.get(ref.path) })),
          set: (ref: { path: string }, data: Record<string, unknown>) => writes.set(ref.path, data),
          create: (ref: { path: string }, data: Record<string, unknown>) => { if (store.has(ref.path)) throw new Error("already exists"); writes.set(ref.path, data); },
        });
        writes.forEach((data, path) => store.set(path, data));
      });
      lock = task.catch(() => undefined);
      return task;
    },
  };
  mock.db.mockReturnValue(db);
});

describe("persistent assistant reservations", () => {
  const now = Date.parse("2026-11-17T10:00:00Z");
  it("serializes competing requests and survives module-independent store reads", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => reserveAssistantUsage("uid", `request_${i}`, config, now)));
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(2);
    for (const item of results) if (item.status === "rejected") expect(item.reason).toMatchObject({ status: 429, code: "rate_limit" });
    expect([...store.values()].filter(item => item.status === "reserved")).toHaveLength(2);
  });
  it("deduplicates the same request concurrently and isolates request IDs by UID", async () => {
    const results = await Promise.allSettled([reserveAssistantUsage("a", "same_request", config, now), reserveAssistantUsage("a", "same_request", config, now)]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.find(item => item.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    await expect(reserveAssistantUsage("b", "same_request", config, now)).resolves.toBeDefined();
  });
  it("resets minute/day windows and enforces the global budget across users", async () => {
    await reserveAssistantUsage("a", "request_1", config, now);
    await reserveAssistantUsage("a", "request_2", config, now);
    await reserveAssistantUsage("a", "request_3", config, now + 60000);
    await expect(reserveAssistantUsage("a", "request_4", config, now + 120000)).rejects.toMatchObject({ code: "daily_quota" });
    await reserveAssistantUsage("b", "request_1", config, now + 120000);
    await expect(reserveAssistantUsage("c", "request_1", config, now + 120000)).rejects.toMatchObject({ code: "daily_quota" });
    await expect(reserveAssistantUsage("a", "request_5", config, now + 86400000)).resolves.toBeDefined();
  });
  it("records only metadata and retains charged failures", async () => {
    const ref = await reserveAssistantUsage("uid", "request_1", config, now);
    await finishAssistantUsage(ref, "error", 0, "provider_timeout", Date.now());
    const log = store.get(ref.path)!;
    expect(Object.keys(log).sort()).toEqual(["code", "created_at", "duration_ms", "evidence_count", "expires_at", "model", "status"].sort());
    expect(log.status).toBe("error");
    await expect(reserveAssistantUsage("uid", "request_1", config, now)).rejects.toMatchObject({ code: "duplicate_request" });
  });
});
