import { describe, expect, it } from 'vitest';
import { decideCampaignWork, type CampaignDiagnostics } from '../workerCampaignStatus.js';

function diag(overrides: Partial<CampaignDiagnostics> = {}): CampaignDiagnostics {
  return {
    pendingTouch1Recipients: 0,
    sendingRecipients: 0,
    dueFollowUpsNow: 0,
    futureFollowUps: 0,
    nextFollowUpAt: null,
    ...overrides,
  };
}

const FUTURE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days from now

describe('decideCampaignWork', () => {
  // ── Requirement 9a: sent touch1 + future follow-ups ⟹ waiting, not completed ─

  it('returns wait when touch1 is fully sent but future follow-ups exist', () => {
    const result = decideCampaignWork(diag({ futureFollowUps: 4, nextFollowUpAt: FUTURE }));
    expect(result.action).toBe('wait');
    expect(result.nextDueAt).toEqual(FUTURE);
  });

  it('includes the correct nextDueAt timestamp', () => {
    const nextAt = new Date('2026-06-01T09:00:00.000Z');
    const result = decideCampaignWork(diag({ futureFollowUps: 1, nextFollowUpAt: nextAt }));
    expect(result.action).toBe('wait');
    expect(result.nextDueAt?.toISOString()).toBe('2026-06-01T09:00:00.000Z');
  });

  // ── Requirement 9b: no pending and no future touches ⟹ completed (idle) ──────

  it('returns idle when there is nothing pending at all', () => {
    const result = decideCampaignWork(diag());
    expect(result.action).toBe('idle');
    expect(result.nextDueAt).toBeUndefined();
  });

  it('returns idle when all recipients sent and no follow-up sequences exist', () => {
    const result = decideCampaignWork(diag({ sendingRecipients: 0 }));
    expect(result.action).toBe('idle');
  });

  // ── Requirement 9c: due follow-up exists ⟹ send ─────────────────────────────

  it('returns send when at least one follow-up is due now', () => {
    const result = decideCampaignWork(diag({ dueFollowUpsNow: 2 }));
    expect(result.action).toBe('send');
  });

  it('returns send when pending touch1 recipients exist', () => {
    const result = decideCampaignWork(diag({ pendingTouch1Recipients: 5 }));
    expect(result.action).toBe('send');
  });

  it('prioritises send over wait when both pending touch1 and future follow-ups exist', () => {
    const result = decideCampaignWork(
      diag({ pendingTouch1Recipients: 1, futureFollowUps: 2, nextFollowUpAt: FUTURE }),
    );
    expect(result.action).toBe('send');
  });

  it('prioritises send when due follow-ups exist alongside future follow-ups', () => {
    const result = decideCampaignWork(
      diag({ dueFollowUpsNow: 1, futureFollowUps: 3, nextFollowUpAt: FUTURE }),
    );
    expect(result.action).toBe('send');
  });

  // ── Guard: inconsistent state ─────────────────────────────────────────────────

  it('returns idle rather than wait when futureFollowUps > 0 but nextFollowUpAt is null', () => {
    const result = decideCampaignWork(diag({ futureFollowUps: 2, nextFollowUpAt: null }));
    expect(result.action).toBe('idle');
  });
});
