/**
 * src/mcp/tools/inbox/summarizeReplies.tool.ts
 *
 * Phase 1 uses deterministic summarization:
 *  - Fetches up to maxSample replies from MailFlow
 *  - Counts replies by status
 *  - Extracts top keywords from reply body text (stopword-filtered word frequency)
 *
 * When an LLM is connected in a future phase, replace buildDeterministicSummary()
 * with a model call. The tool handler, schema, and ToolContext remain unchanged.
 */

import { TOOL_NAMES, SUMMARIZE_REPLIES_MAX_SAMPLE } from "../../../config/constants.js";
import { SummarizeRepliesSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Reply, ReplyStatus, ReplySummary } from "../../../types/mailflow.js";
import type { ToolContext } from "../../types/toolContext.js";

// ── Stopword list ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "do", "does", "did", "for", "from", "had", "has", "have", "he",
  "her", "his", "i", "in", "is", "it", "its", "me", "my", "not",
  "of", "on", "or", "our", "she", "so", "the", "their", "them",
  "they", "this", "that", "to", "up", "us", "was", "we", "were",
  "will", "with", "would", "you", "your",
]);

const TOP_KEYWORDS_N = 10;
const MIN_WORD_LENGTH = 3;

// ── Deterministic summarization ───────────────────────────────────────────────

function extractTopKeywords(replies: Reply[]): string[] {
  const freq = new Map<string, number>();

  for (const reply of replies) {
    const words = reply.bodyText
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/);

    for (const word of words) {
      if (word.length >= MIN_WORD_LENGTH && !STOPWORDS.has(word)) {
        freq.set(word, (freq.get(word) ?? 0) + 1);
      }
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_KEYWORDS_N)
    .map(([word]) => word);
}

function buildDeterministicSummary(
  replies: Reply[],
  campaignId: string | undefined,
  totalAvailable: number,
): ReplySummary {
  const statusBreakdown: Record<ReplyStatus, number> = {
    unread: 0,
    read: 0,
    archived: 0,
  };

  for (const reply of replies) {
    statusBreakdown[reply.status] += 1;
  }

  return {
    campaignId: campaignId ? asCampaignId(campaignId) : asCampaignId("all"),
    totalReplies: totalAvailable,
    sampleSize: replies.length,
    statusBreakdown,
    topKeywords: extractTopKeywords(replies),
    generatedAt: new Date().toISOString() as import("../../../types/common.js").ISODateString,
  };
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export const summarizeRepliesTool: McpToolDefinition<
  typeof SummarizeRepliesSchema,
  ReplySummary
> = {
  name: TOOL_NAMES.SUMMARIZE_REPLIES,

  description:
    "Produces an aggregated summary of email replies for a campaign. " +
    "Returns total reply count, status breakdown (unread/read/archived), " +
    "and the top recurring keywords extracted from reply bodies. " +
    "Use list_replies to retrieve individual reply content.",

  inputSchema: SummarizeRepliesSchema,

  handler: async (input, context: ToolContext) => {
    const maxSample = input.maxSample ?? SUMMARIZE_REPLIES_MAX_SAMPLE;

    context.log.info(
      { campaignId: input.campaignId, maxSample },
      "Summarizing replies",
    );

    try {
      const result = await context.mailflow.listReplies({
        campaignId: input.campaignId
          ? asCampaignId(input.campaignId)
          : undefined,
        page: 1,
        pageSize: maxSample,
      });

      const summary = buildDeterministicSummary(
        result.items,
        input.campaignId,
        result.total,
      );

      context.log.info(
        {
          campaignId: input.campaignId,
          totalReplies: summary.totalReplies,
          sampleSize: summary.sampleSize,
          keywordCount: summary.topKeywords.length,
        },
        "Reply summary built",
      );

      return toolSuccess(summary);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to summarize replies");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
