/**
 * src/graph/nodes/leadgen.node.ts
 *
 * Thin LangGraph node wrapper — delegates to LeadGenAgent (lead finder intents).
 */

import { leadGenAgent } from "../../agents/LeadGenAgent.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

export async function leadGenNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  return leadGenAgent.handle(state);
}
