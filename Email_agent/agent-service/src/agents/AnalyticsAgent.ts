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
import {
  campaignChoiceList,
  campaignNotFoundMessage,
  impossibleCampaignIdIn,
  isValidCampaignId,
  ordinalPick,
  resolveNamedCampaign,
} from "../lib/campaignLookup.js";
import { isAccountLevelQuestion, isClickQuestion } from "../lib/accountStats.js";
import {
  accountClickAnswer,
  campaignFactAnswer,
  isCampaignFactQuestion,
  isNewestCampaignQuestion,
  isOverviewQuestion,
  listUserCampaigns,
  isPeriodStatsQuestion,
  multiCampaignStatsAnswer,
  newestCampaignOf,
  overviewAnswer,
  pausedCampaignStatsAnswer,
  periodStatsAnswer,
  rankingAnswer,
  rankingMetric,
} from "../lib/campaignAnalytics.js";
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
      return this.unhandledIntent(intent, userId);
    }

    const toolName = TOOL_MAP[intent];

    // An id that can't exist (0, -5, 4.34, a 20-digit number) gets the same not-found answer as any
    // unknown id — not "Something went wrong: Invalid campaign id" or the whole campaign list.
    const impossible = impossibleCampaignIdIn(state.userMessage);
    const llmRaw = llmExtractedArgs?.campaignId;
    const badLlmId = typeof llmRaw === "string" && /^-?\d+(?:[.,]\d+)?$/.test(llmRaw.trim()) && !isValidCampaignId(llmRaw) ? llmRaw.trim() : undefined;
    if (impossible ?? badLlmId) {
      return {
        toolName: undefined,
        toolArgs: {},
        formattedResponse: JSON.stringify({ status: "error", intent: "get_campaign_stats", message: campaignNotFoundMessage((impossible ?? badLlmId)!) }),
      };
    }

    // "show stats for the second one" → the 2nd campaign of the list just shown (QA P3 bug 57).
    const picked = ordinalPick(state.userMessage, state.campaignSelectionList);
    if (picked) {
      return { toolName, toolArgs: { campaignId: picked.id }, activeCampaignId: picked.id };
    }

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

    // "Total emails sent across all my campaigns" / "my overall open rate":
    // account totals, not one campaign (bug A-05). The session's active campaign
    // does not count here — only an id the user gave in this message.
    const llmId = String(llmExtractedArgs?.campaignId ?? "").trim();
    if (!/^\d+$/.test(llmId) && isAccountLevelQuestion(state.userMessage)) {
      return { toolName: "get_account_stats", toolArgs: {} };
    }

    if (/\b(?:paused|on\s+hold)\s+campaigns?\b[^.!?]{0,40}\b(stats?|open\s+rates?|sent|opened)\b|\b(?:stats?|open\s+rates?)\b[^.!?]{0,40}\bpaused\s+campaigns?\b/i.test(state.userMessage)) {
      const answer = await pausedCampaignStatsAnswer(state);
      if (answer) return { toolName: undefined, toolArgs: {}, formattedResponse: JSON.stringify({ status: "success", intent, message: answer }) };
    }

    // Questions answered from real numbers (lib/campaignAnalytics.ts), before any name lookup:
    //   several campaigns  "stats for campaigns 434 and 431", "compare DRY RUN and Campaign 3"
    //   ranking            "which campaign has the best open rate?" (was a lookup for a campaign NAMED that)
    //   overview           "how are my campaigns doing?", "why is my open rate low?"
    //   a period           "how many emails did I send in October?"
    const msg = state.userMessage;
    const answer =
      (isCampaignFactQuestion(msg) ? await campaignFactAnswer(state) : undefined) ??
      (await multiCampaignStatsAnswer(state)) ??
      (rankingMetric(msg) ? await rankingAnswer(state) : undefined) ??
      (isOverviewQuestion(msg) ? await overviewAnswer(state) : undefined) ??
      (isPeriodStatsQuestion(msg) ? await periodStatsAnswer(state) : undefined) ??
      // "What is my click rate?" with no campaign named: account level (not the campaign pick list).
      (isClickQuestion(msg) && !/\d/.test(msg) && (await resolveNamedCampaign(state)).kind === "none" ? await accountClickAnswer(state) : undefined);
    if (answer) {
      return {
        toolName: undefined,
        toolArgs: {},
        formattedResponse: JSON.stringify({ status: "success", intent: "get_campaign_stats", message: answer }),
      };
    }

    // "Stats for the last campaign I created" / "my most recent campaign" → the newest campaign by date.
    if (isNewestCampaignQuestion(msg) && !/^\d+$/.test(llmId)) {
      const newest = await newestCampaignOf(state);
      if (newest) return { toolName, toolArgs: { campaignId: newest.id }, activeCampaignId: newest.id };
    }

    // "and the same for campaign 431", "no, I meant Campaign 3", "sorry, I meant ALL": a correction or a
    // follow-up that names the campaign by id or by its exact name (QA P3-2 bugs 20 / 21 / 28).
    const followUp = await this.campaignFromFollowUp(state);
    if (followUp) return { toolName, toolArgs: { campaignId: followUp.id }, activeCampaignId: followUp.id };

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

    // Remember the campaign so "how many people replied to it?" next turn means
    // this campaign, not every campaign (bug A-07).
    return { toolName, toolArgs, activeCampaignId: String(toolArgs.campaignId) };
  }

  /**
   * One match → stats right away. Several (duplicate names) → only those to pick from.
   * None → "not found" plus the list to pick from. undefined → no name given / list unavailable.
   */
  private async campaignFromFollowUp(state: AgentGraphStateType): Promise<{ id: string } | undefined> {
    const msg = state.userMessage;
    const meant = /\b(?:i\s+)?meant\s+(?:the\s+)?(?:campaign\s+)?["']?(.+?)["']?\s*[.!?]*$/i.exec(msg)?.[1]?.trim();
    const idIn = /\bcampaign\s+(?:id\s*[:#]?\s*)?#?(\d{1,9})\b|#(\d{1,9})\b/i.exec(msg);
    if (!meant && !idIn) return undefined;
    const all = await listUserCampaigns(state);
    if (!all) return undefined;
    const id = idIn ? (idIn[1] ?? idIn[2]) : undefined;
    if (id && all.some((c) => c.id === id)) return { id };
    if (meant) {
      const wanted = meant.toLowerCase().replace(/\s+/g, " ");
      const exact = all.filter((c) => c.name.toLowerCase().replace(/\s+/g, " ") === wanted || c.id === meant.replace(/^#/, ""));
      if (exact.length === 1) return { id: exact[0]!.id };
    }
    return undefined;
  }

  private async resolveByName(state: AgentGraphStateType): Promise<Partial<AgentGraphStateType> | undefined> {
    const named = await resolveNamedCampaign(state);
    if (named.kind === "none") return undefined;

    if (named.kind === "one") {
      const c = named.campaign;
      this.log.info({ userId: state.userId, campaignId: c.id }, "AnalyticsAgent: campaign name resolved");
      return { toolName: "get_campaign_stats", toolArgs: { campaignId: c.id }, activeCampaignId: c.id };
    }

    // A typo ("dry rn") → only the close name(s) to confirm, not all 38 campaigns.
    const close = named.kind === "notFound" ? named.close : [];
    const choices = named.kind === "many" ? named.matches : close.length ? close : named.all;
    if (choices.length === 0) return undefined;
    const intro = named.kind === "many"
      ? `I found ${choices.length} campaigns named **${named.name}**. Which one do you mean?`
      : close.length === 1
        ? `I couldn't find a campaign named **${named.name}**. Did you mean **${close[0]!.name}** (#${close[0]!.id})?`
        : close.length
          ? `I couldn't find a campaign named **${named.name}**. Did you mean one of these?`
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
