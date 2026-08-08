/**
 * src/lib/__tests__/agentResponseFormatter.test.ts
 *
 * Unit tests for agentResponseFormatter.
 *
 * Each factory function is exercised for:
 *   - Required field presence and correct values
 *   - Discriminant field values (approvalRequired, cancelled, error)
 *   - Optional field inclusion/exclusion (toolResult, reason)
 *   - The buildConfirmMessage private helper via formatConfirmSuccess
 */

import { describe, it, expect } from "vitest";
import {
  formatChatSuccess,
  formatApprovalRequired,
  formatConfirmSuccess,
  formatCancelled,
  formatWorkflowError,
  parseAgentResponse,
  type ChatSuccessPayload,
  type ApprovalRequiredPayload,
  type ConfirmSuccessPayload,
  type CancelledPayload,
  type WorkflowErrorPayload,
  type AgentResult,
  type NeedsInputResult,
  type SuccessResult,
  type ErrorResult,
  type PlainTextResult,
} from "../agentResponseFormatter.js";
import type { PendingAction } from "../../services/pendingAction.service.js";
import type { UserId, SessionId } from "../../types/common.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePendingAction(
  overrides?: Partial<PendingAction>,
): PendingAction {
  return {
    id:        "action-abc-123",
    userId:    "user-1"  as UserId,
    sessionId: "sess-1"  as SessionId,
    intent:    "start_campaign",
    toolName:  "start_campaign",
    toolArgs:  { campaignId: "c1" },
    status:    "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

const TOOL_RESULT_OK = { data: { id: "c1", status: "active" }, isToolError: false };
const TOOL_RESULT_ERR = { data: "Campaign not found", isToolError: true };
const TOOL_RESULT_ERR_OBJ = { data: { error: "Not found" }, isToolError: true };

// ── formatChatSuccess ─────────────────────────────────────────────────────────

describe("formatChatSuccess", () => {
  it("sets approvalRequired: false (discriminant)", () => {
    const p = formatChatSuccess("s1", "Hello");
    expect(p.approvalRequired).toBe(false);
  });

  it("includes sessionId and wraps plain text in result.message", () => {
    const p = formatChatSuccess("sess-42", "Here are your stats.");
    expect(p.sessionId).toBe("sess-42");
    // Plain text → PlainTextResult (no "status" field)
    expect((p.result as PlainTextResult).message).toBe("Here are your stats.");
    expect("status" in p.result).toBe(false);
  });

  it("omits toolResult field when not provided", () => {
    const p = formatChatSuccess("s1", "ok");
    expect("toolResult" in p).toBe(false);
  });

  it("includes toolResult when a successful result is provided", () => {
    const p = formatChatSuccess("s1", "Done", TOOL_RESULT_OK);
    expect(p.toolResult).toEqual({ data: TOOL_RESULT_OK.data, isToolError: false });
  });

  it("includes toolResult when the tool returned an error flag", () => {
    const p = formatChatSuccess("s1", "Error", TOOL_RESULT_ERR);
    expect(p.toolResult?.isToolError).toBe(true);
    expect(p.toolResult?.data).toBe("Campaign not found");
  });

  it("omits rawContent from McpToolResult — only data and isToolError are forwarded", () => {
    const mcpResult = { data: { x: 1 }, isToolError: false, rawContent: ["raw"] };
    const p = formatChatSuccess("s1", "ok", mcpResult) as ChatSuccessPayload & {
      toolResult?: { rawContent?: unknown };
    };
    expect(p.toolResult).not.toHaveProperty("rawContent");
  });

  it("returns a plain object conforming to ChatSuccessPayload shape", () => {
    const p: ChatSuccessPayload = formatChatSuccess("s", "r", TOOL_RESULT_OK);
    expect(p).toMatchObject({
      approvalRequired: false,
      sessionId: "s",
      // Plain text "r" → PlainTextResult
      result: { message: "r" },
      toolResult: { isToolError: false },
    });
  });
});

// ── formatApprovalRequired ────────────────────────────────────────────────────

describe("formatApprovalRequired", () => {
  it("sets approvalRequired: true (discriminant)", () => {
    const p = formatApprovalRequired("s1", "Confirm?", makePendingAction());
    expect(p.approvalRequired).toBe(true);
  });

  it("includes sessionId and message", () => {
    const p = formatApprovalRequired("sess-7", "Please confirm", makePendingAction());
    expect(p.sessionId).toBe("sess-7");
    expect(p.message).toBe("Please confirm");
  });

  it("maps pendingAction id, intent, toolName, expiresAt from PendingAction", () => {
    const action = makePendingAction({
      id:        "pa-999",
      intent:    "start_campaign",
      toolName:  "start_campaign",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
    const p = formatApprovalRequired("s", "msg", action);
    expect(p.pendingAction.id).toBe("pa-999");
    expect(p.pendingAction.intent).toBe("start_campaign");
    expect(p.pendingAction.toolName).toBe("start_campaign");
    expect(p.pendingAction.expiresAt).toBe("2026-01-01T00:10:00.000Z");
  });

  it("includes reason in pendingAction when provided", () => {
    const p = formatApprovalRequired("s", "msg", makePendingAction(), "Emails will be sent.");
    expect(p.pendingAction.reason).toBe("Emails will be sent.");
  });

  it("omits reason from pendingAction when not provided", () => {
    const p = formatApprovalRequired("s", "msg", makePendingAction());
    expect("reason" in p.pendingAction).toBe(false);
  });

  it("does not leak toolArgs or sensitive fields from PendingAction", () => {
    const action = makePendingAction({ toolArgs: { campaignId: "c1", secret: "s" } });
    const p: ApprovalRequiredPayload = formatApprovalRequired("s", "msg", action);
    expect(p.pendingAction).not.toHaveProperty("toolArgs");
    expect(p.pendingAction).not.toHaveProperty("secret");
  });
});

// ── formatConfirmSuccess ──────────────────────────────────────────────────────

describe("formatConfirmSuccess", () => {
  // ── Known intent labels ──────────────────────────────────────────────────

  it("returns 'Campaign started successfully.' for start_campaign with no error", () => {
    const p = formatConfirmSuccess("start_campaign", TOOL_RESULT_OK);
    expect(p.response).toBe("Campaign started successfully.");
  });

  it("returns 'Campaign resumed successfully.' for resume_campaign with no error", () => {
    const p = formatConfirmSuccess("resume_campaign", TOOL_RESULT_OK);
    expect(p.response).toBe("Campaign resumed successfully.");
  });

  it("returns 'SMTP settings updated successfully.' for update_smtp with no error", () => {
    const p = formatConfirmSuccess("update_smtp", TOOL_RESULT_OK);
    expect(p.response).toBe("SMTP settings updated successfully.");
  });

  it("returns generic completion message for an unlabelled intent with success result", () => {
    const p = formatConfirmSuccess("pause_campaign", TOOL_RESULT_OK);
    expect(p.response).toContain("pause campaign");
  });

  // ── No toolResult ────────────────────────────────────────────────────────

  it("returns generic action-completed message when no toolResult is provided", () => {
    const p = formatConfirmSuccess("start_campaign");
    expect(p.response).toContain("start campaign");
    expect(p.response.toLowerCase()).toContain("completed");
  });

  it("omits toolResult field when not provided", () => {
    const p = formatConfirmSuccess("start_campaign");
    expect("toolResult" in p).toBe(false);
  });

  // ── Tool error ───────────────────────────────────────────────────────────

  it("returns error message when toolResult.isToolError is true (string data)", () => {
    const p = formatConfirmSuccess("start_campaign", TOOL_RESULT_ERR);
    expect(p.response).toContain("Campaign not found");
    expect(p.response.toLowerCase()).toContain("issue");
  });

  it("returns JSON-stringified error detail when toolResult.data is an object", () => {
    const p = formatConfirmSuccess("start_campaign", TOOL_RESULT_ERR_OBJ);
    expect(p.response).toContain("Not found");
  });

  // ── toolResult passthrough ───────────────────────────────────────────────

  it("includes toolResult in output when provided", () => {
    const p: ConfirmSuccessPayload = formatConfirmSuccess("start_campaign", TOOL_RESULT_OK);
    expect(p.toolResult).toEqual({ data: TOOL_RESULT_OK.data, isToolError: false });
  });

  it("underscores in intent name are replaced with spaces in fallback message", () => {
    const p = formatConfirmSuccess("list_replies");
    expect(p.response).toContain("list replies");
  });
});

// ── formatCancelled ───────────────────────────────────────────────────────────

describe("formatCancelled", () => {
  it("returns cancelled: true (discriminant)", () => {
    const p: CancelledPayload = formatCancelled();
    expect(p.cancelled).toBe(true);
  });

  it("returns a non-empty message", () => {
    const p = formatCancelled();
    expect(p.message.length).toBeGreaterThan(0);
  });

  it("returns same shape on every call (pure function)", () => {
    expect(formatCancelled()).toEqual(formatCancelled());
  });

  it("does not include approvalRequired or toolResult fields", () => {
    const p = formatCancelled() as Record<string, unknown>;
    expect(p).not.toHaveProperty("approvalRequired");
    expect(p).not.toHaveProperty("toolResult");
  });
});

// ── formatWorkflowError ───────────────────────────────────────────────────────

describe("formatWorkflowError", () => {
  it("returns error: true (discriminant)", () => {
    const p: WorkflowErrorPayload = formatWorkflowError("Something went wrong");
    expect(p.error).toBe(true);
  });

  it("passes the errorDetail string through as response", () => {
    const msg = "The operation could not be completed: timeout";
    const p = formatWorkflowError(msg);
    expect(p.response).toBe(msg);
  });

  it("returns a distinct object each call (not a cached reference)", () => {
    const a = formatWorkflowError("err");
    const b = formatWorkflowError("err");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("does not include approvalRequired, cancelled, or toolResult fields", () => {
    const p = formatWorkflowError("e") as Record<string, unknown>;
    expect(p).not.toHaveProperty("approvalRequired");
    expect(p).not.toHaveProperty("cancelled");
    expect(p).not.toHaveProperty("toolResult");
  });
});

// ── parseAgentResponse ────────────────────────────────────────────────────────

describe("parseAgentResponse", () => {

  // ── Structured inputs ─────────────────────────────────────────────────────

  it("Test 1 — parses needs_input JSON into a NeedsInputResult object", () => {
    const raw = JSON.stringify({
      status:          "needs_input",
      intent:          "update_campaign",
      message:         "Please provide the campaign ID.",
      required_fields: ["campaign_id OR campaign_name"],
      optional_fields: ["subject", "body"],
    });
    const result = parseAgentResponse(raw) as NeedsInputResult;
    expect(result.status).toBe("needs_input");
    expect(result.intent).toBe("update_campaign");
    expect(result.message).toBe("Please provide the campaign ID.");
    expect(result.required_fields).toEqual(["campaign_id OR campaign_name"]);
    expect(result.optional_fields).toEqual(["subject", "body"]);
    // Must NOT be wrapped in a { message } envelope
    expect("message" in result && result.status === "needs_input").toBe(true);
  });

  it("Test 2 — parses success JSON into a SuccessResult object", () => {
    const raw = JSON.stringify({
      status:  "success",
      intent:  "update_campaign",
      message: "update the campaign completed successfully.",
      data:    { id: "123", status: "updated" },
    });
    const result = parseAgentResponse(raw) as SuccessResult;
    expect(result.status).toBe("success");
    expect(result.intent).toBe("update_campaign");
    expect(result.data).toEqual({ id: "123", status: "updated" });
    // Must NOT be a string
    expect(typeof result).toBe("object");
  });

  it("parses error JSON into an ErrorResult object", () => {
    const raw = JSON.stringify({
      status:  "error",
      intent:  "update_campaign",
      message: "The request timed out.",
      action:  "Please try again.",
    });
    const result = parseAgentResponse(raw) as ErrorResult;
    expect(result.status).toBe("error");
    expect(result.action).toBe("Please try again.");
  });

  // ── Plain text inputs ─────────────────────────────────────────────────────

  it("Test 4 — wraps plain conversational text in PlainTextResult", () => {
    const raw = "Here's what I can help you with:\n\n**Campaigns**\n- Create...";
    const result = parseAgentResponse(raw) as PlainTextResult;
    expect("status" in result).toBe(false);
    expect(result.message).toBe(raw);
  });

  it("wraps approval prompt text in PlainTextResult", () => {
    const raw = "I need your confirmation before I start the campaign.";
    const result = parseAgentResponse(raw) as PlainTextResult;
    expect((result as PlainTextResult).message).toBe(raw);
    expect("status" in result).toBe(false);
  });

  // ── Test 5: Malformed / edge-case inputs ──────────────────────────────────

  it("Test 5 — handles malformed JSON gracefully — wraps as PlainTextResult", () => {
    const malformed = '{ "status": "success", "intent": "update_campaign", ...BROKEN';
    const result = parseAgentResponse(malformed);
    // Must not throw; must return a PlainTextResult, not crash
    expect(result).toBeDefined();
    expect((result as PlainTextResult).message).toBe(malformed);
    expect("status" in result).toBe(false);
  });

  it("handles valid JSON object without status field — wraps as PlainTextResult", () => {
    const raw = JSON.stringify({ foo: "bar", baz: 42 });
    const result = parseAgentResponse(raw) as PlainTextResult;
    // Has no "status" → treated as plain text
    expect("status" in result).toBe(false);
    expect(result.message).toBe(raw);
  });

  it("handles empty string — returns PlainTextResult with empty message", () => {
    const result = parseAgentResponse("") as PlainTextResult;
    expect(result.message).toBe("");
  });

  it("handles JSON null — wraps as PlainTextResult", () => {
    const result = parseAgentResponse("null") as PlainTextResult;
    expect(result.message).toBe("null");
    expect("status" in result).toBe(false);
  });

  it("handles JSON number — wraps as PlainTextResult", () => {
    const result = parseAgentResponse("42") as PlainTextResult;
    expect(result.message).toBe("42");
  });

  // ── formatChatSuccess integration ─────────────────────────────────────────

  it("formatChatSuccess with needs_input JSON exposes structured result — no string wrapper", () => {
    const raw = JSON.stringify({
      status:          "needs_input",
      intent:          "update_campaign",
      message:         "Please provide the campaign ID.",
      required_fields: ["campaign_id OR campaign_name"],
      optional_fields: ["subject"],
    });
    const payload = formatChatSuccess("sess-1", raw);
    // result must be a native object, not a string
    expect(typeof payload.result).toBe("object");
    expect((payload.result as NeedsInputResult).status).toBe("needs_input");
    expect((payload.result as NeedsInputResult).intent).toBe("update_campaign");
    // The old `response` field must not exist
    expect("response" in payload).toBe(false);
  });

  it("formatChatSuccess with success JSON exposes structured result", () => {
    const raw = JSON.stringify({
      status:  "success",
      intent:  "update_campaign",
      message: "update the campaign completed successfully.",
      data:    { id: "123" },
    });
    const payload = formatChatSuccess("sess-2", raw, { data: { id: "123" }, isToolError: false });
    expect((payload.result as SuccessResult).status).toBe("success");
    expect((payload.result as SuccessResult).data).toEqual({ id: "123" });
    // toolResult still present alongside result
    expect(payload.toolResult?.isToolError).toBe(false);
  });

  it("formatChatSuccess with plain text produces PlainTextResult", () => {
    const text = "I can help you with campaigns, analytics, and more.";
    const payload = formatChatSuccess("sess-3", text);
    expect("status" in payload.result).toBe(false);
    expect((payload.result as PlainTextResult).message).toBe(text);
  });

  it("formatChatSuccess with malformed JSON falls back to PlainTextResult", () => {
    const broken = '{ "status": "success" BROKEN }';
    const payload = formatChatSuccess("sess-4", broken);
    expect("status" in payload.result).toBe(false);
    expect((payload.result as PlainTextResult).message).toBe(broken);
  });
});
