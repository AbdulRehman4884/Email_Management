/**
 * src/lib/mcpClient.ts
 *
 * Per-request MCP client factory.
 *
 * Design:
 *  - A new Client + SSEClientTransport is created for every tool call.
 *    MCP SSE connections are cheap and this avoids shared session state.
 *  - Auth headers are injected at the transport level, not in tool arguments.
 *  - The client is always closed in a finally block — even on timeout.
 *
 * Header contract with mailflow-mcp-server:
 *  X-Service-Token           → MCP_SERVICE_SECRET (service-to-service auth)
 *  X-Forwarded-Authorization → "Bearer <user JWT>" (end-user identity)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../config/env.js";
import { SERVICE_NAME, SERVICE_VERSION } from "../config/constants.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SERVICE_TOKEN_HEADER = "x-service-token";
const FORWARDED_AUTH_HEADER = "x-forwarded-authorization";

// ── Session handle ────────────────────────────────────────────────────────────

export interface McpSession {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Opens a new MCP SSE session authenticated with the provided user token.
 * The caller is responsible for calling session.close() after use.
 *
 * @param rawToken - The user's raw JWT bearer token (forwarded as-is to MCP server)
 */
export async function openMcpSession(rawToken: string): Promise<McpSession> {
  const authHeaders = {
    [SERVICE_TOKEN_HEADER]: env.MCP_SERVICE_SECRET,
    [FORWARDED_AUTH_HEADER]: `Bearer ${rawToken}`,
  };

  const transport = new SSEClientTransport(
    new URL(env.MCP_SERVER_URL),
    {
      // eventSourceInit carries headers on the initial SSE GET connection
      eventSourceInit: {
        headers: authHeaders,
      } as EventSourceInit,
      // requestInit carries headers on subsequent POST messages
      requestInit: {
        headers: authHeaders,
      },
    },
  );

  const client = new Client(
    { name: SERVICE_NAME, version: SERVICE_VERSION },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    callTool: (name, args) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>,

    close: async () => {
      try {
        await client.close();
      } catch {
        // Best-effort — do not propagate close errors
      }
    },
  };
}
