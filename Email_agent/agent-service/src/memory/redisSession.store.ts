/**
 * src/memory/redisSession.store.ts
 *
 * Redis-backed implementation of ISessionMemoryStore.
 *
 * Storage:
 *   Key:   `session:${userId}:${sessionId}`
 *   Value: JSON-serialised SessionSnapshot
 *   TTL:   SESSION_TTL_SECS (24 hours), refreshed on every write
 *
 * Failure contract:
 *   All Redis errors are caught and logged. get() returns undefined on error
 *   (treated as cache miss). set()/delete()/clear() swallow errors silently so
 *   Redis outages never abort the agent workflow.
 */

import type { Redis } from "ioredis";
import { createLogger } from "../lib/logger.js";
import { SESSION_TTL_SECS } from "../config/constants.js";
import type { ISessionMemoryStore, SessionSnapshot } from "./sessionMemory.store.js";

const log = createLogger("redisSession");

const KEY_PREFIX = "session:";

function redisKey(storeKey: string): string {
  return `${KEY_PREFIX}${storeKey}`;
}

export class RedisSessionStore implements ISessionMemoryStore {
  constructor(private readonly client: Redis) {}

  async get(key: string): Promise<SessionSnapshot | undefined> {
    try {
      const raw = await this.client.get(redisKey(key));
      if (raw === null) return undefined;
      return JSON.parse(raw) as SessionSnapshot;
    } catch (err) {
      log.error({ err, key }, "RedisSessionStore.get failed");
      return undefined;
    }
  }

  async set(key: string, snapshot: SessionSnapshot): Promise<void> {
    try {
      const raw = JSON.stringify(snapshot);
      await this.client.set(redisKey(key), raw, "EX", SESSION_TTL_SECS);
    } catch (err) {
      log.error({ err, key }, "RedisSessionStore.set failed");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(redisKey(key));
    } catch (err) {
      log.error({ err, key }, "RedisSessionStore.delete failed");
    }
  }

  /**
   * Clears all session keys from this Redis instance.
   * Uses SCAN to avoid blocking the server — intended for tests only.
   */
  async clear(): Promise<void> {
    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          "MATCH",
          `${KEY_PREFIX}*`,
          "COUNT",
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.client.del(...keys);
        }
      } while (cursor !== "0");
    } catch (err) {
      log.error({ err }, "RedisSessionStore.clear failed");
    }
  }
}
