import { integer, pgTable, varchar, text, date, boolean, timestamp, jsonb, numeric, index, unique, primaryKey, type AnyPgColumn } from "drizzle-orm/pg-core";
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
  /** Max sends per calendar day for this SMTP profile; null = unlimited, 0 = block all sending, 1-50 = cap */
  dailyEmailLimit: integer("daily_email_limit"),
  /**
   * Set to NOW() whenever dailyEmailLimit transitions from null/0 → a positive cap.
   * countSendsTodayForSmtp uses this as the lower bound so sends made under the
   * old "unlimited" setting don't count against the newly configured quota.
   */
  dailyLimitResetAt: timestamp("daily_limit_reset_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const campaignTable = pgTable("campaigns", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  smtpSettingsId: integer("smtp_settings_id").references(() => smtpSettingsTable.id, { onDelete: "restrict" }),
  /** Array of SMTP profile IDs for this campaign; replaces single smtpSettingsId for multi-sender support */
  smtpSettingIds: jsonb("smtp_setting_ids").$type<number[]>().default(sql`'[]'::jsonb`),
  name: varchar("name", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("draft" as CampaignStatus),
  subject: varchar("subject", { length: 255 }).notNull(),
  emailContent: text("email_content").notNull(),
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
  /** Daily send window start (HH:mm) in schedule timezone; null = no window */
  dailySendWindowStart: varchar("daily_send_window_start", { length: 8 }),
  /** Daily send window end (HH:mm); may be before start for cross-midnight windows */
  dailySendWindowEnd: varchar("daily_send_window_end", { length: 8 }),
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
}, (t) => [
  // CRM step 6 (migration 0034): the notification bell reads the newest rows of one user.
  index("user_notifications_user_created_idx").on(t.userId, t.createdAt),
]);

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
  customFields: varchar("custom_fields", { length: 5000 }),
  messageId: varchar("message_id", { length: 255 }),
  sentAt: date("sent_at"),
  delieveredAt: date("delivered_at"),
  /** Internal precise send time for open-tracking only (visible sent_at stays date). */
  sentTs: timestamp("sent_ts", { withTimezone: true, mode: "string" }),
  openedAt: timestamp("opened_at"),
  repliedAt: timestamp("replied_at"),
  usedSmtpEmail: varchar("used_smtp_email", { length: 255 }),
});

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
  /** When set, outbound row came from this scheduled bulk follow-up job. */
  followUpJobId: integer("follow_up_job_id").references((): AnyPgColumn => followUpJobsTable.id, { onDelete: "set null" }),
  /** CRM reply label: interested | not_interested | out_of_office | question | meeting_booked | neutral | bounce_unsubscribe */
  label: varchar("label", { length: 30 }),
  /** 'keyword' | 'ai' | 'manual' */
  labelSource: varchar("label_source", { length: 20 }),
  /** 0.0000 - 1.0000 */
  labelConfidence: numeric("label_confidence", { precision: 5, scale: 4 }),
  labeledAt: timestamp("labeled_at", { withTimezone: true }),
}, (t) => [
  index("email_replies_label_idx").on(t.label),
  // CRM step 9 (0036): thread and recipient look-ups (Inbox list, CRM labeling, needs-reply, timeline).
  index("email_replies_thread_idx").on(sql`(COALESCE(${t.threadRootId}, ${t.id}))`, t.direction, t.receivedAt.desc()),
  index("email_replies_recipient_idx").on(t.recipientId, t.direction, t.receivedAt),
]);

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

// ─── Subscription / Billing ───────────────────────────────────────────────────

export const plansTable = pgTable("plans", {
  code: varchar("code", { length: 20 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  smtpLimit: integer("smtp_limit").notNull(),
  dailyEmailLimit: integer("daily_email_limit").notNull(),
  inboxEnabled: boolean("inbox_enabled").notNull().default(false),
  followUpEnabled: boolean("follow_up_enabled").notNull().default(false),
  crmEnabled: boolean("crm_enabled").notNull().default(false),
  stripePriceId: varchar("stripe_price_id", { length: 255 }),
  priceUsd: numeric("price_usd", { precision: 10, scale: 2 }).notNull().default("0"),
});

export const subscriptionsTable = pgTable("subscriptions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull().unique(),
  planCode: varchar("plan_code", { length: 20 }).references(() => plansTable.code).notNull(),
  stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
  stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }).unique(),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const pendingRegistrationsTable = pgTable("pending_registrations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  stripeSessionId: varchar("stripe_session_id", { length: 255 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  planCode: varchar("plan_code", { length: 20 }).references(() => plansTable.code).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const paymentEventsTable = pgTable("payment_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  stripeEventId: varchar("stripe_event_id", { length: 255 }).notNull().unique(),
  type: varchar("type", { length: 100 }).notNull(),
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── CRM Lifecycle Module (migration 0031_crm_module.sql) ────────────────────
// Additive only: new crm_* tables. Keep this block and the SQL file in sync.

export const crmPipelinesTable = pgTable("crm_pipelines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  /** When the default rules were added (migration 0032); null = not yet. */
  rulesSeededAt: timestamp("rules_seeded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("crm_pipelines_user_idx").on(t.userId),
]);

export const crmPipelineStagesTable = pgTable("crm_pipeline_stages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  pipelineId: integer("pipeline_id").references(() => crmPipelinesTable.id, { onDelete: "cascade" }).notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  color: varchar("color", { length: 20 }).notNull().default("#6366f1"),
  position: integer("position").notNull().default(0),
  /** 'normal' | 'won' | 'lost' */
  type: varchar("type", { length: 20 }).notNull().default("normal"),
  /** Rule engine may not move contacts into or out of this stage; manual moves only. */
  manualOnly: boolean("manual_only").notNull().default(false),
  /** Contacts in this stage are excluded from follow-up sends. */
  stopFollowUps: boolean("stop_follow_ups").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("crm_pipeline_stages_pipeline_name_uq").on(t.pipelineId, t.name),
  index("crm_pipeline_stages_pipeline_idx").on(t.pipelineId, t.position),
]);

export const crmContactsTable = pgTable("crm_contacts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  /** Always stored trimmed + lowercase. */
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  company: varchar("company", { length: 255 }),
  customFields: jsonb("custom_fields").$type<Record<string, string>>(),
  notes: text("notes"),
  pipelineId: integer("pipeline_id").references(() => crmPipelinesTable.id, { onDelete: "set null" }),
  stageId: integer("stage_id").references(() => crmPipelineStagesTable.id, { onDelete: "set null" }),
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }),
  score: integer("score").notNull().default(0),
  /** 'hot' | 'warm' | 'cold' */
  scoreTier: varchar("score_tier", { length: 10 }).notNull().default("cold"),
  lastReplyLabel: varchar("last_reply_label", { length: 30 }),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
  lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
  needsReply: boolean("needs_reply").notNull().default(false),
  needsReplySince: timestamp("needs_reply_since", { withTimezone: true }),
  needsReplyNotifiedAt: timestamp("needs_reply_notified_at", { withTimezone: true }),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  /** "Mark as done" in the Inbox (migration 0034): replies before this time need no reply. */
  needsReplyClearedAt: timestamp("needs_reply_cleared_at", { withTimezone: true }),
  /** Parts of the current score, "why this score" (migration 0035, step 7). */
  scoreBreakdown: jsonb("score_breakdown").$type<Array<{ key: string; source: string; label: string; points: number }>>(),
  scoreUpdatedAt: timestamp("score_updated_at", { withTimezone: true }),
  /** Set by the stop_follow_ups rule action, a bounce or an unsubscribe (migration 0032). */
  followUpsStopped: boolean("follow_ups_stopped").notNull().default(false),
  followUpsStoppedAt: timestamp("follow_ups_stopped_at", { withTimezone: true }),
  /** Human opens counted by the CRM (every open, not only the first per campaign). */
  openCount: integer("open_count").notNull().default(0),
  lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("crm_contacts_user_email_uq").on(t.userId, t.email),
  index("crm_contacts_user_stage_idx").on(t.userId, t.stageId),
  index("crm_contacts_user_needs_reply_idx").on(t.userId, t.needsReply),
  index("crm_contacts_user_score_idx").on(t.userId, t.score),
  index("crm_contacts_waiting_idx").on(t.userId, t.needsReplySince).where(sql`needs_reply`),
  index("crm_contacts_score_updated_idx").on(t.scoreUpdatedAt.asc().nullsFirst()),
  // Step 9 (0036): default "recent activity" sort of the CRM table.
  index("crm_contacts_user_recent_idx").on(t.userId, sql`(GREATEST(${t.updatedAt}, COALESCE(${t.lastInboundAt}, ${t.updatedAt}))) DESC`, t.id.desc()),
]);

/** Links every campaign recipient row to exactly one CRM contact. */
export const crmContactRecipientsTable = pgTable("crm_contact_recipients", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  contactId: integer("contact_id").references(() => crmContactsTable.id, { onDelete: "cascade" }).notNull(),
  recipientId: integer("recipient_id").references(() => recipientTable.id, { onDelete: "cascade" }).notNull(),
  campaignId: integer("campaign_id").references(() => campaignTable.id, { onDelete: "cascade" }).notNull(),
}, (t) => [
  unique("crm_contact_recipients_recipient_uq").on(t.recipientId),
  index("crm_contact_recipients_contact_idx").on(t.contactId),
  index("crm_contact_recipients_campaign_idx").on(t.campaignId),
]);

export const crmRulesTable = pgTable("crm_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  pipelineId: integer("pipeline_id").references(() => crmPipelinesTable.id, { onDelete: "cascade" }).notNull(),
  /** null = rule applies from any stage */
  fromStageId: integer("from_stage_id").references(() => crmPipelineStagesTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  /** e.g. email_sent | email_opened | reply_received | reply_labeled | bounced | time_tick */
  trigger: varchar("trigger", { length: 50 }).notNull(),
  /** { op: 'AND' | 'OR', items: [...] } — items may be nested groups */
  conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull().default(sql`'{"op":"AND","items":[]}'::jsonb`),
  /** [{ type: 'move_to_stage', stageId: 3 }, ...] */
  actions: jsonb("actions").$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
  forwardOnly: boolean("forward_only").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("crm_rules_pipeline_active_idx").on(t.pipelineId, t.isActive),
]);

export const crmStageHistoryTable = pgTable("crm_stage_history", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  contactId: integer("contact_id").references(() => crmContactsTable.id, { onDelete: "cascade" }).notNull(),
  fromStageId: integer("from_stage_id").references(() => crmPipelineStagesTable.id, { onDelete: "set null" }),
  toStageId: integer("to_stage_id").references(() => crmPipelineStagesTable.id, { onDelete: "set null" }),
  ruleId: integer("rule_id").references(() => crmRulesTable.id, { onDelete: "set null" }),
  changedByUserId: integer("changed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** 'rule' | 'manual' | 'backfill' */
  reason: varchar("reason", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("crm_stage_history_contact_idx").on(t.contactId, t.createdAt),
]);

export const crmTagsTable = pgTable("crm_tags", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  color: varchar("color", { length: 20 }).notNull().default("#6366f1"),
  /** 'contact' | 'campaign' | 'both' */
  scope: varchar("scope", { length: 20 }).notNull().default("both"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("crm_tags_user_name_uq").on(t.userId, t.name),
]);

export const crmContactTagsTable = pgTable("crm_contact_tags", {
  contactId: integer("contact_id").references(() => crmContactsTable.id, { onDelete: "cascade" }).notNull(),
  tagId: integer("tag_id").references(() => crmTagsTable.id, { onDelete: "cascade" }).notNull(),
}, (t) => [
  primaryKey({ name: "crm_contact_tags_pk", columns: [t.contactId, t.tagId] }),
  index("crm_contact_tags_tag_idx").on(t.tagId),
]);

export const crmCampaignTagsTable = pgTable("crm_campaign_tags", {
  campaignId: integer("campaign_id").references(() => campaignTable.id, { onDelete: "cascade" }).notNull(),
  tagId: integer("tag_id").references(() => crmTagsTable.id, { onDelete: "cascade" }).notNull(),
}, (t) => [
  primaryKey({ name: "crm_campaign_tags_pk", columns: [t.campaignId, t.tagId] }),
  index("crm_campaign_tags_tag_idx").on(t.tagId),
]);

/** CRM options of one campaign (migration 0033, step 5): start pipeline + tags added to every lead. */
export const crmCampaignSettingsTable = pgTable("crm_campaign_settings", {
  campaignId: integer("campaign_id").primaryKey().references(() => campaignTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  /** null = the user's default pipeline */
  pipelineId: integer("pipeline_id").references(() => crmPipelinesTable.id, { onDelete: "set null" }),
  autoTagIds: integer("auto_tag_ids").array().notNull().default(sql`'{}'::integer[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("crm_campaign_settings_user_idx").on(t.userId),
]);

/** Every score change, so the UI can explain why a lead has its score. */
export const crmScoreEventsTable = pgTable("crm_score_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  contactId: integer("contact_id").references(() => crmContactsTable.id, { onDelete: "cascade" }).notNull(),
  points: integer("points").notNull(),
  reason: varchar("reason", { length: 255 }).notNull(),
  /** 'reply' | 'open' | 'label' | 'rule' | 'manual' | 'decay' | 'backfill' */
  sourceType: varchar("source_type", { length: 30 }).notNull(),
  sourceId: integer("source_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("crm_score_events_contact_idx").on(t.contactId, t.createdAt),
]);

/** Follow-ups planned by the schedule_follow_up rule action (migration 0032). Sent by workers/crmWorker.ts. */
export const crmScheduledFollowUpsTable = pgTable("crm_scheduled_follow_ups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  contactId: integer("contact_id").references(() => crmContactsTable.id, { onDelete: "cascade" }).notNull(),
  recipientId: integer("recipient_id").references(() => recipientTable.id, { onDelete: "cascade" }).notNull(),
  campaignId: integer("campaign_id").references(() => campaignTable.id, { onDelete: "cascade" }).notNull(),
  ruleId: integer("rule_id").references(() => crmRulesTable.id, { onDelete: "set null" }),
  /** campaigns.follow_up_templates[].id; null = next unsent template */
  templateId: varchar("template_id", { length: 64 }),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  /** 'pending' | 'sent' | 'cancelled' | 'failed' */
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  error: varchar("error", { length: 1000 }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("crm_scheduled_follow_ups_due_idx").on(t.status, t.dueAt),
  index("crm_scheduled_follow_ups_contact_idx").on(t.contactId, t.status),
]);

/** One row per user. */
export const crmSettingsTable = pgTable("crm_settings", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  needsReplyAfterHours: integer("needs_reply_after_hours").notNull().default(24),
  reminderEmailDigest: boolean("reminder_email_digest").notNull().default(false),
  /** When the daily "waiting for your reply" email was last sent (migration 0034). */
  lastDigestSentAt: timestamp("last_digest_sent_at", { withTimezone: true }),
  /** Point values per event; empty object = use built-in defaults. */
  /** Lead scoring weights (step 7, see lib/crm/leadScoring.ts). Empty object = built-in defaults. */
  scoreWeights: jsonb("score_weights").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  hotThreshold: integer("hot_threshold").notNull().default(70),
  warmThreshold: integer("warm_threshold").notNull().default(40),
  aiLabelingEnabled: boolean("ai_labeling_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
