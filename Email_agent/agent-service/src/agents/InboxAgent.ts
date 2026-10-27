/**
 * src/agents/InboxAgent.ts
 *
 * Handles inbox / reply management intents.
 *
 * Intents handled:
 *   list_replies      → MCP tool: list_replies
 *   summarize_replies → MCP tool: summarize_replies
 *
 * Argument resolution:
 *   toolArgs are built by resolveToolArgs() which merges:
 *     - list_replies:
 *         campaignId  from llmExtractedArgs or activeCampaignId
 *         limit       from llmExtractedArgs.limit (positive integer)
 *         filters     from llmExtractedArgs.filters (sanitised — no auth keys)
 *     - summarize_replies:
 *         campaignId  from llmExtractedArgs or activeCampaignId
 *         query       from llmExtractedArgs.query
 *         filters     from llmExtractedArgs.filters (sanitised)
 *   userId / accountId / tenantId are NEVER sourced from LLM output.
 */

import { BaseAgent } from "./BaseAgent.js";
import { resolveToolArgs } from "../lib/toolArgResolver.js";
import { campaignChoiceList, resolveNamedCampaign } from "../lib/campaignLookup.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { Intent } from "../config/intents.js";
import type { KnownToolName } from "../types/tools.js";

const TOOL_MAP = {
  list_replies:      "list_replies",
  summarize_replies: "summarize_replies",
  show_hot_leads: "show_hot_leads",
  show_meeting_ready_leads: "show_meeting_ready_leads",
  summarize_objections: "get_reply_intelligence_summary",
  draft_reply_to_latest_lead: "draft_reply_suggestion",
  mark_reply_human_review: "mark_reply_human_review",
  show_autonomous_recommendations: "get_campaign_autonomous_summary",
  explain_lead_priority: "get_autonomous_recommendation",
  preview_sequence_adaptation: "preview_sequence_adaptation",
  show_next_best_action: "get_autonomous_recommendation",
  show_escalation_queue: "get_campaign_autonomous_summary",
} satisfies Partial<Record<Intent, KnownToolName>>;

type InboxIntent = keyof typeof TOOL_MAP;

function isInboxIntent(intent: Intent | undefined): intent is InboxIntent {
  return intent !== undefined && intent in TOOL_MAP;
}

export class InboxAgent extends BaseAgent {
  readonly domain = "inbox" as const;

  constructor() {
    super("inbox");
  }

  async handle(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { intent, userId, llmExtractedArgs, activeCampaignId } = state;

    if (!isInboxIntent(intent)) {
      const msg = `InboxAgent received unhandled intent: ${intent ?? "undefined"}`;
      this.log.error({ intent, userId }, msg);
      return { error: msg };
    }

    const toolName = TOOL_MAP[intent];

    const toolArgs = resolveToolArgs(toolName, {
      extractedArgs:    llmExtractedArgs,
      activeCampaignId,
    });

    // "Who replied to the DRY RUN campaign?" / "Proving AI Services pa kitne replies han"
    // — a campaign NAME in the message wins over the session's active campaign, so the
    // replies always belong to the campaign the user named.
    if (toolName === "list_replies" || toolName === "summarize_replies") {
      const named = await resolveNamedCampaign(state);
      if (named.kind === "one") {
        toolArgs.campaignId = named.campaign.id;
        return { toolName, toolArgs, activeCampaignId: named.campaign.id };
      }
      if (named.kind === "many" || named.kind === "notFound") {
        const choices = named.kind === "many" ? named.matches : named.all;
        const intro = named.kind === "many"
          ? `I found ${choices.length} campaigns named **${named.name}**. Which one do you mean?`
          : `I couldn't find a campaign named **${named.name}**.${choices.length ? " Your campaigns:" : ""}`;
        const ask = choices.length ? "\n\nAsk again with the exact name, e.g. *replies of campaign #" + choices[0]!.id + "*." : "";
        return {
          formattedResponse: JSON.stringify({
            status: "needs_input",
            intent,
            message: `${intro}${choices.length ? `\n\n${campaignChoiceList(choices)}` : ""}${ask}`,
          }),
        };
      }
    }

    this.log.debug(
      {
        intent,
        toolName,
        userId,
        resolvedArgKeys: Object.keys(toolArgs),
      },
      "InboxAgent resolved tool and args",
    );

    return { toolName, toolArgs };
  }
}

export const inboxAgent = new InboxAgent();
