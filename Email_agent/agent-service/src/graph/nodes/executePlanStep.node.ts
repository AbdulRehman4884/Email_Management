/**
 * src/graph/nodes/executePlanStep.node.ts
 *
 * Executes a multi-step plan produced by planDetection.node.
 *
 * Execution strategy — all steps are handled in a single node invocation
 * (no LangGraph self-loops), which keeps the workflow topology simple:
 *
 *   1. Iterate through plan steps in order.
 *   2. Safe steps (requiresApproval=false): execute immediately via
 *      ToolExecutionService and append the result to planResults.
 *   3. First risky step encountered: create a PendingAction (with planContext
 *      for later resumption), set requiresApproval=true, and return — the
 *      finalResponse node renders the approval prompt.
 *   4. On any tool error: set state.error and return — the finalResponse node
 *      renders the error message.
 *   5. When all steps complete safely: return planResults and let
 *      finalResponse build the multi-step summary.
 *
 * The existing single-step approval flow (approval.node → executeTool.node)
 * is completely unchanged — this node is only reached via the planDetection
 * conditional edge when plan.length >= 2.
 */

import { createLogger } from "../../lib/logger.js";
import { toolExecutionService } from "../../services/toolExecution.service.js";
import { pendingActionService } from "../../services/pendingAction.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { PlanStepResult } from "../../lib/planTypes.js";

const log = createLogger("node:executePlanStep");

// ── Arg resolution for risky steps ───────────────────────────────────────────
//
// The planner builds toolArgs before plan execution begins. When an earlier
// safe step (create_campaign) produces a new campaignId at runtime, the
// planner had no way to know it. resolveRiskyStepArgs injects the runtime
// campaignId into any tool that requires it before the args are persisted into
// the pending action — ensuring resumePlan reads the correct value on confirm.

const TOOLS_NEEDING_CAMPAIGN_ID = new Set([
  "start_campaign",
  "pause_campaign",
  "resume_campaign",
  "update_campaign",
  "get_campaign_stats",
]);

function resolveRiskyStepArgs(
  toolName: string,
  originalArgs: Record<string, unknown>,
  localActiveCampaignId: string | undefined,
): Record<string, unknown> {
  if (
    TOOLS_NEEDING_CAMPAIGN_ID.has(toolName) &&
    !originalArgs.campaignId &&
    localActiveCampaignId
  ) {
    return { ...originalArgs, campaignId: localActiveCampaignId };
  }
  return originalArgs;
}

export async function executePlanStepNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const {
    plan,
    userId,
    sessionId,
    llmExtractedArgs,
    activeCampaignId,
  } = state;

  if (!plan || plan.length === 0) {
    log.error({ sessionId }, "executePlanStep reached with no plan in state");
    return { error: "Internal error: no plan found for multi-step execution." };
  }

  const planResults: PlanStepResult[] = [];
  // Tracks the most recently created campaign ID so a create_campaign step
  // immediately followed by start_campaign targets the new campaign, not the
  // stale activeCampaignId from the session.
  let localActiveCampaignId = activeCampaignId;

  for (const [i, step] of plan.entries()) {

    // ── Risky step: pause and request confirmation ──────────────────────────

    if (step.requiresApproval) {
      const resolvedArgs = resolveRiskyStepArgs(
        step.toolName,
        step.toolArgs,
        localActiveCampaignId,
      );

      if (step.toolName === "start_campaign" && !resolvedArgs.campaignId) {
        log.error(
          { sessionId, stepIndex: i, toolName: step.toolName, localActiveCampaignId },
          "executePlanStep: start_campaign pending action has no campaignId — cannot proceed",
        );
        return {
          error:
            "Internal error: cannot queue start_campaign for confirmation without a campaign ID. Please try again or create a campaign first.",
        };
      }

      // ── Recipient count pre-check for start_campaign ──────────────────────
      // Block start_campaign if the campaign has no recipients. This gives a
      // clear error before the backend's 422 (which is a generic "no pending
      // recipients" response). The check runs after add_recipients may have
      // already been auto-injected so the count reflects any inline emails.
      if (step.toolName === "start_campaign" && resolvedArgs.campaignId) {
        const countCheckState: AgentGraphStateType = {
          ...state,
          toolName:         "get_recipient_count",
          toolArgs:         { campaignId: resolvedArgs.campaignId },
          activeCampaignId: resolvedArgs.campaignId as string,
        };
        const countPatch = await toolExecutionService.executeFromState(countCheckState);
        if (!countPatch.error && countPatch.toolResult && !countPatch.toolResult.isToolError) {
          const raw = countPatch.toolResult.data as Record<string, unknown> | undefined;
          const countData =
            typeof raw?.data === "object" && raw.data !== null
              ? (raw.data as Record<string, unknown>)
              : raw;
          const totalCount = typeof countData?.totalCount === "number" ? countData.totalCount : -1;
          if (totalCount === 0) {
            log.warn(
              { sessionId, stepIndex: i, campaignId: resolvedArgs.campaignId },
              "executePlanStep: start_campaign blocked — campaign has no recipients",
            );
            return {
              error:
                "This campaign has no recipients. Please add at least one recipient before starting the campaign.",
              toolName: "start_campaign",
              planResults,
              planIndex: i,
            };
          }
          log.info(
            { sessionId, campaignId: resolvedArgs.campaignId, totalCount },
            "executePlanStep: recipient count check passed for start_campaign",
          );
        }
      }

      // Inject resolved args back into the plan so planExecution.service reads them on resume.
      const resolvedPlan = plan.map((s, idx) =>
        idx === i ? { ...s, toolArgs: resolvedArgs } : s,
      );

      const action = await pendingActionService.create({
        userId:    userId!,
        sessionId: sessionId!,
        intent:    step.intent,
        toolName:  step.toolName,
        toolArgs:  resolvedArgs,
        planContext: {
          plan:             resolvedPlan,
          pausedStepIndex:  i,
          completedResults: planResults,
          llmExtractedArgs,
          activeCampaignId: localActiveCampaignId,
        },
      });

      log.info(
        {
          sessionId,
          stepIndex:      i,
          toolName:       step.toolName,
          intent:         step.intent,
          pendingActionId: action.id,
          priorSteps:     planResults.length,
          pendingArgs:    resolvedArgs,
        },
        "Plan paused with pending action args",
      );

      return {
        requiresApproval: true,
        pendingActionId:  action.id,
        intent:           step.intent,
        toolName:         step.toolName,
        planResults,
        planIndex:        i,
      };
    }

    // ── Safe step: execute immediately ─────────────────────────────────────

    const execState: AgentGraphStateType = {
      ...state,
      toolName:         step.toolName,
      toolArgs:         step.toolArgs,
      intent:           step.intent,
      activeCampaignId: localActiveCampaignId,
    };

    log.debug(
      { sessionId, stepIndex: i, toolName: step.toolName },
      "Executing safe plan step",
    );

    const patch = await toolExecutionService.executeFromState(execState);

    if (patch.error) {
      log.warn(
        { sessionId, stepIndex: i, toolName: step.toolName, error: patch.error },
        "Plan step failed — aborting plan",
      );
      // Include toolName so finalResponseNode can produce a meaningful error
      // message rather than falling back to the raw error string.
      return { error: patch.error, toolName: step.toolName, planResults, planIndex: i };
    }

    if (patch.toolResult) {
      planResults.push({
        stepIndex:  i,
        toolName:   step.toolName,
        toolArgs:   step.toolArgs,
        toolResult: patch.toolResult,
        executedAt: new Date().toISOString(),
      });

      // After a successful create_campaign step, capture the new campaign ID so
      // subsequent steps (e.g. start_campaign) target the just-created campaign.
      if (step.toolName === "create_campaign" && !patch.toolResult.isToolError) {
        const raw = patch.toolResult.data as Record<string, unknown> | undefined;
        if (raw?.success !== false) {
          const campaignData =
            typeof raw?.data === "object" && raw.data !== null
              ? (raw.data as Record<string, unknown>)
              : raw;
          const rawId = campaignData?.id;
          const newId =
            typeof rawId === "string"  ? rawId
            : typeof rawId === "number" ? String(rawId)
            : undefined;
          if (newId) {
            localActiveCampaignId = newId;
            log.info({ newCampaignId: newId }, "executePlanStep: activeCampaignId updated after create_campaign");
          }
        }

        // ── Auto-inject add_recipients when the user supplied inline emails ──
        // The planner has no way to know about emails extracted from the prompt;
        // we inject the step here so recipients are saved before start_campaign.
        const inlineEmails = state.extractedRecipients;
        const willCallAddRecipients =
          Boolean(localActiveCampaignId) &&
          Array.isArray(inlineEmails) &&
          inlineEmails.length > 0;

        log.info(
          {
            sessionId,
            newCampaignId: localActiveCampaignId,
            extractedRecipients: inlineEmails,
            willCallAddRecipients,
          },
          "executePlanStep: post-create_campaign state",
        );

        if (willCallAddRecipients) {
          log.info(
            { sessionId, campaignId: localActiveCampaignId, extractedRecipients: inlineEmails },
            "addRecipients: auto-injecting step after create_campaign",
          );

          const addRecipientsArgs = {
            campaignId: localActiveCampaignId,
            recipients: inlineEmails.map((email) => ({ email })),
          };
          const addRecipientsState: AgentGraphStateType = {
            ...state,
            toolName:         "add_recipients",
            toolArgs:         addRecipientsArgs,
            intent:           "create_campaign",
            activeCampaignId: localActiveCampaignId,
          };

          log.info(
            { sessionId, toolArgs: addRecipientsArgs },
            "add_recipients MCP call: toolArgs",
          );
          const addPatch = await toolExecutionService.executeFromState(addRecipientsState);

          if (addPatch.error) {
            log.warn(
              { sessionId, campaignId: localActiveCampaignId, error: addPatch.error },
              "addRecipients: auto-inject step failed — continuing without recipients",
            );
          } else if (addPatch.toolResult) {
            const addResult = addPatch.toolResult.data as Record<string, unknown> | undefined;
            log.info(
              {
                sessionId,
                campaignId: localActiveCampaignId,
                count: inlineEmails.length,
                saved: addResult?.saved,
                skipped: addResult?.skipped,
              },
              "addRecipients: auto-injected recipients saved",
            );
            planResults.push({
              stepIndex:  i + 0.5,   // fractional so it sorts after create_campaign
              toolName:   "add_recipients",
              toolArgs:   addRecipientsArgs,
              toolResult: addPatch.toolResult,
              executedAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  log.info(
    { sessionId, completedSteps: planResults.length },
    "Multi-step plan completed successfully",
  );

  return { planResults, planIndex: plan.length, activeCampaignId: localActiveCampaignId };
}
