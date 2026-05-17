/**
 * src/types/tools.ts
 *
 * Typed input interfaces for every MCP tool exposed by mailflow-mcp-server.
 * These types are the agent-service's contract with the MCP layer.
 *
 * The MCP server applies its own Zod validation; these types exist so that
 * TypeScript callers get compile-time guarantees about what they pass, and
 * so future LLM arg-extraction (Phase 6) can target well-defined shapes.
 *
 * All interfaces are intentionally permissive at the optional-field level —
 * the MCP server is the authoritative validator for required vs. optional.
 */

// ── Known tool registry ───────────────────────────────────────────────────────

/**
 * Exhaustive tuple of every MCP tool name available in mailflow-mcp-server.
 * Used for runtime validation in ToolExecutionService.
 */
export const KNOWN_TOOL_NAMES = [
  "create_campaign",
  "update_campaign",
  "start_campaign",
  "pause_campaign",
  "resume_campaign",
  "get_campaign_stats",
  "list_replies",
  "summarize_replies",
  "get_smtp_settings",
  "update_smtp_settings",
] as const;

export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

/** Type-guard — narrows an arbitrary string to KnownToolName. */
export function isKnownTool(name: string): name is KnownToolName {
  return (KNOWN_TOOL_NAMES as readonly string[]).includes(name);
}

// ── Campaign tool inputs ──────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  recipientListId?: string;
  fromName?: string;
  fromEmail?: string;
}

export interface UpdateCampaignInput {
  campaignId: string;
  name?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  fromName?: string;
  fromEmail?: string;
}

/** Shared input shape for single-ID campaign actions (start/pause/resume). */
export interface CampaignActionInput {
  campaignId: string;
}

// ── Analytics tool inputs ─────────────────────────────────────────────────────

export interface GetCampaignStatsInput {
  campaignId: string;
}

// ── Inbox tool inputs ─────────────────────────────────────────────────────────

export interface ListRepliesInput {
  campaignId?: string;
  limit?: number;
  offset?: number;
}

export interface SummarizeRepliesInput {
  campaignId?: string;
}

// ── Settings tool inputs ──────────────────────────────────────────────────────

/** No required arguments — returns all current SMTP settings. */
export type GetSmtpSettingsInput = Record<string, never>;

export interface UpdateSmtpSettingsInput {
  host?: string;
  port?: number;
  username?: string;
  /** Password is accepted but always masked in responses. */
  password?: string;
  secure?: boolean;
}

// ── Per-tool input map ────────────────────────────────────────────────────────

/**
 * Maps each KnownToolName to its typed input interface.
 * Keeps the McpClientService method signatures DRY and provides a single
 * source of truth for tool↔input relationships.
 */
export interface ToolInputMap {
  create_campaign:      CreateCampaignInput;
  update_campaign:      UpdateCampaignInput;
  start_campaign:       CampaignActionInput;
  pause_campaign:       CampaignActionInput;
  resume_campaign:      CampaignActionInput;
  get_campaign_stats:   GetCampaignStatsInput;
  list_replies:         ListRepliesInput;
  summarize_replies:    SummarizeRepliesInput;
  get_smtp_settings:    GetSmtpSettingsInput;
  update_smtp_settings: UpdateSmtpSettingsInput;
}
