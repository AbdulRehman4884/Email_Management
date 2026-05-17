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
import { enrichmentNode }       from "../nodes/enrichment.node.js";
import { validationNode, routeFromValidation } from "../nodes/validation.node.js";
import { clarificationNode }     from "../nodes/clarification.node.js";
import { approvalNode }          from "../nodes/approval.node.js";
import { executeToolNode }       from "../nodes/executeTool.node.js";
import { executePlanStepNode }   from "../nodes/executePlanStep.node.js";
import { finalResponseNode }     from "../nodes/finalResponse.node.js";
import { saveMemoryNode }        from "../nodes/saveMemory.node.js";
import { resumeWorkflowNode }    from "../nodes/resumeWorkflow.node.js";
import {
  phase3ContinuationNode,
  routeAfterPhase3Continuation,
} from "../nodes/phase3Continuation.node.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

// ── Resume routing (workflow stack) ───────────────────────────────────────────

type DetectRoute = "resumeWorkflow" | "planDetection";
function routeFromDetectIntent(state: AgentGraphStateType): DetectRoute {
  return state.intent === "resume_workflow" ? "resumeWorkflow" : "planDetection";
}

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
  .addNode("loadMemory",      loadMemoryNode)
  .addNode("detectIntent",    detectIntentNode)
  .addNode("resumeWorkflow",  resumeWorkflowNode)
  .addNode("planDetection",   planDetectionNode)
  .addNode("manager",         managerNode)
  .addNode("campaign",        campaignNode)
  .addNode("analytics",       analyticsNode)
  .addNode("inbox",           inboxNode)
  .addNode("enrichment",      enrichmentNode)
  .addNode("validation",      validationNode)
  .addNode("clarification",   clarificationNode)
  .addNode("approval",        approvalNode)
  .addNode("executeTool",     executeToolNode)
  .addNode("phase3Continuation", phase3ContinuationNode)
  .addNode("executePlanStep", executePlanStepNode)
  .addNode("formatResponse",  finalResponseNode)
  .addNode("saveMemory",      saveMemoryNode)

  // ── Edges ──────────────────────────────────────────────────────────────────
  .addEdge(START, "loadMemory")
  .addEdge("loadMemory", "detectIntent")

  // detectIntent: resume → restore snapshot; otherwise → planDetection
  .addConditionalEdges(
    "detectIntent",
    routeFromDetectIntent,
    {
      resumeWorkflow: "resumeWorkflow",
      planDetection:  "planDetection",
    },
  )

  // resumeWorkflow produces a formattedResponse and skips tool execution
  .addEdge("resumeWorkflow", "formatResponse")

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
      enrichment:     "enrichment",
      formatResponse: "formatResponse",
    },
  )

  // All domain agents flow through the validation gate first
  .addEdge("campaign",    "validation")
  .addEdge("analytics",   "validation")
  .addEdge("inbox",       "validation")
  .addEdge("enrichment",  "validation")

  // Validation routing:
  //   formattedResponse set → skip clarification, go straight to finalResponse
  //   toolName absent       → clarification (missing required params)
  //   toolName present      → approval gate (proceed to tool execution)
  .addConditionalEdges(
    "validation",
    routeFromValidation,
    {
      clarification:    "clarification",
      approval:         "approval",
      formattedResponse: "formatResponse",
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

  // Tool execution → Phase 3 chain continuation (no-op if not in Phase 3 chain)
  .addEdge("executeTool", "phase3Continuation")
  .addConditionalEdges(
    "phase3Continuation",
    routeAfterPhase3Continuation,
    {
      executeTool:    "executeTool",
      formatResponse: "formatResponse",
    },
  )

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
