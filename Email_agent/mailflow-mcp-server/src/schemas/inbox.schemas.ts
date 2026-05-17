/**
 * src/schemas/inbox.schemas.ts
 *
 * Zod input schemas for inbox-related MCP tools: list_replies, summarize_replies.
 *
 * Rules:
 *  - userId is NEVER a schema field — resolved server-side from the bearer token
 *  - campaignId is optional in both tools (allows cross-campaign queries)
 *  - maxSample is bounded by SUMMARIZE_REPLIES_MAX_SAMPLE to prevent abuse
 */

import { z } from "zod";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SUMMARIZE_REPLIES_MAX_SAMPLE,
} from "../config/constants.js";

// ── Shared primitives ─────────────────────────────────────────────────────────

const replyStatusField = z.enum(["unread", "read", "archived"], {
  errorMap: () => ({
    message: 'status must be one of "unread", "read", or "archived"',
  }),
});

// ── listReplies ───────────────────────────────────────────────────────────────

export const ListRepliesSchema = z.object({
  /**
   * Filter replies to a specific campaign.
   * Omit to list replies across all accessible campaigns.
   */
  campaignId: z.string().min(1).trim().optional(),

  /** Filter by read/unread/archived status */
  status: replyStatusField.optional(),

  /** 1-based page number */
  page: z
    .number({ invalid_type_error: "page must be a number" })
    .int("page must be an integer")
    .min(1, "page must be at least 1")
    .default(1),

  /** Number of results per page; capped at MAX_PAGE_SIZE */
  pageSize: z
    .number({ invalid_type_error: "pageSize must be a number" })
    .int("pageSize must be an integer")
    .min(1, "pageSize must be at least 1")
    .max(MAX_PAGE_SIZE, `pageSize must be ${MAX_PAGE_SIZE} or fewer`)
    .default(DEFAULT_PAGE_SIZE),
});

export type ListRepliesInput = z.infer<typeof ListRepliesSchema>;

// ── summarizeReplies ──────────────────────────────────────────────────────────

export const SummarizeRepliesSchema = z.object({
  /**
   * Restrict the summary to a single campaign.
   * Omit to summarize across all accessible campaigns.
   */
  campaignId: z.string().min(1).trim().optional(),

  /**
   * Maximum number of replies to include in the sample.
   * Phase 1 uses deterministic summarization; bounded to prevent large payloads.
   */
  maxSample: z
    .number({ invalid_type_error: "maxSample must be a number" })
    .int("maxSample must be an integer")
    .min(1, "maxSample must be at least 1")
    .max(
      SUMMARIZE_REPLIES_MAX_SAMPLE,
      `maxSample must be ${SUMMARIZE_REPLIES_MAX_SAMPLE} or fewer`,
    )
    .default(SUMMARIZE_REPLIES_MAX_SAMPLE),
});

export type SummarizeRepliesInput = z.infer<typeof SummarizeRepliesSchema>;

export const ReplyIntelligenceSummarySchema = z.object({
  campaignId: z.string().min(1).trim().optional(),
});

export const ReplyLeadListSchema = z.object({
  campaignId: z.string().min(1).trim().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const DraftReplySuggestionSchema = z.object({
  replyId: z.string().min(1).trim(),
});

export const MarkReplyHumanReviewSchema = z.object({
  replyId: z.string().min(1).trim(),
  reason: z.string().min(1).max(500).optional(),
});

export const AutonomousRecommendationSchema = z.object({
  recipientId: z.string().min(1).trim(),
});

export const CampaignAutonomousSummarySchema = z.object({
  campaignId: z.string().min(1).trim(),
});

export const PreviewSequenceAdaptationSchema = z.object({
  recipientId: z.string().min(1).trim(),
  campaignId: z.string().min(1).trim(),
  replyText: z.string().min(1).max(5000).optional(),
  scenario: z.enum([
    "pricing_objection",
    "competitor_objection",
    "timing_objection",
    "meeting_interest",
    "positive_interest",
    "unsubscribe",
    "spam_complaint",
  ]).optional(),
});

export type ReplyIntelligenceSummaryInput = z.infer<typeof ReplyIntelligenceSummarySchema>;
export type ReplyLeadListInput = z.infer<typeof ReplyLeadListSchema>;
export type DraftReplySuggestionInput = z.infer<typeof DraftReplySuggestionSchema>;
export type MarkReplyHumanReviewInput = z.infer<typeof MarkReplyHumanReviewSchema>;
export type AutonomousRecommendationInput = z.infer<typeof AutonomousRecommendationSchema>;
export type CampaignAutonomousSummaryInput = z.infer<typeof CampaignAutonomousSummarySchema>;
export type PreviewSequenceAdaptationInput = z.infer<typeof PreviewSequenceAdaptationSchema>;
