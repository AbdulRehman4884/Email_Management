/**
 * src/agents/AnalyticsAgent.ts
 *
 * Handles campaign analytics intents.
 *
 * Intents handled:
 *   get_campaign_stats → MCP tool: get_campaign_stats
 *
 * Argument resolution:
 *   toolArgs are built by resolveToolArgs() which merges:
 *     1. state.llmExtractedArgs.campaignId  — if Gemini extracted a campaign reference
 *     2. state.activeCampaignId             — session-level fallback
 *   If neither is present, toolArgs is {} and the MCP server returns a
 *   validation error asking the user which campaign to report on.
 */

import { BaseAgent } from "./BaseAgent.js";
import { resolveToolArgs } from "../lib/toolArgResolver.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { Intent } from "../config/intents.js";
import type { KnownToolName } from "../types/tools.js";

const TOOL_MAP = {
  get_campaign_stats: "get_campaign_stats",
} satisfies Partial<Record<Intent, KnownToolName>>;

type AnalyticsIntent = keyof typeof TOOL_MAP;

function isAnalyticsIntent(
  intent: Intent | undefined,
): intent is AnalyticsIntent {
  return intent !== undefined && intent in TOOL_MAP;
}

export class AnalyticsAgent extends BaseAgent {
  readonly domain = "analytics" as const;

  constructor() {
    super("analytics");
  }

  async handle(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { intent, userId, llmExtractedArgs, activeCampaignId } = state;

    if (!isAnalyticsIntent(intent)) {
      const msg = `AnalyticsAgent received unhandled intent: ${intent ?? "undefined"}`;
      this.log.error({ intent, userId }, msg);
      return { error: msg };
    }

    const toolName = TOOL_MAP[intent];

    const toolArgs = resolveToolArgs(toolName, {
      extractedArgs:    llmExtractedArgs,
      activeCampaignId,
    });

    this.log.debug(
      {
        intent,
        toolName,
        userId,
        resolvedArgKeys: Object.keys(toolArgs),
      },
      "AnalyticsAgent resolved tool and args",
    );

    return { toolName, toolArgs };
  }
}

export const analyticsAgent = new AnalyticsAgent();
