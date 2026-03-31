/**
 * src/types/tool.ts
 *
 * Generic tool infrastructure types.
 *
 * These types define the contract between:
 *  - The MCP tool definition layer (FastMCP)
 *  - The tool handler functions (business logic per tool)
 *  - The tool execution service (centralized wrapping)
 *
 * Tool handlers receive a typed ToolContext (defined in mcp/types/toolContext.ts)
 * and return a ToolResult<T> (defined in types/common.ts).
 */

import type { ZodTypeAny, z } from "zod";
import type { ToolContext } from "../mcp/types/toolContext.js";
import type { ToolResult } from "./common.js";
import type { ToolName } from "../config/constants.js";

// ── Handler signature ─────────────────────────────────────────────────────────

/**
 * The function signature every tool handler must implement.
 *
 * @typeParam TInput - Zod-inferred input type for this tool
 * @typeParam TOutput - The typed value returned in ToolResult.data on success
 */
export type ToolHandler<TInput, TOutput> = (
  input: TInput,
  context: ToolContext,
) => Promise<ToolResult<TOutput>>;

// ── Tool definition ───────────────────────────────────────────────────────────

/**
 * Full definition of an MCP tool as understood by mailflow-mcp-server.
 *
 * This is the internal representation. The registry converts it into the
 * FastMCP tool shape via `registerTool()`.
 *
 * @typeParam TSchema - Zod schema type for input validation
 * @typeParam TOutput - Return type of the handler on success
 */
export interface McpToolDefinition<
  TSchema extends ZodTypeAny,
  TOutput = unknown,
> {
  /** Stable machine-readable name; must match a TOOL_NAMES constant */
  name: ToolName;

  /** Human-readable description shown to the agent/LLM */
  description: string;

  /** Zod schema used for input validation before the handler is called */
  inputSchema: TSchema;

  /** Tool implementation; receives validated input and injected context */
  handler: ToolHandler<z.infer<TSchema>, TOutput>;
}

// ── Registry entry ────────────────────────────────────────────────────────────

/**
 * Erased version of McpToolDefinition stored in the tool registry.
 * The registry holds these as an array; each entry is registered with FastMCP.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMcpToolDefinition = McpToolDefinition<ZodTypeAny, any>;

// ── Tool execution metadata ───────────────────────────────────────────────────

/**
 * Metadata emitted by toolExecution.service for observability.
 */
export interface ToolExecutionMeta {
  toolName: ToolName;
  durationMs: number;
  success: boolean;
  errorCode?: string;
}

// ── FastMCP execute return ────────────────────────────────────────────────────

/**
 * The value toolExecution.service serializes and returns to FastMCP's execute().
 * FastMCP expects either a string or a JSON-serializable value.
 * We always return a JSON string so the agent receives a consistent envelope.
 */
export type FastMcpToolReturn = string;
