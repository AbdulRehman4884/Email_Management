/**
 * src/services/planExecution.service.ts
 *
 * Resumes a multi-step plan after the user has confirmed a risky step.
 *
 * Called by the /api/agent/confirm controller when the confirmed PendingAction
 * carries a planContext.
 *
 * Execution order:
 *   1. Execute the confirmed risky step (planContext.pausedStepIndex).
 *   2. Execute any subsequent safe steps in order.
 *   3. Stop immediately if any step returns an error.
 *
 * Returns the results of all newly executed steps (pausedStep + remainder).
 * The completedResults from before the pause are not re-executed — they were
 * already surfaced in the original chat response.
 */

import { createLogger } from "../lib/logger.js";
import { toolExecutionService } from "./toolExecution.service.js";
import type { PlanResumptionContext, PlanStepResult } from "../lib/planTypes.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { UserId, SessionId } from "../types/common.js";

const log = createLogger("planExecution");

// ── Result type ───────────────────────────────────────────────────────────────

export interface ResumeResult {
  /** Newly executed steps (the confirmed step + any following safe steps). */
  readonly results: PlanStepResult[];
  /** Set when a step failed; subsequent steps were not attempted. */
  readonly error?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class PlanExecutionService {
  /**
   * Executes the paused step and all subsequent steps in the plan.
   *
   * `rawToken` is sourced from the current request — never stored.
   */
  async resumePlan(
    planContext: PlanResumptionContext,
    rawToken: string,
    userId: UserId,
    sessionId: SessionId,
  ): Promise<ResumeResult> {
    const { plan, pausedStepIndex, llmExtractedArgs, activeCampaignId } = planContext;
    const results: PlanStepResult[] = [];

    // Execute the paused step (now confirmed) and all steps after it
    const stepsToExecute = plan.slice(pausedStepIndex);
    for (const [offset, step] of stepsToExecute.entries()) {
      const i = pausedStepIndex + offset;

      // Construct a minimal execution state for this step
      const execState: AgentGraphStateType = {
        messages:         [],
        userMessage:      "",
        sessionId,
        userId,
        rawToken,
        intent:           step.intent,
        confidence:       1.0,
        agentDomain:      undefined,
        llmExtractedArgs,
        toolName:         step.toolName,
        toolArgs:         step.toolArgs,
        toolResult:       undefined,
        requiresApproval: false,
        pendingActionId:  undefined,
        finalResponse:    undefined,
        error:            undefined,
        activeCampaignId,
        plan,
        planIndex:        i,
        planResults:      [],
      };

      log.debug(
        { sessionId, stepIndex: i, toolName: step.toolName },
        "Resuming plan step",
      );

      const patch = await toolExecutionService.executeFromState(execState);

      if (patch.error) {
        log.warn(
          { sessionId, stepIndex: i, toolName: step.toolName, error: patch.error },
          "Plan step failed during resume — stopping",
        );
        return { results, error: patch.error };
      }

      if (patch.toolResult) {
        results.push({
          stepIndex:   i,
          toolName:    step.toolName,
          toolArgs:    step.toolArgs,
          toolResult:  patch.toolResult,
          executedAt:  new Date().toISOString(),
        });
      }
    }

    log.info(
      { sessionId, resumedSteps: results.length },
      "Plan resumed successfully",
    );

    return { results };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const planExecutionService = new PlanExecutionService();
