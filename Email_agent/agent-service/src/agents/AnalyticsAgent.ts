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
 *     1. state.llmExtractedArgs.campaignId  — if OpenAI extracted a campaign reference
 *     2. state.activeCampaignId             — session-level fallback
 *   If neither is present, toolArgs is {} and the MCP server returns a
 *   validation error asking the user which campaign to report on.
 */

import { BaseAgent } from "./BaseAgent.js";
import { resolveToolArgs } from "../lib/toolArgResolver.js";
import { campaignChoiceList, resolveNamedCampaign } from "../lib/campaignLookup.js";
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

    // A campaign NAME was given ("stats for the campaign DRY RUN"): resolve it now
    // instead of showing the whole list (bug A-01). The name also wins over the
    // session's active campaign (a numeric id from the LLM keeps the id path).
    const byName = await this.resolveByName(state);
    if (byName) return byName;

    // No campaignId — fetch all campaigns so the user can select one
    if (!toolArgs.campaignId) {
      this.log.info({ userId }, "AnalyticsAgent: no campaignId — triggering campaign selection");
      return {
        toolName:              "get_all_campaigns",
        toolArgs:              {},
        pendingCampaignAction: "get_campaign_stats",
      };
    }

    return { toolName, toolArgs };
  }

  /**
   * One match → stats right away. Several (duplicate names) → only those to pick from.
   * None → "not found" plus the list to pick from. undefined → no name given / list unavailable.
   */
  private async resolveByName(state: AgentGraphStateType): Promise<Partial<AgentGraphStateType> | undefined> {
    const named = await resolveNamedCampaign(state);
    if (named.kind === "none") return undefined;

    if (named.kind === "one") {
      const c = named.campaign;
      this.log.info({ userId: state.userId, campaignId: c.id }, "AnalyticsAgent: campaign name resolved");
      return { toolName: "get_campaign_stats", toolArgs: { campaignId: c.id }, activeCampaignId: c.id };
    }

    const choices = named.kind === "many" ? named.matches : named.all;
    if (choices.length === 0) return undefined;
    const intro = named.kind === "many"
      ? `I found ${choices.length} campaigns named **${named.name}**. Which one do you mean?`
      : `I couldn't find a campaign named **${named.name}**. Which campaign do you mean?`;
    return {
      formattedResponse: JSON.stringify({
        status: "needs_input",
        intent: "get_campaign_stats",
        message: `${intro}\n\n${campaignChoiceList(choices)}\n\nReply with the **number** or the campaign name.`,
      }),
      campaignSelectionList: choices,
      pendingCampaignAction: "get_campaign_stats",
    };
  }
}

export const analyticsAgent = new AnalyticsAgent();
