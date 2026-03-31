/**
 * src/memory/__tests__/redisSession.store.test.ts
 *
 * Unit tests for RedisSessionStore.
 *
 * The ioredis client is fully mocked — no real Redis connection is made.
 *
 * Scenarios covered:
 *   1. get() — key exists → returns parsed snapshot
 *   2. get() — key missing (null) → returns undefined
 *   3. get() — Redis throws → returns undefined (error swallowed)
 *   4. set() — serialises snapshot, calls SET EX with SESSION_TTL_SECS
 *   5. set() — Redis throws → does not rethrow
 *   6. delete() — calls DEL with the prefixed key
 *   7. delete() — Redis throws → does not rethrow
 *   8. clear() — single SCAN page with matches → DEL called
 *   9. clear() — empty SCAN → DEL not called
 *  10. Key prefix — all operations use "session:" prefix
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock env before any module that transitively imports env.ts (via logger.ts).
vi.mock("../../config/env.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV:  "test",
  },
}));

import { RedisSessionStore } from "../redisSession.store.js";
import { SESSION_TTL_SECS } from "../../config/constants.js";
import type { SessionSnapshot } from "../sessionMemory.store.js";

// ── Mock Redis client ─────────────────────────────────────────────────────────

function makeRedis() {
  return {
    get:        vi.fn<[string], Promise<string | null>>(),
    set:        vi.fn<unknown[], Promise<"OK">>(),
    del:        vi.fn<unknown[], Promise<number>>(),
    scan:       vi.fn<unknown[], Promise<[string, string[]]>>(),
  };
}

type MockRedis = ReturnType<typeof makeRedis>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId:      "sess-1",
    userId:         "user-1",
    messages:       [],
    messageCount:   0,
    recentToolCalls: [],
    createdAt:      "2026-01-01T00:00:00.000Z",
    updatedAt:      "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RedisSessionStore", () => {
  let redis: MockRedis;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = makeRedis();
    store = new RedisSessionStore(redis as never);
  });

  // ── get() ──────────────────────────────────────────────────────────────────

  it("get() returns parsed snapshot when key exists", async () => {
    const snap = makeSnapshot();
    redis.get.mockResolvedValue(JSON.stringify(snap));

    const result = await store.get("user-1:sess-1");

    expect(redis.get).toHaveBeenCalledWith("session:user-1:sess-1");
    expect(result).toEqual(snap);
  });

  it("get() returns undefined when key is missing", async () => {
    redis.get.mockResolvedValue(null);

    const result = await store.get("user-1:sess-1");

    expect(result).toBeUndefined();
  });

  it("get() returns undefined when Redis throws", async () => {
    redis.get.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await store.get("user-1:sess-1");

    expect(result).toBeUndefined();
  });

  // ── set() ──────────────────────────────────────────────────────────────────

  it("set() calls SET EX with the correct key, JSON payload, and TTL", async () => {
    redis.set.mockResolvedValue("OK");
    const snap = makeSnapshot();

    await store.set("user-1:sess-1", snap);

    expect(redis.set).toHaveBeenCalledWith(
      "session:user-1:sess-1",
      JSON.stringify(snap),
      "EX",
      SESSION_TTL_SECS,
    );
  });

  it("set() does not rethrow when Redis throws", async () => {
    redis.set.mockRejectedValue(new Error("OOM"));

    await expect(store.set("user-1:sess-1", makeSnapshot())).resolves.toBeUndefined();
  });

  // ── delete() ───────────────────────────────────────────────────────────────

  it("delete() calls DEL with the prefixed key", async () => {
    redis.del.mockResolvedValue(1);

    await store.delete("user-1:sess-1");

    expect(redis.del).toHaveBeenCalledWith("session:user-1:sess-1");
  });

  it("delete() does not rethrow when Redis throws", async () => {
    redis.del.mockRejectedValue(new Error("READONLY"));

    await expect(store.delete("user-1:sess-1")).resolves.toBeUndefined();
  });

  // ── clear() ────────────────────────────────────────────────────────────────

  it("clear() scans and deletes matching keys", async () => {
    // Single SCAN page: cursor returns "0" (done), two keys found.
    redis.scan.mockResolvedValue(["0", ["session:user-1:sess-1", "session:user-2:sess-2"]]);
    redis.del.mockResolvedValue(2);

    await store.clear();

    expect(redis.scan).toHaveBeenCalledWith("0", "MATCH", "session:*", "COUNT", 100);
    expect(redis.del).toHaveBeenCalledWith("session:user-1:sess-1", "session:user-2:sess-2");
  });

  it("clear() does not call DEL when no keys are found", async () => {
    redis.scan.mockResolvedValue(["0", []]);

    await store.clear();

    expect(redis.del).not.toHaveBeenCalled();
  });

  // ── Key prefix ─────────────────────────────────────────────────────────────

  it("always prefixes the store key with 'session:'", async () => {
    redis.get.mockResolvedValue(null);
    await store.get("abc:xyz");
    expect(redis.get).toHaveBeenCalledWith("session:abc:xyz");
  });

  // ── Snapshot fields preserved ──────────────────────────────────────────────

  it("round-trips plan/planIndex/planResults fields", async () => {
    const snap = makeSnapshot({
      plan:         [{ stepIndex: 0, toolName: "pause_campaign", toolArgs: {}, intent: "pause_campaign", description: "Pause", requiresApproval: false }],
      planIndex:    1,
      planResults:  [],
      messageCount: 3,
    });
    redis.get.mockResolvedValue(JSON.stringify(snap));

    const result = await store.get("user-1:sess-1");

    expect(result?.plan).toEqual(snap.plan);
    expect(result?.planIndex).toBe(1);
    expect(result?.planResults).toEqual([]);
    expect(result?.messageCount).toBe(3);
  });
});
