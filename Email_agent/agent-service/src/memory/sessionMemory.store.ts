/**
 * src/memory/sessionMemory.store.ts
 *
 * Storage abstraction for session memory.
 *
 * ISessionMemoryStore is the interface.
 * InMemorySessionStore is the default (non-Redis) implementation.
 * RedisSessionStore (src/memory/redisSession.store.ts) is the production impl.
 *
 * Key schema: `${userId}:${sessionId}`
 * This keeps sessions user-scoped and maps cleanly to a Redis key prefix.
 */

import type { PlannedStep, PlanStepResult } from "../lib/planTypes.js";

// ── Record types ──────────────────────────────────────────────────────────────

/** A single message turn stored in session history. */
export interface StoredMessage {
  readonly role: "human" | "ai" | "system";
  readonly content: string;
  readonly timestamp: string; // ISO-8601
}

/** A summary of one MCP tool call appended after execution. */
export interface ToolCallRecord {
  readonly toolName: string;
  readonly timestamp: string; // ISO-8601
  readonly success: boolean;  // false if toolResult.isToolError or threw
}

/** Full session snapshot persisted per userId+sessionId pair. */
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly userId: string;

  /** Bounded conversation history — oldest entries are dropped at MAX_MESSAGES. */
  readonly messages: StoredMessage[];

  /** Total number of messages ever written to this session (monotonically increasing). */
  readonly messageCount: number;

  /** Intent detected in the most recent turn. */
  readonly lastIntent?: string;

  /** Agent domain that handled the most recent turn. */
  readonly lastAgentDomain?: string;

  /** Campaign the user is currently working with (persists across turns). */
  readonly activeCampaignId?: string;

  /** Recent tool calls — bounded at MAX_TOOL_CALLS. */
  readonly recentToolCalls: ToolCallRecord[];

  // ── Multi-step plan state (persisted so plan survives across API calls) ──

  /** Active multi-step plan, if any. Undefined between turns. */
  readonly plan?: PlannedStep[];
  /** Next step to execute within the active plan. */
  readonly planIndex?: number;
  /** Accumulated results from completed plan steps in the current session. */
  readonly planResults?: PlanStepResult[];

  readonly createdAt: string; // ISO-8601
  readonly updatedAt: string; // ISO-8601
}

// ── Store interface ───────────────────────────────────────────────────────────

/**
 * Minimal key-value interface for session storage.
 * Implementations must be safe for concurrent reads from the same process.
 *
 * Redis replacement notes:
 *   get  → GET key + JSON.parse
 *   set  → SETEX key TTL JSON.stringify
 *   delete → DEL key
 *   clear → FLUSHDB (test only)
 */
export interface ISessionMemoryStore {
  get(key: string): Promise<SessionSnapshot | undefined>;
  set(key: string, snapshot: SessionSnapshot): Promise<void>;
  delete(key: string): Promise<void>;
  /** Clears all entries. Intended for tests only. */
  clear(): Promise<void>;
}

// ── Key helper ────────────────────────────────────────────────────────────────

export function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

// ── In-memory implementation ──────────────────────────────────────────────────

export class InMemorySessionStore implements ISessionMemoryStore {
  private readonly store = new Map<string, SessionSnapshot>();

  async get(key: string): Promise<SessionSnapshot | undefined> {
    return this.store.get(key);
  }

  async set(key: string, snapshot: SessionSnapshot): Promise<void> {
    this.store.set(key, snapshot);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  /** Exposed for testing — returns current store size. */
  get size(): number {
    return this.store.size;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates the appropriate session store based on runtime configuration.
 *
 * If REDIS_URL is set and the Redis client connects successfully, returns a
 * RedisSessionStore. Otherwise falls back to InMemorySessionStore.
 *
 * Called once during startup in src/index.ts (or lazily in sessionMemory.service.ts).
 */
export async function createSessionStore(): Promise<ISessionMemoryStore> {
  const { getRedisClient } = await import("../lib/redisClient.js");
  const client = await getRedisClient();
  if (client) {
    const { RedisSessionStore } = await import("./redisSession.store.js");
    return new RedisSessionStore(client);
  }
  return new InMemorySessionStore();
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * Module-level singleton.
 * Starts as in-memory; replaced with Redis-backed store at startup when
 * REDIS_URL is present (see src/index.ts → initStores()).
 */
export let sessionMemoryStore: ISessionMemoryStore = new InMemorySessionStore();

/** Replaces the active store. Called once during startup by initStores(). */
export function setSessionMemoryStore(store: ISessionMemoryStore): void {
  sessionMemoryStore = store;
}
