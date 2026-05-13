/**
 * src/graph/__tests__/phase3Intelligence.workflow.test.ts
 *
 * Integration tests for Phase 3 AI company intelligence intents flowing
 * through the compiled LangGraph agent graph (fetch → chained MCP tools).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockDetectPlan, mockExecuteFromState } = vi.hoisted(() => ({
  mockDetectPlan:       vi.fn(),
  mockExecuteFromState: vi.fn(),
}));

vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService:   () => undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));
vi.mock("../../services/planner.service.js", () => ({
  plannerService: { detectPlan: mockDetectPlan },
}));
vi.mock("../../services/toolExecution.service.js", () => ({
  toolExecutionService: { executeFromState: mockExecuteFromState },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { agentGraph }               from "../workflow/agent.workflow.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type GraphInput = Partial<AgentGraphStateType>;

async function run(userMessage: string, extra: GraphInput = {}) {
  return agentGraph.invoke({ userMessage, messages: [], ...extra });
}

function toolResult(data: Record<string, unknown>) {
  return { isToolError: false, data };
}

function parseResponse(state: AgentGraphStateType): Record<string, unknown> {
  try {
    return JSON.parse(state.finalResponse ?? "{}") as Record<string, unknown>;
  } catch {
    return { message: state.finalResponse };
  }
}

const FETCH_OK = {
  url:            "https://acme.com",
  content:        "A".repeat(200),
  contentLength:  200,
  source:         "jina",
  success:        true,
};

function phase3MockImplementation(state: AgentGraphStateType) {
  const t = state.toolName;
  if (t === "fetch_website_content") {
    return Promise.resolve({
      toolResult: toolResult(FETCH_OK),
      error: undefined,
    });
  }
  if (t === "extract_company_profile") {
    return Promise.resolve({
      toolResult: toolResult({
        companyName:       "Acme",
        industry:          "Technology",
        businessSummary:   "Cloud widgets for teams.",
        productsServices:  ["Widgets", "API"],
        targetCustomers:   "Mid-market SaaS",
        confidence:        82,
        score:             72,
        category:          "warm",
        painPoints:        [],
        aiGenerated:       true,
      }),
      error: undefined,
    });
  }
  if (t === "detect_pain_points") {
    return Promise.resolve({
      toolResult: toolResult({
        painPoints: [
          { title: "Operational scale", description: "Growing coordination needs.", confidence: "high" },
        ],
        aiGenerated: true,
      }),
      error: undefined,
    });
  }
  if (t === "classify_industry") {
    return Promise.resolve({
      toolResult: toolResult({ industry: "Technology", confidence: "high" }),
      error: undefined,
    });
  }
  if (t === "score_lead") {
    return Promise.resolve({
      toolResult: toolResult({ score: 65, priority: "warm", reasons: ["Company name available"] }),
      error: undefined,
    });
  }
  if (t === "generate_outreach_draft") {
    return Promise.resolve({
      toolResult: toolResult({
        subject:               "Quick idea for Acme",
        emailBody:             "Hi,\n\nWe help teams like yours.\n\nBest",
        tone:                  "professional",
        personalizationUsed: ["pain point"],
        aiGenerated:           true,
      }),
      error: undefined,
    });
  }
  return Promise.resolve({ toolResult: toolResult({}), error: undefined });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
  mockExecuteFromState.mockImplementation(phase3MockImplementation);
});

// ── analyze_company chain ─────────────────────────────────────────────────────

describe("Phase 3 — analyze_company chains fetch → extract_company_profile", () => {
  it("calls fetch_website_content first, then extract_company_profile", async () => {
    await run("analyze company https://acme.com");

    expect(mockExecuteFromState.mock.calls.length).toBeGreaterThanOrEqual(2);
    const names = mockExecuteFromState.mock.calls.map(
      (c) => (c[0] as AgentGraphStateType).toolName,
    );
    expect(names[0]).toBe("fetch_website_content");
    expect(names).toContain("extract_company_profile");
  });

  it("after fetch success, schedules extract_company_profile", async () => {
    const state = await run("analyze company https://acme.com");
    expect(state.toolName).toBe("extract_company_profile");
  });

  it("final response shows Company Intelligence Summary, not raw fetch summary", async () => {
    const state = await run("analyze company OpenAI using website https://openai.com");
    const resp = parseResponse(state);
    const msg = resp.message as string;
    expect(msg).toContain("Company Intelligence Summary");
    expect(msg).not.toContain("Website content fetched");
    expect(msg.split("\n").length).toBeGreaterThan(3);
    expect(() => JSON.parse(msg)).toThrow();
    const data = resp.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("painPoints");
    expect(data).toHaveProperty("leadScore");
  });

  it("returns needs_input when no URL is provided", async () => {
    const state = await run("analyze company");

    expect(state.toolName).toBeUndefined();
    const resp = parseResponse(state);
    expect(resp.status).toBe("needs_input");
    expect(typeof resp.message).toBe("string");
  });
});

// ── detect_pain_points chain ───────────────────────────────────────────────────

describe("Phase 3 — detect_pain_points chains fetch → detect_pain_points", () => {
  it("calls fetch then detect_pain_points", async () => {
    await run("detect pain points https://acme.com");

    expect(mockExecuteFromState.mock.calls.length).toBeGreaterThanOrEqual(2);
    const names = mockExecuteFromState.mock.calls.map(
      (c) => (c[0] as AgentGraphStateType).toolName,
    );
    expect(names[0]).toBe("fetch_website_content");
    expect(names).toContain("detect_pain_points");
  });

  it("final message describes pain points, not website fetch summary", async () => {
    const state = await run("detect pain points for OpenAI using https://openai.com");
    const resp = parseResponse(state);
    const msg = resp.message as string;
    expect(msg.toLowerCase()).toMatch(/pain/);
    expect(msg).not.toContain("Website content fetched");
  });

  it("returns needs_input when neither URL nor content is provided", async () => {
    const state = await run("find pain points");

    const resp = parseResponse(state);
    expect(resp.status).toBe("needs_input");
  });
});

// ── generate_outreach chain (URL path) ─────────────────────────────────────────

describe("Phase 3 — generate_outreach chains fetch → detect → draft", () => {
  it("calls fetch_website_content then detect_pain_points then generate_outreach_draft when URL present", async () => {
    await run("generate outreach for Stripe using stripe.com");

    expect(mockExecuteFromState.mock.calls.length).toBe(3);
    const names = mockExecuteFromState.mock.calls.map(
      (c) => (c[0] as AgentGraphStateType).toolName,
    );
    expect(names).toEqual([
      "fetch_website_content",
      "detect_pain_points",
      "generate_outreach_draft",
    ]);
  });

  it("final response shows draft subject/body, not fetch summary", async () => {
    const state = await run("generate outreach for Stripe using stripe.com");
    const resp = parseResponse(state);
    const msg = resp.message as string;
    expect(msg).toContain("Outreach Draft");
    expect(msg).toContain("Quick idea for Acme");
    expect(msg).not.toContain("Website content fetched");
  });
});

// ── generate_outreach (company-only, no URL) ───────────────────────────────────

describe("Phase 3 — generate_outreach without URL", () => {
  it("dispatches generate_outreach_draft directly when only company name is present", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: toolResult({
        subject:               "Helping Acme Corp grow",
        emailBody:             "Hi,\n\nWe help SaaS companies like Acme.\n\nBest",
        tone:                  "professional",
        personalizationUsed: ["industry", "pain point"],
        aiGenerated:           true,
      }),
      error: undefined,
    });

    const state = await run("generate outreach email for Acme Corp");

    expect(state.agentDomain).toBe("enrichment");
    expect(state.toolName).toBe("generate_outreach_draft");
    expect(mockExecuteFromState).toHaveBeenCalledTimes(1);
    const args = state.toolArgs as Record<string, unknown>;
    expect(args.companyName).toBe("Acme Corp");
    expect(args.industry).toBe("Unknown");
    expect(Array.isArray(args.painPoints)).toBe(true);
  });

  it("returns needs_input when no company name is detectable", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: toolResult({}),
      error: undefined,
    });

    const state = await run("generate outreach");

    const resp = parseResponse(state);
    expect(resp.status).toBe("needs_input");
    expect(typeof resp.message).toBe("string");
  });
});

// ── JSON envelope hygiene ───────────────────────────────────────────────────────

describe("Phase 3 — response envelope", () => {
  it("message field is markdown prose, not nested JSON", async () => {
    const state = await run("analyze company https://acme.com");
    const resp = parseResponse(state);
    expect(typeof resp.message).toBe("string");
    expect(() => JSON.parse(resp.message as string)).toThrow();
  });
});
