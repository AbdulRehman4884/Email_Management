/**
 * src/graph/nodes/inbox.node.ts
 *
 * Thin LangGraph node wrapper — delegates to InboxAgent.
 *
 * InboxAgent reads state.llmExtractedArgs (set by detectIntent.node when
 * Gemini successfully classifies the intent) and uses resolveToolArgs() to
 * merge those args with state.activeCampaignId into the final toolArgs.
 *
 * A previous implementation added a secondary Gemini call here to extract
 * filter parameters for summarize_replies.  That was removed when
 * detectIntent.node began storing structured args in state.llmExtractedArgs,
 * making the duplicate call wasteful and redundant.
 */

import { inboxAgent } from "../../agents/InboxAgent.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

export async function inboxNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  return inboxAgent.handle(state);
}
