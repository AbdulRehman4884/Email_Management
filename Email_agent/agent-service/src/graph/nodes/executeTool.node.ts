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

    return patch;

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
