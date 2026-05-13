/**
 * src/graph/nodes/saveMemory.node.ts
 *
 * Last node in the graph — persists the completed turn to session memory.
 *
 * Reads:   state.userId, state.sessionId, state.userMessage,
 *          state.finalResponse, state.intent, state.agentDomain,
 *          state.activeCampaignId, state.toolName, state.toolResult
 * Writes:  nothing to state (returns empty patch)
 *
 * Side effects only — state is unchanged after this node.
 *
 * What is saved per turn:
 *   - userMessage  → StoredMessage{ role: "human" }
 *   - finalResponse → StoredMessage{ role: "ai" }
 *   - intent, agentDomain, activeCampaignId → session metadata
 *   - toolName + success/fail → ToolCallRecord (if a tool was selected)
 */

import { createLogger } from "../../lib/logger.js";
import { sessionMemoryService } from "../../services/sessionMemory.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import { computeWorkflowDeadlineIso } from "../../lib/mcpErrorMapping.js";

const log = createLogger("node:saveMemory");

const SESSION_SCHEMA_VERSION = 2;

export async function saveMemoryNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const {
    userId, sessionId,
    userMessage, finalResponse,
    intent, agentDomain, activeCampaignId,
    toolName, toolResult,
    pendingCampaignDraft, pendingCampaignStep,
    senderDefaults,
    pendingCampaignAction, campaignSelectionList,
    pendingScheduledAt,
    pendingAiCampaignStep, pendingAiCampaignData,
    pendingCsvData,
    pendingEnrichmentStep, pendingEnrichmentData, pendingOutreachDraft, pendingEnrichmentAction,
    pendingPhase3EnrichmentAction,
    pendingPhase3CompanyName,
    pendingPhase3Url,
    pendingPhase3WebsiteContent,
    pendingPhase3ToolQueue,
    pendingPhase3Scratch,
    pendingPhase3ContinueExecute,
    pendingWorkflowDeadlineIso,
    activeWorkflowLock,
    workflowStack,
  } = state;

  if (!userId || !sessionId) {
    log.debug("saveMemory: no userId/sessionId — skipping");
    return {};
  }

  const aiResponse = finalResponse ?? "";

  // After a successful campaign creation:
  //  1. Capture fromName/fromEmail as sender defaults for future campaigns.
  //  2. Store the new campaign's ID as activeCampaignId so the next turn
  //     knows which campaign the user is working with.
  let savedSenderDefaults  = senderDefaults;
  let savedActiveCampaignId = activeCampaignId;

  if (toolName === "create_campaign" && toolResult && !toolResult.isToolError) {
    // Sender defaults — read from tool args (pre-dispatch values)
    const args = state.toolArgs as Record<string, unknown>;
    const fromName  = typeof args.fromName  === "string" ? args.fromName  : undefined;
    const fromEmail = typeof args.fromEmail === "string" ? args.fromEmail : undefined;
    if (fromName && fromEmail) {
      savedSenderDefaults = { fromName, fromEmail };
    }

    // Campaign ID — unwrap MCP success envelope { success, data: Campaign }
    const raw          = toolResult.data as Record<string, unknown>;
    const campaignData = (
      typeof raw?.data === "object" && raw.data !== null && !Array.isArray(raw.data)
        ? (raw.data as Record<string, unknown>)
        : raw
    );
    const rawCreatedId = campaignData?.id;
    const createdId = typeof rawCreatedId === "string" ? rawCreatedId
                    : typeof rawCreatedId === "number" ? String(rawCreatedId)
                    : undefined;
    if (createdId) {
      savedActiveCampaignId = createdId;
      log.info({ campaignId: createdId }, "saveMemory: activeCampaignId updated from created campaign");
    }
  }

  // When a campaign list was just fetched, always save it so the next turn can
  // map "1" / "Summer Sale" → campaignId — regardless of whether a pending action
  // triggered the fetch (e.g. plain "list campaigns" should also enable selection).
  let savedCampaignSelectionList = campaignSelectionList;
  let savedPendingCampaignAction = pendingCampaignAction;

  if (
    toolName === "get_all_campaigns" &&
    toolResult &&
    !toolResult.isToolError
  ) {
    const raw = toolResult.data;
    // toolResult.data is the MCP envelope { success, data: Campaign[] }.
    // Unwrap the inner array; also accept a direct array for forward-compat.
    const rawArray: Array<Record<string, unknown>> =
      Array.isArray(raw)
        ? (raw as Array<Record<string, unknown>>)
        : typeof raw === "object" &&
          raw !== null &&
          Array.isArray((raw as Record<string, unknown>).data)
        ? ((raw as Record<string, unknown>).data as Array<Record<string, unknown>>)
        : [];

    const extracted = rawArray
      .filter((c) => (typeof c.id === "string" || typeof c.id === "number") && typeof c.name === "string")
      .map((c) => ({
        id:     String(c.id),
        name:   c.name   as string,
        status: typeof c.status === "string" ? c.status : "unknown",
      }));

    if (extracted.length > 0) {
      savedCampaignSelectionList = extracted;
    } else {
      // No campaigns exist — clear the pending action so it doesn't persist
      // across turns and confuse subsequent requests.
      savedPendingCampaignAction = undefined;
      savedCampaignSelectionList = undefined;
    }
  }

  // When get_recipient_count succeeds during the AI wizard, extract the count
  // and merge it into pendingAiCampaignData so the check_count step can validate it.
  let savedAiCampaignStep = pendingAiCampaignStep;
  let savedAiCampaignData = pendingAiCampaignData;
  if (
    toolName === "get_recipient_count" &&
    toolResult &&
    !toolResult.isToolError &&
    pendingAiCampaignData !== undefined
  ) {
    const raw = toolResult.data as Record<string, unknown>;
    const inner =
      typeof raw?.data === "object" && raw.data !== null && !Array.isArray(raw.data)
        ? (raw.data as Record<string, unknown>)
        : raw;
    const pendingCount =
      typeof inner?.pendingCount === "number" ? inner.pendingCount : undefined;
    if (pendingCount !== undefined) {
      savedAiCampaignData = { ...pendingAiCampaignData, recipientCount: String(pendingCount) };
      log.info(
        { pendingCount, activeCampaignId },
        "saveMemory: recipient count stored in AI wizard data",
      );
    }
  }

  // ── CSV file ingestion state ───────────────────────────────────────────────
  // After parse_csv_file succeeds, extract parsed rows and preview, then store
  // them so the next turn can confirm/save without the raw file buffer.
  // Raw file buffer (pendingCsvFile) is intentionally NOT persisted here.
  // After save_csv_recipients, clear pendingCsvData — the upload is complete.
  let savedCsvData = pendingCsvData;

  if (toolName === "parse_csv_file" && toolResult && !toolResult.isToolError) {
    const raw = toolResult.data as Record<string, unknown>;
    const inner =
      typeof raw?.data === "object" && raw.data !== null && !Array.isArray(raw.data)
        ? (raw.data as Record<string, unknown>)
        : raw;
    if (inner && typeof inner === "object") {
      const d = inner as Record<string, unknown>;
      savedCsvData = {
        totalRows:   typeof d.totalRows   === "number" ? d.totalRows   : 0,
        validRows:   typeof d.validRows   === "number" ? d.validRows   : 0,
        invalidRows: typeof d.invalidRows === "number" ? d.invalidRows : 0,
        columns:     Array.isArray(d.columns) ? (d.columns as string[]) : [],
        preview:     Array.isArray(d.preview)
          ? (d.preview as Array<Record<string, string>>)
          : [],
        rows:        Array.isArray(d.rows)
          ? (d.rows as Array<Record<string, string>>)
          : [],
      };
      log.info(
        { validRows: savedCsvData.validRows, rowCount: savedCsvData.rows.length },
        "saveMemory: CSV parsed data stored",
      );
    }
  }

  if (toolName === "save_csv_recipients") {
    savedCsvData = undefined;
    log.info("saveMemory: CSV data cleared after save");
  }

  // ── Enrichment flow state ──────────────────────────────────────────────────
  // After parse_csv_file succeeds in the enrichment domain, advance the step
  // to "enrich" so the next turn's EnrichmentAgent knows to run enrichBatch().
  // pendingEnrichmentData and pendingOutreachDraft are set by EnrichmentAgent
  // directly in its state patch — we just carry them through here unchanged.
  let savedEnrichmentStep   = pendingEnrichmentStep;
  let savedEnrichmentData   = pendingEnrichmentData;
  let savedOutreachDraft    = pendingOutreachDraft;
  let savedEnrichmentAction = pendingEnrichmentAction;

  if (
    toolName === "parse_csv_file" &&
    toolResult &&
    !toolResult.isToolError &&
    agentDomain === "enrichment"
  ) {
    // Signal to the next turn that enrichment should run
    savedEnrichmentStep = "enrich";
    log.info("saveMemory: parse_csv_file succeeded in enrichment domain — setting pendingEnrichmentStep=enrich");
  }

  let savedPhase3Action        = pendingPhase3EnrichmentAction;
  let savedPhase3Company       = pendingPhase3CompanyName;
  let savedPhase3Url           = pendingPhase3Url;
  let savedPhase3WebContent    = pendingPhase3WebsiteContent;
  let savedPhase3Queue         = pendingPhase3ToolQueue;
  let savedPhase3Scratch       = pendingPhase3Scratch;
  let savedPhase3Continue      = pendingPhase3ContinueExecute;

  let savedWorkflowDeadline = pendingWorkflowDeadlineIso;
  let savedActiveWorkflowLock = activeWorkflowLock;
  let savedWorkflowStack = workflowStack;

  if (toolName === "save_enriched_contacts" && toolResult && !toolResult.isToolError) {
    // Clear all enrichment + Phase 3 state after a successful save
    savedEnrichmentStep   = undefined;
    savedEnrichmentData   = undefined;
    savedOutreachDraft    = undefined;
    savedCsvData          = undefined;
    savedEnrichmentAction = undefined;
    savedCampaignSelectionList = undefined;
    savedPhase3Action        = undefined;
    savedPhase3Company       = undefined;
    savedPhase3Url           = undefined;
    savedPhase3WebContent    = undefined;
    savedPhase3Queue         = undefined;
    savedPhase3Scratch       = undefined;
    savedPhase3Continue      = false;
    savedWorkflowDeadline    = undefined;
    if (savedActiveWorkflowLock?.type === "enrichment") savedActiveWorkflowLock = undefined;
    if (Array.isArray(savedWorkflowStack)) {
      savedWorkflowStack = savedWorkflowStack.filter((w) => w.type !== "enrichment");
    }
    log.info("saveMemory: enrichment + Phase 3 state cleared after save_enriched_contacts");
  }

  const workflowStillActive =
    savedEnrichmentStep !== undefined ||
    savedEnrichmentAction !== undefined ||
    (savedCsvData !== undefined && agentDomain === "enrichment") ||
    savedPhase3Action !== undefined ||
    (Array.isArray(savedPhase3Queue) && savedPhase3Queue.length > 0);

  if (workflowStillActive) {
    savedWorkflowDeadline = computeWorkflowDeadlineIso();
  }

  // Refresh lock expiry for active workflows; clear lock when workflow completes.
  if (savedActiveWorkflowLock) {
    const lockType = savedActiveWorkflowLock.type;
    const stillActiveForType =
      (lockType === "enrichment" &&
        (savedEnrichmentStep !== undefined ||
          savedEnrichmentAction !== undefined ||
          (savedCsvData !== undefined && agentDomain === "enrichment"))) ||
      (lockType === "phase3" &&
        (savedPhase3Action !== undefined ||
          (Array.isArray(savedPhase3Queue) && savedPhase3Queue.length > 0)));

    if (stillActiveForType) {
      savedActiveWorkflowLock = {
        ...savedActiveWorkflowLock,
        expiresAtIso: computeWorkflowDeadlineIso(),
      };
    } else if (lockType === "enrichment" || lockType === "phase3") {
      savedActiveWorkflowLock = undefined;
    }
  }

  // Clear selection state once the actual campaign action has been dispatched.
  // update_campaign covers both update_campaign and schedule_campaign intents.
  let savedPendingScheduledAt = pendingScheduledAt;
  const actionDispatched =
    toolName === "start_campaign" ||
    toolName === "pause_campaign" ||
    toolName === "resume_campaign" ||
    toolName === "update_campaign";
  if (actionDispatched) {
    savedPendingCampaignAction = undefined;
    savedCampaignSelectionList = undefined;
    savedPendingScheduledAt    = undefined;
  }

  const toolCall = toolName
    ? {
        toolName,
        success: !toolResult?.isToolError && !state.error,
      }
    : undefined;

  try {
    await sessionMemoryService.saveTurn(
      userId as string,
      sessionId as string,
      {
        userMessage,
        aiResponse,
        metadata: {
          lastIntent:            intent,
          lastAgentDomain:       agentDomain,
          activeCampaignId:      savedActiveCampaignId,
          senderDefaults:        savedSenderDefaults,
          pendingCampaignDraft,
          pendingCampaignStep,
          pendingCampaignAction:  savedPendingCampaignAction,
          campaignSelectionList:  savedCampaignSelectionList,
          pendingScheduledAt:     savedPendingScheduledAt,
          pendingAiCampaignStep:  savedAiCampaignStep,
          pendingAiCampaignData:  savedAiCampaignData,
          pendingCsvData:         savedCsvData,
          pendingEnrichmentStep:   savedEnrichmentStep,
          pendingEnrichmentData:   savedEnrichmentData,
          pendingOutreachDraft:    savedOutreachDraft,
          pendingEnrichmentAction: savedEnrichmentAction,
          pendingPhase3EnrichmentAction: savedPhase3Action,
          pendingPhase3CompanyName:      savedPhase3Company,
          pendingPhase3Url:              savedPhase3Url,
          pendingPhase3WebsiteContent:   savedPhase3WebContent,
          pendingPhase3ToolQueue:        savedPhase3Queue,
          pendingPhase3Scratch:          savedPhase3Scratch,
          pendingPhase3ContinueExecute:  savedPhase3Continue,
          pendingWorkflowDeadlineIso:    savedWorkflowDeadline,
          sessionSchemaVersion:          SESSION_SCHEMA_VERSION,
          activeWorkflowLock:            savedActiveWorkflowLock,
          workflowStack:                 savedWorkflowStack,
        },
        toolCall,
      },
    );

    log.debug({ userId, sessionId, intent }, "saveMemory: turn persisted");
  } catch (err) {
    // Memory errors must never crash the graph — log and continue
    log.error({ userId, sessionId, err }, "saveMemory: failed to persist session (non-fatal)");
  }

  // Surface the effective (possibly updated) state back so callers that inspect
  // the returned state (e.g. tests) see a consistent picture.
  return {
    activeCampaignId:      savedActiveCampaignId,
    pendingCampaignAction: savedPendingCampaignAction,
    campaignSelectionList: savedCampaignSelectionList,
    pendingScheduledAt:    savedPendingScheduledAt,
    pendingAiCampaignData: savedAiCampaignData,
    pendingCsvData:        savedCsvData,
    pendingEnrichmentStep:   savedEnrichmentStep,
    pendingEnrichmentData:   savedEnrichmentData,
    pendingOutreachDraft:    savedOutreachDraft,
    pendingEnrichmentAction: savedEnrichmentAction,
    pendingPhase3EnrichmentAction: savedPhase3Action,
    pendingPhase3CompanyName:      savedPhase3Company,
    pendingPhase3Url:              savedPhase3Url,
    pendingPhase3WebsiteContent:   savedPhase3WebContent,
    pendingPhase3ToolQueue:        savedPhase3Queue,
    pendingPhase3Scratch:          savedPhase3Scratch,
    pendingPhase3ContinueExecute:  savedPhase3Continue,
    pendingWorkflowDeadlineIso:    savedWorkflowDeadline,
    sessionSchemaVersion:          SESSION_SCHEMA_VERSION,
    activeWorkflowLock:            savedActiveWorkflowLock,
    workflowStack:                 savedWorkflowStack,
  };
}
