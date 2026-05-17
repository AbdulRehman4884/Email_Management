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

export async function executePlanStepNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const {
    plan,
    userId,
    sessionId,
    rawToken,
    llmExtractedArgs,
    activeCampaignId,
  } = state;

  if (!plan || plan.length === 0) {
    log.error({ sessionId }, "executePlanStep reached with no plan in state");
    return { error: "Internal error: no plan found for multi-step execution." };
  }

  const planResults: PlanStepResult[] = [];

  for (const [i, step] of plan.entries()) {

    // ── Risky step: pause and request confirmation ──────────────────────────

    if (step.requiresApproval) {
      const action = await pendingActionService.create({
        userId:    userId!,
        sessionId: sessionId!,
        intent:    step.intent,
        toolName:  step.toolName,
        toolArgs:  step.toolArgs,
        planContext: {
          plan,
          pausedStepIndex:  i,
          completedResults: planResults,
          llmExtractedArgs,
          activeCampaignId,
        },
      });

      log.info(
        {
          sessionId,
          stepIndex: i,
          toolName:  step.toolName,
          intent:    step.intent,
          pendingActionId: action.id,
          priorSteps: planResults.length,
        },
        "Plan paused at risky step — awaiting confirmation",
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
      toolName: step.toolName,
      toolArgs: step.toolArgs,
      intent:   step.intent,
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
      return { error: patch.error, planResults, planIndex: i };
    }

    if (patch.toolResult) {
      planResults.push({
        stepIndex:  i,
        toolName:   step.toolName,
        toolArgs:   step.toolArgs,
        toolResult: patch.toolResult,
        executedAt: new Date().toISOString(),
      });
    }
  }

  log.info(
    { sessionId, completedSteps: planResults.length },
    "Multi-step plan completed successfully",
  );

  return { planResults, planIndex: plan.length };
}
