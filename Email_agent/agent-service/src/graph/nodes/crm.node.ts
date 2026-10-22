/**
 * src/graph/nodes/crm.node.ts
 *
 * Thin LangGraph node wrapper — delegates to CrmAgent (read-only CRM intents).
 */

import { crmAgent } from "../../agents/CrmAgent.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

export async function crmNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  return crmAgent.handle(state);
}
