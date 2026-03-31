/**
 * src/graph/workflow/agent.workflow.ts
 *
 * Compiles the MailFlow agent LangGraph workflow.
 *
 * Graph topology (Phase E — multi-step planning):
 *
 *   START
 *     │
 *   loadMemory            (restore session context)
 *     │
 *   detectIntent          (LLM-first intent detection with deterministic fallback)
 *     │
 *   planDetection         (Gemini: is this a 2–3 step plan? → set state.plan)
 *     │
 *   ┌─┴──────────────────────────────────────────────┐
 *   manager                                  executePlanStep
 *   (single-step: set agentDomain)           (multi-step: run safe steps,
 *     │                                       pause at risky step)
 *   ┌─┴──────────┬──────────────┬──────────────────────┐
 *   campaign  analytics       inbox              finalResponse
 *     │           │              │               (general_help / fallback)
 *   approval ─────┴──────────────┘
 *     │
 *   ┌─┴──────────────────────────────┐
 *   executeTool                finalResponse  ← approval=true (awaiting confirm)
 *   (approval=false)
 *     │
 *   finalResponse
 *     │
 *   saveMemory            (persist turn to session)
 *     │
 *   END
 *
 * Routing notes:
 *   - planDetection: plan.length >= 2 → executePlanStep; otherwise → manager.
 *   - "settings" domain routes to campaign node (CampaignAgent owns smtp intents).
 *   - Risky single-step actions bypass executeTool; tool runs after confirm.
 *   - Risky multi-step steps pause at executePlanStep with a PendingAction.
 *   - saveMemory is a side-effect node; it never alters state (returns empty patch).
 *   - Memory errors in loadMemory/saveMemory are swallowed — they must not abort the graph.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentGraphState } from "../state/agentGraph.state.js";
import { loadMemoryNode }        from "../nodes/loadMemory.node.js";
import { detectIntentNode }      from "../nodes/detectIntent.node.js";
import { planDetectionNode }     from "../nodes/planDetection.node.js";
import { managerNode, routeToAgent } from "../nodes/manager.node.js";
import { campaignNode }          from "../nodes/campaign.node.js";
import { analyticsNode }         from "../nodes/analytics.node.js";
import { inboxNode }             from "../nodes/inbox.node.js";
import { approvalNode }          from "../nodes/approval.node.js";
import { executeToolNode }       from "../nodes/executeTool.node.js";
import { executePlanStepNode }   from "../nodes/executePlanStep.node.js";
import { finalResponseNode }     from "../nodes/finalResponse.node.js";
import { saveMemoryNode }        from "../nodes/saveMemory.node.js";
import type { AgentRoute }       from "../nodes/manager.node.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

// ── Plan detection routing ────────────────────────────────────────────────────

type PlanRoute = "executePlanStep" | "manager";

/**
 * Routes to executePlanStep for genuine multi-step plans (≥2 steps).
 * Falls through to manager for single-step requests, general_help, and
 * all cases where Gemini is unavailable or plan detection failed.
 */
function routeFromPlanDetection(state: AgentGraphStateType): PlanRoute {
  return state.plan && state.plan.length >= 2 ? "executePlanStep" : "manager";
}

// ── Approval routing ──────────────────────────────────────────────────────────

type ApprovalRoute = "executeTool" | "formatResponse";

function routeFromApproval(state: AgentGraphStateType): ApprovalRoute {
  if (state.requiresApproval) return "formatResponse";
  // A domain agent may set state.error before dispatch (e.g. missing required
  // fields for create_campaign).  Skip tool execution and go straight to
  // finalResponse so the clarification message reaches the user.
  if (state.error) return "formatResponse";
  return "executeTool";
}

// ── Build ─────────────────────────────────────────────────────────────────────

const workflow = new StateGraph(AgentGraphState)

  // ── Nodes ──────────────────────────────────────────────────────────────────
  .addNode("loadMemory",    loadMemoryNode)
  .addNode("detectIntent",  detectIntentNode)
  .addNode("planDetection", planDetectionNode)
  .addNode("manager",       managerNode)
  .addNode("campaign",      campaignNode)
  .addNode("analytics",     analyticsNode)
  .addNode("inbox",         inboxNode)
  .addNode("approval",      approvalNode)
  .addNode("executeTool",   executeToolNode)
  .addNode("executePlanStep", executePlanStepNode)
  .addNode("formatResponse", finalResponseNode)
  .addNode("saveMemory",    saveMemoryNode)

  // ── Edges ──────────────────────────────────────────────────────────────────
  .addEdge(START, "loadMemory")
  .addEdge("loadMemory", "detectIntent")
  .addEdge("detectIntent", "planDetection")

  // planDetection: multi-step → executePlanStep; single-step → manager
  .addConditionalEdges(
    "planDetection",
    routeFromPlanDetection,
    {
      executePlanStep: "executePlanStep",
      manager:         "manager",
    },
  )

  // executePlanStep always flows to finalResponse (handles both success and
  // approval-pause; finalResponse reads state.requiresApproval to decide format)
  .addEdge("executePlanStep", "formatResponse")

  // Manager: conditional routing by agentDomain
  .addConditionalEdges(
    "manager",
    routeToAgent,
    {
      campaign:       "campaign",
      analytics:      "analytics",
      inbox:          "inbox",
      formatResponse: "formatResponse",
    },
  )

  // All domain agents flow through the approval gate
  .addEdge("campaign",  "approval")
  .addEdge("analytics", "approval")
  .addEdge("inbox",     "approval")

  // Approval: safe actions execute the tool; risky actions skip to finalResponse
  .addConditionalEdges(
    "approval",
    routeFromApproval,
    {
      executeTool:    "executeTool",
      formatResponse: "formatResponse",
    },
  )

  // Tool execution leads to final response
  .addEdge("executeTool",   "formatResponse")

  // All paths converge at finalResponse then persist to memory
  .addEdge("formatResponse", "saveMemory")
  .addEdge("saveMemory",    END);

// ── Compile ───────────────────────────────────────────────────────────────────

/**
 * Compiled, runnable agent graph.
 *
 * Usage:
 *   const result = await agentGraph.invoke({
 *     userMessage: "Show campaign stats",
 *     sessionId,
 *     userId,
 *     rawToken,
 *     messages: [],
 *   });
 *
 *   result.finalResponse      — response text for the user
 *   result.requiresApproval   — true if a confirmation step is needed
 *   result.pendingActionId    — present when requiresApproval=true
 *   result.toolResult         — present when a tool ran successfully
 */
export const agentGraph = workflow.compile();

export type AgentGraph = typeof agentGraph;
