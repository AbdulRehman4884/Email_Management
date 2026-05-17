/**
 * src/graph/nodes/enrichment.node.ts
 *
 * LangGraph node wrapper for the EnrichmentAgent.
 * Delegates to EnrichmentAgent.handle() and returns its state patch.
 */

import { createLogger } from "../../lib/logger.js";
import { enrichmentAgent } from "../../agents/EnrichmentAgent.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:enrichment");

export async function enrichmentNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  log.info(
    {
      sessionId:             state.sessionId,
      userId:                state.userId,
      intent:                state.intent,
      pendingEnrichmentStep: state.pendingEnrichmentStep,
      hasCsvFile:            !!state.pendingCsvFile,
      hasCsvData:            !!state.pendingCsvData,
    },
    "enrichmentNode: entry",
  );

  return enrichmentAgent.handle(state);
}
