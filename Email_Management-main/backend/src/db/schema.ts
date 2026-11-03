import { integer, pgTable, varchar, text, date, boolean, timestamp, jsonb, numeric, index, uniqueIndex, unique, primaryKey, smallint, bigint, char, time, check, type AnyPgColumn } from "drizzle-orm/pg-core";
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
  /** Lead Engine (migration 0037). */
  leadGenEnabled: boolean("lead_gen_enabled").notNull().default(false),
  /** New leads per user per day (user timezone day). */
  leadGenDailyLimit: integer("lead_gen_daily_limit").notNull().default(50),
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

// ── Script generation ─────────────────────────────────────────────────────────
// A company list uploaded through the AI agent chat. Scripts are generated on
// demand, one company + one channel at a time, and saved so they are never paid
// for twice.

export const scriptFilesTable = pgTable("script_files", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  /** The user's chat prompt sent with the file — may steer focus and tone of scripts. */
  userInstructions: text("user_instructions"),
  totalRows: integer("total_rows").notNull(),
  companyCount: integer("company_count").notNull(),
  /** { totalRows, validRows, missingWebsite, invalidWebsite, missingCompanyName, duplicates } */
  report: jsonb("report").$type<Record<string, number>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("script_files_user_idx").on(t.userId, t.createdAt)]);

export const scriptCompaniesTable = pgTable("script_companies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  fileId: integer("file_id").references(() => scriptFilesTable.id, { onDelete: "cascade" }).notNull(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  /** Row number in the uploaded sheet (header = 1). */
  rowNumber: integer("row_number").notNull(),
  companyName: varchar("company_name", { length: 255 }).notNull(),
  website: varchar("website", { length: 500 }).notNull(),
  /** Other columns from the file (industry, contact name, city…). */
  extraFields: jsonb("extra_fields").$type<Record<string, string>>().notNull().default({}),
  /** Website text cached after the first fetch, so later scripts skip the fetch. */
  websiteContent: text("website_content"),
  websiteFetchedAt: timestamp("website_fetched_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("script_companies_file_idx").on(t.fileId, t.rowNumber)]);

export type ScriptType = "cold_email" | "cold_call" | "linkedin";

export const companyScriptsTable = pgTable("company_scripts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  companyId: integer("company_id").references(() => scriptCompaniesTable.id, { onDelete: "cascade" }).notNull(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
  type: varchar("type", { length: 20 }).$type<ScriptType>().notNull(),
  /** "ok" | "insufficient_data" */
  status: varchar("status", { length: 30 }).notNull(),
  /** "website" (problem seen on their site) | "industry" (best-guess from their industry) */
  angle: varchar("angle", { length: 20 }).notNull().default("website"),
  whatTheySell: text("what_they_sell").notNull().default(""),
  problemStatement: text("problem_statement").notNull().default(""),
  painPoints: jsonb("pain_points").$type<string[]>().notNull().default([]),
  recommendedServices: jsonb("recommended_services").$type<string[]>().notNull().default([]),
  /** Cold email only. */
  subject: varchar("subject", { length: 255 }),
  script: text("script").notNull().default(""),
  wordCount: integer("word_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("company_scripts_company_type_uq").on(t.companyId, t.type)]);

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

// ─── Lead Engine (migration 0037_lead_engine.sql) ───────────────────────────
// Master data (shared by all users) + collection pipeline + per-user workspace + compliance.
// See the Lead Engine Use Case Document, section 7. SQL helpers live in lib/leadgen/leadStore.ts.

const tsz = (name: string) => timestamp(name, { withTimezone: true });

/** Every data source: on/off, rate limit, daily cap. Seeded by the migration. */
export const leadSourcesTable = pgTable("sources", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  /** osm | ddg | serp_api | website | search_linkedin | pdl ... */
  code: varchar("code", { length: 30 }).notNull(),
  /** directory | search | website | provider | manual */
  type: varchar("type", { length: 20 }).notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  ratePerMin: integer("rate_per_min"),
  dailyCap: integer("daily_cap"),
  notes: text("notes"),
  /** No requests before this time (set after a 429/403/CAPTCHA). */
  cooldownUntil: tsz("cooldown_until"),
}, (t) => [
  unique("sources_code_uq").on(t.code),
  check("sources_type_chk", sql`${t.type} IN ('directory', 'search', 'website', 'provider', 'manual')`),
]);

/** One master record per business (best known value of every field). */
export const companiesTable = pgTable("companies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 255 }).notNull(),
  /** Lowercase, legal suffixes removed; used for dedupe. */
  normalizedName: varchar("normalized_name", { length: 255 }).notNull(),
  /** Lowercase, without www. */
  primaryDomain: varchar("primary_domain", { length: 255 }),
  websiteUrl: varchar("website_url", { length: 500 }),
  /** Max 2,000 chars. */
  description: text("description"),
  category: varchar("category", { length: 100 }),
  industry: varchar("industry", { length: 100 }),
  employeeRange: varchar("employee_range", { length: 20 }),
  foundedYear: smallint("founded_year"),
  address: varchar("address", { length: 500 }),
  city: varchar("city", { length: 120 }),
  region: varchar("region", { length: 120 }),
  countryCode: char("country_code", { length: 2 }),
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  techStack: jsonb("tech_stack").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  hiringSignals: jsonb("hiring_signals").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Title / headings / meta keywords of the website (short phrases), matched against a search's focus. */
  siteTopics: jsonb("site_topics").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** active | closed | unknown */
  status: varchar("status", { length: 20 }).notNull().default("active"),
  /** 0-100: how complete the data is. */
  dataQuality: smallint("data_quality").notNull().default(0),
  firstSeenAt: tsz("first_seen_at").notNull().defaultNow(),
  lastEnrichedAt: tsz("last_enriched_at"),
  nextRefreshAt: tsz("next_refresh_at"),
  deletedAt: tsz("deleted_at"),
}, (t) => [
  uniqueIndex("companies_domain_uq").on(t.primaryDomain).where(sql`deleted_at IS NULL AND primary_domain IS NOT NULL`),
  index("companies_name_city_idx").on(t.normalizedName, t.city, t.countryCode),
  index("companies_category_city_idx").on(t.category, t.city, t.countryCode),
  index("companies_next_refresh_idx").on(t.nextRefreshAt).where(sql`deleted_at IS NULL`),
  check("companies_founded_year_chk", sql`${t.foundedYear} IS NULL OR ${t.foundedYear} BETWEEN 1800 AND 2100`),
  check("companies_status_chk", sql`${t.status} IN ('active', 'closed', 'unknown')`),
  check("companies_data_quality_chk", sql`${t.dataQuality} BETWEEN 0 AND 100`),
  check("companies_description_len_chk", sql`${t.description} IS NULL OR length(${t.description}) <= 2000`),
]);

/** All domains of a company (.com, .pk ...). Dedupe matches on this table first. */
export const companyDomainsTable = pgTable("company_domains", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }).notNull(),
  domain: varchar("domain", { length: 255 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
}, (t) => [
  unique("company_domains_domain_uq").on(t.domain),
  index("company_domains_company_idx").on(t.companyId),
]);

/** Decision makers. Public, business-context data only. */
export const peopleTable = pgTable("people", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  normalizedName: varchar("normalized_name", { length: 255 }).notNull(),
  title: varchar("title", { length: 255 }),
  /** owner | c_level | director | manager | staff */
  seniority: varchar("seniority", { length: 20 }),
  department: varchar("department", { length: 50 }),
  currentCompanyId: integer("current_company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  city: varchar("city", { length: 120 }),
  countryCode: char("country_code", { length: 2 }),
  /** Normalized: https, no query string. */
  linkedinUrl: varchar("linkedin_url", { length: 500 }),
  confidence: smallint("confidence").notNull().default(50),
  firstSeenAt: tsz("first_seen_at").notNull().defaultNow(),
  lastSeenAt: tsz("last_seen_at").notNull().defaultNow(),
  nextRefreshAt: tsz("next_refresh_at"),
  deletedAt: tsz("deleted_at"),
}, (t) => [
  uniqueIndex("people_linkedin_uq").on(t.linkedinUrl).where(sql`linkedin_url IS NOT NULL AND deleted_at IS NULL`),
  index("people_company_idx").on(t.currentCompanyId),
  index("people_name_company_idx").on(t.normalizedName, t.currentCompanyId),
  index("people_next_refresh_idx").on(t.nextRefreshAt).where(sql`deleted_at IS NULL`),
  check("people_seniority_chk", sql`${t.seniority} IS NULL OR ${t.seniority} IN ('owner', 'c_level', 'director', 'manager', 'staff')`),
  check("people_confidence_chk", sql`${t.confidence} BETWEEN 0 AND 100`),
]);

/** Which person works / worked where. A job change ends the old row and adds a new one. */
export const employmentsTable = pgTable("employments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  personId: integer("person_id").references(() => peopleTable.id, { onDelete: "cascade" }).notNull(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }).notNull(),
  title: varchar("title", { length: 255 }),
  isCurrent: boolean("is_current").notNull().default(true),
  firstSeenAt: tsz("first_seen_at").notNull().defaultNow(),
  endedAt: tsz("ended_at"),
}, (t) => [
  uniqueIndex("employments_current_uq").on(t.personId, t.companyId).where(sql`is_current`),
  index("employments_company_current_idx").on(t.companyId).where(sql`is_current`),
]);

/** Emails and phones of exactly one company OR one person. */
export const contactPointsTable = pgTable("contact_points", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
  personId: integer("person_id").references(() => peopleTable.id, { onDelete: "cascade" }),
  /** email | phone | whatsapp */
  type: varchar("type", { length: 10 }).notNull(),
  value: varchar("value", { length: 255 }).notNull(),
  /** Email lowercase; phone E.164. */
  valueNormalized: varchar("value_normalized", { length: 255 }).notNull(),
  /** generic | direct | sales | support */
  label: varchar("label", { length: 20 }),
  /** unverified | valid | invalid | risky | guessed */
  verifyStatus: varchar("verify_status", { length: 15 }).notNull().default("unverified"),
  mxValid: boolean("mx_valid"),
  sourceId: integer("source_id").references(() => leadSourcesTable.id, { onDelete: "set null" }),
  sourceUrl: varchar("source_url", { length: 500 }),
  firstSeenAt: tsz("first_seen_at").notNull().defaultNow(),
  lastVerifiedAt: tsz("last_verified_at"),
}, (t) => [
  uniqueIndex("contact_points_uq").on(t.type, t.valueNormalized, sql`COALESCE(${t.companyId}, 0)`, sql`COALESCE(${t.personId}, 0)`),
  index("contact_points_value_idx").on(t.valueNormalized),
  index("contact_points_company_idx").on(t.companyId).where(sql`company_id IS NOT NULL`),
  index("contact_points_person_idx").on(t.personId).where(sql`person_id IS NOT NULL`),
  check("contact_points_one_owner", sql`num_nonnulls(${t.companyId}, ${t.personId}) = 1`),
  check("contact_points_type_chk", sql`${t.type} IN ('email', 'phone', 'whatsapp')`),
  check("contact_points_label_chk", sql`${t.label} IS NULL OR ${t.label} IN ('generic', 'direct', 'sales', 'support')`),
  check("contact_points_verify_chk", sql`${t.verifyStatus} IN ('unverified', 'valid', 'invalid', 'risky', 'guessed')`),
]);

/** Social links of exactly one company OR one person (URL + where it was found). */
export const socialProfilesTable = pgTable("social_profiles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
  personId: integer("person_id").references(() => peopleTable.id, { onDelete: "cascade" }),
  /** linkedin | facebook | instagram | x | youtube */
  platform: varchar("platform", { length: 20 }).notNull(),
  url: varchar("url", { length: 500 }).notNull(),
  /** website_link | search_result | provider | manual */
  foundVia: varchar("found_via", { length: 20 }).notNull(),
  /** Search result title (search engine only). */
  snippet: varchar("snippet", { length: 300 }),
  lastCheckedAt: tsz("last_checked_at").notNull().defaultNow(),
}, (t) => [
  unique("social_profiles_platform_url_uq").on(t.platform, t.url),
  index("social_profiles_company_idx").on(t.companyId).where(sql`company_id IS NOT NULL`),
  index("social_profiles_person_idx").on(t.personId).where(sql`person_id IS NOT NULL`),
  check("social_profiles_one_owner", sql`num_nonnulls(${t.companyId}, ${t.personId}) = 1`),
  check("social_profiles_platform_chk", sql`${t.platform} IN ('linkedin', 'facebook', 'instagram', 'x', 'youtube')`),
  check("social_profiles_found_via_chk", sql`${t.foundVia} IN ('website_link', 'search_result', 'provider', 'manual')`),
]);

/** Pages read from a company site. Raw HTML is never stored, only its hash. */
export const webPagesTable = pgTable("web_pages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }).notNull(),
  url: varchar("url", { length: 500 }).notNull(),
  /** home | about | contact | team | careers | other */
  pageType: varchar("page_type", { length: 20 }).notNull(),
  httpStatus: smallint("http_status"),
  /** sha256 hex; a changed hash means extract again. */
  contentHash: char("content_hash", { length: 64 }),
  robotsAllowed: boolean("robots_allowed").notNull().default(true),
  lastFetchedAt: tsz("last_fetched_at"),
}, (t) => [
  unique("web_pages_url_uq").on(t.url),
  index("web_pages_company_idx").on(t.companyId),
  check("web_pages_type_chk", sql`${t.pageType} IN ('home', 'about', 'contact', 'team', 'careers', 'other')`),
]);

/** Two duplicate records joined (undo + audit). */
export const entityMergesTable = pgTable("entity_merges", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  /** company | person */
  entityType: varchar("entity_type", { length: 10 }).notNull(),
  winnerId: integer("winner_id").notNull(),
  loserId: integer("loser_id").notNull(),
  /** same_domain | same_linkedin | name_city */
  reason: varchar("reason", { length: 100 }).notNull(),
  mergedAt: tsz("merged_at").notNull().defaultNow(),
}, (t) => [
  index("entity_merges_loser_idx").on(t.entityType, t.loserId),
  check("entity_merges_type_chk", sql`${t.entityType} IN ('company', 'person')`),
]);

/** The user's ICP: what to look for. Runs once or on a schedule. */
export const savedSearchesTable = pgTable("saved_searches", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  /** Key of lib/leadgen/categories.ts, or null for keyword-only search. */
  category: varchar("category", { length: 100 }),
  keywords: jsonb("keywords").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  city: varchar("city", { length: 120 }),
  region: varchar("region", { length: 120 }),
  countryCode: char("country_code", { length: 2 }),
  includePeople: boolean("include_people").notNull().default(false),
  /** {titles:['owner','ceo'], seniority:[...]} */
  personFilters: jsonb("person_filters").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  targetPerRun: integer("target_per_run").notNull().default(20),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: tsz("created_at").notNull().defaultNow(),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
}, (t) => [
  index("saved_searches_user_active_idx").on(t.userId, t.isActive),
  check("saved_searches_target_chk", sql`${t.targetPerRun} BETWEEN 1 AND 100`),
]);

/** When a saved search runs. One schedule per search. */
export const searchSchedulesTable = pgTable("search_schedules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  savedSearchId: integer("saved_search_id").references(() => savedSearchesTable.id, { onDelete: "cascade" }).notNull(),
  /** daily | weekly */
  frequency: varchar("frequency", { length: 10 }).notNull().default("daily"),
  /** 'HH:MM:SS' in `timezone`. */
  runAtLocal: time("run_at_local").notNull().default("09:00"),
  /** IANA, e.g. Asia/Karachi. */
  timezone: varchar("timezone", { length: 50 }).notNull().default("Asia/Karachi"),
  /** Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64. 127 = every day. */
  weekdaysMask: smallint("weekdays_mask").notNull().default(127),
  /** UTC. */
  nextRunAt: tsz("next_run_at"),
  lastRunAt: tsz("last_run_at"),
  isPaused: boolean("is_paused").notNull().default(false),
  /** 3 = auto-pause. */
  consecutiveFailures: smallint("consecutive_failures").notNull().default(0),
  createdAt: tsz("created_at").notNull().defaultNow(),
}, (t) => [
  unique("search_schedules_search_uq").on(t.savedSearchId),
  index("search_schedules_due_idx").on(t.nextRunAt).where(sql`NOT is_paused`),
  check("search_schedules_frequency_chk", sql`${t.frequency} IN ('daily', 'weekly')`),
  check("search_schedules_mask_chk", sql`${t.weekdaysMask} BETWEEN 1 AND 127`),
]);

/** One run: scheduled ('search'), 'manual' (run now) or system 'refresh' (user_id null). */
export const scrapeRunsTable = pgTable("scrape_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  savedSearchId: integer("saved_search_id").references(() => savedSearchesTable.id, { onDelete: "set null" }),
  scheduleId: integer("schedule_id").references(() => searchSchedulesTable.id, { onDelete: "set null" }),
  /** Date in the user's timezone. */
  runDate: date("run_date").notNull(),
  /** search | refresh | manual */
  runType: varchar("run_type", { length: 10 }).notNull(),
  /** queued | running | done | partial | failed | cancelled */
  status: varchar("status", { length: 15 }).notNull().default("queued"),
  /** {discovered, new_companies, new_people, updated, failed} */
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: tsz("created_at").notNull().defaultNow(),
  startedAt: tsz("started_at"),
  heartbeatAt: tsz("heartbeat_at"),
  completedAt: tsz("completed_at"),
  /** User-friendly. */
  error: varchar("error", { length: 1000 }),
}, (t) => [
  uniqueIndex("scrape_runs_once_per_day").on(t.scheduleId, t.runDate).where(sql`schedule_id IS NOT NULL`),
  index("scrape_runs_user_started_idx").on(t.userId, t.startedAt.desc()),
  index("scrape_runs_active_idx").on(t.status).where(sql`status IN ('queued', 'running')`),
  check("scrape_runs_type_chk", sql`${t.runType} IN ('search', 'refresh', 'manual')`),
  check("scrape_runs_status_chk", sql`${t.status} IN ('queued', 'running', 'done', 'partial', 'failed', 'cancelled')`),
]);

/** Every extracted fact: source, URL, time, confidence (provenance). Purged after 180 days. */
export const observationsTable = pgTable("observations", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  /** company | person */
  entityType: varchar("entity_type", { length: 10 }).notNull(),
  /** Polymorphic, no FK (log table). */
  entityId: integer("entity_id").notNull(),
  field: varchar("field", { length: 50 }).notNull(),
  value: jsonb("value").$type<unknown>().notNull(),
  sourceId: integer("source_id").references(() => leadSourcesTable.id, { onDelete: "set null" }),
  sourceUrl: varchar("source_url", { length: 500 }),
  runId: integer("run_id").references(() => scrapeRunsTable.id, { onDelete: "set null" }),
  confidence: smallint("confidence").notNull().default(50),
  observedAt: tsz("observed_at").notNull().defaultNow(),
}, (t) => [
  index("observations_entity_idx").on(t.entityType, t.entityId, t.field),
  index("observations_observed_idx").on(t.observedAt),
  index("observations_external_id_idx").on(sql`(${t.value} #>> '{}')`).where(sql`field = 'external_id'`),
  check("observations_type_chk", sql`${t.entityType} IN ('company', 'person')`),
  check("observations_confidence_chk", sql`${t.confidence} BETWEEN 0 AND 100`),
]);

/** Task queue of a run. Each task is retried on its own (max 3 attempts). */
export const scrapeTasksTable = pgTable("scrape_tasks", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  runId: integer("run_id").references(() => scrapeRunsTable.id, { onDelete: "cascade" }).notNull(),
  sourceId: integer("source_id").references(() => leadSourcesTable.id, { onDelete: "set null" }),
  /** discover | fetch_site | find_social | verify_email | provider_enrich */
  taskType: varchar("task_type", { length: 20 }).notNull(),
  /** URL or query. */
  target: varchar("target", { length: 500 }).notNull(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** pending | running | done | failed | skipped | cancelled */
  status: varchar("status", { length: 12 }).notNull().default("pending"),
  attempts: smallint("attempts").notNull().default(0),
  /** Higher first. User runs outrank the nightly refresh. */
  priority: smallint("priority").notNull().default(0),
  nextAttemptAt: tsz("next_attempt_at").notNull().defaultNow(),
  lockedAt: tsz("locked_at"),
  heartbeatAt: tsz("heartbeat_at"),
  lastError: varchar("last_error", { length: 500 }),
  createdAt: tsz("created_at").notNull().defaultNow(),
  completedAt: tsz("completed_at"),
}, (t) => [
  index("scrape_tasks_claim_idx").on(t.status, t.nextAttemptAt, t.priority).where(sql`status = 'pending'`),
  index("scrape_tasks_running_idx").on(t.heartbeatAt).where(sql`status = 'running'`),
  index("scrape_tasks_run_idx").on(t.runId, t.status),
  unique("scrape_tasks_run_target_uq").on(t.runId, t.taskType, t.target),
  check("scrape_tasks_type_chk", sql`${t.taskType} IN ('discover', 'fetch_site', 'find_social', 'verify_email', 'provider_enrich')`),
  check("scrape_tasks_status_chk", sql`${t.status} IN ('pending', 'running', 'done', 'failed', 'skipped', 'cancelled')`),
]);

/** Requests and blocks per source per day (daily cap + block detection). */
export const sourceDailyUsageTable = pgTable("source_daily_usage", {
  sourceId: integer("source_id").references(() => leadSourcesTable.id, { onDelete: "cascade" }).notNull(),
  day: date("day").notNull(),
  requestsUsed: integer("requests_used").notNull().default(0),
  /** 429 / 403 / CAPTCHA. */
  blockedCount: integer("blocked_count").notNull().default(0),
}, (t) => [primaryKey({ name: "source_daily_usage_pk", columns: [t.sourceId, t.day] })]);

/** Cached answers of outside APIs: geocode 30 days, Overpass 7 days, search 1 day. */
export const leadgenCacheTable = pgTable("leadgen_cache", {
  cacheKey: varchar("cache_key", { length: 300 }).primaryKey(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  expiresAt: tsz("expires_at").notNull(),
}, (t) => [index("leadgen_cache_expires_idx").on(t.expiresAt)]);

/** Joins master data to a user: which lead the user got and its status. */
export const workspaceLeadsTable = pgTable("workspace_leads", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }).notNull(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }).notNull(),
  personId: integer("person_id").references(() => peopleTable.id, { onDelete: "cascade" }),
  savedSearchId: integer("saved_search_id").references(() => savedSearchesTable.id, { onDelete: "set null" }),
  firstRunId: integer("first_run_id").references(() => scrapeRunsTable.id, { onDelete: "set null" }),
  /** new | reviewed | saved_to_crm | in_campaign | rejected */
  status: varchar("status", { length: 20 }).notNull().default("new"),
  fitScore: smallint("fit_score").notNull().default(0),
  /** hot | warm | cold */
  scoreTier: varchar("score_tier", { length: 10 }).notNull().default("cold"),
  /** "Why this score": [{key, label, points}]. */
  scoreBreakdown: jsonb("score_breakdown").$type<Array<{ key: string; label: string; points: number }>>().notNull().default(sql`'[]'::jsonb`),
  crmContactId: integer("crm_contact_id").references(() => crmContactsTable.id, { onDelete: "set null" }),
  foundAt: tsz("found_at").notNull().defaultNow(),
  updatedAt: tsz("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("workspace_leads_uq").on(t.userId, t.companyId, sql`COALESCE(${t.personId}, 0)`),
  index("workspace_leads_user_status_idx").on(t.userId, t.status, t.fitScore.desc()),
  index("workspace_leads_search_found_idx").on(t.savedSearchId, t.foundAt.desc()),
  check("workspace_leads_status_chk", sql`${t.status} IN ('new', 'reviewed', 'saved_to_crm', 'in_campaign', 'rejected')`),
  check("workspace_leads_tier_chk", sql`${t.scoreTier} IN ('hot', 'warm', 'cold')`),
  check("workspace_leads_score_chk", sql`${t.fitScore} BETWEEN 0 AND 100`),
]);

/** Opt-out / erasure / access requests. Only the identifier's hash is stored. */
export const dataSubjectRequestsTable = pgTable("data_subject_requests", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  /** opt_out | erasure | access */
  requestType: varchar("request_type", { length: 10 }).notNull(),
  /** sha256 of the email or LinkedIn URL. */
  identifierHash: char("identifier_hash", { length: 64 }).notNull(),
  /** email | domain | linkedin_url */
  identifierType: varchar("identifier_type", { length: 15 }).notNull(),
  /** received | verified | done | rejected */
  status: varchar("status", { length: 12 }).notNull().default("received"),
  /** sha256 of the one-time confirmation token. */
  verifyTokenHash: char("verify_token_hash", { length: 64 }),
  receivedAt: tsz("received_at").notNull().defaultNow(),
  verifiedAt: tsz("verified_at"),
  processedAt: tsz("processed_at"),
}, (t) => [
  index("dsr_identifier_idx").on(t.identifierHash),
  check("dsr_type_chk", sql`${t.requestType} IN ('opt_out', 'erasure', 'access')`),
  check("dsr_identifier_type_chk", sql`${t.identifierType} IN ('email', 'domain', 'linkedin_url')`),
  check("dsr_status_chk", sql`${t.status} IN ('received', 'verified', 'done', 'rejected')`),
]);

/** Hashes of people/domains that asked to be removed; daily runs never collect them again. */
export const doNotCollectTable = pgTable("do_not_collect", {
  identifierHash: char("identifier_hash", { length: 64 }).primaryKey(),
  /** email | domain | linkedin_url */
  identifierType: varchar("identifier_type", { length: 15 }).notNull(),
  addedAt: tsz("added_at").notNull().defaultNow(),
}, (t) => [check("do_not_collect_type_chk", sql`${t.identifierType} IN ('email', 'domain', 'linkedin_url')`)]);
