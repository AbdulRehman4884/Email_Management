import { createLogger } from "../../lib/logger.js";
import type { AgentGraphStateType, WorkflowType } from "../state/agentGraph.state.js";
import {
  createWorkflowLock,
  popWorkflowStack,
} from "../../lib/workflowConcurrency.js";

const log = createLogger("node:resumeWorkflow");

function buildResumePrompt(state: AgentGraphStateType): string {
  // Enrichment confirm step → show review/save prompt
  if (state.pendingEnrichmentStep === "confirm") {
    const n = state.pendingEnrichmentData?.enrichedCount ?? state.pendingEnrichmentData?.contacts?.length ?? 0;
    const count = typeof n === "number" ? n : 0;
    const noun = count === 1 ? "contact" : "contacts";
    return [
      "### Back to your enrichment review",
      "",
      count > 0
        ? `I still have **${count}** enriched ${noun} ready.`
        : "I still have your enrichment review ready.",
      "",
      "Say **yes** or **save** to add them to a campaign, **customize** to change the tone, or **discard** to cancel.",
    ].join("\n");
  }

  // Campaign selection flow for enrichment save
  if (state.pendingEnrichmentAction === "save_enriched_contacts") {
    return [
      "### Back to campaign selection",
      "",
      "Your contacts are ready. Reply with a **campaign number** or **campaign name** from the list to save them.",
    ].join("\n");
  }

  return "I restored your previous workflow. What would you like to do next?";
}

export async function resumeWorkflowNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { nextStack, item } = popWorkflowStack(state.workflowStack);

  if (!item) {
    return {
      workflowStack: nextStack,
      formattedResponse: "There's no previous workflow to resume right now.",
    };
  }

  const snapshot = (item.snapshot ?? {}) as Partial<AgentGraphStateType>;
  const type = item.type as WorkflowType;
  const interruptible = type === "enrichment";

  log.info({ sessionId: state.sessionId, userId: state.userId, type }, "resumeWorkflow: restoring snapshot");

  return {
    ...snapshot,
    workflowStack: nextStack,
    activeWorkflowLock: createWorkflowLock(type, {
      workflowId: item.workflowId,
      interruptible,
    }),
    formattedResponse: buildResumePrompt({ ...state, ...snapshot } as AgentGraphStateType),
  };
}

