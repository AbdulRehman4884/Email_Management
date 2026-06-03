/**
 * LangGraph node wrapper for read-only research outreach intelligence.
 */

import { createLogger } from "../../lib/logger.js";
import { researchOutreachAgent } from "../../agents/ResearchOutreachAgent.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:researchOutreach");

export async function researchOutreachNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  log.info(
    {
      sessionId: state.sessionId,
      userId: state.userId,
      intent: state.intent,
    },
    "researchOutreachNode: entry",
  );

  return researchOutreachAgent.handle(state);
}
