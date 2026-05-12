/**
 * src/graph/nodes/detectIntent.node.ts
 *
 * First detection node in the agent graph.
 *
 * Strategy — LLM-first with deterministic fallback:
 *   1. detectWithLLM() asks OpenAI to classify the intent AND extract
 *      structured arguments (campaignId, limit, query, filters).
 *   2. If OpenAI is unavailable, returns low-confidence JSON, or fails Zod
 *      validation → falls back to synchronous rule-based detect().
 *   3. If LLM confidence < 0.7 → falls back to deterministic detect().
 *
 * State written:
 *   intent           — resolved Intent literal
 *   confidence       — normalised confidence in [0, 1]
 *   llmExtractedArgs — structured args from OpenAI; undefined when
 *                      the deterministic path ran or no args were found.
 *                      Domain agents should read this field to get
 *                      pre-parsed values instead of re-parsing userMessage.
 *
 * What this node does NOT do:
 *   - Set toolArgs (domain agents own that field)
 *   - Call MCP tools
 *   - Execute any workflow actions
 *
 * Audit and structured logging are unchanged from the previous implementation.
 */

import { createLogger } from "../../lib/logger.js";
import { intentDetectionService } from "../../services/intentDetection.service.js";
import { auditLogService } from "../../services/auditLog.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import { inferPhase3IntentFromUserMessage } from "../../lib/phase3IntentFromMessage.js";
import {
  buildEnrichmentSnapshot,
  clearEnrichmentUiState,
  createWorkflowLock,
  isLockExpired,
  pushWorkflowStack,
} from "../../lib/workflowConcurrency.js";

const log = createLogger("node:detectIntent");

export async function detectIntentNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { userMessage, sessionId, userId } = state;

  /**
   * Deterministic routing priority (highest first). Short-circuit paths run before
   * LLM detection so confirmations, uploads, and Phase 3 commands cannot be
   * misclassified as general chat.
   *
   * 1. Pending CSV attachment in state → `upload_csv`
   * 2. Explicit Phase 3 intelligence phrase while enrichment confirm/save is active → Phase 3 intent
   * 3. `pendingEnrichmentAction === save_enriched_contacts` → `enrich_contacts` (campaign selection)
   * 4. Active enrichment wizard (`pendingEnrichmentStep` / related) → keyword-mapped enrich intents
   * 5. LLM-first detection → rule-based `detect()` fallback
   */

  // ── Resume workflow (stack) ───────────────────────────────────────────────
  // Must run before LLM detection so "resume" isn't misclassified as help.
  if (
    Array.isArray(state.workflowStack) &&
    state.workflowStack.length > 0 &&
    /\b(resume|continue previous|continue earlier|go back|back to previous|return to previous)\b/i.test(userMessage)
  ) {
    log.info({ userId, sessionId }, "detectIntent: resume phrase with workflowStack — forcing resume_workflow intent");
    return { intent: "resume_workflow", confidence: 1.0, llmExtractedArgs: undefined };
  }

  // ── CSV upload bypass ─────────────────────────────────────────────────────
  // When a CSV/XLSX file is already in state, skip LLM detection entirely and
  // force upload_csv so CampaignAgent handles the multi-step wizard directly.
  if (state.pendingCsvFile !== undefined) {
    log.info({ userId, sessionId }, "detectIntent: pendingCsvFile in state — forcing upload_csv intent");
    return { intent: "upload_csv", confidence: 1.0, llmExtractedArgs: undefined };
  }

  // Explicit Phase 3 commands override enrichment wizard / campaign-pick replies.
  const phase3FromMsg = inferPhase3IntentFromUserMessage(userMessage);
  if (
    phase3FromMsg &&
    (state.pendingEnrichmentStep === "confirm" || state.pendingEnrichmentAction === "save_enriched_contacts")
  ) {
    // Safe interruption: suspend enrichment flow onto workflowStack, clear UI state,
    // and proceed with Phase 3 intent.
    const enrichmentLock =
      state.activeWorkflowLock?.type === "enrichment" && !isLockExpired(state.activeWorkflowLock)
        ? state.activeWorkflowLock
        : createWorkflowLock("enrichment", { interruptible: true });

    const nextStack = pushWorkflowStack(state.workflowStack, {
      workflowId:   enrichmentLock.workflowId,
      type:         "enrichment",
      resumeIntent: "enrich_contacts",
      snapshot:     buildEnrichmentSnapshot(state) as unknown as Record<string, unknown>,
    });

    log.info(
      { userId, sessionId, phase3FromMsg },
      "detectIntent: Phase 3 phrase during enrichment — forcing Phase 3 intent",
    );
    return {
      intent: phase3FromMsg,
      confidence: 1.0,
      llmExtractedArgs: undefined,
      workflowStack: nextStack.length > 0 ? nextStack : undefined,
      activeWorkflowLock: createWorkflowLock("phase3", { interruptible: false }),
      ...clearEnrichmentUiState(),
    };
  }

  // Saving enriched contacts — only campaign selection replies apply; map everything to enrich_contacts.
  if (state.pendingEnrichmentAction === "save_enriched_contacts") {
    log.info(
      { userId, sessionId },
      "detectIntent: enrichment save — campaign selection active — forcing enrich_contacts",
    );
    return { intent: "enrich_contacts", confidence: 1.0, llmExtractedArgs: undefined };
  }

  // ── Enrichment context override ───────────────────────────────────────────
  // When an enrichment flow is active the LLM has no conversation context and
  // routinely misclassifies short replies ("yes", "no", "formal") as general_help
  // or out_of_domain.  Map them deterministically so EnrichmentAgent receives
  // the correct intent without relying on the LLM.
  if (state.pendingEnrichmentStep !== undefined || state.pendingEnrichmentAction !== undefined) {
    const lower = userMessage.trim().toLowerCase();
    let enrichIntent: import("../../config/intents.js").Intent;

    if (
      lower === "yes" || lower === "y" || lower === "ok" || lower === "okay" ||
      lower.includes("confirm") || lower.includes("save") ||
      lower.includes("proceed") || lower.includes("go ahead") ||
      lower.includes("sounds good") || lower.includes("do it")
    ) {
      enrichIntent = "confirm_enrichment";
    } else if (
      lower === "no" || lower.includes("discard") ||
      lower.includes("cancel") || lower.includes("abort") || lower.includes("stop enrichment")
    ) {
      enrichIntent = "discard_enrichment";
    } else if (
      lower.includes("custom") || lower.includes("tone") ||
      lower.includes("formal") || lower.includes("friendly") ||
      lower.includes("sales") || lower.includes("executive") ||
      lower.includes("change template") || lower.includes("change tone")
    ) {
      enrichIntent = "customize_outreach";
    } else {
      enrichIntent = "enrich_contacts";
    }

    log.info(
      {
        userId, sessionId, enrichIntent,
        pendingEnrichmentStep:   state.pendingEnrichmentStep,
        pendingEnrichmentAction: state.pendingEnrichmentAction,
      },
      "detectIntent: enrichment context override",
    );
    return { intent: enrichIntent, confidence: 1.0, llmExtractedArgs: undefined };
  }

  // ── extract_domain pre-check ──────────────────────────────────────────────
  // Common "extract domain from X" / "domain from X" phrases are reliably
  // detected here before the LLM path to avoid misclassification as general_help.
  if (
    /extract\s+domain\s+from\s+/i.test(userMessage) ||
    /\bdomain\s+from\s+/i.test(userMessage) ||
    /\bparse\s+domain\s+from\s+/i.test(userMessage) ||
    /\bget\s+domain\s+from\s+/i.test(userMessage)
  ) {
    log.info({ userId, sessionId }, "detectIntent: extract_domain pattern matched — bypassing LLM");
    return { intent: "extract_domain", confidence: 1.0, llmExtractedArgs: undefined };
  }

  // ── LLM-first detection ───────────────────────────────────────────────────
  // detectWithLLM() never throws — deterministic detect() is always the
  // last resort if anything goes wrong with the LLM path.
  const detected = await intentDetectionService.detectWithLLM(userMessage);

  // ── Structured log ────────────────────────────────────────────────────────
  log.info(
    {
      sessionId,
      userId,
      intent:          detected.intent,
      confidence:      detected.confidence,
      matchedPatterns: detected.matchedPatterns,
      // Log extracted arg keys only — values may contain user PII
      extractedArgKeys: detected.extractedArgs
        ? Object.keys(detected.extractedArgs)
        : [],
      source: detected.matchedPatterns.length > 0 ? "deterministic" : "llm",
    },
    "Intent detected",
  );

  // ── Audit log (unchanged contract) ────────────────────────────────────────
  auditLogService.intentDetected(
    {
      userId:    userId    as string | undefined,
      sessionId: sessionId as string | undefined,
    },
    {
      intent:          detected.intent,
      confidence:      detected.confidence,
      matchedPatterns: detected.matchedPatterns,
    },
  );

  // ── State patch ───────────────────────────────────────────────────────────
  // llmExtractedArgs is written to state so domain agents can read pre-parsed
  // values (campaignId, limit, query, filters) without re-parsing userMessage.
  // When the deterministic path ran, extractedArgs is undefined — the field
  // defaults to undefined in state, so no explicit clear is needed.
  return {
    intent:          detected.intent,
    confidence:      detected.confidence,
    llmExtractedArgs: detected.extractedArgs,
  };
}
