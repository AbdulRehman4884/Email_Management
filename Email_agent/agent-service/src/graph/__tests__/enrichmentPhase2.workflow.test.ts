/**
 * src/graph/__tests__/enrichmentPhase2.workflow.test.ts
 *
 * Integration tests for Phase 2 company search intents flowing through the
 * compiled LangGraph agent graph.
 *
 * Covers routing, extraction, all five source states, and regression safety.
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

import { agentGraph } from "../workflow/agent.workflow.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type GraphInput = Partial<AgentGraphStateType>;

async function run(userMessage: string, extra: GraphInput = {}) {
  return agentGraph.invoke({ userMessage, messages: [], ...extra });
}

function toolResult(data: Record<string, unknown>) {
  return { isToolError: false, data };
}

function searchResult(
  source: "duckduckgo" | "no_results" | "rate_limited" | "search_failed" | "timeout",
  candidates: Array<{ title: string; url: string; snippet: string }> = [],
  extra: Record<string, unknown> = {},
) {
  const success = source === "duckduckgo" || source === "no_results";
  return toolResult({
    companyName: "Acme Corp",
    query:       '"Acme Corp" official website',
    candidates,
    source,
    count:       candidates.length,
    success,
    ...extra,
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
  mockExecuteFromState.mockResolvedValue({
    toolResult: toolResult({}),
    error: undefined,
  });
});

// ── Company name / location extraction ───────────────────────────────────────

describe("Phase 2 — search_company_web: extraction", () => {
  it("strips 'find official website of' → companyName='Acme Corp'", async () => {
    const state = await run("find official website of Acme Corp");
    expect((state.toolArgs as Record<string, unknown>)?.companyName).toBe("Acme Corp");
  });

  it("strips 'search company website for' → companyName='AK Traders', location='Pakistan'", async () => {
    const state = await run("Search company website for AK Traders Pakistan");
    expect((state.toolArgs as Record<string, unknown>)?.companyName).toBe("AK Traders");
    expect((state.toolArgs as Record<string, unknown>)?.location).toBe("Pakistan");
  });

  it("strips 'find official website of' → companyName='Delta Prime AI Solutions' (no location)", async () => {
    const state = await run("Find official website of Delta Prime AI Solutions");
    expect((state.toolArgs as Record<string, unknown>)?.companyName).toBe("Delta Prime AI Solutions");
    expect((state.toolArgs as Record<string, unknown>)?.location).toBeUndefined();
  });

  it("handles numbered prefix '1. Search company website for AK Traders Pakistan'", async () => {
    const state = await run("1. Search company website for AK Traders Pakistan");
    expect((state.toolArgs as Record<string, unknown>)?.companyName).toBe("AK Traders");
    expect((state.toolArgs as Record<string, unknown>)?.location).toBe("Pakistan");
  });

  it("handles numbered prefix '3. Find official website of Delta Prime AI Solutions'", async () => {
    const state = await run("3. Find official website of Delta Prime AI Solutions");
    expect((state.toolArgs as Record<string, unknown>)?.companyName).toBe("Delta Prime AI Solutions");
  });
});

// ── search_company_web routing ───────────────────────────────────────────────

describe("Phase 2 — search_company_web workflow", () => {
  it("routes to enrichment domain and dispatches search_company_web tool", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: searchResult("duckduckgo", [{ title: "Acme Corp", url: "https://acme.com", snippet: "" }]),
      error: undefined,
    });

    const state = await run("find official website of Acme Corp");

    expect(state.agentDomain).toBe("enrichment");
    expect(state.toolName).toBe("search_company_web");
  });

  it("returns valid JSON for any company website search message", async () => {
    const state  = await run("search company website");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string };
    expect(["needs_input", "success"]).toContain(parsed.status);
  });
});

// ── source=duckduckgo ────────────────────────────────────────────────────────

describe("Phase 2 — source=duckduckgo", () => {
  it("lists candidates with DuckDuckGo label", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: searchResult("duckduckgo", [{ title: "Acme Corp", url: "https://acme.com", snippet: "Official site" }]),
      error: undefined,
    });

    const state  = await run("find official website of Acme Corp");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string; message: string };

    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("Acme Corp");
    expect(parsed.message).toContain("acme.com");
    expect(parsed.message).toContain("DuckDuckGo");
  });
});

// ── source=no_results ────────────────────────────────────────────────────────

describe("Phase 2 — source=no_results", () => {
  it("shows 'no candidates found' message — no fake links", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: searchResult("no_results"),
      error: undefined,
    });

    const state  = await run("find official website of Acme Corp");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string; message: string };

    expect(parsed.status).toBe("success");
    // Must NOT contain any guessed/fake URLs
    expect(parsed.message).not.toMatch(/https?:\/\/[^\s]+\.com/);
    // Must NOT say "rate-limited"
    expect(parsed.message).not.toContain("rate-limit");
    expect(parsed.message).not.toContain("rate_limited");
  });
});

// ── source=rate_limited ──────────────────────────────────────────────────────

describe("Phase 2 — source=rate_limited", () => {
  it("shows rate-limited message — not 'no candidates found'", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: searchResult("rate_limited", [], { error: "ddg anomaly", retryable: true }),
      error: undefined,
    });

    const state  = await run("find official website of Acme Corp");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string; message: string };

    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("rate-limited");
    // Must NOT say "no candidates found"
    expect(parsed.message).not.toContain("No website candidates");
    // Must NOT contain fake URLs
    expect(parsed.message).not.toMatch(/https?:\/\/[^\s]+\.com/);
  });

  it("tells user to retry after a short pause", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: searchResult("rate_limited", [], { retryable: true }),
      error: undefined,
    });

    const state  = await run("find official website of Acme Corp");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { message: string };

    expect(parsed.message).toContain("retry");
  });
});

// ── source=timeout ───────────────────────────────────────────────────────────

describe("Phase 2 — source=timeout", () => {
  it("shows timeout message", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: searchResult("timeout", [], { retryable: true }),
      error: undefined,
    });

    const state  = await run("find official website of Acme Corp");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string; message: string };

    expect(parsed.status).toBe("success");
    expect(parsed.message.toLowerCase()).toContain("timed out");
    expect(parsed.message).not.toContain("No website candidates");
    expect(parsed.message).not.toContain("rate-limited");
  });
});

// ── source=search_failed ─────────────────────────────────────────────────────

describe("Phase 2 — source=search_failed", () => {
  it("shows search-failed message", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: searchResult("search_failed", [], { retryable: false }),
      error: undefined,
    });

    const state  = await run("find official website of Acme Corp");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string; message: string };

    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("could not be completed");
    expect(parsed.message).not.toContain("No website candidates");
  });
});

// ── select_official_website ──────────────────────────────────────────────────

describe("Phase 2 — select_official_website workflow", () => {
  it("routes and formats the selected URL", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: toolResult({
        companyName:   "Acme Corp",
        selected:      { title: "Acme Corp", url: "https://acme.com", snippet: "", score: 75, selected: true, reasons: [] },
        allCandidates: [{ title: "Acme Corp", url: "https://acme.com", snippet: "", score: 75, selected: true, reasons: [] }],
        selectionMade: true,
      }),
      error: undefined,
    });

    const state  = await run("select official website for Acme Corp from https://acme.com https://acmeinc.com");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string; message: string };

    expect(state.agentDomain).toBe("enrichment");
    expect(state.toolName).toBe("select_official_website");
    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("acme.com");
  });
});

// ── verify_company_website ───────────────────────────────────────────────────

describe("Phase 2 — verify_company_website workflow", () => {
  it("routes and formats the confidence score", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: toolResult({
        url: "https://acme.com", verified: true, confidence: 80,
        signals: ["HTTPS connection", "Domain name matches company name"], warnings: [],
      }),
      error: undefined,
    });

    const state  = await run("verify company website for Acme Corp at https://acme.com");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string; message: string };

    expect(state.agentDomain).toBe("enrichment");
    expect(state.toolName).toBe("verify_company_website");
    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("80");
    expect(parsed.message).toContain("acme.com");
  });

  it("returns needs_input when no URL or company is present", async () => {
    const state  = await run("verify company website");
    const parsed = JSON.parse(state.finalResponse ?? "{}") as { status: string };
    expect(parsed.status).toBe("needs_input");
  });

  it("extracts companyName and URL from 'belongs to' phrasing", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: toolResult({
        url: "https://openai.com", verified: true, confidence: 90,
        signals: ["HTTPS connection", "Domain name matches company name"], warnings: [],
      }),
      error: undefined,
    });

    const state = await run("Verify this website belongs to OpenAI: https://openai.com");

    expect(state.toolName).toBe("verify_company_website");
    expect((state.toolArgs as Record<string, unknown>)?.companyName).toBe("OpenAI");
    expect((state.toolArgs as Record<string, unknown>)?.url).toBe("https://openai.com");
  });
});

// ── Regression ───────────────────────────────────────────────────────────────

describe("Phase 2 — regression: existing flows", () => {
  it("validate_email still routes to enrichment", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: toolResult({
        email: "alice@acme.com", isValid: true, businessEmail: true,
        domain: "acme.com", disposable: false, source: "heuristic",
      }),
      error: undefined,
    });

    const state = await run("validate email alice@acme.com");

    expect(state.agentDomain).toBe("enrichment");
    expect(state.toolName).toBe("validate_email");
  });

  it("campaign intent is not hijacked by enrichment routing", async () => {
    const state = await run("list campaigns");
    expect(state.agentDomain).toBe("campaign");
  });
});
