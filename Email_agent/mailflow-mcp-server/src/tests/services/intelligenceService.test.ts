/**
 * src/tests/services/intelligenceService.test.ts
 *
 * Tests for IntelligenceService — OpenAI-powered company intelligence.
 *
 * The OpenAI client is mocked; no real API calls are made.
 * env is mocked with a fake OPENAI_API_KEY.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Env mock — must be defined before any import that reads env ───────────────

vi.mock("../../config/env.js", () => ({
  env: {
    LOG_LEVEL:    "silent",
    LOG_PRETTY:   false,
    NODE_ENV:     "test",
    OPENAI_API_KEY: "sk-test-key",
    OPENAI_MODEL:   "gpt-4o-mini",
  },
}));

// ── OpenAI client mock ────────────────────────────────────────────────────────

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  IntelligenceService,
  getIntelligenceService,
  fallbackProfile,
} from "../../services/openai/intelligenceService.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCompletion(content: string) {
  return {
    choices: [{ message: { content } }],
  };
}

const PROFILE_JSON = JSON.stringify({
  businessSummary:     "Acme Corp makes widgets.",
  productsServices:    ["Widgets", "Gadgets"],
  targetCustomers:     "Small businesses",
  companySizeEstimate: "smb",
  geographicFocus:     "United States",
  techIndicators:      ["Salesforce"],
  aiReadiness:         "high",
  industry:            "Manufacturing",
  subIndustry:         "Consumer Goods",
  painPoints: [
    { title: "Manual processes",       description: "Still using paper", confidence: "high" },
    { title: "Low email open rates",   description: "Newsletters go unread", confidence: "medium" },
  ],
  score:         75,
  category:      "hot",
  scoreReasons:  ["Clear pain points", "Business email domain"],
  primaryAngle:  "Help Acme automate outreach",
  secondaryAngle: null,
  recommendedTone: "professional",
  hooks:         ["manual processes", "newsletter fatigue"],
  serviceFit:    "Email automation + personalization",
  emailSubject:  "Quick question for Acme Corp",
  emailBody:     "Hi,\n\nI noticed Acme Corp relies on manual outreach. We can help.\n\nBest regards",
  confidence:    85,
});

const PAIN_POINTS_JSON = JSON.stringify({
  painPoints: [
    { title: "Low retention",  description: "High churn noted in copy", confidence: "high" },
    { title: "Manual billing", description: "No self-serve mentioned",  confidence: "medium" },
  ],
});

const DRAFT_JSON = JSON.stringify({
  subject:            "Helping Acme Corp grow faster",
  emailBody:          "Hi,\n\nWe help companies like Acme with AI outreach.\n\nOpen to a quick chat?\n\nBest",
  tone:               "professional",
  personalizationUsed: ["industry", "pain point: Low retention"],
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("IntelligenceService", () => {
  let svc: IntelligenceService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new IntelligenceService("sk-test-key");
  });

  // ── extractCompanyProfile ────────────────────────────────────────────────────

  describe("extractCompanyProfile", () => {
    it("returns a parsed CompanyProfileResult on success", async () => {
      mockCreate.mockResolvedValue(makeCompletion(PROFILE_JSON));

      const result = await svc.extractCompanyProfile(
        "Acme Corp",
        "https://acme.com",
        "Acme Corp makes widgets and gadgets for small businesses.",
      );

      expect(result.aiGenerated).toBe(true);
      expect(result.industry).toBe("Manufacturing");
      expect(result.score).toBe(75);
      expect(result.category).toBe("hot");
      expect(result.painPoints).toHaveLength(2);
      expect(result.painPoints[0]!.title).toBe("Manual processes");
      expect(result.emailSubject).toBe("Quick question for Acme Corp");
    });

    it("returns fallback when content is too short (< 50 chars)", async () => {
      const result = await svc.extractCompanyProfile("Acme", "https://acme.com", "Short.");

      expect(result.aiGenerated).toBe(false);
      expect(result.industry).toBe("Unknown");
      expect(result.score).toBe(20);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("returns fallback when OpenAI call rejects", async () => {
      mockCreate.mockRejectedValue(new Error("Network error"));

      const result = await svc.extractCompanyProfile(
        "Acme Corp",
        "https://acme.com",
        "Acme Corp makes widgets. They serve small businesses in the US.",
      );

      expect(result.aiGenerated).toBe(false);
      expect(result.category).toBe("cold");
    });

    it("returns fallback when OpenAI returns invalid JSON", async () => {
      mockCreate.mockResolvedValue(makeCompletion("not json at all"));

      const result = await svc.extractCompanyProfile(
        "Acme Corp",
        "https://acme.com",
        "Acme Corp makes widgets. They serve small businesses in the US.",
      );

      expect(result.aiGenerated).toBe(true);
      expect(result.industry).toBe("Unknown");
    });

    it("clamps score to [0, 100]", async () => {
      mockCreate.mockResolvedValue(
        makeCompletion(JSON.stringify({ ...JSON.parse(PROFILE_JSON), score: 150, category: "hot" })),
      );

      const result = await svc.extractCompanyProfile(
        "Acme Corp",
        "https://acme.com",
        "Acme Corp makes widgets. They serve small businesses in the US.",
      );

      expect(result.score).toBe(100);
    });

    it("defaults companySizeEstimate to 'unknown' for unrecognised values", async () => {
      mockCreate.mockResolvedValue(
        makeCompletion(JSON.stringify({ ...JSON.parse(PROFILE_JSON), companySizeEstimate: "giant" })),
      );

      const result = await svc.extractCompanyProfile(
        "Acme Corp",
        "https://acme.com",
        "Acme Corp makes widgets. They serve small businesses in the US.",
      );

      expect(result.companySizeEstimate).toBe("unknown");
    });
  });

  // ── detectPainPoints ─────────────────────────────────────────────────────────

  describe("detectPainPoints", () => {
    it("returns parsed pain points on success", async () => {
      mockCreate.mockResolvedValue(makeCompletion(PAIN_POINTS_JSON));

      const result = await svc.detectPainPoints(
        "Acme Corp",
        "Acme Corp offers a subscription product but has high churn and manual billing.",
        "SaaS",
      );

      expect(result.aiGenerated).toBe(true);
      expect(result.painPoints).toHaveLength(2);
      expect(result.painPoints[0]!.confidence).toBe("high");
    });

    it("returns empty result when content is too short", async () => {
      const result = await svc.detectPainPoints("Acme", "Short.");

      expect(result.painPoints).toHaveLength(0);
      expect(result.aiGenerated).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("returns empty result when OpenAI rejects", async () => {
      mockCreate.mockRejectedValue(new Error("timeout"));

      const result = await svc.detectPainPoints(
        "Acme Corp",
        "Acme Corp offers a subscription product but has high churn and manual billing.",
      );

      expect(result.painPoints).toHaveLength(0);
      expect(result.aiGenerated).toBe(false);
    });

    it("skips pain points that have missing title or description", async () => {
      mockCreate.mockResolvedValue(
        makeCompletion(JSON.stringify({
          painPoints: [
            { title: "Valid Point", description: "Has both fields", confidence: "high" },
            { title: "",            description: "Missing title",   confidence: "low" },
            { description: "Missing title key entirely",            confidence: "medium" },
          ],
        })),
      );

      const result = await svc.detectPainPoints(
        "Acme Corp",
        "Acme Corp offers a subscription product but has high churn and manual billing.",
      );

      expect(result.painPoints).toHaveLength(1);
      expect(result.painPoints[0]!.title).toBe("Valid Point");
    });
  });

  // ── generateOutreachDraft ─────────────────────────────────────────────────────

  describe("generateOutreachDraft", () => {
    const PAIN_POINTS = [
      { title: "Low retention", description: "High churn noted in copy", confidence: "high" as const },
    ];

    it("returns a parsed draft on success", async () => {
      mockCreate.mockResolvedValue(makeCompletion(DRAFT_JSON));

      const result = await svc.generateOutreachDraft(
        "Acme Corp",
        "SaaS",
        PAIN_POINTS,
        "Acme Corp is a B2B SaaS company.",
        "professional",
      );

      expect(result.aiGenerated).toBe(true);
      expect(result.subject).toBe("Helping Acme Corp grow faster");
      expect(result.personalizationUsed).toContain("industry");
    });

    it("returns fallback when company name is empty", async () => {
      const result = await svc.generateOutreachDraft("", "SaaS", [], null, "professional");

      expect(result.aiGenerated).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("returns fallback when OpenAI rejects", async () => {
      mockCreate.mockRejectedValue(new Error("timeout"));

      const result = await svc.generateOutreachDraft(
        "Acme Corp",
        "SaaS",
        PAIN_POINTS,
        null,
        "executive",
      );

      expect(result.aiGenerated).toBe(false);
      expect(result.subject).toContain("Acme Corp");
    });

    it("accepts null businessSummary gracefully", async () => {
      mockCreate.mockResolvedValue(makeCompletion(DRAFT_JSON));

      const result = await svc.generateOutreachDraft(
        "Acme Corp",
        "Manufacturing",
        PAIN_POINTS,
        null,
      );

      expect(result.aiGenerated).toBe(true);
    });
  });

  // ── fallbackProfile ──────────────────────────────────────────────────────────

  describe("fallbackProfile", () => {
    it("returns a cold profile with the company name embedded", () => {
      const fp = fallbackProfile("Beta Inc");
      expect(fp.aiGenerated).toBe(false);
      expect(fp.category).toBe("cold");
      expect(fp.score).toBe(20);
      expect(fp.primaryAngle).toContain("Beta Inc");
      expect(fp.emailSubject).toContain("Beta Inc");
    });
  });

  // ── getIntelligenceService singleton ─────────────────────────────────────────

  describe("getIntelligenceService", () => {
    it("returns an IntelligenceService instance when OPENAI_API_KEY is configured", () => {
      const svcInstance = getIntelligenceService();
      expect(svcInstance).toBeInstanceOf(IntelligenceService);
    });
  });
});
