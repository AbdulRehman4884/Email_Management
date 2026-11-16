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
import type { Intent } from "../../config/intents.js";
import { parseManualBulkRows } from "../../lib/parseManualBulkRows.js";
import { readCampaignChoice, readLeadAnswer, readSelection } from "../../lib/crmContext.js";
import { detectLeadGenIntent } from "../../lib/leadgenArgs.js";
import { detectCrmActionIntent, isLabelFilterAction, isReplyLabelRequest, isTagFollowUp } from "../../lib/crmActions.js";
import { isStandaloneCommand } from "../../lib/busyWorkflow.js";
import { isCampaignCreationActive } from "../../lib/campaignCreationFlow.js";
import { INTENT_DOMAIN } from "../../config/intents.js";

const log = createLogger("node:detectIntent");

// Plural/-ing forms ("cold calls", "scripts", "pitches") must match too.
const SCRIPT_KEYWORDS_RE =
  /\b(call(ing)? scripts?|cold[\s-]?call(s|ing)?|cold[\s-]?email(s|ing)?|linked[\s-]?in|phone scripts?|sales scripts?|email scripts?|pitch(es)?|scripts?)\b/i;

/** File attached + script keywords → save the file for script generation. */
export function detectScriptFileIntent(message: string, hasFile: boolean): Intent | undefined {
  return hasFile && SCRIPT_KEYWORDS_RE.test(message) ? "script_file_intake" : undefined;
}

export async function detectIntentNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { userMessage, sessionId, userId } = state;

  const emailCount = (userMessage.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).length;
  const urlCount = (userMessage.match(/https?:\/\/[^\s)]+/gi) ?? []).length;
  const bulkPrompt =
    /\b(bulk|csv|xlsx|lead list|manual rows|process these leads|create campaign from|use these rows|use these companies and emails|generate templates from this file)\b/i.test(userMessage);
  const manualBulkRows = parseManualBulkRows(userMessage);
  const hasFreshManualBulkRows = manualBulkRows.length > 0;
  const resetBulkWorkflow =
    /\b(start a new bulk campaign workflow|create a fresh bulk job|do not reuse campaign\s+\d+|new job|reset bulk workflow|cancel current bulk workflow|start new bulk job)\b/i.test(userMessage);

  // ── Chat campaign creation: every answer (and the uploaded file) belongs to the flow ──
  // Other commands ("show all campaigns") fall through; the manager then asks to finish or cancel first.
  if (isCampaignCreationActive(state) && !isStandaloneCommand(userMessage)) {
    log.info({ userId, sessionId, step: state.campaignCreation?.step }, "detectIntent: campaign creation answer");
    return { intent: "create_campaign", confidence: 1.0, llmExtractedArgs: undefined };
  }

  // ── Script generation file upload ─────────────────────────────────────────
  // Runs before every bulk / upload_csv check: "scripts for this csv" also
  // matches the bulk prompt, and an attached file would otherwise force upload_csv.
  const scriptIntent = detectScriptFileIntent(userMessage, state.pendingCsvFile !== undefined);
  if (scriptIntent) {
    log.info({ userId, sessionId, intent: scriptIntent }, "detectIntent: script file upload");
    return { intent: scriptIntent, confidence: 1.0, llmExtractedArgs: undefined };
  }

  // ── CRM: answer to "which lead do you mean?" ──────────────────────────────
  // "2", "doosra", an email or "cancel" continues the CRM action that asked.
  // Anything else falls through; the old question is dropped when the turn is saved.
  const crmPending = state.crmContext?.pendingSelection;
  if (crmPending) {
    const crmSelection = crmPending.askLead
      ? isStandaloneCommand(userMessage) || detectCrmActionIntent(userMessage)
        ? undefined
        : readLeadAnswer(userMessage)
      : crmPending.campaignChoices?.length
        ? readCampaignChoice(userMessage, crmPending.campaignChoices)
        : readSelection(userMessage, crmPending.matches);
    if (crmSelection) {
      log.info({ userId, sessionId, intent: crmPending.intent, kind: crmSelection.kind }, "detectIntent: CRM lead choice");
      return { intent: crmPending.intent, confidence: 1.0, llmExtractedArgs: undefined, crmSelection };
    }
  }

  // ── Lead finder: answer to "In which city?" / "What kind of businesses?" ──
  // A short reply ("Karachi", "IT companies jo app development pa kam krti hon", "9 baje", "cancel") continues
  // the waiting request. A new command or a long message falls through; the old question is then dropped on save.
  const lgPending = state.leadGenContext?.pending;
  if (
    lgPending &&
    !detectLeadGenIntent(userMessage, state.leadGenContext) &&
    !isStandaloneCommand(userMessage) &&
    userMessage.trim().length <= 120 &&
    userMessage.trim().split(/\s+/).length <= 14
  ) {
    log.info({ userId, sessionId, intent: lgPending.intent, missing: lgPending.missing }, "detectIntent: answer to a lead finder question");
    return { intent: lgPending.intent as Intent, confidence: 1.0, llmExtractedArgs: undefined };
  }

  // ── Lead finder while another flow is active ──────────────────────────────
  // Checked before the bulk / enrichment overrides below, which would otherwise turn
  // "find dentists in Lahore" into a bulk status request or an enrichment answer.
  // The manager then answers "finish the other flow first" and leaves that flow untouched.
  const leadGenShape = detectLeadGenIntent(userMessage, state.leadGenContext);
  const otherFlowActive =
    state.bulkWorkflow !== undefined || state.pendingEnrichmentStep !== undefined || state.pendingEnrichmentAction !== undefined;
  if (leadGenShape && otherFlowActive) {
    log.info({ userId, sessionId, intent: leadGenShape }, "detectIntent: lead finder request while another flow is active");
    return { intent: leadGenShape, confidence: 1.0, llmExtractedArgs: undefined };
  }

  // ── Reply label (inbox or CRM) ────────────────────────────────────────────
  // '"ali@x.com" ko interested ka label de do', '"We are providing AI services" ko interested label laga do':
  // one reply's label. Before the LLM and the other flows — the LLM read the second one as "create an AI campaign".
  // "interested label wale email ki stage Engaged kar do": the leads with that label move (a bulk change, confirmed first).
  if (!leadGenShape && isLabelFilterAction(userMessage)) {
    log.info({ userId, sessionId }, "detectIntent: stage / tag by reply label");
    return { intent: "crm_bulk_update", confidence: 1.0, llmExtractedArgs: undefined };
  }
  if (!leadGenShape && isReplyLabelRequest(userMessage)) {
    log.info({ userId, sessionId }, "detectIntent: reply label request");
    return { intent: "crm_change_label", confidence: 1.0, llmExtractedArgs: undefined };
  }
  // Right after "create tag engaged": "Bassamilyas90 with engaged" tags that lead (it went to the campaign draft before).
  if (!leadGenShape && isTagFollowUp(userMessage, state.crmContext)) {
    log.info({ userId, sessionId }, "detectIntent: tag follow-up");
    return { intent: "crm_tag_lead", confidence: 1.0, llmExtractedArgs: undefined };
  }

  if (hasFreshManualBulkRows) {
    log.info(
      { userId, sessionId, rowCount: manualBulkRows.length, previousCampaignId: state.activeCampaignId },
      "detectIntent: fresh manual bulk rows override active bulk workflow",
    );
    return {
      intent: "bulk_manual_rows_intake",
      confidence: 1.0,
      llmExtractedArgs: undefined,
      bulkWorkflow: undefined,
      activeCampaignId: undefined,
      pendingCampaignAction: undefined,
      campaignSelectionList: undefined,
      pendingScheduledAt: undefined,
    };
  }

  if (resetBulkWorkflow) {
    log.info(
      { userId, sessionId, previousCampaignId: state.activeCampaignId },
      "detectIntent: reset bulk workflow requested",
    );
    return {
      intent: "start_bulk_template_workflow",
      confidence: 1.0,
      llmExtractedArgs: undefined,
      bulkWorkflow: undefined,
      activeCampaignId: undefined,
      pendingCampaignAction: undefined,
      campaignSelectionList: undefined,
      pendingScheduledAt: undefined,
    };
  }

  if (state.bulkWorkflow !== undefined) {
    const lower = userMessage.trim().toLowerCase();
    let bulkIntent: Intent = "bulk_show_status";
    if (lower === "confirm") bulkIntent = "bulk_final_confirm_start";
    else if (/create.*draft|create.*campaign.*draft/.test(lower)) bulkIntent = "bulk_create_campaign_draft";
    else if (/approve/.test(lower) && /draft|campaign/.test(lower)) bulkIntent = "bulk_create_campaign_draft";
    else if (/approve/.test(lower)) bulkIntent = "bulk_approve_templates";
    else if (/regenerate|redo/.test(lower)) bulkIntent = "bulk_regenerate_template";
    else if (/apply recommendations|use .*template|tone|strategy/.test(lower)) bulkIntent = "bulk_select_template_strategy";
    else if (/preview|show templates/.test(lower)) bulkIntent = "bulk_preview_templates";
    else if (/status|progress/.test(lower)) bulkIntent = "bulk_show_status";
    log.info({ userId, sessionId, bulkIntent }, "detectIntent: active bulk workflow");
    return { intent: bulkIntent, confidence: 1.0, llmExtractedArgs: undefined };
  }

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
  if (state.pendingCsvFile !== undefined && bulkPrompt) {
    log.info({ userId, sessionId }, "detectIntent: pendingCsvFile with bulk prompt - forcing bulk_file_intake intent");
    return { intent: "bulk_file_intake", confidence: 1.0, llmExtractedArgs: undefined };
  }

  if (state.pendingCsvFile !== undefined) {
    log.info({ userId, sessionId }, "detectIntent: pendingCsvFile in state — forcing upload_csv intent");
    return { intent: "upload_csv", confidence: 1.0, llmExtractedArgs: undefined };
  }

  if ((bulkPrompt && emailCount >= 1 && urlCount >= 1) || (emailCount >= 2 && urlCount >= 2)) {
    log.info({ userId, sessionId, emailCount, urlCount }, "detectIntent: manual bulk rows detected");
    return { intent: "bulk_manual_rows_intake", confidence: 1.0, llmExtractedArgs: undefined };
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
  let detected = await intentDetectionService.detectWithLLM(userMessage);

  // A clear lead-finder shape wins over another domain the LLM picked (e.g. research_companies for
  // "find dentists in Lahore"); the LLM's arguments are kept.
  // A question about CRM leads must never become a save, even if the LLM says so.
  const questionNotSave = leadGenShape === "lead_finder_crm_summary" && detected.intent !== leadGenShape;
  if (leadGenShape && (INTENT_DOMAIN[detected.intent] !== "leadgen" || questionNotSave)) {
    log.info({ userId, sessionId, llmIntent: detected.intent, intent: leadGenShape }, "detectIntent: lead finder shape overrides the detected intent");
    detected = { ...detected, intent: leadGenShape, confidence: Math.max(detected.confidence, 0.9) };
  }
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

  // ── Inline recipient extraction ───────────────────────────────────────────
  // Extract all valid email addresses from the user message. Matched emails
  // are stored in state.extractedRecipients so executePlanStep can auto-insert
  // an add_recipients step when create_campaign is followed by start_campaign.
  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const emailMatches = userMessage.match(emailPattern);
  const extractedRecipients =
    emailMatches && emailMatches.length > 0
      ? [...new Set(emailMatches.map((e) => e.toLowerCase()))]
      : undefined;

  if (extractedRecipients) {
    log.info(
      { sessionId, extractedRecipients, count: extractedRecipients.length },
      "detectIntent: extracted recipient emails from message",
    );
  }

  // ── State patch ───────────────────────────────────────────────────────────
  // llmExtractedArgs is written to state so domain agents can read pre-parsed
  // values (campaignId, limit, query, filters) without re-parsing userMessage.
  // When the deterministic path ran, extractedArgs is undefined — the field
  // defaults to undefined in state, so no explicit clear is needed.

  // Preserve extractedRecipients across wizard turns.
  // The wizard is a multi-turn flow: the user supplies the email on turn 1
  // ("create a campaign and send to user@example.com"), and the campaign is
  // not created until turn 2 ("confirm"). If we always return extractedRecipients
  // (even as undefined), the replace reducer clears it on turn 2. We suppress
  // the clear while a wizard draft is pending so the email survives into
  // executeToolNode's auto-inject logic.
  const wizardActive =
    state.pendingCampaignDraft !== undefined ||
    state.pendingCampaignStep  !== undefined;
  const suppressRecipientClear = extractedRecipients === undefined && wizardActive;

  if (suppressRecipientClear) {
    log.info(
      { sessionId, preservedRecipients: state.extractedRecipients },
      "detectIntent: wizard active — preserving extractedRecipients from previous turn",
    );
  }

  return {
    intent:           detected.intent,
    confidence:       detected.confidence,
    llmExtractedArgs: detected.extractedArgs,
    ...(suppressRecipientClear ? {} : { extractedRecipients }),
  };
}
