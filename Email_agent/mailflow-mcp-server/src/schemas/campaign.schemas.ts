/**
 * src/schemas/campaign.schemas.ts
 *
 * Zod input schemas for all campaign-related MCP tools.
 *
 * Rules:
 *  - userId is NEVER a schema field — it is resolved server-side from the token
 *  - campaignId comes from tool input as a plain string; tools cast to CampaignId
 *  - All datetime strings validated as ISO 8601 with timezone offset
 *  - Partial update schemas require at least one field via .refine()
 */

import { z } from "zod";

// ── Shared primitives ─────────────────────────────────────────────────────────

const campaignIdField = z
  .string({ required_error: "campaignId is required" })
  .min(1, "campaignId must not be empty")
  .trim();

const isoDatetimeField = z
  .string()
  .datetime({ offset: true, message: "Must be a valid ISO 8601 datetime with timezone (e.g. 2025-06-01T09:00:00Z)" });

const emailField = z.string().email("Must be a valid email address");

// ── createCampaign ────────────────────────────────────────────────────────────

export const CreateCampaignSchema = z.object({
  /** Human-readable campaign name */
  name: z
    .string({ required_error: "name is required" })
    .min(1, "name must not be empty")
    .max(255, "name must be 255 characters or fewer")
    .trim(),

  /** Email subject line */
  subject: z
    .string({ required_error: "subject is required" })
    .min(1, "subject must not be empty")
    .max(998, "subject must be 998 characters or fewer (RFC 5321)")
    .trim(),

  /** Display name shown in From field */
  fromName: z
    .string({ required_error: "fromName is required" })
    .min(1)
    .max(255)
    .trim(),

  /** Sender email address */
  fromEmail: emailField,

  /** Optional reply-to address */
  replyToEmail: emailField.optional(),

  /** Email body format; defaults to html */
  bodyFormat: z.enum(["html", "plain"]).default("html"),

  /** Email body content */
  body: z
    .string({ required_error: "body is required" })
    .min(1, "body must not be empty"),

  /** Optional scheduled send time */
  scheduledAt: isoDatetimeField.optional(),
});

export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

// ── updateCampaign ────────────────────────────────────────────────────────────

export const UpdateCampaignSchema = z
  .object({
    /** ID of the campaign to update */
    campaignId: campaignIdField,

    name: z.string().min(1).max(255).trim().optional(),
    subject: z.string().min(1).max(998).trim().optional(),
    fromName: z.string().min(1).max(255).trim().optional(),
    fromEmail: emailField.optional(),

    /** Pass null to remove the reply-to address */
    replyToEmail: emailField.nullable().optional(),

    bodyFormat: z.enum(["html", "plain"]).optional(),
    body: z.string().min(1).optional(),

    /** Pass null to remove the scheduled time */
    scheduledAt: isoDatetimeField.nullable().optional(),
  })
  .refine(
    ({ campaignId: _id, ...rest }) =>
      Object.values(rest).some((v) => v !== undefined),
    { message: "At least one field to update must be provided" },
  );

export type UpdateCampaignInput = z.infer<typeof UpdateCampaignSchema>;

// ── startCampaign ─────────────────────────────────────────────────────────────

export const StartCampaignSchema = z.object({
  campaignId: campaignIdField,
});

export type StartCampaignInput = z.infer<typeof StartCampaignSchema>;

// ── pauseCampaign ─────────────────────────────────────────────────────────────

export const PauseCampaignSchema = z.object({
  campaignId: campaignIdField,
});

export type PauseCampaignInput = z.infer<typeof PauseCampaignSchema>;

// ── resumeCampaign ────────────────────────────────────────────────────────────

export const ResumeCampaignSchema = z.object({
  campaignId: campaignIdField,
});

export type ResumeCampaignInput = z.infer<typeof ResumeCampaignSchema>;

// ── getCampaignStats ──────────────────────────────────────────────────────────

export const GetCampaignStatsSchema = z.object({
  campaignId: campaignIdField,
});

export type GetCampaignStatsInput = z.infer<typeof GetCampaignStatsSchema>;
