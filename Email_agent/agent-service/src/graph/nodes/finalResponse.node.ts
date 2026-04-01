/**
 * src/graph/nodes/finalResponse.node.ts
 *
 * Final node in the agent graph — shapes the result returned to the caller.
 *
 * Two-phase response construction:
 *
 *   Phase 1 — Deterministic (buildResponse):
 *     Always runs. Produces a well-formed response for every possible graph
 *     state. This is the guaranteed fallback; it never throws.
 *
 *   Phase 2 — OpenAI enhancement (maybeEnhanceWithOpenAI):
 *     Runs only when OPENAI_API_KEY is configured and the state is suitable.
 *     Two enhancement modes:
 *
 *     a) summarize_replies + toolResult
 *        OpenAI transforms raw MCP reply data into a prose summary.
 *        (OpenAI makes NO API or MCP calls — it only receives the data.)
 *
 *     b) Other intents with a successful toolResult (get_campaign_stats,
 *        list_replies) — OpenAI rewrites the deterministic response into
 *        more natural language while preserving all factual content.
 *
 *     Any OpenAI failure silently falls back to the Phase 1 response.
 *     Error states, approval gates, and general_help are never enhanced.
 *
 * Priority order inside buildResponse:
 *   1. Error state         → user-safe error message
 *   2. Approval required   → confirmation prompt (with prior plan results if any)
 *   3. general_help / no tool → capability overview
 *   4. Multi-step plan complete → step-by-step result summary
 *   5. Tool error result   → error detail from MCP
 *   6. Successful result   → raw data (OpenAI may enhance in Phase 2)
 *   7. Phase 4 placeholder → acknowledgement
 */

import { createLogger } from "../../lib/logger.js";
import { getOpenAIService } from "../../services/openai.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { PlanStepResult } from "../../lib/planTypes.js";

const log = createLogger("node:finalResponse");

// ── Intents that benefit from OpenAI response enhancement ────────────────────

/**
 * Intents whose raw tool results are data-dense enough to benefit from
 * OpenAI's natural-language rewrite. Action-confirmation intents
 * (start_campaign, pause_campaign, etc.) are excluded — their deterministic
 * responses are already concise and correct.
 */
const ENHANCE_INTENTS = new Set<string>(["get_campaign_stats", "list_replies"]);

// ── Help text ─────────────────────────────────────────────────────────────────

const CAPABILITIES = `
Here's what I can help you with:

**Campaigns**
- Create a new email campaign
- Update an existing campaign
- Start / launch a campaign
- Pause a running campaign
- Resume a paused campaign

**Analytics**
- Get campaign statistics (open rate, click rate, bounces)

**Inbox**
- List replies from recipients
- Summarise replies

**Settings**
- Check SMTP configuration
- Update SMTP settings

Just describe what you'd like to do in plain English.
`.trim();

// ── Intent labels ─────────────────────────────────────────────────────────────

const INTENT_LABELS: Record<string, string> = {
  create_campaign:    "create a new campaign",
  update_campaign:    "update the campaign",
  start_campaign:     "start the campaign",
  pause_campaign:     "pause the campaign",
  resume_campaign:    "resume the campaign",
  get_campaign_stats: "retrieve campaign statistics",
  list_replies:       "list campaign replies",
  summarize_replies:  "summarise campaign replies",
  check_smtp:         "retrieve SMTP settings",
  update_smtp:        "update SMTP settings",
  general_help:       "help",
};

// ── Multi-step helpers ────────────────────────────────────────────────────────

/**
 * Builds a human-readable summary of completed plan steps.
 * Used both for the all-safe success case and as a preamble
 * before an approval prompt when safe steps preceded the risky one.
 */
function buildPlanResultsSummary(results: PlanStepResult[]): string {
  const header = results.length === 1
    ? "Completed 1 step:"
    : `Completed ${results.length} steps:`;

  const lines: string[] = [header, ""];

  for (const result of results) {
    const stepLabel = `**Step ${result.stepIndex + 1} — ${result.toolName.replace(/_/g, " ")}**`;
    const body =
      typeof result.toolResult.data === "string"
        ? result.toolResult.data
        : JSON.stringify(result.toolResult.data, null, 2);

    if (result.toolResult.isToolError) {
      lines.push(`${stepLabel}: Error — ${body}`);
    } else {
      lines.push(`${stepLabel}:\n${body}`);
    }
  }

  return lines.join("\n");
}

// ── Phase 1: deterministic response ──────────────────────────────────────────

function buildResponse(state: AgentGraphStateType): string {
  const { intent, error, requiresApproval, pendingActionId, toolName, toolResult, planResults } = state;

  // ── Error ──────────────────────────────────────────────────────────────────
  if (error) {
    // When toolName is absent, the domain agent rejected the request before
    // dispatch (e.g. missing required fields).  The error string is a
    // user-facing clarification prompt — return it directly without the
    // system-error wrapper.
    if (!toolName) return error;
    return `I'm sorry, something went wrong: ${error} Please try again or rephrase your request.`;
  }

  // ── Approval required ─────────────────────────────────────────────────────
  // For multi-step plans: show already-completed steps as preamble, then the
  // approval prompt for the paused risky step.
  // For single-step: standard approval prompt.
  if (requiresApproval && pendingActionId) {
    const actionLabel = intent
      ? (INTENT_LABELS[intent] ?? intent.replace(/_/g, " "))
      : "this action";
    const approvalPrompt =
      `I need your confirmation before I ${actionLabel}.\n\n` +
      `This is a sensitive operation that can affect your live campaigns or mail settings.\n\n` +
      `To confirm, reply **yes** or send:\n` +
      `POST /api/agent/confirm  { "pendingActionId": "${pendingActionId}" }\n\n` +
      `To cancel, reply **no** or send:\n` +
      `POST /api/agent/cancel   { "pendingActionId": "${pendingActionId}" }`;

    if (planResults && planResults.length > 0) {
      return buildPlanResultsSummary(planResults) + "\n\n" + approvalPrompt;
    }
    return approvalPrompt;
  }

  // ── General help / no tool selected ───────────────────────────────────────
  if (intent === "general_help" || !toolName) {
    return CAPABILITIES;
  }

  // ── Multi-step plan completed ──────────────────────────────────────────────
  if (planResults && planResults.length > 0) {
    return buildPlanResultsSummary(planResults);
  }

  // ── Tool result available ──────────────────────────────────────────────────
  if (toolResult !== undefined) {
    const body =
      typeof toolResult.data === "string"
        ? toolResult.data
        : JSON.stringify(toolResult.data, null, 2);

    if (toolResult.isToolError) {
      return `The operation could not be completed: ${body}`;
    }

    return body;
  }

  // ── Phase 4 placeholder ────────────────────────────────────────────────────
  const actionLabel = intent
    ? (INTENT_LABELS[intent] ?? intent.replace(/_/g, " "))
    : "complete your request";
  return `Got it — I'll ${actionLabel}. (Tool: ${toolName})`;
}

// ── Phase 2: optional OpenAI enhancement ─────────────────────────────────────

async function maybeEnhanceWithOpenAI(
  state: AgentGraphStateType,
  baseResponse: string,
): Promise<string> {
  // Skip enhancement entirely if OpenAI is not configured
  const openai = getOpenAIService();
  if (!openai) return baseResponse;

  const { intent, error, requiresApproval, toolResult, userMessage } = state;

  // Never enhance error states or approval gates — those responses are
  // functional and must not be reworded by an LLM.
  if (error || requiresApproval) return baseResponse;

  // ── summarize_replies: OpenAI transforms raw reply data into prose ──────────
  if (intent === "summarize_replies" && toolResult && !toolResult.isToolError) {
    try {
      const summary = await openai.summarizeReplies(toolResult.data);
      log.debug({ sessionId: state.sessionId }, "OpenAI summarizeReplies applied");
      return summary;
    } catch (err) {
      log.warn(
        {
          sessionId: state.sessionId,
          error: err instanceof Error ? err.message : "unknown",
        },
        "OpenAI summarizeReplies failed — using deterministic response",
      );
      return baseResponse;
    }
  }

  // ── Data-dense intents: OpenAI rewrites into natural language ──────────────
  if (
    intent &&
    ENHANCE_INTENTS.has(intent) &&
    toolResult &&
    !toolResult.isToolError &&
    userMessage
  ) {
    try {
      const enhanced = await openai.enhanceResponse(intent, userMessage, baseResponse);
      log.debug(
        { sessionId: state.sessionId, intent },
        "OpenAI enhanceResponse applied",
      );
      return enhanced;
    } catch {
      // Enhancement is optional — silently fall back to deterministic response
    }
  }

  return baseResponse;
}

// ── Node ──────────────────────────────────────────────────────────────────────

export async function finalResponseNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const base = buildResponse(state);
  const response = await maybeEnhanceWithOpenAI(state, base);

  log.debug(
    {
      sessionId: state.sessionId,
      intent: state.intent,
      requiresApproval: state.requiresApproval,
      hasToolResult: state.toolResult !== undefined,
      llmEnhanced: response !== base,
    },
    "Final response shaped",
  );

  return { finalResponse: response };
}
