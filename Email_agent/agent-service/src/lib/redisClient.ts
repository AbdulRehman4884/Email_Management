/**
 * src/lib/redisClient.ts
 *
 * Lazy Redis client singleton backed by ioredis.
 *
 * Design decisions:
 *   - The client is only instantiated when REDIS_URL is set and on first call.
 *   - Connection errors are logged but never thrown — callers must handle
 *     `undefined` gracefully and fall back to the in-memory store.
 *   - `disconnectRedis()` is called during graceful shutdown in src/index.ts.
 */

import { Redis, type Redis as RedisClient } from "ioredis";
import { createLogger } from "./logger.js";
import { env } from "../config/env.js";

const log = createLogger("redisClient");

// ── Lazy singleton ────────────────────────────────────────────────────────────

let _client: RedisClient | undefined;
let _connecting = false;

/**
 * Returns a connected Redis client, or `undefined` if REDIS_URL is not set
 * or the connection fails. Callers must treat `undefined` as a signal to use
 * the in-memory fallback.
 */
export async function getRedisClient(): Promise<RedisClient | undefined> {
  if (!env.REDIS_URL) return undefined;
  if (_client) return _client;
  if (_connecting) return undefined;

  _connecting = true;
  try {
    const client = new Redis(env.REDIS_URL, {
      // Fail fast on initial connect rather than retrying indefinitely.
      maxRetriesPerRequest: 3,
      // Do not block startup if Redis is unreachable.
      lazyConnect: true,
      enableReadyCheck: true,
    });

    await client.connect();

    client.on("error", (err: Error) => {
      log.error({ err }, "Redis client error");
    });

    client.on("reconnecting", () => {
      log.warn("Redis client reconnecting");
    });

    _client = client;
    log.info({ url: env.REDIS_URL.replace(/\/\/.*@/, "//***@") }, "Redis client connected");
    return _client;
  } catch (err) {
    log.error({ err }, "Failed to connect to Redis — using in-memory fallback");
    _client = undefined;
    return undefined;
  } finally {
    _connecting = false;
  }
}

/**
 * Gracefully closes the Redis connection.
 * Called during graceful shutdown in src/index.ts.
 * Safe to call even if no client was created.
 */
export async function disconnectRedis(): Promise<void> {
  if (!_client) return;
  try {
    await _client.quit();
    log.info("Redis client disconnected");
  } catch (err) {
    log.warn({ err }, "Redis disconnect error (ignored)");
  } finally {
    _client = undefined;
  }
}

/** Resets the singleton — for tests only. */
export function _resetRedisClient(): void {
  _client = undefined;
  _connecting = false;
}
