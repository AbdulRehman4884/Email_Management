/**
 * src/tests/tools/enrichmentPhase2.tool.test.ts
 *
 * Tests for the three Phase 2 MCP tool handlers:
 *   - searchCompanyWebTool
 *   - selectOfficialWebsiteTool
 *   - verifyCompanyWebsiteTool
 *
 * Service modules and env are mocked so no external API calls are made.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockSearchCompanyWeb     = vi.hoisted(() => vi.fn());
const mockScoreAndSelect       = vi.hoisted(() => vi.fn());
const mockVerifyCompanyWebsite = vi.hoisted(() => vi.fn());

vi.mock("../../services/enrichment/companySearch.service.js", () => ({
  searchCompanyWeb: mockSearchCompanyWeb,
  isSocialDomain:   vi.fn().mockReturnValue(false),
  SOCIAL_DOMAINS:   new Set(),
}));
vi.mock("../../services/enrichment/officialWebsiteSelector.service.js", () => ({
  scoreAndSelect: mockScoreAndSelect,
}));
vi.mock("../../services/enrichment/companyWebsiteVerifier.service.js", () => ({
  verifyCompanyWebsite: mockVerifyCompanyWebsite,
}));
vi.mock("../../config/env.js", () => ({
  env: { LOG_LEVEL: "silent", LOG_PRETTY: false, NODE_ENV: "test" },
}));

import { searchCompanyWebTool }      from "../../mcp/tools/enrichment/searchCompanyWeb.tool.js";
import { selectOfficialWebsiteTool } from "../../mcp/tools/enrichment/selectOfficialWebsite.tool.js";
import { verifyCompanyWebsiteTool }  from "../../mcp/tools/enrichment/verifyCompanyWebsite.tool.js";
import { createMockToolContext }      from "../helpers.js";
import { TOOL_NAMES }                 from "../../config/constants.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_CANDIDATES = [
  { title: "Acme Corp",     url: "https://acme.com",    snippet: "Acme Corporation official site" },
  { title: "Acme Inc Blog", url: "https://acmeinc.com", snippet: "Acme Inc blog" },
];

const MOCK_DDG_SUCCESS = {
  success: true, companyName: "Acme Corp", query: '"Acme Corp" official website',
  candidates: MOCK_CANDIDATES, source: "duckduckgo" as const, count: 2,
};

const MOCK_SCORED = [
  { title: "Acme Corp", url: "https://acme.com",    snippet: "", score: 75, selected: true,  reasons: ["domain matches name (+40)"] },
  { title: "Acme Inc",  url: "https://acmeinc.com", snippet: "", score: 55, selected: false, reasons: ["domain matches name (+40)"] },
];

const MOCK_VERIFICATION: import("../../services/enrichment/companyWebsiteVerifier.service.js").VerificationResult = {
  url: "https://acme.com", verified: true, confidence: 80,
  signals: ["HTTPS connection", "Not a social media or directory site", "Domain name matches company name"],
  warnings: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 2 enrichment tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchCompanyWeb.mockResolvedValue(MOCK_DDG_SUCCESS);
    mockScoreAndSelect.mockReturnValue(MOCK_SCORED);
    mockVerifyCompanyWebsite.mockReturnValue(MOCK_VERIFICATION);
  });

  // ── searchCompanyWebTool ────────────────────────────────────────────────────

  describe("searchCompanyWebTool", () => {
    it("has the correct tool name constant", () => {
      expect(searchCompanyWebTool.name).toBe(TOOL_NAMES.SEARCH_COMPANY_WEB);
      expect(searchCompanyWebTool.name).toBe("search_company_web");
    });

    it("calls searchCompanyWeb service and returns candidates", async () => {
      const ctx    = createMockToolContext();
      const result = await searchCompanyWebTool.handler({ companyName: "Acme Corp" }, ctx);

      expect(mockSearchCompanyWeb).toHaveBeenCalledWith("Acme Corp", {});
      expect(result).toEqual({
        success: true,
        data: {
          companyName: "Acme Corp",
          query:       '"Acme Corp" official website',
          candidates:  MOCK_CANDIDATES,
          source:      "duckduckgo",
          count:       2,
          success:     true,
        },
      });
    });

    it("passes location and country to the service", async () => {
      const ctx = createMockToolContext();
      await searchCompanyWebTool.handler({ companyName: "AK Traders", country: "Pakistan" }, ctx);
      expect(mockSearchCompanyWeb).toHaveBeenCalledWith("AK Traders", { country: "Pakistan" });
    });

    it("propagates rate_limited source without conversion", async () => {
      mockSearchCompanyWeb.mockResolvedValue({
        success: false, companyName: "Acme Corp", query: '"Acme Corp" official website',
        candidates: [], source: "rate_limited", count: 0,
        error: "ddg detected an anomaly", retryable: true,
      });
      const ctx    = createMockToolContext();
      const result = await searchCompanyWebTool.handler({ companyName: "Acme Corp" }, ctx) as {
        success: boolean; data: { source: string; retryable: boolean; success: boolean };
      };

      expect(result.data.source).toBe("rate_limited");
      expect(result.data.retryable).toBe(true);
      expect(result.data.success).toBe(false);
    });

    it("propagates timeout source", async () => {
      mockSearchCompanyWeb.mockResolvedValue({
        success: false, companyName: "Acme Corp", query: '"Acme Corp" official website',
        candidates: [], source: "timeout", count: 0,
        error: "search request timed out", retryable: true,
      });
      const ctx    = createMockToolContext();
      const result = await searchCompanyWebTool.handler({ companyName: "Acme Corp" }, ctx) as {
        success: boolean; data: { source: string };
      };
      expect(result.data.source).toBe("timeout");
    });

    it("propagates search_failed source", async () => {
      mockSearchCompanyWeb.mockResolvedValue({
        success: false, companyName: "Acme Corp", query: '"Acme Corp" official website',
        candidates: [], source: "search_failed", count: 0,
        error: "unexpected error", retryable: false,
      });
      const ctx    = createMockToolContext();
      const result = await searchCompanyWebTool.handler({ companyName: "Acme Corp" }, ctx) as {
        success: boolean; data: { source: string; retryable: boolean };
      };
      expect(result.data.source).toBe("search_failed");
      expect(result.data.retryable).toBe(false);
    });

    it("returns no_results source with empty candidates when DDG finds nothing", async () => {
      mockSearchCompanyWeb.mockResolvedValue({
        success: true, companyName: "Unknown Corp", query: '"Unknown Corp" official website',
        candidates: [], source: "no_results", count: 0,
      });
      const ctx    = createMockToolContext();
      const result = await searchCompanyWebTool.handler({ companyName: "Unknown Corp" }, ctx) as {
        success: boolean; data: { candidates: unknown[]; source: string; count: number };
      };

      expect(result.data.source).toBe("no_results");
      expect(result.data.candidates).toHaveLength(0);
      expect(result.data.count).toBe(0);
    });

    it("source is always one of the five valid values", async () => {
      const sources = ["duckduckgo", "no_results", "rate_limited", "search_failed", "timeout"] as const;
      for (const source of sources) {
        mockSearchCompanyWeb.mockResolvedValue({
          success: source === "duckduckgo" || source === "no_results",
          companyName: "Foo", query: '"Foo" official website',
          candidates: [], source, count: 0,
        });
        const ctx    = createMockToolContext();
        const result = await searchCompanyWebTool.handler({ companyName: "Foo" }, ctx) as {
          success: boolean; data: { source: string };
        };
        expect(sources).toContain(result.data.source as typeof sources[number]);
      }
    });
  });

  // ── selectOfficialWebsiteTool ───────────────────────────────────────────────

  describe("selectOfficialWebsiteTool", () => {
    it("has the correct tool name constant", () => {
      expect(selectOfficialWebsiteTool.name).toBe(TOOL_NAMES.SELECT_OFFICIAL_WEBSITE);
      expect(selectOfficialWebsiteTool.name).toBe("select_official_website");
    });

    it("calls scoreAndSelect and returns scored candidates", async () => {
      const ctx    = createMockToolContext();
      const result = await selectOfficialWebsiteTool.handler(
        { companyName: "Acme Corp", candidates: MOCK_CANDIDATES },
        ctx,
      );

      expect(mockScoreAndSelect).toHaveBeenCalledWith("Acme Corp", MOCK_CANDIDATES, {});
      expect(result).toEqual({
        success: true,
        data: {
          companyName:   "Acme Corp",
          selected:      MOCK_SCORED[0],
          allCandidates: MOCK_SCORED,
          selectionMade: true,
        },
      });
    });

    it("passes location/country options to scoreAndSelect", async () => {
      const ctx = createMockToolContext();
      await selectOfficialWebsiteTool.handler(
        { companyName: "AK Traders", candidates: MOCK_CANDIDATES, country: "Pakistan" },
        ctx,
      );
      expect(mockScoreAndSelect).toHaveBeenCalledWith(
        "AK Traders", MOCK_CANDIDATES, { country: "Pakistan" },
      );
    });

    it("sets selectionMade=false when no candidate is selected", async () => {
      const noSelection = MOCK_SCORED.map((c) => ({ ...c, selected: false }));
      mockScoreAndSelect.mockReturnValue(noSelection);
      const ctx    = createMockToolContext();
      const result = await selectOfficialWebsiteTool.handler(
        { companyName: "Acme Corp", candidates: MOCK_CANDIDATES }, ctx,
      ) as { success: boolean; data: { selectionMade: boolean; selected: null } };

      expect(result.data.selectionMade).toBe(false);
      expect(result.data.selected).toBeNull();
    });
  });

  // ── verifyCompanyWebsiteTool ────────────────────────────────────────────────

  describe("verifyCompanyWebsiteTool", () => {
    it("has the correct tool name constant", () => {
      expect(verifyCompanyWebsiteTool.name).toBe(TOOL_NAMES.VERIFY_COMPANY_WEBSITE);
      expect(verifyCompanyWebsiteTool.name).toBe("verify_company_website");
    });

    it("calls verifyCompanyWebsite and returns result", async () => {
      const ctx    = createMockToolContext();
      const result = await verifyCompanyWebsiteTool.handler(
        { companyName: "Acme Corp", url: "https://acme.com" }, ctx,
      );

      expect(mockVerifyCompanyWebsite).toHaveBeenCalledWith("Acme Corp", "https://acme.com");
      expect(result).toEqual({ success: true, data: MOCK_VERIFICATION });
    });

    it("accepts optional websiteContent, title, snippet without error", async () => {
      const ctx = createMockToolContext();
      await expect(
        verifyCompanyWebsiteTool.handler(
          {
            companyName:    "Acme Corp",
            url:            "https://acme.com",
            title:          "Acme Corp — Official Site",
            snippet:        "Acme Corp is a leading provider …",
            websiteContent: "Welcome to Acme Corp. We offer …",
          },
          ctx,
        ),
      ).resolves.not.toThrow();
    });

    it("returns verified=false for low confidence", async () => {
      mockVerifyCompanyWebsite.mockReturnValue({
        url: "https://linkedin.com/company/acme", verified: false, confidence: 0,
        signals: [], warnings: ["URL appears to be a social media or directory profile"],
      });
      const ctx    = createMockToolContext();
      const result = await verifyCompanyWebsiteTool.handler(
        { companyName: "Acme Corp", url: "https://linkedin.com/company/acme" }, ctx,
      ) as { success: boolean; data: { verified: boolean } };

      expect(result.data.verified).toBe(false);
    });
  });
});
