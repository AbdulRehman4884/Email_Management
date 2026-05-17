/**
 * src/graph/nodes/loadMemory.node.ts
 *
 * First node in the graph — loads session context before any processing.
 *
 * Reads:   state.userId, state.sessionId
 * Writes:  state.messages (prepend session history), state.activeCampaignId
 *
 * If userId or sessionId are absent the node is a no-op — the graph proceeds
 * with empty context (anonymous / first-turn calls).
 *
 * Message restoration:
 *   Stored messages are converted back to LangChain BaseMessage instances
 *   so the conversation history is available to LLM nodes (Phase 6+).
 *   The current turn's message is NOT in the store yet — it is appended by
 *   saveMemory after the graph completes.
 */

import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { createLogger } from "../../lib/logger.js";
import { sessionMemoryService } from "../../services/sessionMemory.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { StoredMessage } from "../../memory/sessionMemory.store.js";

const log = createLogger("node:loadMemory");

/** Maximum number of historical messages to restore into state per turn. */
const RESTORE_LIMIT = 10;

function toBaseMessage(stored: StoredMessage) {
  switch (stored.role) {
    case "human":  return new HumanMessage(stored.content);
    case "ai":     return new AIMessage(stored.content);
    case "system": return new SystemMessage(stored.content);
  }
}

export async function loadMemoryNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { userId, sessionId } = state;

  if (!userId || !sessionId) {
    log.debug("loadMemory: no userId/sessionId — skipping");
    return {};
  }

  const snapshot = await sessionMemoryService.get(
    userId as string,
    sessionId as string,
  );

  if (!snapshot) {
    log.debug({ userId, sessionId }, "loadMemory: no existing session — starting fresh");
    return {};
  }

  // Restore the most recent N messages as BaseMessage instances.
  // messagesStateReducer will append them to the current state.messages ([]).
  const messages = snapshot.messages
    .slice(-RESTORE_LIMIT)
    .map(toBaseMessage);

  log.debug(
    { userId, sessionId, restoredMessages: messages.length, activeCampaignId: snapshot.activeCampaignId },
    "loadMemory: session context restored",
  );

  return {
    messages,
    activeCampaignId: snapshot.activeCampaignId,
  };
}
