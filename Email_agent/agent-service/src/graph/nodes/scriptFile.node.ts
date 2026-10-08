/**
 * src/graph/nodes/scriptFile.node.ts
 *
 * LangGraph node wrapper for saving a script-generation file upload.
 * Always flows to finalResponse (formattedResponse is always set).
 */

import { createLogger } from "../../lib/logger.js";
import { scriptFileAgent } from "../../agents/ScriptFileAgent.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:scriptFile");

export async function scriptFileNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  log.info(
    { sessionId: state.sessionId, userId: state.userId, intent: state.intent, hasFile: !!state.pendingCsvFile },
    "scriptFileNode: entry",
  );

  try {
    return await scriptFileAgent.handle(state);
  } catch (err) {
    log.error({ sessionId: state.sessionId, error: err instanceof Error ? err.message : "unknown" }, "scriptFileNode: failed");
    return {
      pendingCsvFile:    undefined,
      formattedResponse: "Something went wrong while saving your file. Please try again.",
    };
  }
}
