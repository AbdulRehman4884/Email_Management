/**
 * src/services/auditLog.service.ts
 *
 * Structured audit logging for business and security events.
 *
 * Design:
 *   - IAuditStore interface — swappable for DB-backed storage in production
 *   - PinoAuditStore       — default Pino-backed implementation (stdout/file)
 *   - AuditLogService      — typed methods for each named event; fire-and-forget
 *   - auditLogService      — singleton for use across the codebase
 *
 * Audit events recorded:
 *   chat.received            — user message arrived at the API
 *   intent.detected          — rule-based intent classification result
 *   agent.selected           — domain agent chosen by manager node
 *   tool.attempt             — MCP tool call about to start
 *   tool.success             — MCP tool call completed without error
 *   tool.failure             — MCP tool call threw or returned isToolError=true
 *   approval.required        — risky intent flagged for user confirmation
 *   pending_action.created   — PendingAction persisted and awaiting confirm
 *   confirm.received         — POST /confirm arrived
 *   pending_action.executed  — confirmed action executed via MCP
 *   confirm.duplicate        — second confirm on already-confirmed action
 *   confirm.expired          — confirm arrived after TTL elapsed
 *   confirm.forbidden        — confirm attempted by wrong user
 *
 * Rules:
 *   - Methods must NEVER throw — errors are swallowed after logging to stderr
 *   - Sensitive fields (tokens, passwords) must never appear in payloads
 *   - All timestamps are ISO-8601 strings generated inside this module
 */

import { auditLogger } from "../lib/logger.js";

// ── Event type ────────────────────────────────────────────────────────────────

export type AuditEventName =
  | "chat.received"
  | "intent.detected"
  | "agent.selected"
  | "tool.attempt"
  | "tool.success"
  | "tool.failure"
  | "approval.required"
  | "pending_action.created"
  | "confirm.received"
  | "pending_action.executed"
  | "confirm.duplicate"
  | "confirm.expired"
  | "confirm.forbidden";

// ── Audit entry shape ─────────────────────────────────────────────────────────

export interface AuditEntry {
  event: AuditEventName;
  timestamp: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

// ── Caller context ────────────────────────────────────────────────────────────

export interface AuditContext {
  userId?: string;
  sessionId?: string;
  requestId?: string;
}

// ── Storage interface ─────────────────────────────────────────────────────────

export interface IAuditStore {
  /**
   * Persist a single audit entry.
   * Must be synchronous and non-throwing — swallow all errors internally.
   */
  write(entry: AuditEntry): void;
}

// ── Pino-backed implementation ────────────────────────────────────────────────

class PinoAuditStore implements IAuditStore {
  write(entry: AuditEntry): void {
    try {
      auditLogger.info(entry, entry.event);
    } catch {
      // Pino errors must never propagate to callers
      process.stderr.write(`[audit] failed to write entry: ${entry.event}\n`);
    }
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class AuditLogService {
  constructor(private readonly store: IAuditStore = new PinoAuditStore()) {}

  // ── HTTP layer events ──────────────────────────────────────────────────────

  /** User message arrived at POST /api/agent/chat. */
  chatReceived(ctx: AuditContext, data: { messageLength: number; sessionId: string }): void {
    this.emit("chat.received", ctx, data);
  }

  /** POST /api/agent/confirm arrived. */
  confirmReceived(ctx: AuditContext, data: { pendingActionId: string }): void {
    this.emit("confirm.received", ctx, data);
  }

  // ── Graph node events ──────────────────────────────────────────────────────

  /** Rule-based intent detection returned a result. */
  intentDetected(
    ctx: AuditContext,
    data: { intent: string; confidence: number; matchedPatterns: readonly string[] },
  ): void {
    this.emit("intent.detected", ctx, data);
  }

  /** Manager node selected a domain agent. */
  agentSelected(
    ctx: AuditContext,
    data: { intent: string; agentDomain: string; routedTo: string },
  ): void {
    this.emit("agent.selected", ctx, data);
  }

  /** MCP tool call is about to start. */
  toolAttempt(ctx: AuditContext, data: { toolName: string }): void {
    this.emit("tool.attempt", ctx, data);
  }

  /** MCP tool call completed without throwing (may still be isToolError). */
  toolSuccess(
    ctx: AuditContext,
    data: { toolName: string; durationMs: number; isToolError: boolean },
  ): void {
    this.emit("tool.success", ctx, data);
  }

  /** MCP tool call threw an exception or returned isToolError=true. */
  toolFailure(
    ctx: AuditContext,
    data: { toolName: string; durationMs: number; errorCode?: string; errorMessage?: string },
  ): void {
    this.emit("tool.failure", ctx, data);
  }

  // ── Approval events ────────────────────────────────────────────────────────

  /** Risky intent flagged — approval gate will block tool execution. */
  approvalRequired(
    ctx: AuditContext,
    data: { intent: string; toolName: string; reason: string },
  ): void {
    this.emit("approval.required", ctx, data);
  }

  /** PendingAction record persisted and returned to caller. */
  pendingActionCreated(
    ctx: AuditContext,
    data: { pendingActionId: string; intent: string; expiresAt: string },
  ): void {
    this.emit("pending_action.created", ctx, data);
  }

  /** Confirmed action executed via MCP. */
  pendingActionExecuted(
    ctx: AuditContext,
    data: { pendingActionId: string; intent: string; toolName: string; success: boolean },
  ): void {
    this.emit("pending_action.executed", ctx, data);
  }

  // ── Confirm failure events (security audit trail) ──────────────────────────

  /** Confirm attempted on an already-confirmed/executed/cancelled action. */
  confirmDuplicate(ctx: AuditContext, data: { pendingActionId: string; currentStatus: string }): void {
    this.emit("confirm.duplicate", ctx, data);
  }

  /** Confirm attempted after the TTL has elapsed. */
  confirmExpired(ctx: AuditContext, data: { pendingActionId: string }): void {
    this.emit("confirm.expired", ctx, data);
  }

  /** Confirm attempted by a user who does not own the pending action. */
  confirmForbidden(ctx: AuditContext, data: { pendingActionId: string; ownerUserId: string }): void {
    this.emit("confirm.forbidden", ctx, data);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private emit(
    event: AuditEventName,
    ctx: AuditContext,
    data?: Record<string, unknown>,
  ): void {
    try {
      const entry: AuditEntry = {
        event,
        timestamp: new Date().toISOString(),
        ...(ctx.userId    ? { userId: ctx.userId }       : {}),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        ...(data          ? { data }                     : {}),
      };
      this.store.write(entry);
    } catch {
      // Audit errors must never crash the caller
      process.stderr.write(`[audit] failed to emit event: ${event}\n`);
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const auditLogService = new AuditLogService();
