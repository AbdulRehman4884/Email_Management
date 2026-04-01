/**
 * src/services/toolExecution.service.ts
 *
 * Central wrapper around every tool handler invocation.
 *
 * Responsibilities:
 *  1. Measure wall-clock duration per invocation
 *  2. Emit structured start/end log entries with tool name, session, and duration
 *  3. Act as the outermost error boundary — catches unexpected throws from handlers
 *     (handlers are expected to return ToolResult, not throw, but this is a safety net)
 *  4. Serialize ToolResult<T> → JSON string returned to FastMCP
 *
 * This service does NOT validate inputs — FastMCP validates against the Zod schema
 * before calling execute(). It does NOT resolve auth — that happens in toolRegistry.ts
 * before building ToolContext.
 */

import { createLogger } from "../lib/logger.js";
import { serializeError, ErrorCode } from "../lib/errors.js";
import type { AnyMcpToolDefinition, FastMcpToolReturn, ToolExecutionMeta } from "../types/tool.js";
import type { ToolContext } from "../mcp/types/toolContext.js";

const log = createLogger("toolExecution.service");

// ── ToolExecutionService ──────────────────────────────────────────────────────

export class ToolExecutionService {
  /**
   * Executes a tool handler inside a timing + error boundary.
   *
   * @param toolDef   - The registered tool definition (name, handler, schema)
   * @param input     - Validated input from FastMCP (already Zod-parsed)
   * @param context   - Fully resolved ToolContext (auth, logger, mailflow client)
   * @returns         - JSON string serialization of ToolResult<T>
   */
  async execute(
    toolDef: AnyMcpToolDefinition,
    input: unknown,
    context: ToolContext,
  ): Promise<FastMcpToolReturn> {
    const { name } = toolDef;
    const { sessionId } = context.session;
    const startMs = Date.now();

    context.log.info(
      { toolName: name, sessionId, authMode: context.auth.mode },
      "Tool execution started",
    );

    try {
      // Handlers return ToolResult<T>, they do not throw.
      // The cast is safe: FastMCP already validated input against inputSchema.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await toolDef.handler(input as any, context);
      const durationMs = Date.now() - startMs;

      const meta: ToolExecutionMeta = {
        toolName: name,
        durationMs,
        success: result.success,
        errorCode: result.success ? undefined : result.error.code,
      };

      if (result.success) {
        context.log.info({ ...meta }, "Tool execution succeeded");
      } else {
        context.log.warn({ ...meta, errorCode: result.error.code }, "Tool returned failure");
      }

      log.debug({ toolName: name, durationMs, sessionId }, "Tool execution complete");

      return JSON.stringify(result);
    } catch (err) {
      // Unexpected throw from a handler — should not happen in normal operation
      const durationMs = Date.now() - startMs;
      const error = serializeError(err);

      context.log.error(
        { toolName: name, durationMs, sessionId, error },
        "Tool handler threw unexpectedly",
      );

      log.error(
        { toolName: name, durationMs, errorCode: error.code },
        "Unexpected tool handler throw — returning TOOL_EXECUTION_ERROR",
      );

      return JSON.stringify({
        success: false,
        error: {
          code: ErrorCode.TOOL_EXECUTION_ERROR,
          message: `Unexpected error in ${name}: ${error.message}`,
        },
      });
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const toolExecutionService = new ToolExecutionService();
