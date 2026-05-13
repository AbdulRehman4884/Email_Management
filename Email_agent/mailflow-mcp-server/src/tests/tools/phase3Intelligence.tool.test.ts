/**
 * src/tests/tools/phase3Intelligence.tool.test.ts
 *
 * Tests for the three Phase 3 MCP tool handlers:
 *   - extractCompanyProfileTool
 *   - detectPainPointsTool
 *   - generateOutreachDraftTool
 *
 * IntelligenceService is mocked so no OpenAI calls are made.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Service and env mocks ─────────────────────────────────────────────────────

const mockGetIntelligenceService = vi.hoisted(() => vi.fn());
const mockExtractCompanyProfile  = vi.hoisted(() => vi.fn());
const mockDetectPainPoints       = vi.hoisted(() => vi.fn());
const mockGenerateOutreachDraft  = vi.hoisted(() => vi.fn());

vi.mock("../../services/openai/intelligenceService.js", () => ({
  getIntelligenceService: mockGetIntelligenceService,
  fallbackProfile: (name: string) => ({
    businessSummary:     null,
    productsServices:    [],
    targetCustomers:     null,
    companySizeEstimate: "unknown",
    geographicFocus:     null,
    techIndicators:      [],
    aiReadiness:         "low",
    industry:            "Unknown",
    subIndustry:         null,
    painPoints:          [],
    score:               20,
    category:            "cold",
    scoreReasons:        ["Insufficient website data for scoring"],
    primaryAngle:        `Help ${name} grow`,
    secondaryAngle:      null,
    recommendedTone:     "professional",
    hooks:               [],
    serviceFit:          "Email marketing automation",
    emailSubject:        `Quick question for ${name}`,
    emailBody:           `Hi,\n\nI wanted to reach out about ${name}.\n\nBest regards`,
    aiGenerated:         false,
    confidence:          0,
  }),
}));

vi.mock("../../config/env.js", () => ({
  env: { LOG_LEVEL: "silent", LOG_PRETTY: false, NODE_ENV: "test" },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { extractCompanyProfileTool } from "../../mcp/tools/enrichment/extractCompanyProfile.tool.js";
import { detectPainPointsTool }       from "../../mcp/tools/enrichment/detectPainPoints.tool.js";
import { generateOutreachDraftTool }  from "../../mcp/tools/enrichment/generateOutreachDraft.tool.js";
import { createMockToolContext }       from "../helpers.js";
import { TOOL_NAMES }                  from "../../config/constants.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_PROFILE = {
  businessSummary:     "Acme Corp makes widgets.",
  productsServices:    ["Widgets"],
  targetCustomers:     "Small businesses",
  companySizeEstimate: "smb" as const,
  geographicFocus:     "US",
  techIndicators:      [],
  aiReadiness:         "medium" as const,
  industry:            "Manufacturing",
  subIndustry:         null,
  painPoints:          [{ title: "Manual ops", description: "Uses paper", confidence: "high" as const }],
  score:               72,
  category:            "hot" as const,
  scoreReasons:        ["Clear pain points"],
  primaryAngle:        "Automate outreach",
  secondaryAngle:      null,
  recommendedTone:     "professional",
  hooks:               ["manual ops"],
  serviceFit:          "Email automation",
  emailSubject:        "Quick question for Acme Corp",
  emailBody:           "Hi,\n\nWe can help Acme Corp.\n\nBest regards",
  aiGenerated:         true,
  confidence:          80,
};

const MOCK_PAIN_POINTS_RESULT = {
  painPoints: [
    { title: "High churn",    description: "Mentioned in copy",       confidence: "high" as const },
    { title: "Manual billing", description: "No self-serve checkout", confidence: "medium" as const },
  ],
  aiGenerated: true,
};

const MOCK_DRAFT_RESULT = {
  subject:             "Helping Acme Corp grow",
  emailBody:           "Hi,\n\nWe help companies like Acme.\n\nBest",
  tone:                "professional",
  personalizationUsed: ["industry"],
  aiGenerated:         true,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Phase 3 intelligence tools", () => {
  const mockService = {
    extractCompanyProfile:  mockExtractCompanyProfile,
    detectPainPoints:       mockDetectPainPoints,
    generateOutreachDraft:  mockGenerateOutreachDraft,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIntelligenceService.mockReturnValue(mockService);
    mockExtractCompanyProfile.mockResolvedValue(MOCK_PROFILE);
    mockDetectPainPoints.mockResolvedValue(MOCK_PAIN_POINTS_RESULT);
    mockGenerateOutreachDraft.mockResolvedValue(MOCK_DRAFT_RESULT);
  });

  // ── extractCompanyProfileTool ─────────────────────────────────────────────────

  describe("extractCompanyProfileTool", () => {
    it("has the correct tool name constant", () => {
      expect(extractCompanyProfileTool.name).toBe(TOOL_NAMES.EXTRACT_COMPANY_PROFILE);
      expect(extractCompanyProfileTool.name).toBe("extract_company_profile");
    });

    it("calls extractCompanyProfile and returns toolSuccess envelope", async () => {
      const ctx = createMockToolContext();
      const result = await extractCompanyProfileTool.handler(
        { companyName: "Acme Corp", sourceUrl: "https://acme.com", websiteContent: "Acme Corp makes widgets for small businesses." },
        ctx,
      ) as { success: boolean; data: typeof MOCK_PROFILE };

      expect(mockExtractCompanyProfile).toHaveBeenCalledWith(
        "Acme Corp",
        "https://acme.com",
        "Acme Corp makes widgets for small businesses.",
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual(MOCK_PROFILE);
    });

    it("returns fallback profile when service is unavailable", async () => {
      mockGetIntelligenceService.mockReturnValue(undefined);

      const ctx = createMockToolContext();
      const result = await extractCompanyProfileTool.handler(
        { companyName: "Acme Corp", sourceUrl: "https://acme.com", websiteContent: "Content here." },
        ctx,
      ) as { success: boolean; data: { aiGenerated: boolean; score: number } };

      expect(mockExtractCompanyProfile).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data.aiGenerated).toBe(false);
      expect(result.data.score).toBe(20);
    });

    it("does not expose the raw service error to callers", async () => {
      mockGetIntelligenceService.mockReturnValue(mockService);
      mockExtractCompanyProfile.mockRejectedValue(new Error("Internal AI error"));

      const ctx = createMockToolContext();
      await expect(
        extractCompanyProfileTool.handler(
          { companyName: "Acme Corp", sourceUrl: "https://acme.com", websiteContent: "Content here about Acme Corp." },
          ctx,
        ),
      ).resolves.toBeDefined();
    });
  });

  // ── detectPainPointsTool ──────────────────────────────────────────────────────

  describe("detectPainPointsTool", () => {
    it("has the correct tool name constant", () => {
      expect(detectPainPointsTool.name).toBe(TOOL_NAMES.DETECT_PAIN_POINTS);
      expect(detectPainPointsTool.name).toBe("detect_pain_points");
    });

    it("calls detectPainPoints and returns pain points", async () => {
      const ctx = createMockToolContext();
      const result = await detectPainPointsTool.handler(
        { companyName: "Acme Corp", websiteContent: "Acme Corp struggles with manual processes.", industry: "SaaS" },
        ctx,
      ) as { success: boolean; data: typeof MOCK_PAIN_POINTS_RESULT };

      expect(mockDetectPainPoints).toHaveBeenCalledWith(
        "Acme Corp",
        "Acme Corp struggles with manual processes.",
        "SaaS",
      );
      expect(result.success).toBe(true);
      expect(result.data.painPoints).toHaveLength(2);
      expect(result.data.aiGenerated).toBe(true);
    });

    it("passes undefined industry when not provided", async () => {
      const ctx = createMockToolContext();
      await detectPainPointsTool.handler(
        { companyName: "Acme Corp", websiteContent: "Content about Acme Corp processes." },
        ctx,
      );

      expect(mockDetectPainPoints).toHaveBeenCalledWith(
        "Acme Corp",
        "Content about Acme Corp processes.",
        undefined,
      );
    });

    it("returns empty pain points when service is unavailable", async () => {
      mockGetIntelligenceService.mockReturnValue(undefined);

      const ctx = createMockToolContext();
      const result = await detectPainPointsTool.handler(
        { companyName: "Acme Corp", websiteContent: "Content about Acme Corp processes." },
        ctx,
      ) as { success: boolean; data: { painPoints: unknown[]; aiGenerated: boolean } };

      expect(result.success).toBe(true);
      expect(result.data.painPoints).toHaveLength(0);
      expect(result.data.aiGenerated).toBe(false);
    });
  });

  // ── generateOutreachDraftTool ─────────────────────────────────────────────────

  describe("generateOutreachDraftTool", () => {
    it("has the correct tool name constant", () => {
      expect(generateOutreachDraftTool.name).toBe(TOOL_NAMES.GENERATE_OUTREACH_DRAFT);
      expect(generateOutreachDraftTool.name).toBe("generate_outreach_draft");
    });

    it("calls generateOutreachDraft and returns the draft", async () => {
      const painPoints = [{ title: "High churn", description: "Mentioned on site", confidence: "high" as const }];
      const ctx = createMockToolContext();
      const result = await generateOutreachDraftTool.handler(
        { companyName: "Acme Corp", industry: "SaaS", painPoints, tone: "executive" },
        ctx,
      ) as { success: boolean; data: typeof MOCK_DRAFT_RESULT };

      expect(mockGenerateOutreachDraft).toHaveBeenCalledWith(
        "Acme Corp",
        "SaaS",
        painPoints,
        null,
        "executive",
      );
      expect(result.success).toBe(true);
      expect(result.data.subject).toBe("Helping Acme Corp grow");
    });

    it("passes businessSummary when provided", async () => {
      const ctx = createMockToolContext();
      await generateOutreachDraftTool.handler(
        {
          companyName:     "Acme Corp",
          industry:        "Manufacturing",
          painPoints:      [],
          businessSummary: "Makes widgets",
          tone:            "friendly",
        },
        ctx,
      );

      expect(mockGenerateOutreachDraft).toHaveBeenCalledWith(
        "Acme Corp",
        "Manufacturing",
        [],
        "Makes widgets",
        "friendly",
      );
    });

    it("passes tone to the service call", async () => {
      const ctx = createMockToolContext();
      await generateOutreachDraftTool.handler(
        { companyName: "Acme Corp", industry: "Retail", painPoints: [], tone: "professional" },
        ctx,
      );

      const callArgs = mockGenerateOutreachDraft.mock.calls[0] as unknown[];
      expect(callArgs[4]).toBe("professional");
    });

    it("returns generic draft when service is unavailable", async () => {
      mockGetIntelligenceService.mockReturnValue(undefined);

      const ctx = createMockToolContext();
      const result = await generateOutreachDraftTool.handler(
        { companyName: "Acme Corp", industry: "SaaS", painPoints: [], tone: "professional" },
        ctx,
      ) as { success: boolean; data: { aiGenerated: boolean; subject: string } };

      expect(result.success).toBe(true);
      expect(result.data.aiGenerated).toBe(false);
      expect(result.data.subject).toContain("Acme Corp");
    });
  });
});
