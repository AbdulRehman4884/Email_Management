/**
 * src/graph/workflow/agent.workflow.ts
 *
 * Compiles the MailFlow agent LangGraph workflow.
 *
 * Graph topology (Phase F — validation + clarification):
 *
 *   START
 *     │
 *   loadMemory            (restore session context)
 *     │
 *   detectIntent          (LLM-first intent detection with deterministic fallback)
 *     │
 *   planDetection         (OpenAI/Gemini: is this a 2–3 step plan? → set state.plan)
 *     │
 *   ┌─┴──────────────────────────────────────────────┐
 *   manager                                  executePlanStep
 *   (single-step: set agentDomain)           (multi-step: run safe steps,
 *     │                                       pause at risky step)
 *   ┌─┴──────────┬──────────────┬──────────────────────┐
 *   campaign  analytics       inbox              finalResponse
 *     │           │              │               (general_help / fallback)
 *   validation ───┴──────────────┘
 *     │
 *   ┌─┴─────────────────────────────────┐
 *   clarification               approval
 *   (toolName absent —           (toolName present — proceed)
 *    missing params)               │
 *     │                   ┌────────┴───────────────┐
 *   saveMemory         executeTool           finalResponse
 *                      (approval=false)      (approval=true)
 *                          │
 *                      finalResponse
 *                          │
 *                      saveMemory            (persist turn to session)
 *                          │
 *                         END
 *
 * Routing notes:
 *   - planDetection: plan.length >= 2 → executePlanStep; otherwise → manager.
 *   - "settings" domain routes to campaign node (CampaignAgent owns smtp intents).
 *   - validation node guards update_campaign against dispatch without campaignId.
 *   - clarification node returns structured JSON { status:"needs_input", ... }.
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
import { validationNode, routeFromValidation } from "../nodes/validation.node.js";
import { clarificationNode }     from "../nodes/clarification.node.js";
import { approvalNode }          from "../nodes/approval.node.js";
import { executeToolNode }       from "../nodes/executeTool.node.js";
import { executePlanStepNode }   from "../nodes/executePlanStep.node.js";
import { finalResponseNode }     from "../nodes/finalResponse.node.js";
import { saveMemoryNode }        from "../nodes/saveMemory.node.js";
import type { AgentRoute }       from "../nodes/manager.node.js";
import type { ValidationRoute }  from "../nodes/validation.node.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

// ── Plan detection routing ────────────────────────────────────────────────────

type PlanRoute = "executePlanStep" | "manager";

// Suppress unused-import warning — ValidationRoute is used as a type constraint
// in the addConditionalEdges call below.
type _ValidationRoute = ValidationRoute;

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
  .addNode("loadMemory",      loadMemoryNode)
  .addNode("detectIntent",    detectIntentNode)
  .addNode("planDetection",   planDetectionNode)
  .addNode("manager",         managerNode)
  .addNode("campaign",        campaignNode)
  .addNode("analytics",       analyticsNode)
  .addNode("inbox",           inboxNode)
  .addNode("validation",      validationNode)
  .addNode("clarification",   clarificationNode)
  .addNode("approval",        approvalNode)
  .addNode("executeTool",     executeToolNode)
  .addNode("executePlanStep", executePlanStepNode)
  .addNode("formatResponse",  finalResponseNode)
  .addNode("saveMemory",      saveMemoryNode)

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

  // All domain agents flow through the validation gate first
  .addEdge("campaign",  "validation")
  .addEdge("analytics", "validation")
  .addEdge("inbox",     "validation")

  // Validation: if toolName is absent (missing params) → clarification;
  // if toolName is present and args are valid → approval gate
  .addConditionalEdges(
    "validation",
    routeFromValidation,
    {
      clarification: "clarification",
      approval:      "approval",
    },
  )

  // Clarification writes finalResponse and routes directly to saveMemory —
  // no tool execution or approval step is needed
  .addEdge("clarification", "saveMemory")

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
