import { integer, pgTable, varchar, date, boolean, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
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
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const campaignTable = pgTable("campaigns", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => usersTable.id).notNull(),
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
  availableColumns: varchar("available_columns", { length: 2000 }),
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
  customFields: varchar("custom_fields", { length: 5000 }),
  messageId: varchar("message_id", { length: 255 }),
  sentAt: date("sent_at"),
  delieveredAt: date("delivered_at"),
  openedAt: timestamp("opened_at"),
  repliedAt: timestamp("replied_at"),
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
});
