/**
 * src/tests/services/websiteFetch.service.test.ts
 *
 * Tests the websiteFetch.service in isolation.
 *
 * Covers:
 *   1. Successful Jina fetch     → success=true, source="jina"
 *   2. Unreachable website       → all sources fail, success=false
 *   3. Timeout handling          → Jina times out, tries Firecrawl, then fails
 *   4. Empty content fallback    → Jina returns empty, falls through to Firecrawl
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Env mock ──────────────────────────────────────────────────────────────────

const mockEnv = vi.hoisted(() => ({
  LOG_LEVEL:         "silent" as string,
  LOG_PRETTY:        false,
  NODE_ENV:          "test" as const,
  ABSTRACT_API_KEY:  undefined as string | undefined,
  JINA_API_KEY:      undefined as string | undefined,
  FIRECRAWL_API_KEY: undefined as string | undefined,
}));

vi.mock("../../config/env.js", () => ({ env: mockEnv }));

import { fetchWebsiteContent } from "../../services/enrichment/websiteFetch.service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function jinaSuccessResponse(content = "Acme Corp makes software.", title = "Acme") {
  return {
    data: { title, content, url: "https://acme.com" },
  };
}

function firecrawlSuccessResponse(markdown = "Acme Corp builds great tools.", title = "Acme") {
  return {
    data: { metadata: { title }, markdown },
  };
}

function mockFetch(responses: Array<{ ok: boolean; json?: () => Promise<unknown>; rejectWith?: Error }>) {
  let callIndex = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
    const spec = responses[callIndex++] ?? responses[responses.length - 1]!;
    if (spec.rejectWith) return Promise.reject(spec.rejectWith);
    return Promise.resolve({ ok: spec.ok, json: spec.json ?? (() => Promise.resolve({})) });
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("websiteFetch.service", () => {
  beforeEach(() => {
    mockEnv.JINA_API_KEY      = undefined;
    mockEnv.FIRECRAWL_API_KEY = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Jina Reader primary path ────────────────────────────────────────────────

  it("1. returns content when Jina Reader succeeds", async () => {
    mockFetch([{
      ok:   true,
      json: async () => jinaSuccessResponse("Acme builds amazing software.", "Acme Corp"),
    }]);

    const result = await fetchWebsiteContent("https://acme.com");

    expect(result.success).toBe(true);
    expect(result.source).toBe("jina");
    expect(result.title).toBe("Acme Corp");
    expect(result.content).toContain("Acme");
    expect(result.contentLength).toBeGreaterThan(0);
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("normalises a URL without protocol before fetching", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => jinaSuccessResponse("content"),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await fetchWebsiteContent("acme.com");

    const calledUrl: string = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("https://acme.com");
  });

  it("caps content at 8 000 characters", async () => {
    const longContent = "x".repeat(20_000);
    mockFetch([{
      ok:   true,
      json: async () => jinaSuccessResponse(longContent),
    }]);

    const result = await fetchWebsiteContent("https://acme.com");
    expect(result.success).toBe(true);
    expect(result.content!.length).toBe(8_000);
    expect(result.contentLength).toBe(20_000);
  });

  // ── Unreachable / failure path ──────────────────────────────────────────────

  it("2. returns success=false when Jina returns non-OK and no Firecrawl key", async () => {
    mockFetch([{ ok: false }]);

    const result = await fetchWebsiteContent("https://unreachable.example");

    expect(result.success).toBe(false);
    expect(result.source).toBe("none");
    expect(result.error).toBeDefined();
  });

  // ── Timeout handling ────────────────────────────────────────────────────────

  it("3. handles Jina timeout and falls back to Firecrawl when key is set", async () => {
    mockEnv.FIRECRAWL_API_KEY = "test-firecrawl-key";

    const timeoutErr = Object.assign(new Error("signal aborted"), { name: "TimeoutError" });
    mockFetch([
      { ok: false, rejectWith: timeoutErr },
      { ok: true, json: async () => firecrawlSuccessResponse("Content from Firecrawl") },
    ]);

    const result = await fetchWebsiteContent("https://acme.com");

    expect(result.success).toBe(true);
    expect(result.source).toBe("firecrawl");
    expect(result.fallbackUsed).toBe(true);
    expect(result.content).toContain("Firecrawl");
  });

  it("returns failure when both Jina times out and no Firecrawl key", async () => {
    const timeoutErr = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    mockFetch([{ ok: false, rejectWith: timeoutErr }]);

    const result = await fetchWebsiteContent("https://acme.com");

    expect(result.success).toBe(false);
    expect(result.source).toBe("none");
  });

  // ── Empty content fallback ──────────────────────────────────────────────────

  it("4. falls through to Firecrawl when Jina returns empty content", async () => {
    mockEnv.FIRECRAWL_API_KEY = "test-firecrawl-key";

    mockFetch([
      // Jina returns empty content
      { ok: true, json: async () => ({ data: { title: "Acme", content: "", url: "https://acme.com" } }) },
      // Firecrawl returns real content
      { ok: true, json: async () => firecrawlSuccessResponse("Real company content") },
    ]);

    const result = await fetchWebsiteContent("https://acme.com");

    expect(result.success).toBe(true);
    expect(result.source).toBe("firecrawl");
    expect(result.fallbackUsed).toBe(true);
  });

  it("returns failure when both Jina and Firecrawl return empty content", async () => {
    mockEnv.FIRECRAWL_API_KEY = "test-firecrawl-key";

    mockFetch([
      { ok: true, json: async () => ({ data: { content: "" } }) },
      { ok: true, json: async () => ({ data: { markdown: "" } }) },
    ]);

    const result = await fetchWebsiteContent("https://acme.com");
    expect(result.success).toBe(false);
    expect(result.source).toBe("none");
  });
});
