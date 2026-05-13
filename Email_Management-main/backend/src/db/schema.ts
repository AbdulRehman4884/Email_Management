import { integer, pgTable, varchar, date, boolean, timestamp, text, uniqueIndex, real, jsonb, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CampaignStatus } from "../types/campaign";

export const usersTable = pgTable("users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  // Forgot-password OTP (store only hash; never store plaintext OTP)
  passwordResetOtpHash: varchar("password_reset_otp_hash", { length: 255 }),
  passwordResetOtpExpiresAt: timestamp("password_reset_otp_expires_at"),
  passwordResetOtpUsedAt: timestamp("password_reset_otp_used_at"),
  passwordResetRequestedAt: timestamp("password_reset_requested_at"),
  name: varchar("name", { length: 100 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("user"),
  isActive: boolean("is_active").notNull().default(true),
  preferredTheme: varchar("preferred_theme", { length: 20 }).notNull().default("dark"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const smtpSettingsTable = pgTable("smtp_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  host: varchar("host", { length: 255 }).notNull(),
  port: integer("port").notNull(),
  secure: boolean("secure").notNull().default(false),
  user: varchar("user", { length: 255 }).notNull(),
  password: varchar("password", { length: 500 }).notNull(),
  fromName: varchar("from_name", { length: 100 }).default("").notNull(),
  fromEmail: varchar("from_email", { length: 255 }).notNull(),
  replyToEmail: varchar("reply_to_email", { length: 255 }).default("").notNull(),
  trackingBaseUrl: varchar("tracking_base_url", { length: 500 }),
  /** Max sends per calendar day for this SMTP profile; 0 = unlimited */
  dailyEmailLimit: integer("daily_email_limit").notNull().default(50),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const campaignTable = pgTable("campaigns", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  smtpSettingsId: integer("smtp_settings_id").references(() => smtpSettingsTable.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("draft" as CampaignStatus),
  subject: varchar("subject", { length: 255 }).notNull(),
  emailContent: varchar("email_content", { length: 5000 }).notNull(),
  fromName: varchar("from_name", { length: 100 }).notNull(),
  fromEmail: varchar("from_email", { length: 255 }).notNull(),
  recieptCount: integer("reciept_count").notNull().default(0),
  createdAt: date("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: 'string' }).notNull().defaultNow(),
  scheduledAt: varchar("scheduled_at", { length: 30 }),
  pauseAt: varchar("pause_at", { length: 30 }),
  /** Wall-clock minutes from anchor (schedule start or "now"); pause_at is derived on start / activation */
  autoPauseAfterMinutes: integer("auto_pause_after_minutes"),
  availableColumns: varchar("available_columns", { length: 2000 }),
  followUpTemplates: jsonb("follow_up_templates")
    .notNull()
    .$type<Array<{ id: string; title: string; subject: string; body: string }>>()
    .default(sql`'[]'::jsonb`),
  followUpSkipConfirm: boolean("follow_up_skip_confirm").notNull().default(false),
  /** Optional max sends per day for this campaign (spread); null = only SMTP daily limit applies */
  dailySendLimit: integer("daily_send_limit"),
  /** ISO weekdays 1–7 (Mon–Sun) when sends may run; null = every day */
  sendWeekdays: jsonb("send_weekdays").$type<number[] | null>(),
  pauseReason: varchar("pause_reason", { length: 50 }),
  pausedAt: timestamp("paused_at", { mode: "string" }),
});

export const emailSendLogTable = pgTable("email_send_log", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  smtpSettingsId: integer("smtp_settings_id").references(() => smtpSettingsTable.id).notNull(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userNotificationsTable = pgTable("user_notifications", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  type: varchar("type", { length: 50 }).notNull(),
  payload: jsonb("payload"),
  readAt: timestamp("read_at", { mode: "string" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const statsTable = pgTable("campaign_stats", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  sentCount: integer("sent_count").notNull().default(0),
  delieveredCount: integer("delivered_count").notNull().default(0),
  bouncedCount: integer("bounced_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  complainedCount: integer("complained_count").notNull().default(0),
  openedCount: integer("opened_count").notNull().default(0),
  repliedCount: integer("replied_count").notNull().default(0),
});

export const recipientTable = pgTable("recipients", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  name: varchar("name", { length: 100 }),
  messageId: varchar("message_id", { length: 255 }),
  sentAt: date("sent_at"),
  delieveredAt: date("delivered_at"),
  openedAt: timestamp("opened_at"),
  repliedAt: timestamp("replied_at"),
  customFields: text("custom_fields"),
  /** Last SMTP/worker send failure (sanitized; no passwords). Cleared on successful send. */
  lastSendError: varchar("last_send_error", { length: 2000 }),
});

export const campaignAiPromptsTable = pgTable("campaign_ai_prompts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  templateType: varchar("template_type", { length: 50 }),
  toneInstruction: varchar("tone_instruction", { length: 255 }),
  customPrompt: text("custom_prompt"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const campaignPersonalizedEmailsTable = pgTable("campaign_personalized_emails", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  recipientId: integer("recipient_id").references(() => recipientTable.id).notNull(),
  personalizedSubject: varchar("personalized_subject", { length: 500 }),
  personalizedBody: text("personalized_body").notNull(),
  toneUsed: varchar("tone_used", { length: 80 }),
  ctaType: varchar("cta_type", { length: 80 }),
  ctaText: varchar("cta_text", { length: 500 }),
  sequenceType: varchar("sequence_type", { length: 80 }),
  touchNumber: integer("touch_number").notNull().default(1),
  deliverabilityRisk: varchar("deliverability_risk", { length: 20 }),
  strategyReasoning: text("strategy_reasoning"),
  generationStatus: varchar("generation_status", { length: 50 }).notNull().default("generated"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const campaignSequenceTouchesTable = pgTable("campaign_sequence_touches", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  recipientId: integer("recipient_id").references(() => recipientTable.id).notNull(),
  touchNumber: integer("touch_number").notNull(),
  sequenceType: varchar("sequence_type", { length: 80 }).notNull(),
  objective: varchar("objective", { length: 120 }).notNull(),
  recommendedDelayDays: integer("recommended_delay_days").notNull().default(0),
  toneUsed: varchar("tone_used", { length: 80 }),
  ctaType: varchar("cta_type", { length: 80 }),
  ctaText: varchar("cta_text", { length: 500 }),
  personalizedSubject: varchar("personalized_subject", { length: 500 }),
  personalizedBody: text("personalized_body").notNull(),
  personalizedText: text("personalized_text"),
  previousTouchSummary: text("previous_touch_summary"),
  deliverabilityRisk: varchar("deliverability_risk", { length: 20 }),
  strategyReasoning: text("strategy_reasoning"),
  executionStatus: varchar("execution_status", { length: 50 }).notNull().default("pending"),
  scheduledForAt: timestamp("scheduled_for_at"),
  sentAt: timestamp("sent_at"),
  messageId: varchar("message_id", { length: 500 }),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at"),
  retryAfterAt: timestamp("retry_after_at"),
  lastError: varchar("last_error", { length: 2000 }),
  skippedAt: timestamp("skipped_at"),
  skipReason: varchar("skip_reason", { length: 80 }),
  bouncedAt: timestamp("bounced_at"),
  repliedAt: timestamp("replied_at"),
  unsubscribedAt: timestamp("unsubscribed_at"),
  generationStatus: varchar("generation_status", { length: 50 }).notNull().default("generated"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  uniqueRecipientTouch: uniqueIndex("campaign_sequence_touches_campaign_recipient_touch_idx").on(
    table.campaignId,
    table.recipientId,
    table.touchNumber,
  ),
}));

export const recipientSequenceStateTable = pgTable("recipient_sequence_state", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  recipientId: integer("recipient_id").references(() => recipientTable.id).notNull(),
  currentTouchNumber: integer("current_touch_number").notNull().default(0),
  nextTouchNumber: integer("next_touch_number").notNull().default(1),
  nextScheduledTouchAt: timestamp("next_scheduled_touch_at"),
  sequenceStatus: varchar("sequence_status", { length: 50 }).notNull().default("pending"),
  sequenceStartedAt: timestamp("sequence_started_at"),
  sequenceCompletedAt: timestamp("sequence_completed_at"),
  lastTouchSentAt: timestamp("last_touch_sent_at"),
  lastReplyAt: timestamp("last_reply_at"),
  lastBounceAt: timestamp("last_bounce_at"),
  unsubscribedAt: timestamp("unsubscribed_at"),
  stopReason: varchar("stop_reason", { length: 80 }),
  sequencePaused: boolean("sequence_paused").notNull().default(false),
  retryCount: integer("retry_count").notNull().default(0),
  lastTouchMessageId: varchar("last_touch_message_id", { length: 500 }),
  lastAttemptedTouchNumber: integer("last_attempted_touch_number"),
  lastError: varchar("last_error", { length: 2000 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  uniqueRecipientState: uniqueIndex("recipient_sequence_state_campaign_recipient_idx").on(
    table.campaignId,
    table.recipientId,
  ),
}));

export const suppressionListTable = pgTable("suppression_list", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  reason: varchar("reason", { length: 500 }).notNull(),
  addedAt: date("added_at").notNull().defaultNow(),
});

export const emailRepliesTable = pgTable("email_replies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  recipientId: integer("recipient_id").references(() => recipientTable.id).notNull(),
  fromEmail: varchar("from_email", { length: 255 }).notNull(),
  subject: varchar("subject", { length: 500 }).notNull(),
  bodyText: varchar("body_text", { length: 10000 }),
  bodyHtml: varchar("body_html", { length: 20000 }),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  readAt: timestamp("read_at"),
  messageId: varchar("message_id", { length: 500 }),
  inReplyTo: varchar("in_reply_to", { length: 500 }),
  direction: varchar("direction", { length: 20 }).notNull().default("inbound"),
  /** Conversation root reply id; null only briefly until first inbound row is updated to self-reference. */
  threadRootId: integer("thread_root_id").references((): AnyPgColumn => emailRepliesTable.id),
  /** When set, outbound row came from a scheduled/manual follow-up using this template id. */
  followUpTemplateId: varchar("follow_up_template_id", { length: 64 }),
});

export const followUpJobsTable = pgTable("follow_up_jobs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  campaignId: integer("campaign_id").references(() => campaignTable.id, { onDelete: "cascade" }).notNull(),
  scheduledAt: varchar("scheduled_at", { length: 30 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  templateId: varchar("template_id", { length: 64 }).notNull(),
  priorFollowUpCount: integer("prior_follow_up_count").notNull().default(0),
  engagement: varchar("engagement", { length: 20 }).notNull().default("sent"),
  /** Stop sending after this many minutes from job start; null = until queue exhausted */
  maxRunMinutes: integer("max_run_minutes"),
  /** ISO weekdays 1–7 when sends may run; null = every day */
  sendWeekdays: jsonb("send_weekdays").$type<number[] | null>(),
  pausedCampaignWasRunning: boolean("paused_campaign_was_running").notNull().default(false),
  errorMessage: varchar("error_message", { length: 2000 }),
  startedAt: timestamp("started_at", { mode: "string" }),
  completedAt: timestamp("completed_at", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});

export const replyIntelligenceTable = pgTable("reply_intelligence", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  replyId: integer("reply_id").references(() => emailRepliesTable.id).notNull(),
  campaignId: integer("campaign_id").references(() => campaignTable.id).notNull(),
  recipientId: integer("recipient_id").references(() => recipientTable.id).notNull(),
  intentCategory: varchar("intent_category", { length: 80 }).notNull(),
  intentConfidence: real("intent_confidence").notNull().default(0),
  sentiment: varchar("sentiment", { length: 30 }).notNull().default("neutral"),
  buyingSignalStrength: integer("buying_signal_strength").notNull().default(0),
  urgencyLevel: varchar("urgency_level", { length: 20 }).notNull().default("low"),
  meetingLikelihood: integer("meeting_likelihood").notNull().default(0),
  objectionType: varchar("objection_type", { length: 50 }),
  meetingReady: boolean("meeting_ready").notNull().default(false),
  leadTemperature: varchar("lead_temperature", { length: 20 }).notNull().default("cold"),
  hotLeadScore: integer("hot_lead_score").notNull().default(0),
  requiresHumanReview: boolean("requires_human_review").notNull().default(false),
  reviewStatus: varchar("review_status", { length: 30 }).notNull().default("pending"),
  reviewReason: varchar("review_reason", { length: 1000 }),
  autoReplyMode: varchar("auto_reply_mode", { length: 30 }).notNull().default("suggest_only"),
  detectedLanguage: varchar("detected_language", { length: 20 }).notNull().default("en"),
  replySummary: varchar("reply_summary", { length: 1000 }),
  suggestedReplyText: text("suggested_reply_text"),
  suggestedReplyHtml: text("suggested_reply_html"),
  suggestionDiagnostics: text("suggestion_diagnostics"),
  reasoning: text("reasoning"),
  responseTimeMinutes: integer("response_time_minutes"),
  priorReplyCount: integer("prior_reply_count").notNull().default(0),
  isHighValueLead: boolean("is_high_value_lead").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  uniqueReplyIntelligence: uniqueIndex("reply_intelligence_reply_idx").on(table.replyId),
  campaignRecipientIntelligence: uniqueIndex("reply_intelligence_campaign_reply_idx").on(table.campaignId, table.replyId),
}));
