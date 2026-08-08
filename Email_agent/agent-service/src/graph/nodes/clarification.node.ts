/**
 * src/graph/nodes/clarification.node.ts
 *
 * Clarification node — formats a structured JSON response when the validation
 * node determines that required parameters are missing.
 *
 * Input:
 *   state.intent  — which operation was attempted
 *   state.error   — the domain-agent's clarification text (human-readable guidance)
 *
 * Output:
 *   state.finalResponse — a deterministic, structured JSON string:
 *
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
 *
 * Never returns a generic error — every state reachable here has a specific,
 * actionable message from the domain agent (state.error).
 */

import { createLogger } from "../../lib/logger.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { Intent } from "../../config/intents.js";

const log = createLogger("node:clarification");

// ── Field specifications per intent ───────────────────────────────────────────

interface FieldSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/**
 * Describes which fields are required vs. optional for each intent.
 * Used to populate the structured clarification response so the caller
 * (frontend / API consumer) knows exactly what to collect from the user.
 */
const FIELD_SPECS: Partial<Record<Intent, FieldSpec>> = {
  update_campaign: {
    required: ["campaign_id OR campaign_name"],
    optional: ["subject", "body", "name", "fromName", "fromEmail"],
  },
  create_campaign: {
    required: ["name", "subject", "fromName", "fromEmail", "body"],
    optional: [],
  },
  start_campaign: {
    required: ["campaign_id"],
    optional: [],
  },
  pause_campaign: {
    required: ["campaign_id"],
    optional: [],
  },
  resume_campaign: {
    required: ["campaign_id"],
    optional: [],
  },
  update_smtp: {
    required: ["at_least_one_smtp_field"],
    optional: ["host", "port", "secure", "username"],
  },
};

// ── Response shape ─────────────────────────────────────────────────────────────

export interface ClarificationResponse {
  readonly status:          "needs_input";
  readonly intent:          string;
  readonly message:         string;
  readonly required_fields: readonly string[];
  readonly optional_fields: readonly string[];
}

// ── Builder ────────────────────────────────────────────────────────────────────

function buildClarificationResponse(
  intent: Intent | undefined,
  message: string,
): ClarificationResponse {
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

// ── Node ───────────────────────────────────────────────────────────────────────

export async function clarificationNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { intent, error, sessionId } = state;

  const message =
    error ??
    "I need more information to process your request. Please provide the required details.";

  const response = buildClarificationResponse(intent, message);

  log.debug(
    {
      sessionId,
      intent,
      status:         "needs_input",
      requiredFields: response.required_fields,
    },
    "Clarification response built",
  );

  return {
    finalResponse: JSON.stringify(response, null, 2),
  };
}
