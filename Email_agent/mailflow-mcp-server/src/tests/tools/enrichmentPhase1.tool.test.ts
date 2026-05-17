/**
 * src/tests/tools/enrichmentPhase1.tool.test.ts
 *
 * Tests MCP tool handler behaviour for the three Phase 1 enrichment tools:
 *   - validateEmailTool
 *   - extractDomainTool
 *   - fetchWebsiteContentTool
 *
 * Mocks the underlying service modules so tool tests are fully isolated from
 * external API calls and env configuration.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockValidateEmail     = vi.hoisted(() => vi.fn());
const mockExtractDomain     = vi.hoisted(() => vi.fn());
const mockFetchWebsite      = vi.hoisted(() => vi.fn());

vi.mock("../../services/enrichment/emailValidation.service.js", () => ({
  validateEmail: mockValidateEmail,
}));
vi.mock("../../services/enrichment/domainExtraction.service.js", () => ({
  extractDomain: mockExtractDomain,
}));
vi.mock("../../services/enrichment/websiteFetch.service.js", () => ({
  fetchWebsiteContent: mockFetchWebsite,
}));

// Also mock env so the module can be imported without real env vars
vi.mock("../../config/env.js", () => ({
  env: {
    LOG_LEVEL:         "silent",
    LOG_PRETTY:        false,
    NODE_ENV:          "test",
    ABSTRACT_API_KEY:  undefined,
    JINA_API_KEY:      undefined,
    FIRECRAWL_API_KEY: undefined,
  },
}));

import { validateEmailTool }      from "../../mcp/tools/enrichment/validateEmail.tool.js";
import { extractDomainTool }      from "../../mcp/tools/enrichment/extractDomain.tool.js";
import { fetchWebsiteContentTool } from "../../mcp/tools/enrichment/fetchWebsiteContent.tool.js";
import { createMockToolContext }   from "../helpers.js";
import { TOOL_NAMES }              from "../../config/constants.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_VALIDATION_RESULT = {
  email: "alice@acme.com",
  isValid:       true,
  domain:        "acme.com",
  businessEmail: true,
  disposable:    false,
  source:        "heuristic" as const,
  reason:        "Business domain",
};

const MOCK_DOMAIN_RESULT = {
  domain:     "acme.com",
  tld:        "com",
  subdomain:  undefined,
  isPersonal: false,
  website:    "https://acme.com",
};

const MOCK_FETCH_RESULT = {
  success:       true,
  url:           "https://acme.com",
  title:         "Acme Corp",
  content:       "Acme Corp is a software company.",
  contentLength: 34,
  source:        "jina" as const,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 1 enrichment tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateEmail.mockResolvedValue(MOCK_VALIDATION_RESULT);
    mockExtractDomain.mockReturnValue(MOCK_DOMAIN_RESULT);
    mockFetchWebsite.mockResolvedValue(MOCK_FETCH_RESULT);
  });

  // ── validateEmailTool ───────────────────────────────────────────────────────

  describe("validateEmailTool", () => {
    it("has the correct tool name constant", () => {
      expect(validateEmailTool.name).toBe(TOOL_NAMES.VALIDATE_EMAIL);
      expect(validateEmailTool.name).toBe("validate_email");
    });

    it("calls validateEmail service and returns success", async () => {
      const ctx = createMockToolContext();
      const result = await validateEmailTool.handler({ email: "alice@acme.com" }, ctx);

      expect(mockValidateEmail).toHaveBeenCalledWith("alice@acme.com");
      expect(result).toEqual({ success: true, data: MOCK_VALIDATION_RESULT });
    });

    it("passes the email through unchanged to the service", async () => {
      const ctx = createMockToolContext();
      await validateEmailTool.handler({ email: "BOB@EXAMPLE.COM" }, ctx);
      expect(mockValidateEmail).toHaveBeenCalledWith("BOB@EXAMPLE.COM");
    });
  });

  // ── extractDomainTool ───────────────────────────────────────────────────────

  describe("extractDomainTool", () => {
    it("has the correct tool name constant", () => {
      expect(extractDomainTool.name).toBe(TOOL_NAMES.EXTRACT_DOMAIN);
      expect(extractDomainTool.name).toBe("extract_domain");
    });

    it("returns success with domain data", async () => {
      const ctx = createMockToolContext();
      const result = await extractDomainTool.handler({ input: "alice@acme.com" }, ctx);

      expect(mockExtractDomain).toHaveBeenCalledWith("alice@acme.com");
      expect(result).toEqual({ success: true, data: MOCK_DOMAIN_RESULT });
    });

    it("returns toolFailure when domain cannot be extracted", async () => {
      mockExtractDomain.mockReturnValue(null);
      const ctx = createMockToolContext();
      const result = await extractDomainTool.handler({ input: "not-a-domain" }, ctx);

      expect(result).toMatchObject({ success: false, error: { code: "INVALID_INPUT" } });
    });
  });

  // ── fetchWebsiteContentTool ─────────────────────────────────────────────────

  describe("fetchWebsiteContentTool", () => {
    it("has the correct tool name constant", () => {
      expect(fetchWebsiteContentTool.name).toBe(TOOL_NAMES.FETCH_WEBSITE_CONTENT);
      expect(fetchWebsiteContentTool.name).toBe("fetch_website_content");
    });

    it("returns success with website content", async () => {
      const ctx = createMockToolContext();
      const result = await fetchWebsiteContentTool.handler({ url: "https://acme.com" }, ctx);

      expect(mockFetchWebsite).toHaveBeenCalledWith("https://acme.com");
      expect(result).toEqual({ success: true, data: MOCK_FETCH_RESULT });
    });

    it("returns toolFailure when fetch service reports failure", async () => {
      mockFetchWebsite.mockResolvedValue({
        success: false,
        url:     "https://broken.example",
        source:  "none",
        error:   "All sources failed",
      });

      const ctx = createMockToolContext();
      const result = await fetchWebsiteContentTool.handler({ url: "https://broken.example" }, ctx);

      expect(result).toMatchObject({
        success: false,
        error:   { code: "FETCH_FAILED" },
      });
    });
  });
});
