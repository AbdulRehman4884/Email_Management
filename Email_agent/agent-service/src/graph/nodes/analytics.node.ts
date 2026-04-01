/**
 * src/graph/nodes/analytics.node.ts
 *
 * Thin LangGraph node wrapper — delegates to AnalyticsAgent.
 */

import { analyticsAgent } from "../../agents/AnalyticsAgent.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

export async function analyticsNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  return analyticsAgent.handle(state);
}
