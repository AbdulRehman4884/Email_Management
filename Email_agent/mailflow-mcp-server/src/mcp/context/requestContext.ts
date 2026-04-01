/**
 * src/mcp/context/requestContext.ts
 *
 * Adapts FastMCP's opaque execute context into our typed McpSession,
 * and drives the full AuthContext resolution pipeline.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 *
 * FastMCP v1 does not expose per-session HTTP request headers inside the
 * execute() callback. The only stable surface is `context.session`, whose
 * runtime shape depends on the FastMCP version in use.
 *
 * This file isolates all coupling to FastMCP internals. If FastMCP adds
 * native header access in a future release, only this file needs updating —
 * all tool handlers and authContext.service remain untouched.
 *
 * ── Auth header propagation strategy ─────────────────────────────────────────
 *
 * For SSE transport, agent-service performs the SSE handshake with:
 *   Authorization: Bearer <service-secret>          (authenticates agent-service)
 *   X-Service-Token: <MCP_SERVICE_SECRET>           (same — primary field)
 *   X-Forwarded-Authorization: Bearer <user-jwt>    (end-user token to forward)
 *
 * Because FastMCP processes the HTTP upgrade internally, these headers are
 * captured by the `SessionHeaderStore` (below) via an Express middleware that
 * must be registered in Phase 7 (mcp/bootstrap/createServer.ts) BEFORE
 * FastMCP's own SSE routes are mounted.
 *
 * The store is keyed by session ID. `extractRawAuth` looks up the session ID
 * from the FastMCP context and retrieves the stored headers.
 *
 * For stdio transport there is no HTTP context; callers pass an empty
 * RawInboundAuth and auth falls back to MAILFLOW_SERVICE_ACCOUNT_TOKEN.
 *
 * ── Session ID ────────────────────────────────────────────────────────────────
 *
 * FastMCP exposes `context.session` at runtime. We access `session.id` if
 * present and fall back to a generated UUID. The ID is used only for log
 * correlation, never for authorization.
 */

import { randomUUID } from "node:crypto";
import { authContextService } from "../../services/authContext.service.js";
import { createLogger } from "../../lib/logger.js";
import type { AuthContext, RawInboundAuth } from "../../types/auth.js";
import type { FastMcpExecuteContext, McpSession } from "../../types/mcp.js";

const log = createLogger("requestContext");

// ── Session header store ──────────────────────────────────────────────────────

/**
 * In-memory store mapping FastMCP session IDs to the HTTP headers captured
 * at SSE handshake time.
 *
 * Lifecycle:
 *  - Populated by Express middleware in Phase 7 (createServer.ts)
 *  - Read by `extractRawAuth` when a tool is invoked
 *  - Entries are removed when the SSE connection closes (via `deleteSession`)
 *
 * This is intentionally a simple Map — no TTL or eviction needed since
 * entries are removed on disconnect. If the process restarts, all sessions
 * are gone and agents must reconnect (stateless by design).
 */
export class SessionHeaderStore {
  private readonly store = new Map<string, RawInboundAuth>();

  /** Called by SSE middleware when a new session is established. */
  set(sessionId: string, auth: RawInboundAuth): void {
    this.store.set(sessionId, auth);
    log.debug({ sessionId }, "Session auth headers stored");
  }

  /** Called by `extractRawAuth` during tool invocation. */
  get(sessionId: string): RawInboundAuth | undefined {
    return this.store.get(sessionId);
  }

  /** Called when the SSE connection closes to prevent memory leaks. */
  delete(sessionId: string): void {
    this.store.delete(sessionId);
    log.debug({ sessionId }, "Session auth headers removed");
  }

  /** Exposed for testing and diagnostics only. */
  get size(): number {
    return this.store.size;
  }
}

/** Module-level singleton — shared across all SSE session lifetimes. */
export const sessionHeaderStore = new SessionHeaderStore();

// ── FastMCP context extraction ────────────────────────────────────────────────

/**
 * Extracts a stable session ID from FastMCP's execute context.
 *
 * FastMCP's `context.session` is typed as `unknown` in our shim (mcp.ts) to
 * avoid tight coupling. We access `.id` defensively.
 */
function extractSessionId(rawContext: FastMcpExecuteContext): string {
  const session = rawContext.session;

  if (
    session !== null &&
    session !== undefined &&
    typeof session === "object" &&
    "id" in session &&
    typeof (session as Record<string, unknown>).id === "string"
  ) {
    return (session as { id: string }).id;
  }

  // FastMCP did not provide a session ID — generate one for this invocation
  const generated = randomUUID();
  log.debug(
    { sessionId: generated },
    "FastMCP session ID unavailable — generated fallback",
  );
  return generated;
}

/**
 * Retrieves stored RawInboundAuth for the given session ID.
 * Falls back to empty auth (triggers service-account mode if configured).
 */
function extractRawAuth(sessionId: string): RawInboundAuth {
  const stored = sessionHeaderStore.get(sessionId);

  if (!stored) {
    // Stdio transport or unknown session — no HTTP headers available
    log.debug(
      { sessionId },
      "No stored auth headers for session — using empty RawInboundAuth",
    );
    return {};
  }

  return stored;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds an McpSession from the FastMCP execute context.
 * Used by toolExecution.service.ts before any tool handler runs.
 */
export function buildMcpSession(
  rawContext: FastMcpExecuteContext,
): McpSession {
  const sessionId = extractSessionId(rawContext);
  const rawAuth = extractRawAuth(sessionId);
  return { sessionId, rawAuth };
}

/**
 * Resolves a fully validated AuthContext from the FastMCP execute context.
 *
 * This is the single entry point for auth resolution in tool execution.
 * It composes:
 *   buildMcpSession()  →  extracts session ID + raw headers
 *   authContextService.resolve()  →  validates and returns typed AuthContext
 *
 * Throws AuthError if the service token is invalid or no bearer token is available.
 */
export function resolveAuthContext(
  rawContext: FastMcpExecuteContext,
): { auth: AuthContext; session: McpSession } {
  const session = buildMcpSession(rawContext);
  const auth = authContextService.resolve(session.rawAuth);
  return { auth, session };
}
