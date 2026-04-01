/**
 * src/types/mcp.ts
 *
 * Types for MCP tool invocation through agent-service.
 */

// ── Tool call input ───────────────────────────────────────────────────────────

export interface McpToolCall {
  /** MCP tool name as registered in mailflow-mcp-server */
  toolName: string;

  /** Validated, serialisable arguments for the tool */
  args: Record<string, unknown>;
}

// ── Tool call result ──────────────────────────────────────────────────────────

/**
 * Normalised result returned by McpToolCallerService.
 * Content is already extracted from the MCP content array.
 */
export interface McpToolResult {
  /** Parsed JSON data if the tool returned a JSON text block, otherwise raw text */
  data: unknown;

  /** True when the MCP tool itself signalled an error via isError */
  isToolError: boolean;

  /** Raw text content blocks from the MCP response (for debugging) */
  rawContent: string[];
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface McpCallOptions {
  /** Override the default MCP_TOOL_TIMEOUT_MS for this call */
  timeoutMs?: number;
}
