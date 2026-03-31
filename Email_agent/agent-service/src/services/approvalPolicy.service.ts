/**
 * src/services/approvalPolicy.service.ts
 *
 * Determines whether an intent requires explicit user confirmation
 * before the MCP tool is executed.
 *
 * Risky intents and their rationale:
 *   start_campaign  — sends emails to real recipients; irreversible in bulk
 *   resume_campaign — resumes a paused send; same blast-radius as start
 *   update_smtp     — changes production mail-server credentials; can break all delivery
 *
 * Design:
 *   The policy is intentionally separate from the approval workflow so it can
 *   be extended (e.g. per-account policy, threshold-based rules) without
 *   touching the approval store or graph nodes.
 */

import type { Intent } from "../config/intents.js";

// ── Risky intent registry ─────────────────────────────────────────────────────

/**
 * Intents that require a confirmation step before MCP execution.
 * Keyed by intent for O(1) lookup; the description is available for
 * confirmation prompts without branching.
 */
const APPROVAL_POLICY: Partial<Record<Intent, { reason: string }>> = {
  start_campaign: {
    reason: "This will send emails to your recipient list and cannot be undone.",
  },
  resume_campaign: {
    reason: "This will resume sending emails to recipients who have not yet received them.",
  },
  update_smtp: {
    reason: "Changing SMTP settings affects all campaign delivery immediately.",
  },
};

// ── Service ───────────────────────────────────────────────────────────────────

export class ApprovalPolicyService {
  /**
   * Returns true when the intent requires an explicit confirmation step.
   */
  requiresApproval(intent: Intent): boolean {
    return intent in APPROVAL_POLICY;
  }

  /**
   * Returns the human-readable reason why approval is required,
   * or undefined if the intent is not risky.
   */
  approvalReason(intent: Intent): string | undefined {
    return APPROVAL_POLICY[intent]?.reason;
  }

  /**
   * Returns all intents that currently require approval.
   * Used for documentation, admin UIs, and tests.
   */
  riskyIntents(): Intent[] {
    return Object.keys(APPROVAL_POLICY) as Intent[];
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const approvalPolicyService = new ApprovalPolicyService();
