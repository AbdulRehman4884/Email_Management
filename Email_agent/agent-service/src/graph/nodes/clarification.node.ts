/**
 * src/graph/nodes/clarification.node.ts
 *
 * Clarification node — formats a structured JSON response when the validation
 * node determines that required parameters are missing OR when the campaign
 * creation wizard needs to present a step or draft to the user.
 *
 * Input:
 *   state.intent               — which operation was attempted
 *   state.error                — the domain-agent's message (question / draft)
 *   state.pendingCampaignDraft — partial/complete draft fields (if wizard active)
 *   state.pendingCampaignStep  — current wizard step or "confirm"
 *
 * Output:
 *   state.finalResponse — a structured JSON string whose shape depends on context:
 *
 *   ── Draft confirmation (step === "confirm", all fields present) ──────────────
 *   {
 *     "status":          "draft_ready",
 *     "intent":          "create_campaign",
 *     "message":         "<draft presentation with confirm instructions>",
 *     "required_fields": [],
 *     "optional_fields": ["name", "subject", "fromName", "fromEmail", "body"],
 *     "draft":           { name, subject, fromName, fromEmail, body }
 *   }
 *
 *   ── Step-by-step collection (step === field name) ────────────────────────────
 *   {
 *     "status":          "collecting_input",
 *     "intent":          "create_campaign",
 *     "message":         "<question for the current field>",
 *     "required_fields": ["<current field>"],
 *     "optional_fields": [],
 *     "draft":           { ...fields collected so far... }
 *   }
 *
 *   ── Standard clarification (no draft active) ─────────────────────────────────
 *   {
 *     "status":          "needs_input",
 *     "intent":          "<intent>",
 *     "message":         "<clarification guidance>",
 *     "required_fields": [...],
 *     "optional_fields": [...]
 *   }
 *
 * This node writes finalResponse directly and routes to saveMemory, bypassing
 * the executeTool and finalResponse nodes entirely.
 */

import { createLogger } from "../../lib/logger.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { Intent } from "../../config/intents.js";

const log = createLogger("node:clarification");

// ── All campaign wizard fields in collection order ────────────────────────────

const CAMPAIGN_FIELDS = ["name", "subject", "fromName", "fromEmail", "body"] as const;

// ── Field specifications for non-wizard intents ───────────────────────────────

interface FieldSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

const FIELD_SPECS: Partial<Record<Intent, FieldSpec>> = {
  update_campaign: {
    required: ["campaign_id OR campaign_name"],
    optional: ["subject", "body", "name", "fromName", "fromEmail"],
  },
  start_campaign:  { required: ["campaign_id"], optional: [] },
  pause_campaign:  { required: ["campaign_id"], optional: [] },
  resume_campaign: { required: ["campaign_id"], optional: [] },
};

// ── Response shapes ───────────────────────────────────────────────────────────

export interface ClarificationResponse {
  readonly status:          "needs_input" | "collecting_input" | "draft_ready" | "redirect";
  readonly intent:          string;
  readonly message:         string;
  readonly required_fields: readonly string[];
  readonly optional_fields: readonly string[];
  readonly draft?:          Record<string, string>;
  readonly action?:         { readonly type: "navigate"; readonly path: string };
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildClarificationResponse(state: AgentGraphStateType): ClarificationResponse {
  const { intent, error, pendingCampaignDraft, pendingCampaignStep } = state;

  const message =
    error ??
    "I need more information to process your request. Please provide the required details.";

  // ── Draft-ready: all fields present, awaiting user confirmation ───────────
  if (pendingCampaignStep === "confirm" && pendingCampaignDraft) {
    return {
      status:          "draft_ready",
      intent:          "create_campaign",
      message,
      required_fields: [],
      optional_fields: [...CAMPAIGN_FIELDS],
      draft:           pendingCampaignDraft,
    };
  }

  // ── Step-by-step: collecting one field at a time ──────────────────────────
  if (
    pendingCampaignStep &&
    (CAMPAIGN_FIELDS as readonly string[]).includes(pendingCampaignStep)
  ) {
    return {
      status:          "collecting_input",
      intent:          "create_campaign",
      message,
      required_fields: [pendingCampaignStep],
      optional_fields: [],
      draft:           pendingCampaignDraft ?? {},
    };
  }

  // ── SMTP update — redirect to Settings page instead of collecting in chat ──
  if (intent === "update_smtp") {
    return {
      status:          "redirect",
      intent:          "update_smtp",
      message,
      required_fields: [],
      optional_fields: [],
      action:          { type: "navigate", path: "/settings" },
    };
  }

  // ── Standard clarification: not in wizard mode ────────────────────────────
  const spec = intent
    ? (FIELD_SPECS[intent] ?? { required: [], optional: [] })
    : { required: [], optional: [] };

  return {
    status:          "needs_input",
    intent:          intent ?? "unknown",
    message,
    required_fields: [...spec.required],
    optional_fields: [...spec.optional],
  };
}

// ── Node ──────────────────────────────────────────────────────────────────────

export async function clarificationNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const response = buildClarificationResponse(state);

  log.debug(
    {
      sessionId:      state.sessionId,
      intent:         state.intent,
      status:         response.status,
      requiredFields: response.required_fields,
      hasDraft:       !!response.draft,
    },
    "Clarification response built",
  );

  return {
    finalResponse: JSON.stringify(response, null, 2),
  };
}
