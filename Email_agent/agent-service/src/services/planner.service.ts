/**
 * src/services/planner.service.ts
 *
 * Detects whether a user message requires a multi-step plan (2–3 MCP tool
 * calls) and, if so, builds the ordered list of PlannedStep objects.
 *
 * Single-step requests (including those requiring approval) continue to use
 * the existing manager → domain-agent → approval → executeTool path.
 * This service only activates for genuinely multi-step tasks.
 *
 * Plan building rules:
 *   1. Skip planning if OPENAI_API_KEY is not configured or intent is
 *      general_help (no tools involved).
 *   2. Ask OpenAI for a multi-step plan via openai.planSteps().
 *   3. Validate with LLMPlanResponseSchema (Zod).
 *   4. Return null if: OpenAI unavailable, response invalid, isMultiStep=false,
 *      fewer than 2 valid steps, or any step has an unrecognised tool.
 *   5. For each valid step:
 *      a. Resolve toolArgs via resolveToolArgs() (consistent arg rules + security).
 *      b. Tag requiresApproval via approvalPolicyService.
 *   6. Return the typed PlannedStep[].
 */

import { createLogger } from "../lib/logger.js";
import { getOpenAIService } from "./openai.service.js";
import { resolveToolArgs } from "../lib/toolArgResolver.js";
import { approvalPolicyService } from "./approvalPolicy.service.js";
import { LLMPlanResponseSchema } from "../schemas/plan.schema.js";
import { KNOWN_TOOL_NAMES } from "../types/tools.js";
import { ALL_INTENTS } from "../config/intents.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { PlannedStep } from "../lib/planTypes.js";

const log = createLogger("planner");

// ── Service ───────────────────────────────────────────────────────────────────

export class PlannerService {
  /**
   * Attempts to build a multi-step plan for the current graph state.
   *
   * Returns an ordered PlannedStep[] with at least 2 steps, or null when
   * the request is single-step (falls through to the existing agent path).
   */
  async detectPlan(state: AgentGraphStateType): Promise<PlannedStep[] | null> {
    const { userMessage, intent, llmExtractedArgs, activeCampaignId, sessionId } = state;

    // When an AI campaign wizard turn or a campaign action selection is in progress,
    // the user's reply must go directly to CampaignAgent.  A planner-generated plan
    // would bypass the step handlers and corrupt wizard/selection state.
    if (state.pendingAiCampaignStep || state.pendingCampaignAction) {
      log.debug(
        {
          sessionId,
          pendingAiCampaignStep: state.pendingAiCampaignStep,
          pendingCampaignAction: state.pendingCampaignAction,
        },
        "Skipping plan detection — wizard or campaign action selection in progress",
      );
      return null;
    }

    // CSV upload turns must never reach the planner.  The planner cannot supply
    // fileContent or filename args — it would always emit parse_csv_file →
    // save_csv_recipients with empty args {}, causing an MCP validation error.
    // CampaignAgent.handleCsvUpload() owns the entire two-turn flow.
    if (state.pendingCsvFile) {
      log.debug(
        { sessionId },
        "Skipping plan detection — pendingCsvFile present; routing directly to CampaignAgent",
      );
      return null;
    }

    // Skip planning for intents that are purely informational / response-only.
    // These intents never result in MCP tool calls — they produce a direct
    // text response in finalResponse.node.ts.  Sending them to the planner
    // wastes an OpenAI call and may produce hallucinated plans.
    const RESPONSE_ONLY_INTENTS = new Set([
      "general_help",
      "out_of_domain",
      "template_help",
      "upload_recipients_help",
      "next_step_help",
      "ai_campaign_help",
      "recipient_status_help",
      // Wizard-start intent — CampaignAgent owns the full multi-turn flow;
      // the planner must never intercept it with an OpenAI-generated tool plan.
      "create_ai_campaign",
      // CSV upload — CampaignAgent owns the full two-turn parse→confirm flow.
      // The planner cannot supply fileContent/filename args; it would always
      // build parse_csv_file → save_csv_recipients with empty args {}.
      "upload_csv",
      // Enrichment intents — EnrichmentAgent owns the multi-turn flow.
      // These intents carry state (enrichedContacts, outreachDraft) that the
      // planner cannot construct; routing to the planner would produce empty-arg plans.
      "enrich_contacts",
      "confirm_enrichment",
      "customize_outreach",
      "discard_enrichment",
      "enrichment_help",
      // Phase 1 single-shot enrichment tools — dispatch one MCP tool directly.
      "validate_email",
      "enrich_contact",
      "fetch_company_website",
      "extract_domain",
      // Phase 2 company search tools — single-shot, agent builds args directly.
      "search_company_web",
      "select_official_website",
      "verify_company_website",
    ]);
    if (!intent || RESPONSE_ONLY_INTENTS.has(intent)) {
      return null;
    }

    // These intents always route to a domain agent — never to the planner.
    // CampaignAgent owns campaign actions (it handles selection, date parsing,
    // and field-collection wizards). The planner cannot safely build these steps
    // because it may hallucinate create_campaign → start_campaign chains when
    // an activeCampaignId is already in context.
    const CAMPAIGN_ACTION_INTENTS = new Set([
      "start_campaign",
      "pause_campaign",
      "resume_campaign",
      "schedule_campaign",           // requires CampaignAgent for date parsing + selection
      "update_campaign",             // requires CampaignAgent for field-collection wizard
      "generate_personalized_emails",   // requires CampaignAgent; needs activeCampaignId context
      "regenerate_personalized_emails", // same — overwrite flag must pass through CampaignAgent
      "show_sequence_progress",
      "show_pending_follow_ups",
      "show_recipient_touch_history",
      "mark_recipient_replied",
      "mark_recipient_bounced",
    ]);
    if (CAMPAIGN_ACTION_INTENTS.has(intent)) {
      log.debug(
        { sessionId, intent },
        "Skipping plan detection — action intent; routing to domain agent",
      );
      return null;
    }

    if (!userMessage?.trim()) {
      return null;
    }

    // Skip if OpenAI is not configured
    const openai = getOpenAIService();
    if (!openai) {
      return null;
    }

    // ── Ask OpenAI for a plan ────────────────────────────────────────────────

    let rawJson: string | null;
    try {
      rawJson = await openai.planSteps(
        userMessage,
        KNOWN_TOOL_NAMES as unknown as string[],
        ALL_INTENTS as unknown as string[],
      );
    } catch {
      log.warn({ sessionId }, "planSteps OpenAI call threw unexpectedly — skipping multi-step");
      return null;
    }

    if (rawJson === null) {
      return null;
    }

    // ── Parse and validate ───────────────────────────────────────────────────

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      log.warn({ sessionId }, "OpenAI plan response is not valid JSON — skipping multi-step");
      return null;
    }

    const validated = LLMPlanResponseSchema.safeParse(parsed);
    if (!validated.success) {
      log.warn(
        { sessionId, issues: validated.error.issues.map((i) => i.message) },
        "OpenAI plan response failed schema validation — skipping multi-step",
      );
      return null;
    }

    const { isMultiStep, steps } = validated.data;

    // Only activate the plan path for genuine multi-step requests
    if (!isMultiStep || steps.length < 2) {
      return null;
    }

    // ── Build PlannedStep[] ──────────────────────────────────────────────────

    const plan: PlannedStep[] = steps.map((llmStep, idx) => {
      const toolArgs = resolveToolArgs(llmStep.tool, {
        extractedArgs:    llmExtractedArgs,
        activeCampaignId,
      });

      const requiresApproval = approvalPolicyService.requiresApproval(llmStep.intent);

      return {
        stepIndex:        idx,
        toolName:         llmStep.tool,
        toolArgs,
        intent:           llmStep.intent,
        description:      llmStep.description,
        requiresApproval,
      };
    });

    log.info(
      {
        sessionId,
        stepCount: plan.length,
        steps: plan.map((s) => ({ tool: s.toolName, risky: s.requiresApproval })),
      },
      "Multi-step plan detected",
    );

    return plan;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const plannerService = new PlannerService();
