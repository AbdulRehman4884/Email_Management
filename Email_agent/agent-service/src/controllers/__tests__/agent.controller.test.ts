/**
 * src/controllers/__tests__/agent.controller.test.ts
 *
 * Unit tests for agent.controller.ts — chat, confirm, and cancel handlers.
 *
 * Strategy
 * ─────────
 * Controllers are thin HTTP adapters: they validate the body, delegate to
 * services, and shape the response.  Heavy dependencies are mocked at the
 * module level so tests run without a database, MCP server, or LLM API.
 *
 * Mocked modules
 * ──────────────
 *   agentGraph             — LangGraph workflow (prevents real LLM calls)
 *   pendingActionService   — approval lifecycle (in-memory; isolated per test)
 *   toolExecutionService   — MCP tool execution
 *   planExecutionService   — multi-step plan resumption
 *   auditLogService        — fire-and-forget audit trail
 *
 * Section map
 * ───────────
 *   A. chat — request body validation
 *   B. chat — successful response (non-approval path)
 *   C. chat — approval-required response
 *   D. chat — error propagation to next()
 *   E. confirm — single-step execution
 *   F. confirm — validation + error paths
 *   G. cancel
 */

import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { AuthContext, UserId, SessionId, RequestId } from "../../types/common.js";

// ── Hoisted mock functions ────────────────────────────────────────────────────

const {
  mockAgentInvoke,
  mockFindById,
  mockConfirm,
  mockMarkExecuted,
  mockCancel,
  mockToolExecute,
  mockResumePlan,
} = vi.hoisted(() => ({
  mockAgentInvoke:   vi.fn(),
  mockFindById:      vi.fn(),
  mockConfirm:       vi.fn(),
  mockMarkExecuted:  vi.fn(),
  mockCancel:        vi.fn(),
  mockToolExecute:   vi.fn(),
  mockResumePlan:    vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../graph/workflow/agent.workflow.js", () => ({
  agentGraph: { invoke: mockAgentInvoke },
}));

vi.mock("../../services/pendingAction.service.js", () => ({
  pendingActionService: {
    findById:     mockFindById,
    confirm:      mockConfirm,
    markExecuted: mockMarkExecuted,
    cancel:       mockCancel,
  },
}));

vi.mock("../../services/toolExecution.service.js", () => ({
  toolExecutionService: { executeFromState: mockToolExecute },
}));

vi.mock("../../services/planExecution.service.js", () => ({
  planExecutionService: { resumePlan: mockResumePlan },
}));

vi.mock("../../services/auditLog.service.js", () => ({
  auditLogService: {
    chatReceived:          vi.fn(),
    confirmReceived:       vi.fn(),
    pendingActionExecuted: vi.fn(),
  },
}));

// ── Subject under test ────────────────────────────────────────────────────────

import { chat, confirm, cancel } from "../agent.controller.js";
import { ErrorCode, ValidationError } from "../../lib/errors.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID  = "user-test-1" as UserId;
const SESSION  = "00000000-0000-0000-0000-000000000001" as SessionId;
const RAW_TOK  = "raw.bearer.token";

function makeAuthCtx(overrides?: Partial<AuthContext>): AuthContext {
  return { userId: USER_ID, email: "test@example.com", rawToken: RAW_TOK, ...overrides };
}

function makeReq(body: unknown = {}, authCtx?: AuthContext): Request {
  return {
    body,
    authContext: authCtx ?? makeAuthCtx(),
    requestId:  "req-test-id" as RequestId,
    headers:    {},
  } as unknown as Request;
}

/** Chainable mock Response; captures statusCode + body for assertions. */
function makeRes() {
  const captured: { statusCode: number; body: unknown } = { statusCode: 0, body: undefined };

  const chainable = { json: vi.fn((b: unknown) => { captured.body = b; }) };
  const res = {
    req:    { requestId: "req-test-id" },
    status: vi.fn((code: number) => { captured.statusCode = code; return chainable; }),
  } as unknown as Response;

  return { res, captured };
}

/** Minimal agentGraph result for the normal (non-approval) path. */
function makeGraphResult(overrides = {}) {
  return {
    finalResponse:    "Here is your answer.",
    requiresApproval: false,
    pendingActionId:  undefined,
    toolResult:       undefined,
    ...overrides,
  };
}

/** Minimal PendingAction fixture. */
function makePendingAction(overrides = {}) {
  return {
    id:        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    userId:    USER_ID,
    sessionId: SESSION,
    intent:    "start_campaign",
    toolName:  "start_campaign",
    toolArgs:  { campaignId: "c1" },
    status:    "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z",
    planContext: undefined,
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();

  // Default graph result — happy path, no approval needed
  mockAgentInvoke.mockResolvedValue(makeGraphResult());

  // Default pending action operations
  mockFindById.mockResolvedValue(makePendingAction());
  mockConfirm.mockResolvedValue(makePendingAction({ status: "confirmed" }));
  mockMarkExecuted.mockResolvedValue(undefined);
  mockCancel.mockResolvedValue(makePendingAction({ status: "cancelled" }));

  // Default tool execution — success
  mockToolExecute.mockResolvedValue({
    toolResult: { data: { ok: true }, isToolError: false },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A. chat — request body validation
// ═════════════════════════════════════════════════════════════════════════════

describe("A. chat — request body validation", () => {

  it("throws ValidationError when message is missing", async () => {
    const next = vi.fn();
    await chat(makeReq({}), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(mockAgentInvoke).not.toHaveBeenCalled();
  });

  it("throws ValidationError when message is an empty string", async () => {
    const next = vi.fn();
    await chat(makeReq({ message: "" }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it("throws ValidationError when message exceeds 4000 characters", async () => {
    const next = vi.fn();
    await chat(makeReq({ message: "x".repeat(4001) }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it("throws ValidationError when sessionId is present but not a valid UUID", async () => {
    const next = vi.fn();
    await chat(makeReq({ message: "Hello", sessionId: "not-a-uuid" }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it("accepts a valid UUID sessionId without error", async () => {
    const next = vi.fn();
    await chat(
      makeReq({ message: "Hello", sessionId: "00000000-0000-0000-0000-000000000002" }),
      makeRes().res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
  });

  it("accepts the maximum allowed message length (4000 chars) without error", async () => {
    const next = vi.fn();
    await chat(makeReq({ message: "a".repeat(4000) }), makeRes().res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockAgentInvoke).toHaveBeenCalledOnce();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. chat — successful response (non-approval path)
// ═════════════════════════════════════════════════════════════════════════════

describe("B. chat — successful chat response", () => {

  it("returns HTTP 200 with success:true on a normal response", async () => {
    const { res, captured } = makeRes();
    await chat(makeReq({ message: "List my campaigns" }), res, vi.fn());

    expect(captured.statusCode).toBe(200);
    expect((captured.body as any).success).toBe(true);
  });

  it("response payload has approvalRequired: false and a result object", async () => {
    const { res, captured } = makeRes();
    await chat(makeReq({ message: "List my campaigns" }), res, vi.fn());

    const data = (captured.body as any).data;
    expect(data.approvalRequired).toBe(false);
    expect(data.result).toBeDefined();
    expect(data.sessionId).toBeDefined();
  });

  it("invokes agentGraph with the user message and userId from authContext", async () => {
    await chat(makeReq({ message: "Show stats" }), makeRes().res, vi.fn());

    expect(mockAgentInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: "Show stats",
        userId:      USER_ID,
        rawToken:    RAW_TOK,
      }),
    );
  });

  it("uses provided sessionId instead of generating a new one", async () => {
    const SESSION_ID = "11111111-1111-1111-1111-111111111111";
    await chat(makeReq({ message: "Hello", sessionId: SESSION_ID }), makeRes().res, vi.fn());

    expect(mockAgentInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it("includes toolResult in response when graph produced a tool result", async () => {
    const toolResult = { data: { campaignId: "c1", status: "active" }, isToolError: false };
    mockAgentInvoke.mockResolvedValue(makeGraphResult({ toolResult }));

    const { res, captured } = makeRes();
    await chat(makeReq({ message: "Pause campaign" }), res, vi.fn());

    const data = (captured.body as any).data;
    expect(data.toolResult).toBeDefined();
    expect(data.toolResult.isToolError).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. chat — approval-required response
// ═════════════════════════════════════════════════════════════════════════════

describe("C. chat — approval-required path", () => {

  it("returns approvalRequired: true when graph flags a risky action", async () => {
    mockAgentInvoke.mockResolvedValue(
      makeGraphResult({
        requiresApproval: true,
        pendingActionId:  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        finalResponse:    "Please confirm to start the campaign.",
      }),
    );

    const { res, captured } = makeRes();
    await chat(makeReq({ message: "Start campaign" }), res, vi.fn());

    const data = (captured.body as any).data;
    expect(data.approvalRequired).toBe(true);
    expect(data.pendingAction).toBeDefined();
    expect(data.pendingAction.id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("fetches the pending action from store to include expiresAt", async () => {
    mockAgentInvoke.mockResolvedValue(
      makeGraphResult({
        requiresApproval: true,
        pendingActionId:  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    );

    await chat(makeReq({ message: "Start campaign" }), makeRes().res, vi.fn());

    expect(mockFindById).toHaveBeenCalledWith("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("calls next(AppError 500) when pendingActionId is set but findById returns undefined", async () => {
    mockAgentInvoke.mockResolvedValue(
      makeGraphResult({ requiresApproval: true, pendingActionId: "some-id" }),
    );
    mockFindById.mockResolvedValue(undefined); // simulate store miss

    const next = vi.fn();
    await chat(makeReq({ message: "Start campaign" }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, code: ErrorCode.INTERNAL_ERROR }),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. chat — error propagation
// ═════════════════════════════════════════════════════════════════════════════

describe("D. chat — error propagation to next()", () => {

  it("forwards agentGraph errors to next(err) — not swallowed", async () => {
    const boom = new Error("graph internal failure");
    mockAgentInvoke.mockRejectedValue(boom);
    const next = vi.fn();

    await chat(makeReq({ message: "Hello" }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });

  it("does not call res.status on unhandled errors — lets errorHandler respond", async () => {
    mockAgentInvoke.mockRejectedValue(new Error("crash"));
    const { res, captured } = makeRes();

    await chat(makeReq({ message: "Hello" }), res, vi.fn());

    expect(captured.statusCode).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. confirm — single-step execution
// ═════════════════════════════════════════════════════════════════════════════

describe("E. confirm — single-step execution", () => {

  const VALID_BODY = { pendingActionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };

  it("returns HTTP 200 success on confirmed action execution", async () => {
    const { res, captured } = makeRes();
    await confirm(makeReq(VALID_BODY), res, vi.fn());

    expect(captured.statusCode).toBe(200);
    expect((captured.body as any).success).toBe(true);
  });

  it("atomically confirms the action before executing the tool", async () => {
    await confirm(makeReq(VALID_BODY), makeRes().res, vi.fn());

    // confirm() must be called before executeFromState()
    const confirmOrder  = (mockConfirm     as Mock).mock.invocationCallOrder[0];
    const executeOrder  = (mockToolExecute as Mock).mock.invocationCallOrder[0];
    expect(confirmOrder).toBeLessThan(executeOrder!);
  });

  it("calls markExecuted after tool run even when tool returns an error flag", async () => {
    mockToolExecute.mockResolvedValue({
      toolResult: { data: "Campaign not found", isToolError: true },
    });

    await confirm(makeReq(VALID_BODY), makeRes().res, vi.fn());

    expect(mockMarkExecuted).toHaveBeenCalledWith("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("returns workflow error response (not 5xx) when tool run returns state.error", async () => {
    mockToolExecute.mockResolvedValue({ error: "MCP timeout" });

    const { res, captured } = makeRes();
    await confirm(makeReq(VALID_BODY), res, vi.fn());

    expect(captured.statusCode).toBe(200); // still 200 — workflow error surfaced in body
    const data = (captured.body as any).data;
    expect(data.error).toBe(true);
    expect(data.response).toContain("MCP timeout");
  });

  it("forwards unexpected errors from confirm() to next(err)", async () => {
    mockConfirm.mockRejectedValue(new Error("store failure"));
    const next = vi.fn();

    await confirm(makeReq(VALID_BODY), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. confirm — validation
// ═════════════════════════════════════════════════════════════════════════════

describe("F. confirm — request body validation", () => {

  it("returns friendly 'no pending action' response when body is empty (no 400)", async () => {
    // Previously returned 400; now returns a soft workflow error so the
    // frontend can handle a stale confirm without crashing.
    const { res, captured } = makeRes();
    await confirm(makeReq({}), res, vi.fn());

    expect(captured.statusCode).toBe(200);
    const data = (captured.body as any).data;
    expect(data.error).toBe(true);
    expect(data.response).toMatch(/no pending action/i);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("throws ValidationError when pendingActionId is present but not a UUID", async () => {
    const next = vi.fn();
    await confirm(makeReq({ pendingActionId: "not-a-uuid" }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it("accepts a valid UUID pendingActionId without error", async () => {
    const next = vi.fn();
    await confirm(
      makeReq({ pendingActionId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
      makeRes().res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
  });

  it("accepts actionId as an alternative field name (frontend compatibility)", async () => {
    const { res, captured } = makeRes();
    await confirm(
      makeReq({ actionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
      res,
      vi.fn(),
    );

    expect(captured.statusCode).toBe(200);
    expect(mockConfirm).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      USER_ID,
    );
  });

  it("throws ValidationError when actionId is present but not a UUID", async () => {
    const next = vi.fn();
    await confirm(makeReq({ actionId: "bad-id" }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. cancel
// ═════════════════════════════════════════════════════════════════════════════

describe("G. cancel", () => {

  const VALID_BODY = { pendingActionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };

  it("returns HTTP 200 with cancelled: true on success", async () => {
    const { res, captured } = makeRes();
    await cancel(makeReq(VALID_BODY), res, vi.fn());

    expect(captured.statusCode).toBe(200);
    const data = (captured.body as any).data;
    expect(data.cancelled).toBe(true);
  });

  it("calls pendingActionService.cancel with the pendingActionId and userId", async () => {
    await cancel(makeReq(VALID_BODY), makeRes().res, vi.fn());

    expect(mockCancel).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      USER_ID,
    );
  });

  it("returns HTTP 200 cancelled:true when body is empty — nothing to cancel (no 400)", async () => {
    // Previously returned 400; now returns a benign success so the
    // frontend can call cancel safely without tracking the action ID locally.
    const { res, captured } = makeRes();
    await cancel(makeReq({}), res, vi.fn());

    expect(captured.statusCode).toBe(200);
    expect((captured.body as any).data.cancelled).toBe(true);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("throws ValidationError when pendingActionId is present but not a UUID", async () => {
    const next = vi.fn();
    await cancel(makeReq({ pendingActionId: "bad-id" }), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it("accepts actionId as an alternative field name (frontend compatibility)", async () => {
    const { res, captured } = makeRes();
    await cancel(
      makeReq({ actionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
      res,
      vi.fn(),
    );

    expect(captured.statusCode).toBe(200);
    expect(mockCancel).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      USER_ID,
    );
  });

  it("forwards cancel() errors to next(err)", async () => {
    mockCancel.mockRejectedValue(new Error("conflict"));
    const next = vi.fn();

    await cancel(makeReq(VALID_BODY), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
