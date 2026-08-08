/**
 * src/mcp/bootstrap/createServer.ts
 *
 * Creates the FastMCP server with the authenticate hook and registers all tools.
 *
 * ── Auth hook ─────────────────────────────────────────────────────────────────
 *
 * FastMCP's `authenticate` callback fires on every new SSE connection.
 * It receives the HTTP Request (Web Fetch API) and returns a typed session object
 * that becomes available as `context.session` in every tool's execute() function.
 *
 * We extract X-Service-Token and X-Forwarded-Authorization from the request headers
 * here and store them in the session. No validation happens at this stage — validation
 * is deferred to authContext.service.ts at tool execution time. This means a session
 * can be established with bad credentials; the auth error surfaces on the first tool call.
 *
 * If you require authentication before accepting the SSE connection, move the
 * authContextService.validateServiceToken() call into this authenticate callback
 * and throw to reject the connection.
 *
 * For stdio transport, FastMCP does not call authenticate; the session defaults to
 * `{ rawAuth: {} }`, which causes auth to fall back to MAILFLOW_SERVICE_ACCOUNT_TOKEN.
 *
 * ── Session type ──────────────────────────────────────────────────────────────
 *
 * `MailFlowMcpSession` is the typed shape stored in FastMCP's session per connection.
 * Export it so toolRegistry.ts can type the execute() context.session accessor.
 */

import { FastMCP } from "fastmcp";
import type http from "http";
import { SERVER_NAME, SERVER_VERSION, SERVICE_TOKEN_HEADER, FORWARDED_AUTH_HEADER } from "../../config/constants.js";
import { createLogger } from "../../lib/logger.js";
import { registerAllTools } from "../registry/toolRegistry.js";
import type { RawInboundAuth } from "../../types/auth.js";

const log = createLogger("createServer");

// ── Session type ──────────────────────────────────────────────────────────────

export type MailFlowMcpSession = {
  /** Auth headers captured at SSE connection time */
  readonly rawAuth: RawInboundAuth;
};

// ── Factory ───────────────────────────────────────────────────────────────────

/** Safely extract a single string value from IncomingMessage headers. */
function getHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function buildMcpServer(): FastMCP<MailFlowMcpSession> {
  const server = new FastMCP<MailFlowMcpSession>({
    name: SERVER_NAME,
    version: SERVER_VERSION,

    authenticate: async (request: http.IncomingMessage): Promise<MailFlowMcpSession> => {
      try {
        const serviceToken = getHeader(request, SERVICE_TOKEN_HEADER);
        const forwardedAuthorization = getHeader(request, FORWARDED_AUTH_HEADER);

        log.debug(
          {
            hasServiceToken: serviceToken !== undefined,
            hasForwardedAuth: forwardedAuthorization !== undefined,
          },
          "SSE session established — auth headers captured",
        );

        const rawAuth: RawInboundAuth = {};
        if (serviceToken !== undefined) rawAuth.serviceToken = serviceToken;
        if (forwardedAuthorization !== undefined) {
          rawAuth.forwardedAuthorization = forwardedAuthorization;
        }
        return { rawAuth };
      } catch (err) {
        log.error({ err }, "SSE authenticate hook threw — connection rejected");
        throw err;
      }
    },
  });

  // Register all MCP tools against the server instance
  registerAllTools(server);

  log.info(`${SERVER_NAME} bootstrap complete`);

  return server;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * The fully configured FastMCP server instance.
 * Imported by server.ts to replace the bare Phase-1 instance.
 */
export const mcpServer = buildMcpServer();
