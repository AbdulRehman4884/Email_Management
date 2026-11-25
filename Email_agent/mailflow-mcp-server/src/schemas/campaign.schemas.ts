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

const hhmmField = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be a time as HH:mm (e.g. 09:00)");

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

  /**
   * SMTP profile ID to use for sending.
   * When omitted, the MCP tool auto-resolves: single profile → auto-select,
   * multiple profiles → returns SMTP_SELECTION_REQUIRED with choices.
   */
  smtpSettingsId: z.number().int().positive().optional(),

  /** Several SMTP profiles (sends rotate across them); the first is the primary sender. */
  smtpSettingIds: z.array(z.number().int().positive()).min(1).max(50).optional(),

  /** Only these sending aliases of the chosen profiles; empty = every active alias. */
  aliasIds: z.array(z.number().int().positive()).max(500).optional(),
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

    /**
     * The email account (SMTP profile) the campaign sends from. The sender name and email come from
     * this account — fromName / fromEmail on their own are not saved by the backend.
     */
    smtpSettingsId: z.number().int().positive().optional(),

    /** Stop sending at this time (null = no stop time). */
    pauseAt: isoDatetimeField.nullable().optional(),
    /** Pause after running this many minutes, then resume and repeat (null = off). */
    autoPauseAfterMinutes: z.number().int().min(1).max(10080).nullable().optional(),
    /** Max emails per day for this campaign (null = as fast as the accounts allow). */
    dailySendLimit: z.number().int().min(1).max(10000).nullable().optional(),
    /** ISO weekdays 1 = Mon … 7 = Sun (null = every day). */
    sendWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),
    /** Daily sending hours "HH:mm" in the backend schedule timezone; both set or both null. */
    dailySendWindowStart: hhmmField.nullable().optional(),
    dailySendWindowEnd: hhmmField.nullable().optional(),
  })
  .refine(
    ({ campaignId: _id, ...rest }) =>
      Object.values(rest).some((v) => v !== undefined),
    { message: "At least one field to update must be provided" },
  )
  .refine(
    ({ dailySendWindowStart: s, dailySendWindowEnd: e }) => (s === undefined) === (e === undefined) && (s == null) === (e == null) && (s == null || s !== e),
    { message: "dailySendWindowStart and dailySendWindowEnd must both be set (and differ) or both be null" },
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

/** All campaigns of the authenticated user; `tag` keeps only the campaigns with that tag (by name). */
export const GetAllCampaignsSchema = z.object({
  tag: z.string().trim().min(1).max(100).optional()
    .describe("Only campaigns with this campaign tag (tag name, e.g. 'QA-Auto'), like the Campaigns page tag filter."),
});

export type GetAllCampaignsInput = z.infer<typeof GetAllCampaignsSchema>;

export const GetAccountStatsSchema = z.object({
  /** "yearly" adds months: emails sent / opened / replies per month for the last 12 months. */
  view: z.enum(["yearly"]).optional(),
});

export type GetAccountStatsInput = z.infer<typeof GetAccountStatsSchema>;

/** get_account_plan: no input — the user comes from the token. */
export const GetAccountPlanSchema = z.object({});

/** get_best_send_time: the hour the user's leads open emails most, in this IANA time zone. */
export const GetBestSendTimeSchema = z.object({
  timezone: z.string().trim().min(1).max(64).default("UTC").describe("IANA time zone, e.g. Asia/Karachi"),
});

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

/** read_table_file: same file input as parse_csv_file; the result is the raw table. */
export const ReadTableFileSchema = ParseCsvFileSchema;
export type ReadTableFileInput = z.infer<typeof ReadTableFileSchema>;

/** get_campaign_recipients: a campaign's settings + its recipients with their uploaded rows. */
export const GetCampaignRecipientsSchema = z.object({
  campaignId: campaignIdField,
  /** Most recipients to return (pages of 100 are read until this many). */
  limit: z.number().int().min(1).max(1000).optional(),
});
export type GetCampaignRecipientsInput = z.infer<typeof GetCampaignRecipientsSchema>;

/** save_follow_up_templates: replaces the campaign's follow-up templates (any campaign status). */
export const SaveFollowUpTemplatesSchema = z.object({
  campaignId: campaignIdField,
  templates: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        title: z.string().max(200),
        subject: z.string().min(1).max(255),
        body: z.string().min(1).max(10000),
      }),
    )
    .max(30),
});
export type SaveFollowUpTemplatesInput = z.infer<typeof SaveFollowUpTemplatesSchema>;

export const SaveCsvRecipientsSchema = z.object({
  campaignId: campaignIdField,
  /** Parsed recipient rows from parse_csv_file — each row is a key→value record. */
  rows: z.array(z.record(z.string())).min(1, "rows must contain at least one recipient"),
  /** Chat campaign flows: every row is its own recipient, even when the email repeats. */
  allowDuplicates: z.boolean().optional(),
});
export type SaveCsvRecipientsInput = z.infer<typeof SaveCsvRecipientsSchema>;

// ── addRecipients ─────────────────────────────────────────────────────────────

const recipientEntrySchema = z.object({
  /** Must be a valid email address. */
  email: z.string().email("Must be a valid email address"),
  /** Optional display name for the recipient. */
  name: z.string().max(255).trim().optional(),
});

export const AddRecipientsSchema = z.object({
  campaignId: campaignIdField,
  /** List of recipients to add to the campaign. At least one required. */
  recipients: z
    .array(recipientEntrySchema)
    .min(1, "recipients must contain at least one entry"),
});
export type AddRecipientsInput = z.infer<typeof AddRecipientsSchema>;
