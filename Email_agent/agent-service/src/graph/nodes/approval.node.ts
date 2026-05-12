/**
 * src/graph/nodes/approval.node.ts
 *
 * Approval gate node — runs after every domain agent node.
 *
 * Phase 6 behaviour:
 *   - Delegates policy decision to ApprovalPolicyService
 *   - If risky: creates and persists a PendingAction via PendingActionService,
 *     sets requiresApproval=true + pendingActionId
 *   - If safe: sets requiresApproval=false
 *
 * The pendingActionId is the real persisted action id. The confirm endpoint
 * (POST /api/agent/confirm) looks it up, validates ownership + TTL, and
 * executes the tool exactly once.
 *
 * Risky intents (from ApprovalPolicyService):
 *   - start_campaign   — sends emails to real recipients
 *   - resume_campaign  — resumes a previously paused send
 *   - update_smtp      — changes production mail server settings
 */

import { createLogger } from "../../lib/logger.js";
import { approvalPolicyService } from "../../services/approvalPolicy.service.js";
import { pendingActionService } from "../../services/pendingAction.service.js";
import { auditLogService } from "../../services/auditLog.service.js";
import { asUserId, asSessionId } from "../../types/common.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:approval");

export async function approvalNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { intent, userId, sessionId, toolName, toolArgs } = state;

  const ctx = {
    userId:    userId    as string | undefined,
    sessionId: sessionId as string | undefined,
  };

  // ── Safe action ─────────────────────────────────────────────────────────────
  // Skip approval when:
  //   - intent is not risky, OR
  //   - toolName is "get_all_campaigns" (selection flow — risky tool not dispatched yet), OR
  //   - toolName is undefined (e.g. wizard collecting data, not yet executing)
  if (
    !intent ||
    !approvalPolicyService.requiresApproval(intent) ||
    toolName === "get_all_campaigns" ||
    toolName === undefined
  ) {
    log.debug({ intent, toolName, sessionId }, "Action does not require approval");
    return { requiresApproval: false, pendingActionId: undefined };
  }

  // ── Risky action — persist pending action ───────────────────────────────────
  const reason = approvalPolicyService.approvalReason(intent) ?? "This action requires confirmation.";

  log.info(
    { intent, sessionId, userId, reason },
    "Risky action detected — creating pending action",
  );

  auditLogService.approvalRequired(ctx, {
    intent,
    toolName: toolName ?? "",
    reason,
  });

  const action = await pendingActionService.create({
    userId:    userId    ? asUserId(userId as string)       : asUserId("unknown"),
    sessionId: sessionId ? asSessionId(sessionId as string) : asSessionId("unknown"),
    intent,
    toolName:  toolName  ?? "",
    toolArgs:  toolArgs  ?? {},
  });

  log.info(
    { id: action.id, intent, expiresAt: action.expiresAt },
    "Pending action created — awaiting user confirmation",
  );

  auditLogService.pendingActionCreated(ctx, {
    pendingActionId: action.id,
    intent,
    expiresAt: action.expiresAt,
  });

  return {
    requiresApproval: true,
    pendingActionId:  action.id,
  };
}
