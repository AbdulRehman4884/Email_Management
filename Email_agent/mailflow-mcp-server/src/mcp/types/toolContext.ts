/**
 * src/mcp/types/toolContext.ts
 *
 * ToolContext is the single dependency injection object passed to every
 * MCP tool handler.
 *
 * It provides:
 *  - Validated auth context (never raw userId)
 *  - Scoped structured logger
 *  - Session metadata for correlation
 *  - The MailFlow API client (Phase 3)
 *
 * Tool handlers must not import env, logger, or the API client directly.
 * Everything they need arrives via ToolContext, making tools independently
 * testable by injecting mocked contexts.
 */

import type { Logger } from "pino";
import type { AuthContext } from "../../types/auth.js";
import type { McpSession } from "../../types/mcp.js";
import type { IMailFlowApiClient } from "../../lib/mailflowApiClient.js";

// IMailFlowApiClient is defined alongside its implementation in Phase 3
export type { IMailFlowApiClient } from "../../lib/mailflowApiClient.js";

// ── Tool context ──────────────────────────────────────────────────────────────

export interface ToolContext {
  /**
   * Validated auth context.
   * Contains the bearer token to use for MailFlow API calls.
   * userId is resolved server-side — never from tool input.
   */
  readonly auth: AuthContext;

  /**
   * Scoped pino logger pre-bound with toolName and sessionId.
   * Use this for all logging inside tool handlers.
   */
  readonly log: Logger;

  /**
   * MCP session metadata (sessionId, raw headers).
   * Use sessionId for log correlation; do not use rawAuth directly.
   */
  readonly session: McpSession;

  /**
   * MailFlow API client authenticated with auth.bearerToken.
   * Instantiated by toolExecution.service via createMailFlowApiClient().
   */
  readonly mailflow: IMailFlowApiClient;
}

// ── Context factory type ──────────────────────────────────────────────────────

/**
 * Function signature for the context factory used in toolExecution.service.ts.
 * Accepts the raw FastMCP execute context and returns a fully resolved ToolContext.
 */
export type ToolContextFactory = (
  toolName: string,
  rawFastMcpContext: unknown,
) => Promise<ToolContext>;
