/**
 * src/services/planner.service.ts
 *
 * Detects whether a user message requires a multi-step plan (2–3 MCP tool
 * calls) and, if so, builds the ordered list of PlannedStep objects.
 *
 * Single-step requests (including those requiring approval) continue to use
 * the existing manager → domain-agent → approval → executeTool path.
 * This service only activates for genuinely multi-step tasks.
 *
 * Plan building rules:
 *   1. Skip planning if OPENAI_API_KEY is not configured or intent is
 *      general_help (no tools involved).
 *   2. Ask OpenAI for a multi-step plan via openai.planSteps().
 *   3. Validate with LLMPlanResponseSchema (Zod).
 *   4. Return null if: OpenAI unavailable, response invalid, isMultiStep=false,
 *      fewer than 2 valid steps, or any step has an unrecognised tool.
 *   5. For each valid step:
 *      a. Resolve toolArgs via resolveToolArgs() (consistent arg rules + security).
 *      b. Tag requiresApproval via approvalPolicyService.
 *   6. Return the typed PlannedStep[].
 */

import { createLogger } from "../lib/logger.js";
import { getOpenAIService } from "./openai.service.js";
import { resolveToolArgs } from "../lib/toolArgResolver.js";
import { approvalPolicyService } from "./approvalPolicy.service.js";
import { LLMPlanResponseSchema } from "../schemas/plan.schema.js";
import { KNOWN_TOOL_NAMES } from "../types/tools.js";
import { ALL_INTENTS } from "../config/intents.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { PlannedStep } from "../lib/planTypes.js";

const log = createLogger("planner");

// ── Service ───────────────────────────────────────────────────────────────────

export class PlannerService {
  /**
   * Attempts to build a multi-step plan for the current graph state.
   *
   * Returns an ordered PlannedStep[] with at least 2 steps, or null when
   * the request is single-step (falls through to the existing agent path).
   */
  async detectPlan(state: AgentGraphStateType): Promise<PlannedStep[] | null> {
    const { userMessage, intent, llmExtractedArgs, activeCampaignId, sessionId } = state;

    // Skip planning for general_help — it never involves MCP tools
    if (intent === "general_help" || !intent) {
      return null;
    }

    if (!userMessage?.trim()) {
      return null;
    }

    // Skip if OpenAI is not configured
    const openai = getOpenAIService();
    if (!openai) {
      return null;
    }

    // ── Ask OpenAI for a plan ────────────────────────────────────────────────

    let rawJson: string | null;
    try {
      rawJson = await openai.planSteps(
        userMessage,
        KNOWN_TOOL_NAMES as unknown as string[],
        ALL_INTENTS as unknown as string[],
      );
    } catch {
      log.warn({ sessionId }, "planSteps OpenAI call threw unexpectedly — skipping multi-step");
      return null;
    }

    if (rawJson === null) {
      return null;
    }

    // ── Parse and validate ───────────────────────────────────────────────────

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      log.warn({ sessionId }, "OpenAI plan response is not valid JSON — skipping multi-step");
      return null;
    }

    const validated = LLMPlanResponseSchema.safeParse(parsed);
    if (!validated.success) {
      log.warn(
        { sessionId, issues: validated.error.issues.map((i) => i.message) },
        "OpenAI plan response failed schema validation — skipping multi-step",
      );
      return null;
    }

    const { isMultiStep, steps } = validated.data;

    // Only activate the plan path for genuine multi-step requests
    if (!isMultiStep || steps.length < 2) {
      return null;
    }

    // ── Build PlannedStep[] ──────────────────────────────────────────────────

    const plan: PlannedStep[] = steps.map((llmStep, idx) => {
      const toolArgs = resolveToolArgs(llmStep.tool, {
        extractedArgs:    llmExtractedArgs,
        activeCampaignId,
      });

      const requiresApproval = approvalPolicyService.requiresApproval(llmStep.intent);

      return {
        stepIndex:        idx,
        toolName:         llmStep.tool,
        toolArgs,
        intent:           llmStep.intent,
        description:      llmStep.description,
        requiresApproval,
      };
    });

    log.info(
      {
        sessionId,
        stepCount: plan.length,
        steps: plan.map((s) => ({ tool: s.toolName, risky: s.requiresApproval })),
      },
      "Multi-step plan detected",
    );

    return plan;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const plannerService = new PlannerService();
