/**
 * src/integration/mcp-connection.note.ts
 *
 * MCP Integration Reference — Phase 5
 * =====================================
 *
 * This file documents the SSE connection protocol between agent-service
 * and mailflow-mcp-server and exports a connectivity health-check utility.
 *
 * ── Connection protocol ────────────────────────────────────────────────────
 *
 *   Transport:  Server-Sent Events (SSE)
 *   Endpoint:   MCP_SERVER_URL (env)   →   http://localhost:4000/sse
 *   SDK:        @modelcontextprotocol/sdk  (pinned to 1.21.0 via overrides)
 *
 *   A new Client + SSEClientTransport is created per tool call.
 *   Shared session state is avoided — each call is fully independent.
 *
 * ── Authentication headers ─────────────────────────────────────────────────
 *
 *   X-Service-Token           MCP_SERVICE_SECRET (shared secret, ≥ 32 chars)
 *                             Validated by mailflow-mcp-server using
 *                             crypto.timingSafeEqual — no timing oracle.
 *
 *   X-Forwarded-Authorization "Bearer <user JWT>"
 *                             Forwarded as-is to mailflow-mcp-server, which
 *                             attaches it to every MailFlow backend API call.
 *                             The JWT is NOT verified by the MCP server —
 *                             MailFlow backend is the authoritative validator.
 *
 * ── SDK version note ───────────────────────────────────────────────────────
 *
 *   SDK versions ≥ 1.22.0 introduced assertRequestHandlerCapability() which
 *   throws when FastMCP registers completion/complete without advertising the
 *   completions capability. Pin to 1.21.0 in mailflow-mcp-server/package.json
 *   via npm "overrides" until FastMCP publishes a fix.
 *
 * ── Call stack ─────────────────────────────────────────────────────────────
 *
 *   executeToolNode
 *     → ToolExecutionService.executeFromState()
 *       → McpClientService.dispatch()
 *         → McpToolCallerService.call()       (timeout, error mapping)
 *           → openMcpSession()                (SSE transport factory)
 *             → mailflow-mcp-server /sse
 *               → MailFlow backend APIs
 *
 * ── Troubleshooting ────────────────────────────────────────────────────────
 *
 *   HTTP 500 from /sse
 *     Likely cause: @modelcontextprotocol/sdk version mismatch.
 *     Fix: ensure mailflow-mcp-server pins SDK to 1.21.0 via overrides.
 *
 *   "Missing service token" / 401
 *     MCP_SERVICE_SECRET in agent-service .env does not match
 *     MCP_SERVICE_SECRET in mailflow-mcp-server .env.
 *
 *   ECONNREFUSED
 *     mailflow-mcp-server is not running, or MCP_SERVER_URL points to the
 *     wrong host/port. Default: http://localhost:4000/sse.
 *
 *   Tool call timeout
 *     DEFAULT_MCP_TOOL_TIMEOUT_MS (30 s) exceeded. The MailFlow backend may
 *     be slow or unreachable. Check MAILFLOW_API_BASE_URL in mcp-server env.
 */

import { openMcpSession } from "../lib/mcpClient.js";
import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { SERVICE_NAME, SERVICE_VERSION } from "../config/constants.js";

const log = createLogger("mcp-connection");

// ── Connection config snapshot ────────────────────────────────────────────────

/**
 * Read-only snapshot of the MCP connection parameters sourced from env.
 * Useful for logging and health-check responses.
 */
export interface McpConnectionConfig {
  readonly serverUrl: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly timeoutMs: number;
}

export function getMcpConnectionConfig(): McpConnectionConfig {
  return {
    serverUrl:     env.MCP_SERVER_URL,
    clientName:    SERVICE_NAME,
    clientVersion: SERVICE_VERSION,
    timeoutMs:     30_000,
  };
}

// ── Connectivity check ────────────────────────────────────────────────────────

export interface McpConnectivityResult {
  connected: boolean;
  serverUrl: string;
  latencyMs?: number;
  error?: string;
}

/**
 * Opens an MCP session and immediately closes it to verify that:
 *   1. The SSE endpoint is reachable
 *   2. The X-Service-Token is accepted
 *   3. No SDK compatibility errors occur on connect
 *
 * @param rawToken - A valid bearer token (e.g. a service-account token)
 *                   Used only to satisfy the auth header — no tool is called.
 */
export async function checkMcpConnectivity(
  rawToken: string,
): Promise<McpConnectivityResult> {
  const serverUrl = env.MCP_SERVER_URL;
  const start = Date.now();

  log.debug({ serverUrl }, "MCP connectivity check starting");

  try {
    const session = await openMcpSession(rawToken);
    await session.close();

    const latencyMs = Date.now() - start;
    log.info({ serverUrl, latencyMs }, "MCP connectivity check passed");

    return { connected: true, serverUrl, latencyMs };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ serverUrl, error }, "MCP connectivity check failed");

    return { connected: false, serverUrl, error };
  }
}
