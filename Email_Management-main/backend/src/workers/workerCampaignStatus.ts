/**
 * Pure decision logic for per-campaign work scheduling.
 * No DB access — fully unit-testable.
 */

export interface CampaignDiagnostics {
  /** Recipients whose Touch 1 has not been sent yet. */
  pendingTouch1Recipients: number;
  /** Recipients currently claimed mid-send (should be 0 between poll ticks). */
  sendingRecipients: number;
  /** Follow-up touches whose scheduled time has already passed. */
  dueFollowUpsNow: number;
  /** Follow-up touches scheduled in the future (not yet due). */
  futureFollowUps: number;
  /** Earliest future follow-up timestamp, or null when futureFollowUps === 0. */
  nextFollowUpAt: Date | null;
}

export type CampaignAction =
  | 'send'  // has immediate work — process now
  | 'wait'  // all current work done; future follow-ups pending
  | 'idle'; // no pending work at all — safe to complete

export interface CampaignWorkDecision {
  action: CampaignAction;
  /** Only set when action === 'wait'. */
  nextDueAt?: Date;
}

/**
 * Given a snapshot of a campaign's workload, return what the worker should do.
 * Called after claimBatch + claimDueFollowUpBatch both return empty.
 */
export function decideCampaignWork(diag: CampaignDiagnostics): CampaignWorkDecision {
  if (diag.pendingTouch1Recipients > 0 || diag.dueFollowUpsNow > 0) {
    return { action: 'send' };
  }
  if (diag.futureFollowUps > 0 && diag.nextFollowUpAt !== null) {
    return { action: 'wait', nextDueAt: diag.nextFollowUpAt };
  }
  return { action: 'idle' };
}
