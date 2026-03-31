/**
 * src/graph/nodes/saveMemory.node.ts
 *
 * Last node in the graph — persists the completed turn to session memory.
 *
 * Reads:   state.userId, state.sessionId, state.userMessage,
 *          state.finalResponse, state.intent, state.agentDomain,
 *          state.activeCampaignId, state.toolName, state.toolResult
 * Writes:  nothing to state (returns empty patch)
 *
 * Side effects only — state is unchanged after this node.
 *
 * What is saved per turn:
 *   - userMessage  → StoredMessage{ role: "human" }
 *   - finalResponse → StoredMessage{ role: "ai" }
 *   - intent, agentDomain, activeCampaignId → session metadata
 *   - toolName + success/fail → ToolCallRecord (if a tool was selected)
 */

import { createLogger } from "../../lib/logger.js";
import { sessionMemoryService } from "../../services/sessionMemory.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:saveMemory");

export async function saveMemoryNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const {
    userId, sessionId,
    userMessage, finalResponse,
    intent, agentDomain, activeCampaignId,
    toolName, toolResult,
  } = state;

  if (!userId || !sessionId) {
    log.debug("saveMemory: no userId/sessionId — skipping");
    return {};
  }

  const aiResponse = finalResponse ?? "";

  const toolCall = toolName
    ? {
        toolName,
        success: !toolResult?.isToolError && !state.error,
      }
    : undefined;

  try {
    await sessionMemoryService.saveTurn(
      userId as string,
      sessionId as string,
      {
        userMessage,
        aiResponse,
        metadata: {
          lastIntent:      intent,
          lastAgentDomain: agentDomain,
          activeCampaignId,
        },
        toolCall,
      },
    );

    log.debug({ userId, sessionId, intent }, "saveMemory: turn persisted");
  } catch (err) {
    // Memory errors must never crash the graph — log and continue
    log.error({ userId, sessionId, err }, "saveMemory: failed to persist session (non-fatal)");
  }

  return {};
}
