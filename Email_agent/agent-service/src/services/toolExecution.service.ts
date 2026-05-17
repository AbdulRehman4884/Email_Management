/**
 * src/services/toolExecution.service.ts
 *
 * Graph adapter — bridges LangGraph state to the MCP tool layer.
 *
 * This service is the single point called by the executeTool graph node.
 * It is responsible for:
 *
 *   1. Reading toolName, toolArgs, rawToken, userId from graph state
 *   2. Validating that the tool name is known
 *   3. Constructing an AuthContext from the state credentials
 *   4. Delegating to McpClientService.dispatch()
 *   5. Returning a state patch:
 *        - { toolResult }   on success
 *        - { error }        on any recoverable failure (logged; not thrown)
 *
 * Only McpError instances that are unrecoverable (e.g. AUTH errors) are
 * re-thrown; all other errors are captured into state.error so the
 * finalResponse node can produce a user-facing message without crashing.
 */

import { createLogger } from "../lib/logger.js";
import { McpError, ErrorCode } from "../lib/errors.js";
import { mcpClientService } from "./mcpClient.service.js";
import { isKnownTool } from "../types/tools.js";
import { asUserId } from "../types/common.js";
import type { AuthContext } from "../types/common.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";

const log = createLogger("toolExecution");

// ── Auth errors that should propagate (not be swallowed into state.error) ─────

const PROPAGATE_CODES = new Set<ErrorCode>([
  ErrorCode.AUTH_MISSING_TOKEN,
  ErrorCode.AUTH_INVALID_TOKEN,
  ErrorCode.AUTH_EXPIRED_TOKEN,
  ErrorCode.AUTH_FORBIDDEN,
]);

// ── Service ───────────────────────────────────────────────────────────────────

export class ToolExecutionService {
  /**
   * Executes the MCP tool described in graph state and returns a state patch.
   *
   * Always resolves (never rejects) unless an auth error occurs.
   * The caller (executeToolNode) can merge the returned patch directly into state.
   */
  async executeFromState(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { toolName, toolArgs, rawToken, userId, sessionId } = state;

    // ── Pre-flight checks ────────────────────────────────────────────────────

    if (!toolName) {
      log.warn({ sessionId }, "executeFromState: toolName missing in state");
      return { error: "No tool was selected for this request." };
    }

    if (!rawToken) {
      log.warn({ sessionId, toolName }, "executeFromState: rawToken missing in state");
      return { error: "Authentication credentials are not available. Please log in again." };
    }

    if (!isKnownTool(toolName)) {
      log.error({ sessionId, toolName }, "executeFromState: unknown tool name in state");
      return { error: `Unknown tool "${toolName}". This is an internal configuration error.` };
    }

    // ── Construct auth context ───────────────────────────────────────────────

    const authContext: AuthContext = {
      // userId may be undefined for service-account calls; fallback keeps
      // the type satisfied — actual authorization is enforced by the bearer token.
      userId: userId ?? asUserId("unknown"),
      rawToken,
    };

    // ── Execute ──────────────────────────────────────────────────────────────

    const startMs = Date.now();
    log.debug({ toolName, userId, sessionId }, "Executing MCP tool");

    try {
      const toolResult = await mcpClientService.dispatch(
        toolName,
        toolArgs,
        authContext,
      );

      log.info(
        {
          toolName,
          userId,
          sessionId,
          durationMs: Date.now() - startMs,
          isToolError: toolResult.isToolError,
        },
        "Tool executed successfully",
      );

      return { toolResult };

    } catch (err) {
      const durationMs = Date.now() - startMs;

      if (err instanceof McpError) {
        // Auth errors are re-thrown — the HTTP layer handles them as 401/403
        if (PROPAGATE_CODES.has(err.code)) {
          throw err;
        }

        log.error(
          { toolName, userId, sessionId, durationMs, code: err.code, message: err.message },
          "MCP tool error",
        );

        return { error: this.userMessage(err) };
      }

      // Unknown error — log full detail, return generic message
      log.error(
        { toolName, userId, sessionId, durationMs, err },
        "Unexpected error during tool execution",
      );

      return { error: "An unexpected error occurred while processing your request. Please try again." };
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private userMessage(err: McpError): string {
    switch (err.code) {
      case ErrorCode.MCP_TIMEOUT:
        return "The request timed out. The MailFlow service may be temporarily unavailable — please try again.";
      case ErrorCode.MCP_TOOL_ERROR:
        return `The operation could not be completed: ${err.message}`;
      default:
        return "The request could not be completed. Please check your input and try again.";
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const toolExecutionService = new ToolExecutionService();
