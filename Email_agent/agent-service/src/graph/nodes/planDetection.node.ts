/**
 * src/graph/nodes/planDetection.node.ts
 *
 * Runs after detectIntent to determine if the user message requires a
 * multi-step plan (2–3 sequential MCP tool calls).
 *
 * Delegates entirely to PlannerService.detectPlan():
 *   - Returns { plan } with a PlannedStep[] when a multi-step plan is found.
 *   - Returns { plan: undefined } for single-step requests (the agent.workflow
 *     conditional edge routes these to the standard manager path).
 *
 * This node is always fast: it only calls Gemini when GEMINI_API_KEY is
 * configured and the intent is not general_help.  Any Gemini failure or
 * parse error silently falls through to the single-step path.
 */

import { plannerService } from "../../services/planner.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

export async function planDetectionNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const plan = await plannerService.detectPlan(state);
  return { plan: plan ?? undefined };
}
