/**
 * src/graph/nodes/manager.node.ts
 *
 * Manager node — resolves intent → agentDomain and drives conditional routing.
 *
 * Two exports:
 *  - `managerNode`   — LangGraph node function; sets agentDomain on state
 *  - `routeToAgent`  — conditional-edge routing function consumed by agent.workflow.ts
 *
 * Routing table:
 *   "campaign"  → campaign node  (create/update/start/pause/resume)
 *   "settings"  → campaign node  (check_smtp/update_smtp handled by CampaignAgent)
 *   "analytics" → analytics node
 *   "inbox"     → inbox node
 *   "research"  → research outreach node (read-only, no tool execution)
 *   "crm"       → crm node (read-only CRM tools)
 *   "leadgen"   → leadgen node (lead finder: searches, schedules, new leads)
 *   "general"   → formatResponse node (no tool execution needed)
 *   undefined   → formatResponse node (defensive fallback)
 */

import { createLogger } from "../../lib/logger.js";
import { INTENT_DOMAIN } from "../../config/intents.js";
import { auditLogService } from "../../services/auditLog.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import { isWorkflowDeadlineExpired } from "../../lib/mcpErrorMapping.js";
import { activeWorkflow, buildBusyResponse, isStandaloneCommand } from "../../lib/busyWorkflow.js";
import { isCampaignCreationActive, startsCampaignCreation } from "../../lib/campaignCreationFlow.js";
import { isAnswerableGeneralIntent, isNewRequestDuringSelection } from "../../lib/campaignLookup.js";

const log = createLogger("node:manager");

/**
 * A short reply that continues the active campaign: "schedule it", "start it", "what next", "done",
 * "recipients added", a send time. Longer or unrelated messages are not.
 */
export function isCampaignFollowUp(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (!m || m.length > 80) return false;
  return /^(ok(ay)?[, ]+)?(schedule|start|send|launch|update|edit|change|what('?s| is)?\s+next|next( step)?|now what|done|continue|go ahead|proceed)\b/.test(m) ||
    /\b(schedule|start|send|launch)\s+(it|this|that|the campaign|this campaign)\b/.test(m) ||
    /\b(recipients?|contacts?)\s+(added|uploaded)\b|\buploaded\b/.test(m) ||
    /\b(tomorrow|today|tonight|next\s+(mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}(:\d{2})?\s*(am|pm))\b/.test(m);
}

/** Phase 3 intents — starting these should drop stale CSV wizard state (not enrichment campaign-pick). */
const PHASE3_INTENTS = new Set([
  "analyze_company",
  "detect_pain_points",
  "generate_outreach",
  "enrich_company",
]);

// ── Route destinations ────────────────────────────────────────────────────────

export type AgentRoute = "campaign" | "analytics" | "inbox" | "enrichment" | "research" | "bulk" | "scripts" | "crm" | "leadgen" | "formatResponse";

// ── Node ──────────────────────────────────────────────────────────────────────

export async function managerNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const intent = state.intent ?? "general_help";
  let domain = INTENT_DOMAIN[intent];

  // ── Busy guard: a different command while a flow waits for an answer ─────
  // The command must not become the answer (e.g. "Show all campaigns" as the
  // campaign name). Reply "busy" and leave the flow state untouched.
  const flow = activeWorkflow(state);
  // A lead-finder request is never an answer to another flow's question either (e.g. "find dentists in Lahore"
  // as a campaign name); detectIntent recognises it even while a bulk or enrichment flow is active.
  if (flow && (isStandaloneCommand(state.userMessage) || domain === "leadgen")) {
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, activeWorkflow: flow.label },
      "Manager: command received while a flow is in progress — asking the user to finish it first",
    );
    return { formattedResponse: buildBusyResponse(flow, state.userMessage) };
  }

  // ── Concurrency guard (non-interruptible locks) ───────────────────────────
  const lock = state.activeWorkflowLock;
  if (
    lock &&
    lock.expiresAtIso &&
    !isWorkflowDeadlineExpired(lock.expiresAtIso) &&
    lock.interruptible === false &&
    intent !== "resume_workflow" &&
    intent !== "discard_enrichment"
  ) {
    const requestedType =
      PHASE3_INTENTS.has(intent) ? "phase3" : (domain ?? "general");
    const requestedWorkflow =
      requestedType === "campaign" || requestedType === "analytics" || requestedType === "inbox" || requestedType === "leadgen"
        ? requestedType
        : requestedType === "enrichment"
        ? "enrichment"
        : requestedType === "phase3"
        ? "phase3"
        : "general";

    if (requestedWorkflow !== lock.type && requestedWorkflow !== "general") {
      const label =
        lock.type === "enrichment" ? "enrichment review"
        : lock.type === "campaign" ? "campaign workflow"
        : lock.type === "phase3" ? "company intelligence analysis"
        : lock.type === "analytics" ? "analytics request"
        : lock.type === "inbox" ? "inbox request"
        : lock.type === "leadgen" ? "lead search"
        : "workflow";

      return {
        formattedResponse:
          `I’m already working on your **${label}**. ` +
          "Please complete it, cancel it, or say **discard** to clear it before starting something else.",
      };
    }
  }

  // ── A new question while a campaign list is open (bugs A-05, A-19) ───────────
  // "How many draft campaigns do I have?" while "which ok campaign?" is on screen is a
  // new request, not an answer: drop the list so it reaches its own handler. Otherwise
  // the list keeps swallowing this and every later question until a new chat.
  // The enrichment "pick a campaign to save to" list is that flow's own; leave it.
  const staleSelection =
    !state.pendingEnrichmentAction &&
    isNewRequestDuringSelection({
      userMessage:           state.userMessage,
      intent,
      domain,
      pendingCampaignAction: state.pendingCampaignAction,
      campaignSelectionList: state.campaignSelectionList,
    });
  if (staleSelection) {
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, pendingCampaignAction: state.pendingCampaignAction },
      "Manager: new request while a campaign list was open — dropping the list",
    );
  }
  const pendingCampaignAction = staleSelection ? undefined : state.pendingCampaignAction;
  const campaignSelectionList = staleSelection ? undefined : state.campaignSelectionList;

  const draftActive       = !!state.pendingCampaignDraft;
  const selectionActive   = !!pendingCampaignAction;
  const aiWizardActive    = !!state.pendingAiCampaignStep;
  const enrichmentActive  = !!state.pendingEnrichmentStep || !!state.pendingCsvFile || !!state.pendingEnrichmentAction;
  const bulkActive = !!state.bulkWorkflow;
  // Chat campaign creation owns its answers and its uploaded file (an attached file used to go to enrichment).
  const campaignCreation =
    intent === "create_campaign" && (isCampaignCreationActive(state) || startsCampaignCreation(state));

  if (campaignCreation) {
    domain = "campaign";
    log.info(
      { sessionId: state.sessionId, userId: state.userId, step: state.campaignCreation?.step },
      "Manager: campaign creation — routing to campaign agent",
    );
  } else if (intent === "automations") {
    // Automations in chat (lib/automationFlow.ts) own their answers, whatever other flow is open.
    domain = "crm";
  } else if (domain === "scripts" || domain === "leadgen") {
    // Script generation: detectIntent only picks this intent from an explicit
    // file + script request, so it wins over any bulk or enrichment flow that
    // happens to be active.
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, domain },
      "Manager: script file upload — routing to scripts agent",
    );
  } else if (aiWizardActive && state.pendingCsvFile !== undefined) {
    // A recipient file sent during "Create an AI campaign" is saved straight into that campaign
    // (CampaignAgent CSV upload → save_csv_recipients). It used to start contact enrichment, whose
    // save never worked, so the wizard could not get recipients from the chat.
    domain = "campaign";
  } else if (bulkActive) {
    domain = "bulk";
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, domain },
      "Manager: bulk workflow in progress - routing to bulk agent",
    );
  } else if (enrichmentActive) {
    // Enrichment flow in progress (pendingCsvFile or pendingEnrichmentStep).
    // Route ALL intents to EnrichmentAgent so multi-turn state is handled correctly.
    domain = "enrichment";
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, domain },
      "Manager: enrichment flow in progress — routing to enrichment agent",
    );
  } else if (
    draftActive &&
    (intent === "create_campaign" ||
      intent === "update_campaign" ||
      intent === "general_help" ||
      intent === "out_of_domain")
  ) {
    // Campaign creation OR update wizard in progress. Route to CampaignAgent so it
    // can collect the next field or execute on confirmation.
    // out_of_domain is included because LLM may classify wizard answers (e.g.
    // "Big Sale Today") as out_of_domain when they contain no MailFlow keywords.
    domain = "campaign";
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, domain },
      "Manager: campaign draft in progress — routing to campaign for continuation",
    );
  } else if (selectionActive && intent !== "general_help" && (domain === "general" || domain === undefined)) {
    // User is replying to a campaign selection prompt ("1", "Summer Sale", etc.)
    // or asking a follow-up while an action is pending.
    // Match on domain instead of specific intent names so that help-intent
    // variants (next_step_help, template_help, out_of_domain, etc.) are all
    // caught without exhaustively listing every possible LLM classification.
    // Analytics and inbox domains are intentionally excluded — those requests
    // should still reach their own agents even if a pendingCampaignAction exists.
    domain = "campaign";
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, domain, pendingCampaignAction },
      "Manager: campaign selection in progress — routing to campaign",
    );
  } else if (aiWizardActive) {
    // Phase 1 AI campaign wizard in progress. Route ALL intents to CampaignAgent so
    // wizard step handlers process every user reply — confirmations, field answers,
    // template picks, etc. Without this catch-all, inputs like "Choose template"
    // (classified as template_help → general domain) or campaign field values
    // (classified as create_campaign → sent to planner) bypass the wizard entirely.
    domain = "campaign";
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, domain },
      "Manager: AI campaign wizard in progress — routing to campaign for continuation",
    );
  } else if (isAnswerableGeneralIntent(intent)) {
    // "How many recipients does X have?" has its own answer (finalResponse → recipientCountAnswer,
    // which also uses the active campaign). Never turn it into the campaign menu (bug A-19).
    domain = "general";
  } else if (
    state.activeCampaignId &&
    (domain === "general" || domain === undefined) &&
    intent !== "out_of_domain" &&
    (intent === "next_step_help" || isCampaignFollowUp(state.userMessage))
  ) {
    // Only a short follow-up about that campaign ("schedule it", "start it", "what next", "done") goes to
    // the campaign menu. Any other question ("what is 2+2?", "when was DRY RUN created?", a prompt
    // injection) used to get the same "You're currently working on campaign 434 … Start" menu (QA bug).
    // Active campaign context: a campaign was recently created or selected.
    // Route general/ambiguous intents to CampaignAgent instead of formatResponse
    // so follow-up messages ("done", "schedule it", "what next") are handled
    // in the correct campaign context rather than showing a generic capability card.
    domain = "campaign";
    log.info(
      {
        sessionId: state.sessionId, userId: state.userId, intent,
        activeCampaignId: state.activeCampaignId, contextDetected: true,
      },
      "Manager: active campaign context — routing general intent to campaign agent",
    );
  } else if (
    !pendingCampaignAction &&
    campaignSelectionList?.length &&
    intent !== "general_help" &&
    (domain === "general" || domain === undefined)
  ) {
    // A campaign list was recently shown without a pending action (e.g. plain
    // "list campaigns").  The user's reply is likely a selection ("1", campaign name).
    domain = "campaign";
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, contextDetected: true },
      "Manager: campaign list in context — routing to campaign agent for selection",
    );
  } else {
    const contextDetected = !!(
      state.activeCampaignId || state.pendingAiCampaignStep ||
      pendingCampaignAction || campaignSelectionList?.length
    );
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, domain, contextDetected },
      "Manager routing decision",
    );
  }

  const routedTo = resolveRoute(domain);

  // ── Cross-domain context cleanup ──────────────────────────────────────────
  // When the resolved domain is "enrichment", stale campaign workflow state
  // (pendingCampaignAction, campaignSelectionList) must be cleared so it cannot
  // hijack enrichment routing on the next turn.
  //
  // Guard: skip cleanup when pendingEnrichmentAction is set — in that case the
  // campaignSelectionList was populated by the enrichment flow itself (the
  // "pick a campaign to save enriched contacts to" sub-flow) and must be
  // preserved for EnrichmentAgent.handleCampaignSelection().
  const statePatch: Partial<AgentGraphStateType> = {
    agentDomain: domain,
    ...(staleSelection ? { pendingCampaignAction: undefined, campaignSelectionList: undefined, pendingScheduledAt: undefined } : {}),
  };

  if (
    domain === "enrichment" &&
    !state.pendingEnrichmentAction &&
    (state.pendingCampaignAction || state.campaignSelectionList?.length)
  ) {
    log.info(
      {
        sessionId: state.sessionId,
        userId:    state.userId,
        pendingCampaignAction: state.pendingCampaignAction,
        intent,
      },
      "Manager: clearing stale pendingCampaignAction — new intent domain is enrichment",
    );
    statePatch.pendingCampaignAction = undefined;
    statePatch.campaignSelectionList = undefined;
  }

  const enrichmentCampaignPick =
    state.pendingEnrichmentAction === "save_enriched_contacts";

  if (
    domain === "enrichment" &&
    PHASE3_INTENTS.has(intent) &&
    state.pendingCsvFile === undefined &&
    !enrichmentCampaignPick
  ) {
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent },
      "Manager: Phase 3 intent — clearing stale CSV / enrichment wizard state",
    );
    statePatch.pendingCsvData = undefined;
    statePatch.pendingEnrichmentStep = undefined;
    statePatch.pendingEnrichmentData = undefined;
    statePatch.pendingOutreachDraft = undefined;
  }

  auditLogService.agentSelected(
    {
      userId:    state.userId    as string | undefined,
      sessionId: state.sessionId as string | undefined,
    },
    { intent, agentDomain: domain, routedTo },
  );

  return statePatch;
}

// ── Conditional routing function ──────────────────────────────────────────────

/**
 * Determines which node to execute next based on agentDomain.
 *
 * "settings" is mapped to "campaign" because CampaignAgent owns SMTP intents.
 * This is the single place that encodes that routing decision.
 */
export function routeToAgent(state: AgentGraphStateType): AgentRoute {
  return resolveRoute(state.agentDomain);
}

function resolveRoute(domain: string | undefined): AgentRoute {
  switch (domain) {
    case "campaign":
    case "settings":
      return "campaign";
    case "analytics":
      return "analytics";
    case "inbox":
      return "inbox";
    case "enrichment":
      return "enrichment";
    case "research":
      return "research";
    case "bulk":
      return "bulk";
    case "scripts":
      return "scripts";
    case "crm":
      return "crm";
    case "leadgen":
      return "leadgen";
    default:
      return "formatResponse";
  }
}
