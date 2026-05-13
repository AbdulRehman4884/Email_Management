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

  /** Display name shown in From field — backend derives this from SMTP settings */
  fromName: z.string().min(1).max(255).trim().optional(),

  /** Sender email address — backend derives this from SMTP settings */
  fromEmail: emailField.optional(),

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

// ── getAllCampaigns ────────────────────────────────────────────────────────────

/** No arguments — returns all campaigns for the authenticated user. */
export const GetAllCampaignsSchema = z.object({});

export type GetAllCampaignsInput = z.infer<typeof GetAllCampaignsSchema>;

// ── getCampaignStats ──────────────────────────────────────────────────────────

export const GetCampaignStatsSchema = z.object({
  campaignId: campaignIdField,
});

export type GetCampaignStatsInput = z.infer<typeof GetCampaignStatsSchema>;

const recipientLookupFields = {
  recipientId: z.string().min(1).trim().optional(),
  recipientEmail: emailField.optional(),
} as const;

export const GetSequenceProgressSchema = z.object({
  campaignId: campaignIdField,
});
export type GetSequenceProgressInput = z.infer<typeof GetSequenceProgressSchema>;

export const GetPendingFollowUpsSchema = z.object({
  campaignId: campaignIdField,
  limit: z.number().int().min(1).max(100).optional(),
});
export type GetPendingFollowUpsInput = z.infer<typeof GetPendingFollowUpsSchema>;

export const GetRecipientTouchHistorySchema = z.object({
  campaignId: campaignIdField,
  ...recipientLookupFields,
}).refine(
  (value) => Boolean(value.recipientId || value.recipientEmail),
  { message: "recipientId or recipientEmail is required" },
);
export type GetRecipientTouchHistoryInput = z.infer<typeof GetRecipientTouchHistorySchema>;

export const MarkRecipientRepliedSchema = z.object({
  campaignId: campaignIdField,
  ...recipientLookupFields,
}).refine(
  (value) => Boolean(value.recipientId || value.recipientEmail),
  { message: "recipientId or recipientEmail is required" },
);
export type MarkRecipientRepliedInput = z.infer<typeof MarkRecipientRepliedSchema>;

export const MarkRecipientBouncedSchema = z.object({
  campaignId: campaignIdField,
  ...recipientLookupFields,
}).refine(
  (value) => Boolean(value.recipientId || value.recipientEmail),
  { message: "recipientId or recipientEmail is required" },
);
export type MarkRecipientBouncedInput = z.infer<typeof MarkRecipientBouncedSchema>;

// ── Phase 1: AI Campaign schemas ──────────────────────────────────────────────

export const GetRecipientCountSchema = z.object({
  campaignId: campaignIdField,
});
export type GetRecipientCountInput = z.infer<typeof GetRecipientCountSchema>;

export const SaveAiPromptSchema = z.object({
  campaignId: campaignIdField,
  templateType: z.enum(["promotional", "newsletter", "event", "announcement", "follow_up"]).optional(),
  toneInstruction: z.string().max(255).trim().optional(),
  customPrompt: z.string().max(2000).trim().optional(),
});
export type SaveAiPromptInput = z.infer<typeof SaveAiPromptSchema>;

export const GeneratePersonalizedEmailsSchema = z.object({
  campaignId: campaignIdField,
  /**
   * When true, skips the existing-emails check and regenerates all emails.
   * Pass this when the user explicitly says "regenerate" after being shown the
   * "emails already exist" prompt.
   */
  overwrite: z.boolean().optional(),
  /** Optional copy style mode. Default is low_promotional_plaintext. */
  mode: z.enum(["default", "low_promotional_plaintext", "executive_direct", "friendly_human", "value_first"]).optional(),
  tone: z.enum(["executive_direct", "founder_style", "consultant_style", "friendly_human", "technical_advisor", "concise_enterprise"]).optional(),
  ctaType: z.enum(["curiosity_cta", "soft_meeting_cta", "reply_cta", "value_cta", "direct_cta", "no_pressure_cta"]).optional(),
  sequenceType: z.enum(["cold_outreach", "warm_followup", "reengagement", "founder_outreach"]).optional(),
  sequenceLength: z.union([z.literal(3), z.literal(4)]).optional(),
  includeBreakupEmail: z.boolean().optional(),
  removeBreakupEmail: z.boolean().optional(),
  shortenEmails: z.boolean().optional(),
  intent: z.string().max(100).trim().optional(),
});
export type GeneratePersonalizedEmailsInput = z.infer<typeof GeneratePersonalizedEmailsSchema>;

export const GetPersonalizedEmailsSchema = z.object({
  campaignId: campaignIdField,
  limit: z.number().int().min(1).max(100).default(10).optional(),
});
export type GetPersonalizedEmailsInput = z.infer<typeof GetPersonalizedEmailsSchema>;

// ── CSV file ingestion ────────────────────────────────────────────────────────

export const ParseCsvFileSchema = z.object({
  /** Base64-encoded CSV or XLSX file content */
  fileContent: z.string().min(1, "fileContent must not be empty"),
  /** Original file name — used to detect format (.csv vs .xlsx) */
  filename: z.string().min(1, "filename must not be empty"),
});
export type ParseCsvFileInput = z.infer<typeof ParseCsvFileSchema>;

export const SaveCsvRecipientsSchema = z.object({
  campaignId: campaignIdField,
  /** Parsed recipient rows from parse_csv_file — each row is a key→value record. */
  rows: z.array(z.record(z.string())).min(1, "rows must contain at least one recipient"),
});
export type SaveCsvRecipientsInput = z.infer<typeof SaveCsvRecipientsSchema>;
