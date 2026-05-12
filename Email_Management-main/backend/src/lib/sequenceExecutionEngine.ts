import {
  campaignSequenceTouchesTable,
  recipientSequenceStateTable,
  recipientTable,
  suppressionListTable,
} from "../db/schema.js";
import { db, dbPool } from "./db.js";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

export type SequenceStatus =
  | "pending"
  | "active"
  | "paused"
  | "completed"
  | "stopped"
  | "bounced"
  | "replied"
  | "unsubscribed";

export type SequenceStopReason =
  | "replied"
  | "unsubscribed"
  | "bounced"
  | "manual_pause"
  | "campaign_paused"
  | "sequence_complete"
  | "error_limit"
  | "meeting_ready"
  | "positive_interest"
  | "objection"
  | "not_interested"
  | "spam_complaint";

export type TouchExecutionStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "skipped";

export interface ClaimedFollowUpRow {
  touchId: number;
  campaignId: number;
  recipientId: number;
  touchNumber: number;
  email: string;
  name: string | null;
  personalizedSubject: string | null;
  personalizedBody: string;
  personalizedText: string | null;
  sequenceType: string;
  toneUsed: string | null;
  ctaType: string | null;
  ctaText: string | null;
  objective: string;
  nextTouchNumber: number | null;
  nextDelayDays: number | null;
}

export interface SequenceProgressSummary {
  campaignId: number;
  totalRecipients: number;
  activeRecipients: number;
  pausedRecipients: number;
  completedRecipients: number;
  stoppedRecipients: number;
  repliedRecipients: number;
  bouncedRecipients: number;
  unsubscribedRecipients: number;
  pendingFollowUps: number;
  dueFollowUps: number;
  touchSendCount: number;
  replyCount: number;
  unsubscribeCount: number;
  bounceCount: number;
  completionRate: number;
  stopReasonBreakdown: Record<string, number>;
  touchPerformance: Array<{
    touchNumber: number;
    planned: number;
    sent: number;
    replied: number;
    bounced: number;
    unsubscribed: number;
  }>;
}

export interface SequenceStateLike {
  nextTouchNumber: number;
  sequenceStatus: SequenceStatus | string;
  nextScheduledTouchAt: Date | string | null;
  sequencePaused?: boolean | null;
  lastReplyAt?: Date | string | null;
  lastBounceAt?: Date | string | null;
  unsubscribedAt?: Date | string | null;
  stopReason?: string | null;
  currentTouchNumber?: number;
}

export interface SequenceTouchLike {
  touchNumber: number;
  sentAt?: Date | string | null;
}

const MAX_SEQUENCE_RETRIES = 2;
const MAX_SEQUENCE_SENDS_PER_HOUR = 60;
const MAX_DOMAIN_SENDS_PER_HOUR = 25;
const THROTTLE_DELAY_MS = 60 * 60 * 1000;

function nowDate(): Date {
  return new Date();
}

function addDelayDays(base: Date, delayDays: number): Date {
  return new Date(base.getTime() + delayDays * 24 * 60 * 60 * 1000);
}

export function isTerminalSequenceStatus(status: SequenceStatus | string | null | undefined): boolean {
  return status === "completed" || status === "stopped" || status === "bounced" || status === "replied" || status === "unsubscribed";
}

export function isTransientSequenceFailure(category: string | null | undefined): boolean {
  const normalized = String(category ?? "").toLowerCase();
  return [
    "timeout",
    "smtp_tls_connection",
    "connection",
    "temporary",
    "rate_limit",
  ].some((part) => normalized.includes(part));
}

export function shouldRetrySequenceFailure(category: string | null | undefined, retryCount: number): boolean {
  return isTransientSequenceFailure(category) && retryCount < MAX_SEQUENCE_RETRIES;
}

export function computeNextSequenceStep(nextTouch: { touchNumber: number; recommendedDelayDays: number } | null, sentAt: Date): {
  nextTouchNumber: number;
  nextScheduledTouchAt: Date | null;
  sequenceStatus: "active" | "completed";
  stopReason: SequenceStopReason | null;
  sequenceCompletedAt: Date | null;
} {
  if (!nextTouch) {
    return {
      nextTouchNumber: 0,
      nextScheduledTouchAt: null,
      sequenceStatus: "completed",
      stopReason: "sequence_complete",
      sequenceCompletedAt: sentAt,
    };
  }
  return {
    nextTouchNumber: nextTouch.touchNumber,
    nextScheduledTouchAt: addDelayDays(sentAt, nextTouch.recommendedDelayDays),
    sequenceStatus: "active",
    stopReason: null,
    sequenceCompletedAt: null,
  };
}

export function isFollowUpEligibleNow(state: SequenceStateLike, now = new Date()): { eligible: boolean; reason?: string } {
  if (state.sequencePaused) return { eligible: false, reason: "paused" };
  if (isTerminalSequenceStatus(state.sequenceStatus)) return { eligible: false, reason: "terminal_status" };
  if (state.sequenceStatus !== "active") return { eligible: false, reason: "not_active" };
  if ((state.nextTouchNumber ?? 0) <= 1) return { eligible: false, reason: "no_follow_up_touch" };
  if (state.lastReplyAt) return { eligible: false, reason: "replied" };
  if (state.lastBounceAt) return { eligible: false, reason: "bounced" };
  if (state.unsubscribedAt) return { eligible: false, reason: "unsubscribed" };
  if (!state.nextScheduledTouchAt) return { eligible: false, reason: "not_scheduled" };
  const scheduledAt = state.nextScheduledTouchAt instanceof Date
    ? state.nextScheduledTouchAt
    : new Date(state.nextScheduledTouchAt);
  if (Number.isNaN(scheduledAt.getTime())) return { eligible: false, reason: "invalid_schedule" };
  if (scheduledAt.getTime() > now.getTime()) return { eligible: false, reason: "delay_not_reached" };
  return { eligible: true };
}

export function summarizeSequenceAnalytics(
  campaignId: number,
  stateRows: SequenceStateLike[],
  touchRows: SequenceTouchLike[],
): SequenceProgressSummary {
  const stopReasonBreakdown = stateRows.reduce<Record<string, number>>((acc, row) => {
    if (row.stopReason) acc[row.stopReason] = (acc[row.stopReason] ?? 0) + 1;
    return acc;
  }, {});
  const maxTouchNumber = touchRows.reduce((max, row) => Math.max(max, row.touchNumber), 0);
  const touchPerformance = Array.from({ length: Math.max(maxTouchNumber, 1) }, (_, index) => {
    const touchNumber = index + 1;
    const planned = touchRows.filter((row) => row.touchNumber === touchNumber).length;
    const sent = touchRows.filter((row) => row.touchNumber === touchNumber && row.sentAt != null).length;
    const replied = stateRows.filter((row) => row.sequenceStatus === "replied" && row.currentTouchNumber === touchNumber).length;
    const bounced = stateRows.filter((row) => row.sequenceStatus === "bounced" && row.currentTouchNumber === touchNumber).length;
    const unsubscribed = stateRows.filter((row) => row.sequenceStatus === "unsubscribed" && row.currentTouchNumber === touchNumber).length;
    return { touchNumber, planned, sent, replied, bounced, unsubscribed };
  });

  const completedRecipients = stateRows.filter((row) => row.sequenceStatus === "completed").length;
  const pendingFollowUps = stateRows.filter((row) => row.nextTouchNumber > 1 && row.sequenceStatus === "active").length;
  const dueFollowUps = stateRows.filter((row) => isFollowUpEligibleNow(row).eligible).length;

  return {
    campaignId,
    totalRecipients: stateRows.length,
    activeRecipients: stateRows.filter((row) => row.sequenceStatus === "active").length,
    pausedRecipients: stateRows.filter((row) => row.sequenceStatus === "paused").length,
    completedRecipients,
    stoppedRecipients: stateRows.filter((row) => row.sequenceStatus === "stopped").length,
    repliedRecipients: stateRows.filter((row) => row.sequenceStatus === "replied").length,
    bouncedRecipients: stateRows.filter((row) => row.sequenceStatus === "bounced").length,
    unsubscribedRecipients: stateRows.filter((row) => row.sequenceStatus === "unsubscribed").length,
    pendingFollowUps,
    dueFollowUps,
    touchSendCount: touchRows.filter((row) => row.sentAt != null).length,
    replyCount: stateRows.filter((row) => row.lastReplyAt != null).length,
    unsubscribeCount: stateRows.filter((row) => row.unsubscribedAt != null).length,
    bounceCount: stateRows.filter((row) => row.lastBounceAt != null).length,
    completionRate: stateRows.length > 0 ? completedRecipients / stateRows.length : 0,
    stopReasonBreakdown,
    touchPerformance,
  };
}

function retryDelayForAttempt(attemptNumber: number): number {
  return Math.min(THROTTLE_DELAY_MS, 15 * 60 * 1000 * Math.max(1, attemptNumber));
}

export async function upsertSequenceStateFromGeneratedTouches(input: {
  campaignId: number;
  recipientId: number;
  touchCount: number;
}): Promise<void> {
  const [existing] = await db
    .select({ id: recipientSequenceStateTable.id, sequenceStatus: recipientSequenceStateTable.sequenceStatus })
    .from(recipientSequenceStateTable)
    .where(and(
      eq(recipientSequenceStateTable.campaignId, input.campaignId),
      eq(recipientSequenceStateTable.recipientId, input.recipientId),
    ))
    .limit(1);

  const baseUpdate = {
    currentTouchNumber: 0,
    nextTouchNumber: input.touchCount > 0 ? 1 : 0,
    nextScheduledTouchAt: null,
    sequenceStatus: "pending" as const,
    sequenceStartedAt: null,
    sequenceCompletedAt: null,
    lastTouchSentAt: null,
    stopReason: null,
    sequencePaused: false,
    retryCount: 0,
    lastTouchMessageId: null,
    lastAttemptedTouchNumber: null,
    lastError: null,
    updatedAt: nowDate(),
  };

  if (existing) {
    // Preserve terminal statuses caused by real-world outcomes unless a new campaign run
    // explicitly regenerates before sending has started.
    if (existing.sequenceStatus && isTerminalSequenceStatus(existing.sequenceStatus)) {
      return;
    }
    await db
      .update(recipientSequenceStateTable)
      .set(baseUpdate)
      .where(eq(recipientSequenceStateTable.id, existing.id));
    return;
  }

  await db.insert(recipientSequenceStateTable).values({
    campaignId: input.campaignId,
    recipientId: input.recipientId,
    ...baseUpdate,
  });
}

export async function releaseFollowUpClaims(campaignId: number): Promise<void> {
  await db
    .update(campaignSequenceTouchesTable)
    .set({ executionStatus: "pending" })
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, campaignId),
      eq(campaignSequenceTouchesTable.executionStatus, "sending"),
      isNull(campaignSequenceTouchesTable.sentAt),
    ));
}

export async function markInitialTouchSent(input: {
  campaignId: number;
  recipientId: number;
  sentAt?: Date;
  messageId?: string | null;
}): Promise<void> {
  const sentAt = input.sentAt ?? nowDate();
  const [nextTouch] = await db
    .select({
      touchNumber: campaignSequenceTouchesTable.touchNumber,
      recommendedDelayDays: campaignSequenceTouchesTable.recommendedDelayDays,
    })
    .from(campaignSequenceTouchesTable)
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
      eq(campaignSequenceTouchesTable.touchNumber, 2),
    ))
    .limit(1);

  await db
    .update(campaignSequenceTouchesTable)
    .set({
      executionStatus: "sent",
      sentAt,
      messageId: input.messageId ?? null,
      attemptCount: 1,
      lastAttemptAt: sentAt,
      lastError: null,
      retryAfterAt: null,
      scheduledForAt: null,
    })
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
      eq(campaignSequenceTouchesTable.touchNumber, 1),
    ));

  await db
    .update(recipientSequenceStateTable)
    .set({
      currentTouchNumber: 1,
      nextTouchNumber: nextTouch?.touchNumber ?? 0,
      nextScheduledTouchAt: nextTouch ? addDelayDays(sentAt, nextTouch.recommendedDelayDays) : null,
      sequenceStatus: nextTouch ? "active" : "completed",
      sequenceStartedAt: sentAt,
      sequenceCompletedAt: nextTouch ? null : sentAt,
      lastTouchSentAt: sentAt,
      stopReason: nextTouch ? null : "sequence_complete",
      sequencePaused: false,
      retryCount: 0,
      lastTouchMessageId: input.messageId ?? null,
      lastAttemptedTouchNumber: 1,
      lastError: null,
      updatedAt: sentAt,
    })
    .where(and(
      eq(recipientSequenceStateTable.campaignId, input.campaignId),
      eq(recipientSequenceStateTable.recipientId, input.recipientId),
    ));

  if (nextTouch) {
    await db
      .update(campaignSequenceTouchesTable)
      .set({
        executionStatus: "pending",
        scheduledForAt: addDelayDays(sentAt, nextTouch.recommendedDelayDays),
        retryAfterAt: null,
      })
      .where(and(
        eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
        eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
        eq(campaignSequenceTouchesTable.touchNumber, nextTouch.touchNumber),
      ));
  }
}

export async function markInitialTouchFailed(input: {
  campaignId: number;
  recipientId: number;
  errorMessage: string;
}): Promise<void> {
  const occurredAt = nowDate();
  await db
    .update(campaignSequenceTouchesTable)
    .set({
      executionStatus: "failed",
      lastError: input.errorMessage.slice(0, 2000),
      lastAttemptAt: occurredAt,
      attemptCount: sql`${campaignSequenceTouchesTable.attemptCount} + 1`,
    })
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
      eq(campaignSequenceTouchesTable.touchNumber, 1),
    ));

  await db
    .update(recipientSequenceStateTable)
    .set({
      sequenceStatus: "stopped",
      stopReason: "error_limit",
      nextScheduledTouchAt: null,
      sequencePaused: false,
      lastError: input.errorMessage.slice(0, 2000),
      updatedAt: occurredAt,
    })
    .where(and(
      eq(recipientSequenceStateTable.campaignId, input.campaignId),
      eq(recipientSequenceStateTable.recipientId, input.recipientId),
    ));
}

export async function markFollowUpTouchSent(input: {
  campaignId: number;
  recipientId: number;
  touchNumber: number;
  sentAt?: Date;
  messageId?: string | null;
}): Promise<void> {
  const sentAt = input.sentAt ?? nowDate();
  const [nextTouch] = await db
    .select({
      touchNumber: campaignSequenceTouchesTable.touchNumber,
      recommendedDelayDays: campaignSequenceTouchesTable.recommendedDelayDays,
    })
    .from(campaignSequenceTouchesTable)
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
      eq(campaignSequenceTouchesTable.touchNumber, input.touchNumber + 1),
    ))
    .limit(1);

  await db
    .update(campaignSequenceTouchesTable)
    .set({
      executionStatus: "sent",
      sentAt,
      messageId: input.messageId ?? null,
      lastError: null,
      retryAfterAt: null,
    })
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
      eq(campaignSequenceTouchesTable.touchNumber, input.touchNumber),
    ));

  await db
    .update(recipientSequenceStateTable)
    .set({
      currentTouchNumber: input.touchNumber,
      nextTouchNumber: nextTouch?.touchNumber ?? 0,
      nextScheduledTouchAt: nextTouch ? addDelayDays(sentAt, nextTouch.recommendedDelayDays) : null,
      sequenceStatus: nextTouch ? "active" : "completed",
      sequenceCompletedAt: nextTouch ? null : sentAt,
      lastTouchSentAt: sentAt,
      lastTouchMessageId: input.messageId ?? null,
      stopReason: nextTouch ? null : "sequence_complete",
      retryCount: 0,
      lastAttemptedTouchNumber: input.touchNumber,
      lastError: null,
      updatedAt: sentAt,
    })
    .where(and(
      eq(recipientSequenceStateTable.campaignId, input.campaignId),
      eq(recipientSequenceStateTable.recipientId, input.recipientId),
    ));

  if (nextTouch) {
    await db
      .update(campaignSequenceTouchesTable)
      .set({
        executionStatus: "pending",
        scheduledForAt: addDelayDays(sentAt, nextTouch.recommendedDelayDays),
        retryAfterAt: null,
      })
      .where(and(
        eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
        eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
        eq(campaignSequenceTouchesTable.touchNumber, nextTouch.touchNumber),
      ));
  }
}

export async function markFollowUpTouchFailed(input: {
  campaignId: number;
  recipientId: number;
  touchNumber: number;
  errorCategory: string;
  errorMessage: string;
}): Promise<{ retried: boolean; retryAt: Date | null }> {
  const occurredAt = nowDate();
  const [state] = await db
    .select({
      retryCount: recipientSequenceStateTable.retryCount,
    })
    .from(recipientSequenceStateTable)
    .where(and(
      eq(recipientSequenceStateTable.campaignId, input.campaignId),
      eq(recipientSequenceStateTable.recipientId, input.recipientId),
    ))
    .limit(1);
  const retryCount = state?.retryCount ?? 0;

  if (shouldRetrySequenceFailure(input.errorCategory, retryCount)) {
    const retryAt = new Date(occurredAt.getTime() + retryDelayForAttempt(retryCount + 1));
    await db
      .update(campaignSequenceTouchesTable)
      .set({
        executionStatus: "pending",
        retryAfterAt: retryAt,
        lastError: input.errorMessage.slice(0, 2000),
      })
      .where(and(
        eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
        eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
        eq(campaignSequenceTouchesTable.touchNumber, input.touchNumber),
      ));
    await db
      .update(recipientSequenceStateTable)
      .set({
        sequenceStatus: "active",
        retryCount: retryCount + 1,
        nextScheduledTouchAt: retryAt,
        lastAttemptedTouchNumber: input.touchNumber,
        lastError: input.errorMessage.slice(0, 2000),
        updatedAt: occurredAt,
      })
      .where(and(
        eq(recipientSequenceStateTable.campaignId, input.campaignId),
        eq(recipientSequenceStateTable.recipientId, input.recipientId),
      ));
    return { retried: true, retryAt };
  }

  await db
    .update(campaignSequenceTouchesTable)
    .set({
      executionStatus: "failed",
      lastError: input.errorMessage.slice(0, 2000),
      retryAfterAt: null,
    })
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
      eq(campaignSequenceTouchesTable.touchNumber, input.touchNumber),
    ));
  await db
    .update(recipientSequenceStateTable)
    .set({
      sequenceStatus: "stopped",
      stopReason: "error_limit",
      nextScheduledTouchAt: null,
      sequencePaused: false,
      retryCount: retryCount + 1,
      lastAttemptedTouchNumber: input.touchNumber,
      lastError: input.errorMessage.slice(0, 2000),
      updatedAt: occurredAt,
    })
    .where(and(
      eq(recipientSequenceStateTable.campaignId, input.campaignId),
      eq(recipientSequenceStateTable.recipientId, input.recipientId),
    ));

  return { retried: false, retryAt: null };
}

export async function stopRecipientSequence(input: {
  campaignId: number;
  recipientId: number;
  sequenceStatus: Extract<SequenceStatus, "paused" | "stopped" | "bounced" | "replied" | "unsubscribed" | "completed">;
  stopReason: SequenceStopReason;
  occurredAt?: Date;
  pauseFlag?: boolean;
}): Promise<void> {
  const occurredAt = input.occurredAt ?? nowDate();
  const stopUpdates: Record<string, unknown> = {
    sequenceStatus: input.sequenceStatus,
    stopReason: input.stopReason,
    nextScheduledTouchAt: null,
    sequencePaused: input.pauseFlag ?? input.sequenceStatus === "paused",
    updatedAt: occurredAt,
  };

  if (input.sequenceStatus === "completed") {
    stopUpdates.sequenceCompletedAt = occurredAt;
  }
  if (input.sequenceStatus === "replied") {
    stopUpdates.lastReplyAt = occurredAt;
  }
  if (input.sequenceStatus === "bounced") {
    stopUpdates.lastBounceAt = occurredAt;
  }
  if (input.sequenceStatus === "unsubscribed") {
    stopUpdates.unsubscribedAt = occurredAt;
  }

  await db
    .update(recipientSequenceStateTable)
    .set(stopUpdates)
    .where(and(
      eq(recipientSequenceStateTable.campaignId, input.campaignId),
      eq(recipientSequenceStateTable.recipientId, input.recipientId),
    ));

  const skipReason = input.stopReason;
  const touchStopUpdates: Record<string, unknown> = {
    executionStatus: "skipped",
    skippedAt: occurredAt,
    skipReason,
    retryAfterAt: null,
  };
  if (input.sequenceStatus === "replied") touchStopUpdates.repliedAt = occurredAt;
  if (input.sequenceStatus === "bounced") touchStopUpdates.bouncedAt = occurredAt;
  if (input.sequenceStatus === "unsubscribed") touchStopUpdates.unsubscribedAt = occurredAt;
  await db
    .update(campaignSequenceTouchesTable)
    .set(touchStopUpdates)
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
      isNull(campaignSequenceTouchesTable.sentAt),
      inArray(campaignSequenceTouchesTable.executionStatus, ["pending", "sending"]),
    ));
}

export async function markRecipientUnsubscribed(input: {
  campaignId: number;
  recipientId: number;
  occurredAt?: Date;
}): Promise<void> {
  await stopRecipientSequence({
    campaignId: input.campaignId,
    recipientId: input.recipientId,
    sequenceStatus: "unsubscribed",
    stopReason: "unsubscribed",
    occurredAt: input.occurredAt,
  });
}

export async function markRecipientBounced(input: {
  campaignId: number;
  recipientId: number;
  occurredAt?: Date;
}): Promise<void> {
  await stopRecipientSequence({
    campaignId: input.campaignId,
    recipientId: input.recipientId,
    sequenceStatus: "bounced",
    stopReason: "bounced",
    occurredAt: input.occurredAt,
  });
}

export async function pauseCampaignSequences(campaignId: number, reason: SequenceStopReason = "campaign_paused"): Promise<void> {
  const occurredAt = nowDate();
  await db
    .update(recipientSequenceStateTable)
    .set({
      sequenceStatus: "paused",
      stopReason: reason,
      sequencePaused: true,
      updatedAt: occurredAt,
    })
    .where(and(
      eq(recipientSequenceStateTable.campaignId, campaignId),
      inArray(recipientSequenceStateTable.sequenceStatus, ["pending", "active"]),
    ));

  await releaseFollowUpClaims(campaignId);
}

export async function resumeCampaignSequences(campaignId: number): Promise<void> {
  const occurredAt = nowDate();
  const rows = await db
    .select({
      id: recipientSequenceStateTable.id,
      currentTouchNumber: recipientSequenceStateTable.currentTouchNumber,
      nextTouchNumber: recipientSequenceStateTable.nextTouchNumber,
    })
    .from(recipientSequenceStateTable)
    .where(and(
      eq(recipientSequenceStateTable.campaignId, campaignId),
      eq(recipientSequenceStateTable.sequencePaused, true),
    ));

  for (const row of rows) {
    const nextStatus: SequenceStatus =
      row.currentTouchNumber === 0 && row.nextTouchNumber <= 1 ? "pending" : "active";
    await db
      .update(recipientSequenceStateTable)
      .set({
        sequenceStatus: nextStatus,
        stopReason: null,
        sequencePaused: false,
        updatedAt: occurredAt,
      })
      .where(eq(recipientSequenceStateTable.id, row.id));
  }
}

export async function isRecipientSuppressed(email: string): Promise<boolean> {
  const [entry] = await db
    .select({ id: suppressionListTable.id })
    .from(suppressionListTable)
    .where(eq(suppressionListTable.email, email.toLowerCase().trim()))
    .limit(1);
  return Boolean(entry);
}

export async function checkFollowUpThrottle(email: string): Promise<{ allowed: boolean; retryAt: Date | null; reason?: string }> {
  const domain = email.split("@")[1]?.toLowerCase().trim() ?? "";
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [globalCountRow] = await db
    .select({ count: count() })
    .from(campaignSequenceTouchesTable)
    .where(and(
      isNotNull(campaignSequenceTouchesTable.sentAt),
      gt(campaignSequenceTouchesTable.sentAt, oneHourAgo),
    ));
  const globalCount = Number(globalCountRow?.count ?? 0);
  if (globalCount >= MAX_SEQUENCE_SENDS_PER_HOUR) {
    return {
      allowed: false,
      retryAt: new Date(Date.now() + THROTTLE_DELAY_MS),
      reason: "global_sequence_hourly_limit",
    };
  }

  if (!domain) {
    return { allowed: true, retryAt: null };
  }

  const rows = await db
    .select({
      recipientEmail: recipientTable.email,
      sentAt: campaignSequenceTouchesTable.sentAt,
    })
    .from(campaignSequenceTouchesTable)
    .innerJoin(recipientTable, eq(recipientTable.id, campaignSequenceTouchesTable.recipientId))
    .where(and(
      isNotNull(campaignSequenceTouchesTable.sentAt),
      gt(campaignSequenceTouchesTable.sentAt, oneHourAgo),
    ));
  const domainCount = rows.filter((row) => row.recipientEmail.toLowerCase().endsWith(`@${domain}`)).length;
  if (domainCount >= MAX_DOMAIN_SENDS_PER_HOUR) {
    return {
      allowed: false,
      retryAt: new Date(Date.now() + THROTTLE_DELAY_MS),
      reason: "domain_hourly_limit",
    };
  }
  return { allowed: true, retryAt: null };
}

export async function deferRecipientSequence(input: {
  campaignId: number;
  recipientId: number;
  touchNumber: number;
  retryAt: Date;
  reason: string;
}): Promise<void> {
  await db
    .update(recipientSequenceStateTable)
    .set({
      sequenceStatus: "active",
      nextScheduledTouchAt: input.retryAt,
      lastAttemptedTouchNumber: input.touchNumber,
      lastError: input.reason.slice(0, 2000),
      updatedAt: nowDate(),
    })
    .where(and(
      eq(recipientSequenceStateTable.campaignId, input.campaignId),
      eq(recipientSequenceStateTable.recipientId, input.recipientId),
    ));

  await db
    .update(campaignSequenceTouchesTable)
    .set({
      executionStatus: "pending",
      retryAfterAt: input.retryAt,
      lastError: input.reason.slice(0, 2000),
    })
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, input.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, input.recipientId),
      eq(campaignSequenceTouchesTable.touchNumber, input.touchNumber),
    ));
}

export async function claimDueFollowUpBatch(campaignId: number, batchSize: number): Promise<ClaimedFollowUpRow[]> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
      UPDATE campaign_sequence_touches cst
      SET execution_status = 'sending',
          last_attempt_at = NOW(),
          attempt_count = cst.attempt_count + 1
      WHERE cst.id IN (
        SELECT cst2.id
        FROM campaign_sequence_touches cst2
        INNER JOIN recipient_sequence_state rss
          ON rss.campaign_id = cst2.campaign_id
         AND rss.recipient_id = cst2.recipient_id
        INNER JOIN recipients r
          ON r.id = rss.recipient_id
        WHERE cst2.campaign_id = $1
          AND cst2.touch_number > 1
          AND cst2.execution_status = 'pending'
          AND rss.sequence_status = 'active'
          AND rss.sequence_paused = false
          AND rss.next_touch_number = cst2.touch_number
          AND rss.next_scheduled_touch_at IS NOT NULL
          AND rss.next_scheduled_touch_at <= NOW()
          AND (cst2.retry_after_at IS NULL OR cst2.retry_after_at <= NOW())
          AND r.replied_at IS NULL
        ORDER BY rss.next_scheduled_touch_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING cst.id
      `,
      [campaignId, batchSize],
    );

    const ids = (result.rows as Array<{ id: number }>).map((row) => row.id);
    if (ids.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const detailResult = await client.query(
      `
      SELECT
        cst.id AS touch_id,
        cst.campaign_id,
        cst.recipient_id,
        cst.touch_number,
        cst.personalized_subject,
        cst.personalized_body,
        cst.personalized_text,
        cst.sequence_type,
        cst.tone_used,
        cst.cta_type,
        cst.cta_text,
        cst.objective,
        r.email,
        r.name,
        next_touch.touch_number AS next_touch_number,
        next_touch.recommended_delay_days AS next_delay_days
      FROM campaign_sequence_touches cst
      INNER JOIN recipients r ON r.id = cst.recipient_id
      LEFT JOIN campaign_sequence_touches next_touch
        ON next_touch.campaign_id = cst.campaign_id
       AND next_touch.recipient_id = cst.recipient_id
       AND next_touch.touch_number = cst.touch_number + 1
      WHERE cst.id = ANY($1::int[])
      ORDER BY cst.touch_number ASC
      `,
      [ids],
    );

    await client.query("COMMIT");
    return (detailResult.rows as Array<Record<string, unknown>>).map((row) => ({
      touchId: Number(row.touch_id),
      campaignId: Number(row.campaign_id),
      recipientId: Number(row.recipient_id),
      touchNumber: Number(row.touch_number),
      email: String(row.email),
      name: typeof row.name === "string" ? row.name : null,
      personalizedSubject: typeof row.personalized_subject === "string" ? row.personalized_subject : null,
      personalizedBody: String(row.personalized_body ?? ""),
      personalizedText: typeof row.personalized_text === "string" ? row.personalized_text : null,
      sequenceType: String(row.sequence_type ?? ""),
      toneUsed: typeof row.tone_used === "string" ? row.tone_used : null,
      ctaType: typeof row.cta_type === "string" ? row.cta_type : null,
      ctaText: typeof row.cta_text === "string" ? row.cta_text : null,
      objective: String(row.objective ?? ""),
      nextTouchNumber: typeof row.next_touch_number === "number" ? row.next_touch_number : row.next_touch_number != null ? Number(row.next_touch_number) : null,
      nextDelayDays: typeof row.next_delay_days === "number" ? row.next_delay_days : row.next_delay_days != null ? Number(row.next_delay_days) : null,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getSequenceProgressSummary(campaignId: number): Promise<SequenceProgressSummary> {
  const stateRows = await db
    .select()
    .from(recipientSequenceStateTable)
    .where(eq(recipientSequenceStateTable.campaignId, campaignId));
  const touchRows = await db
    .select()
    .from(campaignSequenceTouchesTable)
    .where(eq(campaignSequenceTouchesTable.campaignId, campaignId));
  return summarizeSequenceAnalytics(campaignId, stateRows, touchRows);
}

export async function listPendingFollowUps(campaignId: number, limit = 50): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .select({
      recipientId: recipientSequenceStateTable.recipientId,
      currentTouchNumber: recipientSequenceStateTable.currentTouchNumber,
      nextTouchNumber: recipientSequenceStateTable.nextTouchNumber,
      nextScheduledTouchAt: recipientSequenceStateTable.nextScheduledTouchAt,
      sequenceStatus: recipientSequenceStateTable.sequenceStatus,
      email: recipientTable.email,
      name: recipientTable.name,
      touchSubject: campaignSequenceTouchesTable.personalizedSubject,
      touchObjective: campaignSequenceTouchesTable.objective,
      touchCtaType: campaignSequenceTouchesTable.ctaType,
    })
    .from(recipientSequenceStateTable)
    .innerJoin(recipientTable, eq(recipientTable.id, recipientSequenceStateTable.recipientId))
    .leftJoin(
      campaignSequenceTouchesTable,
      and(
        eq(campaignSequenceTouchesTable.campaignId, recipientSequenceStateTable.campaignId),
        eq(campaignSequenceTouchesTable.recipientId, recipientSequenceStateTable.recipientId),
        eq(campaignSequenceTouchesTable.touchNumber, recipientSequenceStateTable.nextTouchNumber),
      ),
    )
    .where(and(
      eq(recipientSequenceStateTable.campaignId, campaignId),
      inArray(recipientSequenceStateTable.sequenceStatus, ["active", "paused", "pending"]),
      gt(recipientSequenceStateTable.nextTouchNumber, 1),
    ))
    .orderBy(asc(recipientSequenceStateTable.nextScheduledTouchAt))
    .limit(limit);

  return rows;
}

export async function getRecipientTouchHistory(campaignId: number, recipientId: number): Promise<{
  sequenceState: Record<string, unknown> | null;
  touches: Array<Record<string, unknown>>;
}> {
  const [sequenceState] = await db
    .select()
    .from(recipientSequenceStateTable)
    .where(and(
      eq(recipientSequenceStateTable.campaignId, campaignId),
      eq(recipientSequenceStateTable.recipientId, recipientId),
    ))
    .limit(1);
  const touches = await db
    .select()
    .from(campaignSequenceTouchesTable)
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, campaignId),
      eq(campaignSequenceTouchesTable.recipientId, recipientId),
    ))
    .orderBy(asc(campaignSequenceTouchesTable.touchNumber));

  return {
    sequenceState: sequenceState ?? null,
    touches,
  };
}

