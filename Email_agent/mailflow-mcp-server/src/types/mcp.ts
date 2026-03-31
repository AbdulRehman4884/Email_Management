/**
 * src/types/mcp.ts
 *
 * MCP protocol and FastMCP integration types.
 *
 * These types represent the boundary between the MCP transport layer
 * (FastMCP session, SSE connection, stdio stream) and the application layer.
 *
 * Design note on FastMCP session auth:
 *  FastMCP v1 does not natively expose per-session HTTP headers to tool
 *  execute() handlers. The abstraction below defines the interface that
 *  authContext.service.ts fulfils. If FastMCP adds native header access,
 *  only authContext.service.ts needs updating — tool code is unaffected.
 */

import type { RawInboundAuth } from "./auth.js";

// ── Transport ─────────────────────────────────────────────────────────────────

export type McpTransportType = "sse" | "stdio";

export interface McpSseConfig {
  port: number;
  endpoint: string;
}

export interface McpTransportConfig {
  type: McpTransportType;
  sse?: McpSseConfig;
}

// ── Session ───────────────────────────────────────────────────────────────────

/**
 * Minimal session metadata available to tool handlers.
 *
 * FastMCP exposes a `context` argument in tool execute() functions.
 * McpSession is our typed wrapper around the parts we rely on.
 *
 * `sessionId` is a server-generated opaque identifier for log correlation.
 * It must never be used as an auth claim.
 */
export interface McpSession {
  /** Opaque identifier for log correlation only */
  sessionId: string;

  /**
   * Raw inbound auth headers extracted at session initiation.
   * Populated by the SSE handshake middleware or set to empty for stdio.
   * authContext.service.ts converts this into a validated AuthContext.
   */
  rawAuth: RawInboundAuth;
}

// ── FastMCP context shim ──────────────────────────────────────────────────────

/**
 * Typed shim over the `context` parameter FastMCP passes to execute().
 *
 * FastMCP's built-in context type is `Context` from the fastmcp package.
 * We shadow only the parts we use to avoid tight coupling to FastMCP internals.
 *
 * When FastMCP exposes richer session data, extend this interface and update
 * the extraction logic in mcp/context/requestContext.ts.
 */
export interface FastMcpExecuteContext {
  /**
   * Structured logger provided by FastMCP.
   * Prefer our own createLogger() in tool code for consistent formatting.
   */
  log?: {
    debug: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };

  /**
   * Progress reporter for long-running tools.
   * Not used in Phase 1; present for future use.
   */
  reportProgress?: (progress: { progress: number; total?: number }) => Promise<void>;

  /**
   * Session object as exposed by FastMCP.
   * The actual runtime type depends on FastMCP version.
   * We access this only via requestContext.ts to isolate coupling.
   */
  session?: unknown;
}

// ── Health ────────────────────────────────────────────────────────────────────

/** Shape returned by the /health endpoint (SSE transport only) */
export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  timestamp: string;
}
