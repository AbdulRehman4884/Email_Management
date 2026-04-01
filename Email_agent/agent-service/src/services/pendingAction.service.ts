/**
 * src/services/pendingAction.service.ts
 *
 * Manages the lifecycle of pending actions awaiting user confirmation.
 *
 * Lifecycle:
 *   created  → pending → confirmed → executed
 *                      ↘ cancelled
 *                      ↘ expired   (TTL elapsed; checked lazily on read)
 *
 * Duplicate-execution prevention:
 *   confirm() atomically transitions status pending → confirmed before the
 *   tool runs. If the same pendingActionId is submitted twice concurrently,
 *   the second call will find status=confirmed and throw ConflictError.
 *
 * Storage:
 *   IPendingActionStore is the interface; InMemoryPendingActionStore is the
 *   Phase 6 implementation. Swap to a Redis/DB-backed store for production.
 *
 *   Redis replacement notes:
 *     create  → SETEX key TTL_SECS JSON.stringify(action)
 *     findById → GET key + JSON.parse (expired keys return null automatically)
 *     update  → SET key JSON.stringify (preserve original EXPIRETIME)
 *     delete  → DEL key
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  ErrorCode,
} from "../lib/errors.js";
import { DEFAULT_APPROVAL_TTL_MS } from "../config/constants.js";
import { auditLogService } from "./auditLog.service.js";
import type { Intent } from "../config/intents.js";
import type { UserId, SessionId } from "../types/common.js";
import type { PlanResumptionContext } from "../lib/planTypes.js";

const log = createLogger("pendingAction");

// ── Types ─────────────────────────────────────────────────────────────────────

export type PendingActionStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "expired"
  | "executed";

export interface PendingAction {
  readonly id: string;
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly intent: Intent;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  /**
   * Present when this pending action is a pause-point inside a multi-step plan.
   * PlanExecutionService.resumePlan() uses this to complete the remaining steps
   * after the user confirms the risky step.
   */
  readonly planContext?: PlanResumptionContext;
  status: PendingActionStatus;
  readonly createdAt: string;  // ISO-8601
  readonly expiresAt: string;  // ISO-8601
  executedAt?: string;         // ISO-8601
}

export interface CreatePendingActionParams {
  userId: UserId;
  sessionId: SessionId;
  intent: Intent;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** When set, the pending action is a pause-point inside a multi-step plan. */
  planContext?: PlanResumptionContext;
  /** Override default TTL in ms (mainly for tests). */
  ttlMs?: number;
}

// ── Storage interface ─────────────────────────────────────────────────────────

export interface IPendingActionStore {
  create(action: PendingAction): Promise<void>;
  findById(id: string): Promise<PendingAction | undefined>;
  /** Persist status/executedAt mutations. */
  update(action: PendingAction): Promise<void>;
  delete(id: string): Promise<void>;
}

// ── In-memory implementation ──────────────────────────────────────────────────

class InMemoryPendingActionStore implements IPendingActionStore {
  private readonly store = new Map<string, PendingAction>();

  async create(action: PendingAction): Promise<void> {
    this.store.set(action.id, action);
  }

  async findById(id: string): Promise<PendingAction | undefined> {
    return this.store.get(id);
  }

  async update(action: PendingAction): Promise<void> {
    this.store.set(action.id, action);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  /** Exposed for tests. */
  get size(): number {
    return this.store.size;
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class PendingActionService {
  constructor(
    private readonly store: IPendingActionStore = new InMemoryPendingActionStore(),
  ) {}

  // ── Create ──────────────────────────────────────────────────────────────────

  /**
   * Creates and persists a new pending action.
   * Returns the full action object including the generated id and expiry time.
   */
  async create(params: CreatePendingActionParams): Promise<PendingAction> {
    const ttlMs = params.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const action: PendingAction = {
      id:         randomUUID(),
      userId:     params.userId,
      sessionId:  params.sessionId,
      intent:     params.intent,
      toolName:   params.toolName,
      toolArgs:   params.toolArgs,
      ...(params.planContext ? { planContext: params.planContext } : {}),
      status:     "pending",
      createdAt:  now.toISOString(),
      expiresAt:  expiresAt.toISOString(),
    };

    await this.store.create(action);

    log.info(
      { id: action.id, intent: action.intent, userId: action.userId, expiresAt: action.expiresAt },
      "Pending action created",
    );

    return action;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Returns the action, or undefined if not found.
   * Does NOT throw on expiry — callers that need validation should use validate().
   */
  async findById(id: string): Promise<PendingAction | undefined> {
    return this.store.findById(id);
  }

  // ── Validate ────────────────────────────────────────────────────────────────

  /**
   * Looks up the pending action and asserts it is:
   *   - present
   *   - owned by the calling userId
   *   - in "pending" status (not already confirmed/cancelled/executed)
   *   - within its TTL
   *
   * Returns the valid action or throws a typed AppError.
   */
  async validate(id: string, userId: UserId): Promise<PendingAction> {
    const action = await this.store.findById(id);

    if (!action) {
      throw new AppError(404, ErrorCode.APPROVAL_NOT_FOUND, "Pending action not found");
    }

    if (action.userId !== userId) {
      log.warn({ id, requestingUserId: userId, ownerUserId: action.userId }, "Forbidden pending action access");
      auditLogService.confirmForbidden(
        { userId: userId as string },
        { pendingActionId: id, ownerUserId: action.userId as string },
      );
      throw new ForbiddenError("You do not have permission to act on this pending action");
    }

    if (this.isExpired(action)) {
      action.status = "expired";
      await this.store.update(action);
      auditLogService.confirmExpired(
        { userId: userId as string, sessionId: action.sessionId as string },
        { pendingActionId: id },
      );
      throw new AppError(410, ErrorCode.APPROVAL_EXPIRED, "Pending action has expired — please start over");
    }

    if (action.status !== "pending") {
      auditLogService.confirmDuplicate(
        { userId: userId as string, sessionId: action.sessionId as string },
        { pendingActionId: id, currentStatus: action.status },
      );
      throw new ConflictError(
        `Pending action is already ${action.status} and cannot be acted on again`,
      );
    }

    return action;
  }

  // ── Status transitions ───────────────────────────────────────────────────────

  /**
   * Atomically transitions status from "pending" → "confirmed".
   * Must be called BEFORE executing the tool to prevent double-execution.
   * The caller is responsible for calling markExecuted() after the tool runs.
   *
   * Throws ConflictError if the action is not in "pending" status.
   */
  async confirm(id: string, userId: UserId): Promise<PendingAction> {
    const action = await this.validate(id, userId);

    action.status = "confirmed";
    await this.store.update(action);

    log.info({ id, intent: action.intent, userId }, "Pending action confirmed");
    return action;
  }

  /**
   * Marks the action as executed after the tool call succeeds.
   * Records executedAt timestamp.
   */
  async markExecuted(id: string): Promise<void> {
    const action = await this.store.findById(id);
    if (!action) return;

    action.status    = "executed";
    action.executedAt = new Date().toISOString();
    await this.store.update(action);

    log.info({ id }, "Pending action marked as executed");
  }

  /**
   * Cancels the pending action. Only valid in "pending" status.
   * Throws ConflictError if already confirmed/executed/cancelled.
   */
  async cancel(id: string, userId: UserId): Promise<PendingAction> {
    const action = await this.validate(id, userId);

    action.status = "cancelled";
    await this.store.update(action);

    log.info({ id, intent: action.intent, userId }, "Pending action cancelled");
    return action;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private isExpired(action: PendingAction): boolean {
    return new Date(action.expiresAt) < new Date();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates the appropriate pending-action store based on runtime configuration.
 *
 * If REDIS_URL is set and the Redis client connects successfully, returns a
 * RedisPendingActionStore. Otherwise falls back to InMemoryPendingActionStore.
 *
 * Called once during startup by initStores() in src/index.ts.
 */
export async function createPendingActionStore(): Promise<IPendingActionStore> {
  const { getRedisClient } = await import("../lib/redisClient.js");
  const client = await getRedisClient();
  if (client) {
    const { RedisPendingActionStore } = await import("./redisPendingAction.store.js");
    return new RedisPendingActionStore(client);
  }
  return new InMemoryPendingActionStore();
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export let pendingActionService = new PendingActionService();

/** Replaces the active service (with its store). Called once during startup by initStores(). */
export function setPendingActionService(service: PendingActionService): void {
  pendingActionService = service;
}
