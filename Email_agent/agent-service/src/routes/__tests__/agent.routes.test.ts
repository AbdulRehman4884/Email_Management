/**
 * src/routes/__tests__/agent.routes.test.ts
 *
 * HTTP integration tests for /api/agent/* routes.
 *
 * These tests exercise the full Express middleware stack:
 *   requireAuth → Zod body validation → controller → sendSuccess/sendFailure
 *
 * Unlike the middleware and controller unit tests, nothing is mocked at the
 * module level except the heavy services that hit external systems.
 *
 * Prerequisites
 * ─────────────
 * supertest must be installed:
 *   npm install --save-dev supertest @types/supertest
 *
 * The agent-service .env file is loaded automatically by env.ts (dotenv/config),
 * so JWT_SECRET and other required vars are available to the running app.
 *
 * Section map
 * ───────────
 *   A. Authentication gate — all routes
 *   B. POST /api/agent/chat — validation
 *   C. POST /api/agent/chat — success + approval paths
 *   D. POST /api/agent/confirm — validation
 *   E. POST /api/agent/cancel — validation
 *   F. Error response envelope shape
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

// ── Hoisted mock functions ────────────────────────────────────────────────────

const { mockAgentInvoke, mockFindById, mockConfirm, mockMarkExecuted, mockCancel, mockToolExecute } =
  vi.hoisted(() => ({
    mockAgentInvoke:  vi.fn(),
    mockFindById:     vi.fn(),
    mockConfirm:      vi.fn(),
    mockMarkExecuted: vi.fn(),
    mockCancel:       vi.fn(),
    mockToolExecute:  vi.fn(),
  }));

// ── Module mocks ──────────────────────────────────────────────────────────────
// Registered before the app import so they are in place during route setup.

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
  planExecutionService: { resumePlan: vi.fn() },
}));

vi.mock("../../services/auditLog.service.js", () => ({
  auditLogService: {
    chatReceived:          vi.fn(),
    confirmReceived:       vi.fn(),
    pendingActionExecuted: vi.fn(),
  },
}));

// ── App + env import (after mocks) ────────────────────────────────────────────

import { app }  from "../../app.js";
import { env }  from "../../config/env.js";
import { ErrorCode } from "../../lib/errors.js";

// ── Token helpers ─────────────────────────────────────────────────────────────

function signToken(payload: Record<string, unknown> = {}, expiresIn = "1h"): string {
  return jwt.sign(
    { sub: "test-user-1", email: "test@example.com", ...payload },
    env.JWT_SECRET,
    { expiresIn } as jwt.SignOptions,
  );
}

function signExpiredToken(): string {
  return jwt.sign(
    { sub: "user-1" },
    env.JWT_SECRET,
    { expiresIn: "-1s" } as jwt.SignOptions,
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeGraphResult(overrides = {}) {
  return {
    finalResponse:    "Here is your answer.",
    requiresApproval: false,
    pendingActionId:  undefined,
    toolResult:       undefined,
    ...overrides,
  };
}

function makePendingAction(overrides = {}) {
  return {
    id:          "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    userId:      "test-user-1",
    sessionId:   "11111111-1111-1111-1111-111111111111",
    intent:      "start_campaign",
    toolName:    "start_campaign",
    toolArgs:    { campaignId: "c1" },
    status:      "pending",
    createdAt:   "2026-01-01T00:00:00.000Z",
    expiresAt:   "2026-01-01T00:10:00.000Z",
    planContext: undefined,
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();

  mockAgentInvoke.mockResolvedValue(makeGraphResult());
  mockFindById.mockResolvedValue(makePendingAction());
  mockConfirm.mockResolvedValue(makePendingAction({ status: "confirmed" }));
  mockMarkExecuted.mockResolvedValue(undefined);
  mockCancel.mockResolvedValue(makePendingAction({ status: "cancelled" }));
  mockToolExecute.mockResolvedValue({
    toolResult: { data: { ok: true }, isToolError: false },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A. Authentication gate
// ═════════════════════════════════════════════════════════════════════════════

describe("A. Authentication gate — all agent routes", () => {

  const PROTECTED_ROUTES = [
    { method: "post", path: "/api/agent/chat",    body: { message: "hello" } },
    { method: "post", path: "/api/agent/confirm", body: { pendingActionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
    { method: "post", path: "/api/agent/cancel",  body: { pendingActionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
  ] as const;

  for (const route of PROTECTED_ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path} returns 401 when Authorization header is absent`, async () => {
      const res = await (request(app) as any)[route.method](route.path).send(route.body);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ErrorCode.AUTH_MISSING_TOKEN);
    });

    it(`${route.method.toUpperCase()} ${route.path} returns 401 with wrong scheme (Token vs Bearer)`, async () => {
      const res = await (request(app) as any)[route.method](route.path)
        .set("Authorization", `Token ${signToken()}`)
        .send(route.body);
      expect(res.status).toBe(401);
    });

    it(`${route.method.toUpperCase()} ${route.path} returns 401 for expired token`, async () => {
      const res = await (request(app) as any)[route.method](route.path)
        .set("Authorization", `Bearer ${signExpiredToken()}`)
        .send(route.body);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ErrorCode.AUTH_EXPIRED_TOKEN);
    });

    it(`${route.method.toUpperCase()} ${route.path} returns 401 for malformed token`, async () => {
      const res = await (request(app) as any)[route.method](route.path)
        .set("Authorization", "Bearer not.a.valid.jwt.token.at.all")
        .send(route.body);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
    });
  }

  it("POST /api/agent/chat accepts a valid Bearer token and reaches the controller", async () => {
    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${signToken()}`)
      .send({ message: "Hello" });

    // 200 means auth passed and the controller ran
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("accepts a token issued with only userId (no sub) — backwards compatibility", async () => {
    // Tokens generated before the sub-claim fix contained { userId, email, role }
    const legacyToken = jwt.sign(
      { userId: 99, email: "legacy@example.com", role: "user" },
      env.JWT_SECRET,
      { expiresIn: "1h" } as jwt.SignOptions,
    );

    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${legacyToken}`)
      .send({ message: "Hello" });

    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. POST /api/agent/chat — body validation
// ═════════════════════════════════════════════════════════════════════════════

describe("B. POST /api/agent/chat — body validation", () => {

  let token: string;
  beforeAll(() => { token = signToken(); });

  it("returns 400 when message is missing", async () => {
    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("returns 400 when message is an empty string", async () => {
    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("returns 400 when message exceeds 4000 characters", async () => {
    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "x".repeat(4001) });

    expect(res.status).toBe(400);
  });

  it("returns 400 when sessionId is not a valid UUID", async () => {
    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Hi", sessionId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for non-JSON body", async () => {
    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .send("not json at all {{");

    expect(res.status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. POST /api/agent/chat — success and approval paths
// ═════════════════════════════════════════════════════════════════════════════

describe("C. POST /api/agent/chat — response shapes", () => {

  let token: string;
  beforeAll(() => { token = signToken(); });

  it("returns { success:true, data: { approvalRequired:false, sessionId, result } } on normal response", async () => {
    mockAgentInvoke.mockResolvedValue(makeGraphResult({ finalResponse: "Campaign paused." }));

    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Pause campaign" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.approvalRequired).toBe(false);
    expect(res.body.data.sessionId).toBeDefined();
    expect(res.body.data.result).toBeDefined();
  });

  it("returns approvalRequired:true with pendingAction shape when graph flags risky action", async () => {
    mockAgentInvoke.mockResolvedValue(
      makeGraphResult({
        requiresApproval: true,
        pendingActionId:  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        finalResponse:    "Confirm to start.",
      }),
    );

    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Start campaign" });

    expect(res.status).toBe(200);
    expect(res.body.data.approvalRequired).toBe(true);
    expect(res.body.data.pendingAction.id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(res.body.data.pendingAction.expiresAt).toBeDefined();
  });

  it("response always contains a requestId field", async () => {
    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Help" });

    expect(res.body.requestId).toBeDefined();
  });

  it("uses the provided sessionId instead of generating one", async () => {
    const SESSION = "22222222-2222-2222-2222-222222222222";

    await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Hello", sessionId: SESSION });

    expect(mockAgentInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION }),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. POST /api/agent/confirm — validation
// ═════════════════════════════════════════════════════════════════════════════

describe("D. POST /api/agent/confirm — validation", () => {

  let token: string;
  beforeAll(() => { token = signToken(); });

  it("returns 400 when pendingActionId is missing", async () => {
    const res = await request(app)
      .post("/api/agent/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("returns 400 when pendingActionId is not a UUID", async () => {
    const res = await request(app)
      .post("/api/agent/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ pendingActionId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns 200 on a valid confirm request", async () => {
    const res = await request(app)
      .post("/api/agent/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ pendingActionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. POST /api/agent/cancel — validation
// ═════════════════════════════════════════════════════════════════════════════

describe("E. POST /api/agent/cancel — validation", () => {

  let token: string;
  beforeAll(() => { token = signToken(); });

  it("returns 400 when pendingActionId is missing", async () => {
    const res = await request(app)
      .post("/api/agent/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 when pendingActionId is not a UUID", async () => {
    const res = await request(app)
      .post("/api/agent/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({ pendingActionId: "bad-id" });

    expect(res.status).toBe(400);
  });

  it("returns 200 with cancelled:true on a valid cancel", async () => {
    const res = await request(app)
      .post("/api/agent/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({ pendingActionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });

    expect(res.status).toBe(200);
    expect(res.body.data.cancelled).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. Error response envelope shape
// ═════════════════════════════════════════════════════════════════════════════

describe("F. API failure envelope shape", () => {

  it("all 401 responses conform to { success:false, error: { code, message }, requestId }", async () => {
    const res = await request(app)
      .post("/api/agent/chat")
      .send({ message: "Hello" }); // no auth header

    expect(res.body).toMatchObject({
      success: false,
      error: {
        code:    expect.any(String),
        message: expect.any(String),
      },
      requestId: expect.any(String),
    });
  });

  it("all 400 responses conform to the same envelope shape", async () => {
    const token = signToken();

    const res = await request(app)
      .post("/api/agent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.body).toMatchObject({
      success:   false,
      error:     { code: expect.any(String), message: expect.any(String) },
      requestId: expect.any(String),
    });
  });

  it("404 for unknown routes returns the standard error envelope", async () => {
    // Use a path that is NOT under /api/agent/* so requireAuth is not invoked
    // before the notFound handler can respond.
    const res = await request(app).get("/completely-unknown-path");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
