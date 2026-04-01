/**
 * src/services/mcpClient.service.ts
 *
 * Typed MCP tool API for agent-service.
 *
 * Provides two call paths:
 *
 *   1. Named typed methods (e.g. createCampaign, getCampaignStats)
 *      For callers that know the tool at compile time and want full type safety.
 *      Phase 6 will use these when LLM arg-extraction produces typed structs.
 *
 *   2. dispatch(toolName, args, authContext)
 *      For callers that select a tool dynamically at runtime (e.g. ToolExecutionService
 *      reading toolName from graph state). Validates the name is known before calling.
 *
 * Neither path calls the MCP SDK directly — all transport, timeout, and error
 * handling is delegated to McpToolCallerService (Phase 2).
 *
 * Connection details (from env):
 *   MCP_SERVER_URL      → http://localhost:4000/sse (SSE endpoint)
 *   MCP_SERVICE_SECRET  → X-Service-Token header value
 *   user rawToken       → X-Forwarded-Authorization: Bearer <token>
 */

import { createLogger } from "../lib/logger.js";
import { McpError, ErrorCode } from "../lib/errors.js";
import { mcpToolCaller } from "./mcpToolCaller.js";
import type { AuthContext } from "../types/common.js";
import type { McpToolResult, McpCallOptions } from "../types/mcp.js";
import {
  isKnownTool,
  type KnownToolName,
  type ToolInputMap,
  type CreateCampaignInput,
  type UpdateCampaignInput,
  type CampaignActionInput,
  type GetCampaignStatsInput,
  type ListRepliesInput,
  type SummarizeRepliesInput,
  type GetSmtpSettingsInput,
  type UpdateSmtpSettingsInput,
} from "../types/tools.js";

const log = createLogger("mcpClient.service");

// ── Service ───────────────────────────────────────────────────────────────────

export class McpClientService {

  // ── Campaign tools ──────────────────────────────────────────────────────────

  createCampaign(
    args: CreateCampaignInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("create_campaign", args, auth, opts);
  }

  updateCampaign(
    args: UpdateCampaignInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("update_campaign", args, auth, opts);
  }

  startCampaign(
    args: CampaignActionInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("start_campaign", args, auth, opts);
  }

  pauseCampaign(
    args: CampaignActionInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("pause_campaign", args, auth, opts);
  }

  resumeCampaign(
    args: CampaignActionInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("resume_campaign", args, auth, opts);
  }

  // ── Analytics tools ─────────────────────────────────────────────────────────

  getCampaignStats(
    args: GetCampaignStatsInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("get_campaign_stats", args, auth, opts);
  }

  // ── Inbox tools ─────────────────────────────────────────────────────────────

  listReplies(
    args: ListRepliesInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("list_replies", args, auth, opts);
  }

  summarizeReplies(
    args: SummarizeRepliesInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("summarize_replies", args, auth, opts);
  }

  // ── Settings tools ──────────────────────────────────────────────────────────

  getSmtpSettings(
    args: GetSmtpSettingsInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("get_smtp_settings", args, auth, opts);
  }

  updateSmtpSettings(
    args: UpdateSmtpSettingsInput,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return this.invoke("update_smtp_settings", args, auth, opts);
  }

  // ── Dynamic dispatch ────────────────────────────────────────────────────────

  /**
   * Dispatches a tool call by name — used by ToolExecutionService when the
   * tool name is resolved from graph state at runtime.
   *
   * Throws McpError(MCP_ERROR) if toolName is not in KNOWN_TOOL_NAMES.
   */
  dispatch<T extends KnownToolName>(
    toolName: T,
    args: ToolInputMap[T],
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult>;

  /**
   * Untyped overload for callers that have already validated the tool name
   * via isKnownTool() but don't have the specific input type available.
   */
  dispatch(
    toolName: KnownToolName,
    args: Record<string, unknown>,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult>;

  dispatch(
    toolName: KnownToolName,
    args: Record<string, unknown>,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    if (!isKnownTool(toolName)) {
      throw new McpError(
        ErrorCode.MCP_ERROR,
        `Unknown MCP tool: "${toolName}". Known tools: ${[...Array.from(new Set([toolName]))].join(", ")}`,
      );
    }
    log.debug({ toolName, userId: auth.userId }, "Dispatching tool");
    return this.invoke(toolName, args, auth, opts);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private invoke(
    toolName: string,
    args: object,
    auth: AuthContext,
    opts?: McpCallOptions,
  ): Promise<McpToolResult> {
    return mcpToolCaller.call(toolName, args as Record<string, unknown>, auth, opts);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const mcpClientService = new McpClientService();
