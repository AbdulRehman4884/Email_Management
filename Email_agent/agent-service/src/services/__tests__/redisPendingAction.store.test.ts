/**
 * src/services/__tests__/redisPendingAction.store.test.ts
 *
 * Unit tests for RedisPendingActionStore.
 *
 * The ioredis client is fully mocked — no real Redis connection is made.
 *
 * Scenarios covered:
 *   1.  create() — serialises action, derives TTL from expiresAt, calls SET EX
 *   2.  create() — TTL clamps to minimum 1 s for already-near-expiry actions
 *   3.  create() — Redis throws → does not rethrow
 *   4.  findById() — key exists → returns parsed PendingAction
 *   5.  findById() — key missing → returns undefined
 *   6.  findById() — Redis throws → returns undefined
 *   7.  update() — EXPIRETIME > 0 → calls SET EXAT preserving TTL
 *   8.  update() — EXPIRETIME ≤ 0 → calls SET without TTL
 *   9.  update() — Redis throws → does not rethrow
 *  10.  delete() — calls DEL with prefixed key
 *  11.  delete() — Redis throws → does not rethrow
 *  12.  Key prefix — all operations use "pending_action:" prefix
 *  13.  planContext round-trip — full PlanResumptionContext is preserved
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock env before any module that transitively imports env.ts (via logger.ts).
vi.mock("../../config/env.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV:  "test",
  },
}));

import { RedisPendingActionStore } from "../redisPendingAction.store.js";
import type { PendingAction } from "../pendingAction.service.js";

// ── Mock Redis client ─────────────────────────────────────────────────────────

function makeRedis() {
  return {
    get:        vi.fn<[string], Promise<string | null>>(),
    set:        vi.fn<unknown[], Promise<"OK">>(),
    del:        vi.fn<unknown[], Promise<number>>(),
    expiretime: vi.fn<[string], Promise<number>>(),
  };
}

type MockRedis = ReturnType<typeof makeRedis>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id:         "action-uuid-1",
    userId:     "user-1" as PendingAction["userId"],
    sessionId:  "sess-1" as PendingAction["sessionId"],
    intent:     "pause_campaign",
    toolName:   "pause_campaign",
    toolArgs:   { campaignId: "c1" },
    status:     "pending",
    createdAt:  new Date().toISOString(),
    expiresAt:  futureIso(10 * 60 * 1000), // 10 minutes from now
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RedisPendingActionStore", () => {
  let redis: MockRedis;
  let store: RedisPendingActionStore;

  beforeEach(() => {
    redis = makeRedis();
    store = new RedisPendingActionStore(redis as never);
  });

  // ── create() ───────────────────────────────────────────────────────────────

  it("create() calls SET EX with the derived TTL", async () => {
    redis.set.mockResolvedValue("OK");
    const action = makeAction({ expiresAt: futureIso(5 * 60 * 1000) }); // 5 min

    await store.create(action);

    const [key, raw, ex, ttl] = redis.set.mock.calls[0] as [string, string, string, number];
    expect(key).toBe("pending_action:action-uuid-1");
    expect(JSON.parse(raw)).toEqual(action);
    expect(ex).toBe("EX");
    // TTL should be ~300 s — allow a 5-second window for test execution time
    expect(ttl).toBeGreaterThan(295);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("create() clamps TTL to 1 when expiresAt is in the past", async () => {
    redis.set.mockResolvedValue("OK");
    const action = makeAction({ expiresAt: new Date(Date.now() - 5000).toISOString() });

    await store.create(action);

    const [, , , ttl] = redis.set.mock.calls[0] as [string, string, string, number];
    expect(ttl).toBe(1);
  });

  it("create() does not rethrow when Redis throws", async () => {
    redis.set.mockRejectedValue(new Error("OOM"));

    await expect(store.create(makeAction())).resolves.toBeUndefined();
  });

  // ── findById() ─────────────────────────────────────────────────────────────

  it("findById() returns parsed action when key exists", async () => {
    const action = makeAction();
    redis.get.mockResolvedValue(JSON.stringify(action));

    const result = await store.findById("action-uuid-1");

    expect(redis.get).toHaveBeenCalledWith("pending_action:action-uuid-1");
    expect(result).toEqual(action);
  });

  it("findById() returns undefined when key is missing", async () => {
    redis.get.mockResolvedValue(null);

    expect(await store.findById("missing")).toBeUndefined();
  });

  it("findById() returns undefined when Redis throws", async () => {
    redis.get.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await store.findById("any")).toBeUndefined();
  });

  // ── update() ───────────────────────────────────────────────────────────────

  it("update() uses SET EXAT when EXPIRETIME returns a positive value", async () => {
    redis.set.mockResolvedValue("OK");
    const futureUnix = Math.floor(Date.now() / 1000) + 300;
    redis.expiretime.mockResolvedValue(futureUnix);

    const action = makeAction({ status: "confirmed" });
    await store.update(action);

    expect(redis.expiretime).toHaveBeenCalledWith("pending_action:action-uuid-1");
    const [key, raw, exat, ts] = redis.set.mock.calls[0] as [string, string, string, number];
    expect(key).toBe("pending_action:action-uuid-1");
    expect(JSON.parse(raw).status).toBe("confirmed");
    expect(exat).toBe("EXAT");
    expect(ts).toBe(futureUnix);
  });

  it("update() uses plain SET (no TTL) when EXPIRETIME returns -1", async () => {
    redis.set.mockResolvedValue("OK");
    redis.expiretime.mockResolvedValue(-1);

    const action = makeAction({ status: "executed" });
    await store.update(action);

    // SET called with only key + value (no EX/EXAT args)
    expect(redis.set).toHaveBeenCalledWith(
      "pending_action:action-uuid-1",
      JSON.stringify(action),
    );
  });

  it("update() does not rethrow when Redis throws", async () => {
    redis.expiretime.mockRejectedValue(new Error("READONLY"));

    await expect(store.update(makeAction())).resolves.toBeUndefined();
  });

  // ── delete() ───────────────────────────────────────────────────────────────

  it("delete() calls DEL with the prefixed key", async () => {
    redis.del.mockResolvedValue(1);

    await store.delete("action-uuid-1");

    expect(redis.del).toHaveBeenCalledWith("pending_action:action-uuid-1");
  });

  it("delete() does not rethrow when Redis throws", async () => {
    redis.del.mockRejectedValue(new Error("TIMEOUT"));

    await expect(store.delete("any")).resolves.toBeUndefined();
  });

  // ── Key prefix ─────────────────────────────────────────────────────────────

  it("always prefixes the action id with 'pending_action:'", async () => {
    redis.get.mockResolvedValue(null);
    await store.findById("custom-id");
    expect(redis.get).toHaveBeenCalledWith("pending_action:custom-id");
  });

  // ── planContext round-trip ──────────────────────────────────────────────────

  it("preserves planContext through JSON serialisation", async () => {
    const planContext = {
      plan: [
        {
          stepIndex:        0,
          toolName:         "get_campaign_stats" as const,
          toolArgs:         { campaignId: "c1" },
          intent:           "get_campaign_stats" as const,
          description:      "Get stats",
          requiresApproval: false,
        },
        {
          stepIndex:        1,
          toolName:         "pause_campaign" as const,
          toolArgs:         { campaignId: "c1" },
          intent:           "pause_campaign" as const,
          description:      "Pause campaign",
          requiresApproval: true,
        },
      ],
      pausedStepIndex:  1,
      completedResults: [],
      llmExtractedArgs: { campaignId: "c1" },
      activeCampaignId: "c1",
    };
    const action = makeAction({ planContext });
    redis.get.mockResolvedValue(JSON.stringify(action));

    const result = await store.findById(action.id);

    expect(result?.planContext).toEqual(planContext);
    expect(result?.planContext?.pausedStepIndex).toBe(1);
  });
});
