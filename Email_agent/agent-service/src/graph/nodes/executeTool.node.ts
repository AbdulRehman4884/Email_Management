/**
 * src/graph/nodes/executeTool.node.ts
 *
 * Executes the MCP tool that was selected and prepared by a domain agent node.
 *
 * This node runs only when requiresApproval=false (safe actions).
 * Risky actions (start_campaign, resume_campaign, update_smtp) are routed
 * directly to finalResponse by the conditional edge on the approval node —
 * they bypass this node until the user confirms via POST /api/agent/confirm.
 *
 * On success: sets state.toolResult
 * On failure: sets state.error (toolResult remains undefined)
 *
 * The finalResponse node reads both toolResult and error to shape its output.
 *
 * Audit events emitted:
 *   tool.attempt  — before the call starts
 *   tool.success  — when the service returns (even if isToolError=true)
 *   tool.failure  — when the service returns state.error or throws (auth errors)
 */

import { createLogger } from "../../lib/logger.js";
import { toolExecutionService } from "../../services/toolExecution.service.js";
import { auditLogService } from "../../services/auditLog.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { PlanStepResult } from "../../lib/planTypes.js";

const log = createLogger("node:executeTool");

/**
 * How many successful tool-executing turns between proactive unread-reply peeks.
 * Each peek costs one extra MCP round-trip, so this is intentionally wide —
 * the nudge is a convenience, not something that should add latency to most turns.
 */
const REPLY_CHECK_INTERVAL = 20;

export async function executeToolNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { toolName, userId, sessionId } = state;

  log.debug({ toolName, sessionId }, "executeTool node entered");

  const ctx = {
    userId:    userId    as string | undefined,
    sessionId: sessionId as string | undefined,
  };

  auditLogService.toolAttempt(ctx, { toolName: toolName ?? "(unknown)" });

  const startMs = Date.now();

  try {
    const patch = await toolExecutionService.executeFromState(state);
    const durationMs = Date.now() - startMs;

    // ── Single-step add_recipients auto-inject ────────────────────────────────
    // When the single-step path executes create_campaign and the user supplied
    // inline email addresses, insert an add_recipients step immediately after
    // so recipients reach the DB in the same turn (before start_campaign runs
    // in a subsequent turn or confirmation).
    if (
      toolName === "create_campaign" &&
      !patch.error &&
      patch.toolResult &&
      !patch.toolResult.isToolError
    ) {
      const inlineEmails = state.extractedRecipients;
      const raw = patch.toolResult.data as Record<string, unknown> | undefined;
      const campaignData =
        typeof raw?.data === "object" && raw.data !== null
          ? (raw.data as Record<string, unknown>)
          : raw;
      const rawId = campaignData?.id;
      const newCampaignId =
        typeof rawId === "string"  ? rawId
        : typeof rawId === "number" ? String(rawId)
        : undefined;

      log.info(
        {
          sessionId,
          newCampaignId,
          extractedRecipients:      inlineEmails ?? null,
          shouldInjectAddRecipients: !!(newCampaignId && inlineEmails && inlineEmails.length > 0),
        },
        "executeToolNode: create_campaign result — add_recipients decision point",
      );

      if (inlineEmails && inlineEmails.length > 0) {
        if (newCampaignId) {
          log.info(
            { sessionId, campaignId: newCampaignId, extractedRecipients: inlineEmails },
            "executeToolNode: auto-injecting add_recipients after single-step create_campaign",
          );
          const addRecipientsArgs = {
            campaignId: newCampaignId,
            recipients: inlineEmails.map((email: string) => ({ email })),
          };
          log.info(
            { sessionId, toolArgs: addRecipientsArgs },
            "add_recipients MCP call: toolArgs",
          );
          const addRecipientsState: AgentGraphStateType = {
            ...state,
            toolName:         "add_recipients",
            toolArgs:         addRecipientsArgs,
            intent:           "create_campaign",
            activeCampaignId: newCampaignId,
          };
          const addPatch = await toolExecutionService.executeFromState(addRecipientsState);

          if (addPatch.error) {
            log.warn(
              { sessionId, campaignId: newCampaignId, error: addPatch.error },
              "executeToolNode: add_recipients failed — continuing",
            );
          } else if (addPatch.toolResult) {
            const addResult = addPatch.toolResult.data as Record<string, unknown> | undefined;
            log.info(
              {
                sessionId,
                campaignId:           newCampaignId,
                addRecipientsResult:  addResult,
                saved:                addResult?.saved,
                skipped:              addResult?.skipped,
              },
              "executeToolNode: add_recipients succeeded",
            );
            // Return both steps as planResults so finalResponse renders a
            // two-step summary ("Campaign created. 1 recipient added.")
            const combinedPlanResults: PlanStepResult[] = [
              {
                stepIndex:  0,
                toolName:   "create_campaign",
                toolArgs:   state.toolArgs ?? {},
                toolResult: patch.toolResult,
                executedAt: new Date().toISOString(),
              },
              {
                stepIndex:  1,
                toolName:   "add_recipients",
                toolArgs:   addRecipientsArgs,
                toolResult: addPatch.toolResult,
                executedAt: new Date().toISOString(),
              },
            ];
            return {
              ...patch,
              activeCampaignId: newCampaignId,
              planResults: combinedPlanResults,
            };
          }
        } else {
          log.warn(
            { sessionId, extractedRecipients: inlineEmails },
            "executeToolNode: skipping add_recipients — could not parse campaignId from create_campaign result",
          );
        }
      } else {
        log.info(
          { sessionId, campaignId: newCampaignId, extractedRecipients: inlineEmails ?? null },
          "executeToolNode: skipping add_recipients — extractedRecipients is empty or undefined",
        );
      }

      // Even when add_recipients is skipped, propagate the new activeCampaignId
      if (newCampaignId) {
        return { ...patch, activeCampaignId: newCampaignId };
      }
    }

    // ── Proactive unread-reply nudge ──────────────────────────────────────────
    // Every REPLY_CHECK_INTERVAL'th successful, non-reply tool call, quietly
    // peek at the inbox so the agent can mention new replies without the user
    // having to ask. Gated to a periodic check (not every turn) so it doesn't
    // double MCP traffic on every single action, and only re-mentions once the
    // unread count grows past what was already surfaced this session. Computed
    // here (not returned early) so the audit logging below still runs
    // unconditionally.
    let unreadNoticePatch: Partial<AgentGraphStateType> = {};
    if (
      toolName !== "list_replies" &&
      toolName !== "summarize_replies" &&
      !patch.error &&
      patch.toolResult &&
      !patch.toolResult.isToolError
    ) {
      const turnsSinceCheck = (state.turnsSinceLastReplyCheck ?? 0) + 1;
      if (turnsSinceCheck < REPLY_CHECK_INTERVAL) {
        unreadNoticePatch = { turnsSinceLastReplyCheck: turnsSinceCheck };
      } else {
        unreadNoticePatch = { turnsSinceLastReplyCheck: 0 };
        try {
          const peekState: AgentGraphStateType = {
            ...state,
            ...patch,
            toolName: "list_replies",
            toolArgs: { pageSize: 10 },
          };
          const peek = await toolExecutionService.executeFromState(peekState);
          const peekRaw = peek.toolResult?.data as Record<string, unknown> | undefined;
          const peekInner =
            typeof peekRaw?.data === "object" && peekRaw.data !== null && !Array.isArray(peekRaw.data)
              ? (peekRaw.data as Record<string, unknown>)
              : peekRaw;
          const items = Array.isArray(peekInner?.items) ? (peekInner.items as Array<Record<string, unknown>>) : [];
          const unreadCount = items.filter((i) => i.status === "unread").length;
          const lastNotified = state.lastNotifiedUnreadReplyCount ?? 0;

          if (unreadCount > 0 && unreadCount > lastNotified) {
            unreadNoticePatch = {
              ...unreadNoticePatch,
              unreadReplyNotice: `📬 You have **${unreadCount}** unread ${unreadCount === 1 ? "reply" : "replies"} — say "show replies" to view ${unreadCount === 1 ? "it" : "them"}.`,
              lastNotifiedUnreadReplyCount: unreadCount,
            };
          } else if (unreadCount === 0 && lastNotified > 0) {
            unreadNoticePatch = { ...unreadNoticePatch, lastNotifiedUnreadReplyCount: 0 };
          }
        } catch (err) {
          log.debug({ err }, "executeTool: unread-reply peek failed — skipping notice");
        }
      }
    }

    if (patch.error) {
      // Service swallowed the error into state — treat as failure for audit
      auditLogService.toolFailure(ctx, {
        toolName:     toolName ?? "(unknown)",
        durationMs,
        errorMessage: patch.error,
      });
      log.info(
        { toolName, userId, sessionId, durationMs, error: patch.error, toolArgs: state.toolArgs },
        "executeTool: FAILED — tool error in state",
      );
    } else {
      auditLogService.toolSuccess(ctx, {
        toolName:    toolName ?? "(unknown)",
        durationMs,
        isToolError: patch.toolResult?.isToolError ?? false,
      });
      log.info(
        {
          toolName, userId, sessionId, durationMs,
          isToolError:  patch.toolResult?.isToolError,
          resultData:   patch.toolResult?.data,
          toolArgs:     state.toolArgs,
        },
        "executeTool: SUCCESS — result data",
      );
    }

    return { ...patch, ...unreadNoticePatch };

  } catch (err) {
    // Only auth errors propagate here (re-thrown by toolExecutionService)
    const durationMs = Date.now() - startMs;

    auditLogService.toolFailure(ctx, {
      toolName:     toolName ?? "(unknown)",
      durationMs,
      errorCode:
        err instanceof Error && "code" in err
          ? String((err as { code: unknown }).code)
          : undefined,
      errorMessage: err instanceof Error ? err.message : "unknown error",
    });

    throw err;
  }
}
