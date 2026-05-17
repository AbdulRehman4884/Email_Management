/**
 * src/graph/nodes/planDetection.node.ts
 *
 * Runs after detectIntent to determine if the user message requires a
 * multi-step plan (2–3 sequential MCP tool calls).
 *
 * Delegates entirely to PlannerService.detectPlan():
 *   - Returns { plan } with a PlannedStep[] when a multi-step plan is found.
 *   - Returns { plan: undefined } for single-step requests (the agent.workflow
 *     conditional edge routes these to the standard manager path).
 *
 * This node is always fast: it only calls Gemini when GEMINI_API_KEY is
 * configured and the intent is not general_help. Any Gemini failure or
 * parse error silently falls through to the single-step path.
 */

import { createLogger } from "../../lib/logger.js";
import { plannerService } from "../../services/planner.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:planDetection");

const PHASE_3_ENRICHMENT_INTENTS = new Set([
  "analyze_company",
  "generate_outreach",
  "detect_pain_points",
  "enrich_company",
]);

export async function planDetectionNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  // CSV upload turns must always go through EnrichmentAgent so the file buffer
  // and parsed data are handled correctly. The planner cannot populate
  // parse_csv_file args from session context — it would always send {}.
  if (state.pendingCsvFile) {
    log.debug(
      { sessionId: state.sessionId },
      "Skipping plan detection — pendingCsvFile present; routing directly to EnrichmentAgent",
    );
    return { plan: undefined };
  }

  // Enrichment flow turns must always go through EnrichmentAgent.
  // The enrichment state (pendingEnrichmentData, pendingOutreachDraft) cannot
  // be reconstructed by the planner — it would build an empty-arg plan.
  if (state.pendingEnrichmentStep) {
    log.debug(
      { sessionId: state.sessionId, pendingEnrichmentStep: state.pendingEnrichmentStep },
      "Skipping plan detection — enrichment flow in progress; routing to EnrichmentAgent",
    );
    return { plan: undefined };
  }

  // Campaign selection sub-flow: the user is choosing a campaign to save
  // enriched contacts into. This reply must go directly to EnrichmentAgent.
  if (state.pendingEnrichmentAction) {
    log.debug(
      { sessionId: state.sessionId, pendingEnrichmentAction: state.pendingEnrichmentAction },
      "Skipping plan detection — enrichment campaign selection in progress; routing to EnrichmentAgent",
    );
    return { plan: undefined };
  }

  // Phase 3 enrichment intents require deterministic URL/company extraction
  // and sequential use of previous tool outputs. The generic planner may choose
  // correct tools but cannot reliably construct required arguments such as:
  // fetch_website_content({ url }) or extract_company_profile({ websiteContent }).
  // Therefore these intents must route directly to EnrichmentAgent handlers.
  if (state.intent && PHASE_3_ENRICHMENT_INTENTS.has(state.intent)) {
    log.debug(
      { sessionId: state.sessionId, intent: state.intent },
      "Skipping plan detection — Phase 3 enrichment intent; routing directly to EnrichmentAgent",
    );
    return { plan: undefined };
  }

  const plan = await plannerService.detectPlan(state);

  log.debug(
    {
      sessionId: state.sessionId,
      intent: state.intent,
      isMultiStep: plan !== null && plan !== undefined && plan.length >= 2,
      planSteps: plan?.map((s) => s.toolName),
    },
    "Plan detection result",
  );

  return { plan: plan ?? undefined };
}