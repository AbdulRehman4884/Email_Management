/**
 * src/graph/nodes/validation.node.ts
 *
 * Validation node — runs after every domain agent to verify that the required
 * parameters for the selected tool have been resolved before dispatch.
 *
 * When a domain agent detects missing required parameters it signals this by
 * returning { toolName: undefined, error: <clarification> }.  This node
 * formalises that check in the graph topology and drives downstream routing.
 *
 * Additionally, as a tool-call safety layer, this node blocks update_campaign
 * from reaching the MCP server without a campaignId, even if the domain agent
 * somehow set toolName without one.
 *
 * Routing outcomes:
 *   "clarification" — toolName is absent (missing params); route to clarificationNode
 *   "approval"      — toolName is present and args are valid; proceed to approval gate
 *
 * Log events emitted:
 *   AI_TOOL_BLOCKED — update_campaign reached this node without a campaignId
 */

import { createLogger } from "../../lib/logger.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:validation");

// ── Route type ─────────────────────────────────────────────────────────────────

export type ValidationRoute = "clarification" | "approval";

// ── Routing predicate (consumed by agent.workflow.ts conditional edge) ─────────

/**
 * Returns "clarification" when the domain agent did not set a toolName
 * (i.e. required parameters are missing), and "approval" otherwise.
 */
export function routeFromValidation(state: AgentGraphStateType): ValidationRoute {
  if (!state.toolName) {
    log.debug(
      { sessionId: state.sessionId, intent: state.intent },
      "Validation: toolName absent — routing to clarification",
    );
    return "clarification";
  }
  return "approval";
}

// ── Node ───────────────────────────────────────────────────────────────────────

/**
 * Tool-call safety guard.
 *
 * CampaignAgent already validates parameters and clears toolName when they are
 * absent.  This node is an additional safety net to ensure update_campaign is
 * never dispatched to the MCP server without a campaignId, regardless of how
 * toolArgs were assembled upstream.
 *
 * For all other tools: passes through unchanged so the conditional edge on this
 * node drives routing based solely on whether toolName was set.
 */
export async function validationNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  if (state.toolName === "update_campaign") {
    const hasCampaignId =
      typeof state.toolArgs.campaignId === "string" &&
      state.toolArgs.campaignId.length > 0;

    if (!hasCampaignId) {
      log.warn(
        {
          event:     "AI_TOOL_BLOCKED",
          sessionId: state.sessionId,
          toolName:  state.toolName,
          argKeys:   Object.keys(state.toolArgs),
        },
        "AI_TOOL_BLOCKED: update_campaign arrived at validation without campaignId",
      );
      return {
        toolName: undefined,
        toolArgs: {},
        error:
          state.error ??
          "A campaign ID is required to update a campaign. Please specify which campaign to update.",
      };
    }
  }

  // All other tools: no state change — routing is driven by whether toolName is set.
  return {};
}
