import { describe, expect, it } from "vitest";
import {
  computeNextSequenceStep,
  isFollowUpEligibleNow,
  shouldRetrySequenceFailure,
  summarizeSequenceAnalytics,
} from "../sequenceExecutionEngine.js";

describe("sequenceExecutionEngine", () => {
  it("schedules touch 2 correctly after touch 1", () => {
    const sentAt = new Date("2026-05-11T10:00:00.000Z");
    const next = computeNextSequenceStep({ touchNumber: 2, recommendedDelayDays: 3 }, sentAt);
    expect(next.sequenceStatus).toBe("active");
    expect(next.nextTouchNumber).toBe(2);
    expect(next.nextScheduledTouchAt?.toISOString()).toBe("2026-05-14T10:00:00.000Z");
  });

  it("schedules touch 3 correctly after touch 2", () => {
    const sentAt = new Date("2026-05-14T10:00:00.000Z");
    const next = computeNextSequenceStep({ touchNumber: 3, recommendedDelayDays: 7 }, sentAt);
    expect(next.nextTouchNumber).toBe(3);
    expect(next.nextScheduledTouchAt?.toISOString()).toBe("2026-05-21T10:00:00.000Z");
  });

  it("blocks follow-ups for replied, paused, and completed recipients", () => {
    const now = new Date("2026-05-11T10:00:00.000Z");
    expect(isFollowUpEligibleNow({
      nextTouchNumber: 2,
      sequenceStatus: "replied",
      nextScheduledTouchAt: now,
      lastReplyAt: now,
    }, now).eligible).toBe(false);

    expect(isFollowUpEligibleNow({
      nextTouchNumber: 2,
      sequenceStatus: "active",
      nextScheduledTouchAt: now,
      sequencePaused: true,
    }, now).reason).toBe("paused");

    expect(isFollowUpEligibleNow({
      nextTouchNumber: 0,
      sequenceStatus: "completed",
      nextScheduledTouchAt: null,
    }, now).eligible).toBe(false);
  });

  it("allows transient retries but stops permanent failures", () => {
    expect(shouldRetrySequenceFailure("smtp_timeout", 0)).toBe(true);
    expect(shouldRetrySequenceFailure("connection_reset", 1)).toBe(true);
    expect(shouldRetrySequenceFailure("gmail_auth", 0)).toBe(false);
    expect(shouldRetrySequenceFailure("temporary_failure", 2)).toBe(false);
  });

  it("aggregates analytics by stop reason and touch", () => {
    const now = new Date("2026-05-11T10:00:00.000Z");
    const summary = summarizeSequenceAnalytics(
      42,
      [
        {
          sequenceStatus: "active",
          nextTouchNumber: 2,
          nextScheduledTouchAt: new Date("2026-05-10T10:00:00.000Z"),
          currentTouchNumber: 1,
        },
        {
          sequenceStatus: "replied",
          nextTouchNumber: 0,
          nextScheduledTouchAt: null,
          stopReason: "replied",
          currentTouchNumber: 2,
          lastReplyAt: now,
        },
        {
          sequenceStatus: "bounced",
          nextTouchNumber: 0,
          nextScheduledTouchAt: null,
          stopReason: "bounced",
          currentTouchNumber: 1,
          lastBounceAt: now,
        },
      ],
      [
        { touchNumber: 1, sentAt: now },
        { touchNumber: 1, sentAt: now },
        { touchNumber: 2, sentAt: now },
        { touchNumber: 3, sentAt: null },
      ],
    );

    expect(summary.pendingFollowUps).toBe(1);
    expect(summary.dueFollowUps).toBe(1);
    expect(summary.replyCount).toBe(1);
    expect(summary.bounceCount).toBe(1);
    expect(summary.stopReasonBreakdown.replied).toBe(1);
    expect(summary.touchPerformance[0]).toMatchObject({ touchNumber: 1, sent: 2 });
    expect(summary.touchPerformance[1]).toMatchObject({ touchNumber: 2, sent: 1, replied: 1 });
  });
});
