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
 *   "general"   → formatResponse node (no tool execution needed)
 *   undefined   → formatResponse node (defensive fallback)
 */

import { createLogger } from "../../lib/logger.js";
import { INTENT_DOMAIN } from "../../config/intents.js";
import { auditLogService } from "../../services/auditLog.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import { isWorkflowDeadlineExpired } from "../../lib/mcpErrorMapping.js";

const log = createLogger("node:manager");

/** Phase 3 intents — starting these should drop stale CSV wizard state (not enrichment campaign-pick). */
const PHASE3_INTENTS = new Set([
  "analyze_company",
  "detect_pain_points",
  "generate_outreach",
  "enrich_company",
]);

// ── Route destinations ────────────────────────────────────────────────────────

export type AgentRoute = "campaign" | "analytics" | "inbox" | "enrichment" | "formatResponse";

// ── Node ──────────────────────────────────────────────────────────────────────

export async function managerNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const intent = state.intent ?? "general_help";
  let domain = INTENT_DOMAIN[intent];

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
      requestedType === "campaign" || requestedType === "analytics" || requestedType === "inbox"
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
        : "workflow";

      return {
        formattedResponse:
          `I’m already working on your **${label}**. ` +
          "Please complete it, cancel it, or say **discard** to clear it before starting something else.",
      };
    }
  }

  const draftActive       = !!state.pendingCampaignDraft;
  const selectionActive   = !!state.pendingCampaignAction;
  const aiWizardActive    = !!state.pendingAiCampaignStep;
  const enrichmentActive  = !!state.pendingEnrichmentStep || !!state.pendingCsvFile || !!state.pendingEnrichmentAction;

  if (enrichmentActive) {
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
  } else if (selectionActive && (domain === "general" || domain === undefined)) {
    // User is replying to a campaign selection prompt ("1", "Summer Sale", etc.)
    // or asking a follow-up while an action is pending.
    // Match on domain instead of specific intent names so that help-intent
    // variants (next_step_help, template_help, out_of_domain, etc.) are all
    // caught without exhaustively listing every possible LLM classification.
    // Analytics and inbox domains are intentionally excluded — those requests
    // should still reach their own agents even if a pendingCampaignAction exists.
    domain = "campaign";
    log.info(
      { sessionId: state.sessionId, userId: state.userId, intent, domain, pendingCampaignAction: state.pendingCampaignAction },
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
  } else if (state.activeCampaignId && (domain === "general" || domain === undefined)) {
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
    !state.pendingCampaignAction &&
    state.campaignSelectionList?.length &&
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
      state.pendingCampaignAction || state.campaignSelectionList?.length
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
  const statePatch: Partial<AgentGraphStateType> = { agentDomain: domain };

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
    default:
      return "formatResponse";
  }
}
