/**
 * src/services/mcpToolCaller.ts
 *
 * Service layer for invoking MCP tools.
 *
 * Responsibilities:
 *  1. Open a per-request MCP session (connect, call, close)
 *  2. Enforce a call timeout — rejects with McpError(MCP_TIMEOUT) on breach
 *  3. Normalise MCP content blocks into McpToolResult
 *  4. Map all MCP / transport errors to typed McpError instances
 *  5. Log toolName, durationMs, userId — never log token or raw args values
 *
 * Consumers (LangGraph nodes, agents) work with McpToolResult and never
 * interact with the MCP SDK directly.
 */

import { createLogger } from "../lib/logger.js";
import { McpError, ErrorCode } from "../lib/errors.js";
import { openMcpSession, type McpSession } from "../lib/mcpClient.js";
import { DEFAULT_MCP_TOOL_TIMEOUT_MS } from "../config/constants.js";
import type { AuthContext } from "../types/common.js";
import type { McpToolResult, McpCallOptions } from "../types/mcp.js";

const log = createLogger("mcpToolCaller");

// ── Content normalisation ─────────────────────────────────────────────────────

interface TextContent {
  type: "text";
  text: string;
}

function isTextContent(c: unknown): c is TextContent {
  return (
    typeof c === "object" &&
    c !== null &&
    (c as Record<string, unknown>)["type"] === "text" &&
    typeof (c as Record<string, unknown>)["text"] === "string"
  );
}

/**
 * Extracts raw text strings from MCP content blocks.
 * Non-text blocks (images, embedded resources) are silently dropped —
 * mailflow-mcp-server only returns text blocks.
 */
function extractTextContent(content: unknown[]): string[] {
  return content.filter(isTextContent).map((c) => c.text);
}

/**
 * Attempts to JSON-parse the first text block. Falls back to the raw string
 * if parsing fails, or returns the full array if multiple blocks are present.
 */
function parseData(texts: string[]): unknown {
  if (texts.length === 0) return null;
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0]!);
    } catch {
      return texts[0];
    }
  }
  // Multiple blocks — return array as-is
  return texts;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class McpToolCallerService {
  /**
   * Calls a named MCP tool and returns a normalised result.
   *
   * @param toolName    - MCP tool name (e.g. "create_campaign")
   * @param args        - Validated tool arguments
   * @param authContext - Resolved auth context; rawToken is forwarded to MCP server
   * @param options     - Optional overrides (timeoutMs)
   */
  async call(
    toolName: string,
    args: Record<string, unknown>,
    authContext: AuthContext,
    options: McpCallOptions = {},
  ): Promise<McpToolResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
    const { userId, rawToken } = authContext;
    const startMs = Date.now();

    log.debug({ toolName, userId }, "MCP tool call starting");

    let session = await this.openSessionWithTimeout(rawToken, timeoutMs).catch(
      (err) => {
        throw this.wrapError(err, toolName, "Failed to connect to MCP server");
      },
    );

    try {
      const mcpResult = await this.callWithTimeout(
        () => session.callTool(toolName, args),
        timeoutMs,
        toolName,
      );

      const content = Array.isArray(mcpResult.content) ? mcpResult.content : [];
      const texts = extractTextContent(content);
      const data = parseData(texts);
      const isToolError = mcpResult.isError === true;

      const durationMs = Date.now() - startMs;
      log.info(
        { toolName, userId, durationMs, isToolError },
        "MCP tool call completed",
      );

      return { data, isToolError, rawContent: texts };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      log.error(
        { toolName, userId, durationMs, err },
        "MCP tool call failed",
      );
      throw err instanceof McpError ? err : this.wrapError(err, toolName, "MCP tool call failed");
    } finally {
      await session.close();
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async openSessionWithTimeout(
    rawToken: string,
    timeoutMs: number,
  ): Promise<McpSession> {
    return Promise.race([
      openMcpSession(rawToken),
      this.timeoutPromise<McpSession>(timeoutMs, "connect"),
    ]);
  }

  private callWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    toolName: string,
  ): Promise<T> {
    return Promise.race([
      fn(),
      this.timeoutPromise<T>(timeoutMs, toolName),
    ]);
  }

  private timeoutPromise<T>(timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new McpError(
              ErrorCode.MCP_TIMEOUT,
              `MCP operation timed out after ${timeoutMs}ms (${label})`,
            ),
          ),
        timeoutMs,
      ),
    );
  }

  private wrapError(err: unknown, toolName: string, message: string): McpError {
    const detail =
      err instanceof Error ? err.message : String(err);
    return new McpError(
      ErrorCode.MCP_ERROR,
      `${message}: ${detail}`,
      { toolName },
    );
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const mcpToolCaller = new McpToolCallerService();
