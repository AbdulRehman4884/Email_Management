/**
 * src/services/redisPendingAction.store.ts
 *
 * Redis-backed implementation of IPendingActionStore.
 *
 * Storage:
 *   Key:   `pending_action:${id}`
 *   Value: JSON-serialised PendingAction
 *   TTL:   Derived from action.expiresAt — set once on create(), never refreshed.
 *          Redis automatically evicts the key when the action expires, which
 *          provides the same behaviour as the in-memory TTL check.
 *
 * Mutation contract (update()):
 *   Status transitions (pending → confirmed/executed/expired/cancelled) are
 *   written back to Redis while preserving the original TTL via EXPIRETIME.
 *   If EXPIRETIME returns -1 (no TTL, shouldn't happen), we fall back to
 *   SET without a TTL so the key is at least consistent.
 *
 * Failure contract:
 *   All Redis errors are caught and logged.
 *   create() / update() / delete() swallow errors — callers must not rely on
 *   these writes being durable during a Redis outage.
 *   findById() returns undefined on error (treated as "not found").
 */

import type { Redis } from "ioredis";
import { createLogger } from "../lib/logger.js";
import type { IPendingActionStore, PendingAction } from "./pendingAction.service.js";

const log = createLogger("redisPendingAction");

const KEY_PREFIX = "pending_action:";

function redisKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

export class RedisPendingActionStore implements IPendingActionStore {
  constructor(private readonly client: Redis) {}

  async create(action: PendingAction): Promise<void> {
    try {
      const raw = JSON.stringify(action);
      // Derive TTL in whole seconds from expiresAt, minimum 1 second.
      const ttlSecs = Math.max(
        1,
        Math.ceil((new Date(action.expiresAt).getTime() - Date.now()) / 1000),
      );
      await this.client.set(redisKey(action.id), raw, "EX", ttlSecs);
    } catch (err) {
      log.error({ err, id: action.id }, "RedisPendingActionStore.create failed");
    }
  }

  async findById(id: string): Promise<PendingAction | undefined> {
    try {
      const raw = await this.client.get(redisKey(id));
      if (raw === null) return undefined;
      return JSON.parse(raw) as PendingAction;
    } catch (err) {
      log.error({ err, id }, "RedisPendingActionStore.findById failed");
      return undefined;
    }
  }

  async update(action: PendingAction): Promise<void> {
    try {
      const raw = JSON.stringify(action);
      const key = redisKey(action.id);

      // Preserve the original expiry so status updates don't extend the TTL.
      const expireTime = await this.client.expiretime(key);
      if (expireTime > 0) {
        // SET key value EXAT unix-timestamp — available from Redis 6.2+
        await this.client.set(key, raw, "EXAT", expireTime);
      } else {
        // Key has no TTL (race/edge case) — write without one.
        await this.client.set(key, raw);
      }
    } catch (err) {
      log.error({ err, id: action.id }, "RedisPendingActionStore.update failed");
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.client.del(redisKey(id));
    } catch (err) {
      log.error({ err, id }, "RedisPendingActionStore.delete failed");
    }
  }
}
