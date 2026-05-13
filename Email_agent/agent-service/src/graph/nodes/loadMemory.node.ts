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
import { isWorkflowDeadlineExpired, WORKFLOW_PENDING_TTL_MS } from "../../lib/mcpErrorMapping.js";

const log = createLogger("node:loadMemory");

const SESSION_SCHEMA_VERSION = 2;

/** Maximum number of historical messages to restore into state per turn. */
const RESTORE_LIMIT = 10;

function toBaseMessage(stored: StoredMessage) {
  switch (stored.role) {
    case "human":  return new HumanMessage(stored.content);
    case "ai":     return new AIMessage(stored.content);
    case "system": return new SystemMessage(stored.content);
  }
}

function isStackItemExpired(createdAtIso: string | undefined): boolean {
  if (!createdAtIso) return true;
  const t = Date.parse(createdAtIso);
  if (Number.isNaN(t)) return true;
  return Date.now() > t + WORKFLOW_PENDING_TTL_MS;
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

  const contextDetected = !!(
    snapshot.activeCampaignId ||
    snapshot.pendingAiCampaignStep ||
    snapshot.pendingCampaignAction ||
    snapshot.campaignSelectionList?.length
  );

  log.info(
    {
      userId,
      sessionId,
      restoredMessages:      messages.length,
      activeCampaignId:      snapshot.activeCampaignId,
      pendingAiCampaignStep: snapshot.pendingAiCampaignStep,
      pendingCampaignAction: snapshot.pendingCampaignAction,
      hasPendingDraft:       !!snapshot.pendingCampaignDraft,
      pendingCampaignStep:   snapshot.pendingCampaignStep,
      hasAiCampaignData:     !!snapshot.pendingAiCampaignData,
      hasSenderDefaults:     !!snapshot.senderDefaults,
      contextDetected,
    },
    "loadMemory: session context restored",
  );

  let workflowExpiredNotice: string | undefined;
  let pendingEnrichmentStep = snapshot.pendingEnrichmentStep;
  let pendingEnrichmentData = snapshot.pendingEnrichmentData;
  let pendingOutreachDraft = snapshot.pendingOutreachDraft;
  let pendingEnrichmentAction = snapshot.pendingEnrichmentAction;
  let pendingCsvData = snapshot.pendingCsvData;
  let campaignSelectionList = snapshot.campaignSelectionList;
  let pendingPhase3EnrichmentAction = snapshot.pendingPhase3EnrichmentAction as AgentGraphStateType["pendingPhase3EnrichmentAction"];
  let pendingPhase3CompanyName = snapshot.pendingPhase3CompanyName;
  let pendingPhase3Url = snapshot.pendingPhase3Url;
  let pendingPhase3WebsiteContent = snapshot.pendingPhase3WebsiteContent;
  let pendingPhase3ToolQueue = snapshot.pendingPhase3ToolQueue;
  let pendingPhase3Scratch = snapshot.pendingPhase3Scratch;
  let pendingPhase3ContinueExecute = snapshot.pendingPhase3ContinueExecute;
  let pendingWorkflowDeadlineIso = snapshot.pendingWorkflowDeadlineIso;
  let activeWorkflowLock = snapshot.activeWorkflowLock;
  let workflowStack = snapshot.workflowStack;

  if (
    snapshot.sessionSchemaVersion !== undefined &&
    snapshot.sessionSchemaVersion > SESSION_SCHEMA_VERSION
  ) {
    log.warn(
      { sessionId, snapshotVersion: snapshot.sessionSchemaVersion },
      "loadMemory: newer session schema than runtime — clearing volatile workflow state",
    );
    pendingEnrichmentStep = undefined;
    pendingEnrichmentData = undefined;
    pendingOutreachDraft = undefined;
    pendingEnrichmentAction = undefined;
    pendingCsvData = undefined;
    campaignSelectionList = undefined;
    pendingPhase3EnrichmentAction = undefined;
    pendingPhase3CompanyName = undefined;
    pendingPhase3Url = undefined;
    pendingPhase3WebsiteContent = undefined;
    pendingPhase3ToolQueue = undefined;
    pendingPhase3Scratch = undefined;
    pendingPhase3ContinueExecute = undefined;
    pendingWorkflowDeadlineIso = undefined;
    activeWorkflowLock = undefined;
    workflowStack = undefined;
    workflowExpiredNotice =
      "Your assistant session was upgraded. Please start your task again from this point.";
  }

  // Clear expired lock (if any)
  if (!workflowExpiredNotice && activeWorkflowLock?.expiresAtIso) {
    if (isWorkflowDeadlineExpired(activeWorkflowLock.expiresAtIso)) {
      log.info({ userId, sessionId, lockType: activeWorkflowLock.type }, "loadMemory: cleared expired workflow lock");
      activeWorkflowLock = undefined;
    }
  }

  // Remove expired stack items
  if (!workflowExpiredNotice && Array.isArray(workflowStack) && workflowStack.length > 0) {
    const before = workflowStack.length;
    workflowStack = workflowStack.filter((w) => !isStackItemExpired(w.createdAtIso));
    if (workflowStack.length !== before) {
      log.info({ userId, sessionId, before, after: workflowStack.length }, "loadMemory: removed expired workflow stack items");
    }
  }
  if (Array.isArray(workflowStack) && workflowStack.length === 0) {
    workflowStack = undefined;
  }

  const hadPendingWorkflow =
    !!pendingEnrichmentStep ||
    !!pendingEnrichmentAction ||
    !!pendingCsvData ||
    (Array.isArray(pendingPhase3ToolQueue) && pendingPhase3ToolQueue.length > 0) ||
    !!pendingPhase3EnrichmentAction;

  if (
    !workflowExpiredNotice &&
    isWorkflowDeadlineExpired(snapshot.pendingWorkflowDeadlineIso) &&
    hadPendingWorkflow
  ) {
    workflowExpiredNotice =
      "Your previous MailFlow assistant step expired after inactivity. Upload your CSV again or run your request once more to continue.";
    pendingEnrichmentStep = undefined;
    pendingEnrichmentData = undefined;
    pendingOutreachDraft = undefined;
    pendingEnrichmentAction = undefined;
    pendingCsvData = undefined;
    campaignSelectionList = undefined;
    pendingPhase3EnrichmentAction = undefined;
    pendingPhase3CompanyName = undefined;
    pendingPhase3Url = undefined;
    pendingPhase3WebsiteContent = undefined;
    pendingPhase3ToolQueue = undefined;
    pendingPhase3Scratch = undefined;
    pendingPhase3ContinueExecute = undefined;
    pendingWorkflowDeadlineIso = undefined;
    if (activeWorkflowLock && (activeWorkflowLock.type === "enrichment" || activeWorkflowLock.type === "phase3")) {
      activeWorkflowLock = undefined;
    }
    log.info({ userId, sessionId }, "loadMemory: cleared expired workflow pending state");
  }

  return {
    messages,
    activeCampaignId:       snapshot.activeCampaignId,
    senderDefaults:         snapshot.senderDefaults,
    pendingCampaignDraft:   snapshot.pendingCampaignDraft,
    pendingCampaignStep:    snapshot.pendingCampaignStep,
    pendingCampaignAction:  snapshot.pendingCampaignAction,
    campaignSelectionList,
    pendingScheduledAt:     snapshot.pendingScheduledAt,
    pendingAiCampaignStep:  snapshot.pendingAiCampaignStep,
    pendingAiCampaignData:  snapshot.pendingAiCampaignData,
    pendingCsvData,
    pendingEnrichmentStep,
    pendingEnrichmentData,
    pendingOutreachDraft,
    pendingEnrichmentAction,
    pendingPhase3EnrichmentAction,
    pendingPhase3CompanyName,
    pendingPhase3Url,
    pendingPhase3WebsiteContent,
    pendingPhase3ToolQueue,
    pendingPhase3Scratch,
    pendingPhase3ContinueExecute,
    pendingWorkflowDeadlineIso,
    workflowExpiredNotice,
    sessionSchemaVersion: snapshot.sessionSchemaVersion ?? SESSION_SCHEMA_VERSION,
    activeWorkflowLock,
    workflowStack,
  };
}
