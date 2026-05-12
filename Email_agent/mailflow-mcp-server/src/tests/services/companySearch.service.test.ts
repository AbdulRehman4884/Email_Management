/**
 * src/tests/services/companySearch.service.test.ts
 *
 * Unit tests for the DuckDuckGo-based company search service.
 * duck-duck-scrape is mocked so no real network calls are made.
 * _sleep is overridden to make retry delays instant.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Hoist mocks ───────────────────────────────────────────────────────────────

const mockDdgSearch = vi.hoisted(() => vi.fn());

vi.mock("duck-duck-scrape", () => ({
  search:         mockDdgSearch,
  SafeSearchType: { STRICT: 0, MODERATE: -1, OFF: -2 },
}));

vi.mock("../../config/env.js", () => ({
  env: { LOG_LEVEL: "silent", LOG_PRETTY: false, NODE_ENV: "test" },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  searchCompanyWeb,
  isSocialDomain,
  SOCIAL_DOMAINS,
  _internals,
} from "../../services/enrichment/companySearch.service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ddgResult(title: string, url: string, description = "") {
  return {
    title, url, description, rawDescription: description,
    icon: "", hostname: new URL(url).hostname,
  };
}

function ddgOk(results: ReturnType<typeof ddgResult>[]) {
  return { noResults: false, vqd: "abc", results };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Make retry delays instant so tests run fast
  _internals.sleep = () => Promise.resolve();
});

afterEach(() => {
  // Restore real sleep (other test files may import the service)
  _internals.sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
});

// ── Tests: success path ───────────────────────────────────────────────────────

describe("searchCompanyWeb — success path", () => {
  it("returns source=duckduckgo with normalized candidates on success", async () => {
    mockDdgSearch.mockResolvedValue(ddgOk([
      ddgResult("Acme Corp",  "https://acme.com",     "Official site of Acme Corporation"),
      ddgResult("Acme Blog",  "https://acmeblog.com", "Blog about Acme products"),
    ]));

    const r = await searchCompanyWeb("Acme Corp");

    expect(r.source).toBe("duckduckgo");
    expect(r.success).toBe(true);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]).toMatchObject({ title: "Acme Corp", url: "https://acme.com" });
    expect(r.count).toBe(2);
    expect(r.query).toContain("Acme Corp");
  });

  it("passes location/country into the search query", async () => {
    mockDdgSearch.mockResolvedValue(ddgOk([
      ddgResult("AK Traders", "https://aktraders.pk", "AK Traders Pakistan"),
    ]));

    await searchCompanyWeb("AK Traders", { country: "Pakistan" });

    expect(mockDdgSearch).toHaveBeenCalledWith(
      expect.stringContaining("Pakistan"),
      expect.any(Object),
    );
  });

  it("filters out social / directory domains from results", async () => {
    mockDdgSearch.mockResolvedValue(ddgOk([
      ddgResult("AK Traders on LinkedIn", "https://linkedin.com/company/ak-traders", ""),
      ddgResult("AK Traders",             "https://aktraders.pk",                    "Official site"),
    ]));

    const { candidates } = await searchCompanyWeb("AK Traders");

    expect(candidates.every((c) => !c.url.includes("linkedin.com"))).toBe(true);
    expect(candidates).toHaveLength(1);
  });

  it("strips HTML bold tags from DDG description", async () => {
    mockDdgSearch.mockResolvedValue(ddgOk([
      ddgResult("Acme", "https://acme.com", "<b>Acme</b> official site — <b>trusted</b>"),
    ]));

    const { candidates } = await searchCompanyWeb("Acme");
    expect(candidates[0]!.snippet).toBe("Acme official site — trusted");
  });

  it("respects maxResults option", async () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      ddgResult(`Site ${i}`, `https://site${i}.com`, ""),
    );
    mockDdgSearch.mockResolvedValue(ddgOk(many));

    const { candidates } = await searchCompanyWeb("Big Corp", { maxResults: 3 });
    expect(candidates).toHaveLength(3);
  });
});

// ── Tests: no_results ─────────────────────────────────────────────────────────

describe("searchCompanyWeb — no_results", () => {
  it("returns source=no_results when DDG returns empty array", async () => {
    mockDdgSearch.mockResolvedValue({ noResults: true, vqd: "x", results: [] });

    const r = await searchCompanyWeb("Unknown Corp XYZ");

    expect(r.source).toBe("no_results");
    expect(r.success).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("returns source=no_results when all candidates are filtered out", async () => {
    mockDdgSearch.mockResolvedValue(ddgOk([
      ddgResult("AK on LinkedIn",  "https://linkedin.com/company/ak",  ""),
      ddgResult("AK on Glassdoor", "https://glassdoor.com/company/ak", ""),
    ]));

    const r = await searchCompanyWeb("AK Traders");

    expect(r.source).toBe("no_results");
    expect(r.success).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("never produces fake/heuristic domains when no results", async () => {
    mockDdgSearch.mockResolvedValue({ noResults: true, vqd: "x", results: [] });

    const r = await searchCompanyWeb("Delta Prime AI Solutions");
    expect(r.candidates.some((c) => c.url.includes("deltaprimeai"))).toBe(false);
    expect(r.candidates).toHaveLength(0);
  });
});

// ── Tests: rate_limited ───────────────────────────────────────────────────────

describe("searchCompanyWeb — rate_limited", () => {
  it("returns source=rate_limited for DDG anomaly error (no fake domains)", async () => {
    mockDdgSearch.mockRejectedValue(
      new Error("DDG detected an anomaly in the request, you are likely making requests too quickly."),
    );

    const r = await searchCompanyWeb("Test Corp");

    expect(r.source).toBe("rate_limited");
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.candidates).toHaveLength(0);
    // No fake domains
    expect(r.candidates.some((c) => c.url.includes("testcorp"))).toBe(false);
  });

  it("retries up to MAX_RETRIES times on rate_limited, then returns rate_limited", async () => {
    mockDdgSearch.mockRejectedValue(new Error("DDG detected an anomaly in the request"));

    const r = await searchCompanyWeb("Test Corp");

    // initial attempt + 2 retries = 3 total calls
    expect(mockDdgSearch).toHaveBeenCalledTimes(3);
    expect(r.source).toBe("rate_limited");
  });

  it("succeeds on retry if second attempt works", async () => {
    mockDdgSearch
      .mockRejectedValueOnce(new Error("DDG detected an anomaly"))
      .mockResolvedValueOnce(ddgOk([
        ddgResult("Acme Corp", "https://acme.com", "Official site"),
      ]));

    const r = await searchCompanyWeb("Acme Corp");

    expect(r.source).toBe("duckduckgo");
    expect(r.success).toBe(true);
    expect(r.candidates).toHaveLength(1);
    expect(mockDdgSearch).toHaveBeenCalledTimes(2);
  });

  it("calls _internals.sleep between retries", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    _internals.sleep = sleepSpy;

    mockDdgSearch.mockRejectedValue(new Error("DDG detected an anomaly"));

    await searchCompanyWeb("Test Corp");

    // 2 retries → 2 sleep calls
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });
});

// ── Tests: timeout ────────────────────────────────────────────────────────────

describe("searchCompanyWeb — timeout", () => {
  it("returns source=timeout for timeout-flavoured errors", async () => {
    mockDdgSearch.mockRejectedValue(new Error("ETIMEDOUT: operation timed out"));

    const r = await searchCompanyWeb("Acme");

    expect(r.source).toBe("timeout");
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("does NOT retry on timeout (returns after first attempt)", async () => {
    mockDdgSearch.mockRejectedValue(new Error("search request timed out"));

    await searchCompanyWeb("Acme");

    // No auto-retry on timeout — only 1 call
    expect(mockDdgSearch).toHaveBeenCalledTimes(1);
  });
});

// ── Tests: search_failed ──────────────────────────────────────────────────────

describe("searchCompanyWeb — search_failed", () => {
  it("returns source=search_failed for unknown errors", async () => {
    mockDdgSearch.mockRejectedValue(new Error("Unexpected internal error XYZ"));

    const r = await searchCompanyWeb("Acme");

    expect(r.source).toBe("search_failed");
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.candidates).toHaveLength(0);
  });

  it("does NOT retry on unknown errors", async () => {
    mockDdgSearch.mockRejectedValue(new Error("Unknown error"));

    await searchCompanyWeb("Acme");

    expect(mockDdgSearch).toHaveBeenCalledTimes(1);
  });
});

// ── Tests: isSocialDomain ─────────────────────────────────────────────────────

describe("isSocialDomain", () => {
  it("returns true for linkedin.com", () =>
    expect(isSocialDomain("https://linkedin.com/company/x")).toBe(true));

  it("returns true for www.facebook.com", () =>
    expect(isSocialDomain("https://www.facebook.com/x")).toBe(true));

  it("returns false for acme.com", () =>
    expect(isSocialDomain("https://acme.com")).toBe(false));

  it("SOCIAL_DOMAINS is exported and contains linkedin.com", () =>
    expect(SOCIAL_DOMAINS.has("linkedin.com")).toBe(true));

  it("_internals.sleep is exported and callable", () =>
    expect(typeof _internals.sleep).toBe("function"));
});
