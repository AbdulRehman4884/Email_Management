/**
 * src/lib/agentResponseFormatter.ts
 *
 * Unified response formatter for all agent API endpoints.
 *
 * Provides typed factory functions that produce consistent response payloads
 * for every outcome the agent can produce:
 *
 *   formatChatSuccess         — tool ran or general reply (no approval needed)
 *   formatApprovalRequired    — risky action registered, waiting for confirm
 *   formatConfirmSuccess      — approved action executed
 *   formatConfirmToolError    — action confirmed but tool returned an error
 *   formatCancelled           — pending action cancelled
 *   formatWorkflowError       — graph produced state.error (non-auth failure)
 *
 * All functions return plain objects — serialised by the controllers via
 * sendSuccess().  Error cases (auth, validation) are still handled by the
 * Express errorHandler so they retain the ApiFailure envelope.
 *
 * Response normalisation:
 *   The LangGraph finalResponse field is a string (plain text or serialised JSON).
 *   parseAgentResponse() safely converts it to a native AgentResult object so
 *   the API never exposes a stringified JSON payload inside a string field.
 */

import type { PendingAction } from "../services/pendingAction.service.js";

// ── Shared sub-types ──────────────────────────────────────────────────────────

export interface ToolResultSummary {
  data: unknown;
  isToolError: boolean;
}

function toToolResultSummary(
  r: { data: unknown; isToolError: boolean },
): ToolResultSummary {
  return { data: r.data, isToolError: r.isToolError };
}

// ── AgentResult — the normalised chat payload ─────────────────────────────────

/**
 * Structured result shapes produced by the graph nodes.
 * clarificationNode  → NeedsInputResult
 * finalResponseNode  → SuccessResult | ErrorResult
 * general_help path  → PlainTextResult (no "status" field)
 */
export interface NeedsInputResult {
  status: "needs_input";
  intent: string;
  message: string;
  required_fields: string[];
  optional_fields: string[];
}

export interface SuccessResult {
  status: "success";
  intent: string;
  message: string;
  data: unknown;
}

export interface ErrorResult {
  status: "error";
  intent: string;
  message: string;
  action: string;
}

/** Plain conversational text (general_help, approval prompts, legacy paths). */
export interface PlainTextResult {
  message: string;
}

/**
 * Union of all possible normalised chat result shapes.
 * Callers can discriminate on the presence / value of the `status` field.
 */
export type AgentResult =
  | NeedsInputResult
  | SuccessResult
  | ErrorResult
  | PlainTextResult;

/**
 * Safely normalises the raw `finalResponse` string from the LangGraph graph
 * into a native AgentResult object.
 *
 * Rules:
 *   1. If `raw` is valid JSON with a top-level `status` field → return as a
 *      structured result (NeedsInputResult | SuccessResult | ErrorResult).
 *   2. If `raw` is valid JSON but has no `status` field → wrap as PlainTextResult.
 *   3. If `raw` is not valid JSON (plain text) → wrap as PlainTextResult.
 *   4. If `raw` is empty → PlainTextResult with empty message.
 *
 * This prevents any path from returning a stringified JSON payload as
 * `data.result = "{ \"status\": \"success\" ... }"`.
 */
export function parseAgentResponse(raw: string): AgentResult {
  if (!raw) return { message: "" };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "status" in parsed &&
      typeof (parsed as Record<string, unknown>).status === "string"
    ) {
      return parsed as NeedsInputResult | SuccessResult | ErrorResult;
    }
  } catch {
    // Not valid JSON — fall through to plain-text wrapper
  }

  return { message: raw };
}

// ── Payload types ─────────────────────────────────────────────────────────────

/**
 * Chat turn completed without requiring approval.
 *
 * `result` is the normalised graph output — a native object, never a string.
 * Callers can inspect `result.status` to distinguish structured results from
 * plain conversational text (which has no `status` field).
 *
 * `toolResult` is included only when a tool was dispatched and returned data.
 */
export interface ChatSuccessPayload {
  approvalRequired: false;
  sessionId: string;
  result: AgentResult;
  toolResult?: ToolResultSummary;
}

export interface ApprovalRequiredPayload {
  approvalRequired: true;
  sessionId: string;
  message: string;
  pendingAction: {
    id: string;
    intent: string;
    toolName: string;
    reason?: string;
    expiresAt: string;
  };
}

export interface ConfirmSuccessPayload {
  response: string;
  toolResult?: ToolResultSummary;
}

export interface CancelledPayload {
  cancelled: true;
  message: string;
}

export interface WorkflowErrorPayload {
  response: string;
  error: true;
}

// ── Discriminated union ───────────────────────────────────────────────────────

export type AgentPayload =
  | ChatSuccessPayload
  | ApprovalRequiredPayload
  | ConfirmSuccessPayload
  | CancelledPayload
  | WorkflowErrorPayload;

// ── Factory functions ─────────────────────────────────────────────────────────

/**
 * Builds the payload for a successful chat turn (tool ran or plain reply).
 *
 * `response` is the raw finalResponse string from the graph.  It is normalised
 * via parseAgentResponse() so the API always returns a native object in `result`
 * — never a stringified JSON payload.
 */
export function formatChatSuccess(
  sessionId: string,
  response: string,
  toolResult?: { data: unknown; isToolError: boolean },
): ChatSuccessPayload {
  return {
    approvalRequired: false,
    sessionId,
    result: parseAgentResponse(response),
    ...(toolResult ? { toolResult: toToolResultSummary(toolResult) } : {}),
  };
}

/**
 * Builds the payload when the agent has flagged a risky action for confirmation.
 */
export function formatApprovalRequired(
  sessionId: string,
  message: string,
  action: PendingAction,
  reason?: string,
): ApprovalRequiredPayload {
  return {
    approvalRequired: true,
    sessionId,
    message,
    pendingAction: {
      id:       action.id,
      intent:   action.intent,
      toolName: action.toolName,
      expiresAt: action.expiresAt,
      ...(reason ? { reason } : {}),
    },
  };
}

/**
 * Builds the payload after a confirmed action has been executed successfully.
 */
export function formatConfirmSuccess(
  intent: string,
  toolResult?: { data: unknown; isToolError: boolean },
): ConfirmSuccessPayload {
  const response = buildConfirmMessage(intent, toolResult);
  return {
    response,
    ...(toolResult ? { toolResult: toToolResultSummary(toolResult) } : {}),
  };
}

/**
 * Builds the payload for a cancelled pending action.
 */
export function formatCancelled(): CancelledPayload {
  return {
    cancelled: true,
    message: "Action cancelled successfully.",
  };
}

/**
 * Builds the payload when graph state contains a workflow/tool error.
 * Used when the error is recoverable (non-auth, non-validation) and the
 * response should still be HTTP 200 so the frontend renders the message.
 */
export function formatWorkflowError(errorDetail: string): WorkflowErrorPayload {
  return {
    response: errorDetail,
    error: true,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function buildConfirmMessage(
  intent: string,
  toolResult: { data: unknown; isToolError: boolean } | undefined,
): string {
  if (!toolResult) {
    return `The ${intent.replace(/_/g, " ")} action completed.`;
  }

  if (toolResult.isToolError) {
    const detail =
      typeof toolResult.data === "string"
        ? toolResult.data
        : JSON.stringify(toolResult.data);
    return `The operation encountered an issue: ${detail}`;
  }

  const labels: Record<string, string> = {
    start_campaign:  "Campaign started successfully.",
    resume_campaign: "Campaign resumed successfully.",
    update_smtp:     "SMTP settings updated successfully.",
  };

  return labels[intent] ?? `${intent.replace(/_/g, " ")} completed successfully.`;
}
