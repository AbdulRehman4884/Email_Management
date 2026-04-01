/**
 * src/graph/nodes/campaign.node.ts
 *
 * Thin LangGraph node wrapper — delegates to CampaignAgent.
 */

import { campaignAgent } from "../../agents/CampaignAgent.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

export async function campaignNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  return campaignAgent.handle(state);
}
