import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import {
  campaignAutonomousRecommendationsHandler,
  campaignAutonomousSummaryHandler,
  leadAutonomousRecommendationHandler,
} from "../autonomousController.js";
import {
  getAutonomousLeadRecommendation,
  getCampaignAutonomousRecommendations,
  getCampaignAutonomousSummary,
} from "../../lib/autonomousRecommendations.js";

vi.mock("../../lib/autonomousRecommendations.js", () => ({
  getAutonomousLeadRecommendation: vi.fn(),
  getCampaignAutonomousRecommendations: vi.fn(),
  getCampaignAutonomousSummary: vi.fn(),
}));

function res() {
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return response as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function req(partial: Partial<Request>): Request {
  return {
    params: {},
    body: {},
    query: {},
    user: { id: 1 },
    ...partial,
  } as Request;
}

const recommendation = {
  recipientId: 7,
  campaignId: 12,
  leadEmail: "lead@example.com",
  priority: { priorityLevel: "urgent", recommendedAction: "Prioritize manual response.", confidence: 0.9, reasons: ["Meeting-ready signal detected."] },
  recommendedAction: "escalate_to_human",
  autonomousDecision: { action: "escalate_to_human", confidence: 0.9, reasons: ["Meeting-ready signal detected."] },
  safety: { allowed: true, status: "allowed", requiresHumanApproval: false },
  adaptationPreview: { adaptedTouches: [], adaptationSummary: "Stop sequence and escalate.", changedTouchNumbers: [], adaptationReasons: ["Meeting interest."], requiresHumanReview: true, safetyBlocked: false, recommendedAction: "escalate_to_human" },
  humanEscalation: { escalate: true, priority: "urgent", reason: "High meeting intent.", suggestedOwner: "account_executive" },
  reasons: ["Meeting-ready signal detected."],
  nextBestAction: "Review and respond to this lead before sending further follow-ups.",
  replyContext: { meetingReady: true, hotLeadScore: 91 },
};

describe("autonomousController", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recipient recommendation returns priority, safety, and next action", async () => {
    vi.mocked(getAutonomousLeadRecommendation).mockResolvedValue(recommendation as never);
    const response = res();

    await leadAutonomousRecommendationHandler(req({ params: { recipientId: "7" } }), response);

    expect(getAutonomousLeadRecommendation).toHaveBeenCalledWith({
      userId: 1,
      recipientId: 7,
      campaignId: null,
      replyText: null,
      scenario: null,
    });
    expect(response.json).toHaveBeenCalledWith({ success: true, data: recommendation });
  });

  it("campaign recommendations endpoint returns sorted recommendation data", async () => {
    const blocked = { ...recommendation, recipientId: 8, safety: { allowed: false, status: "blocked", reason: "Autonomy blocked for spam_warning.", requiresHumanApproval: true } };
    vi.mocked(getCampaignAutonomousRecommendations).mockResolvedValue([blocked, recommendation] as never);
    const response = res();

    await campaignAutonomousRecommendationsHandler(req({ params: { campaignId: "12" } }), response);

    expect(response.json).toHaveBeenCalledWith({
      success: true,
      data: { campaignId: 12, recommendations: [blocked, recommendation] },
    });
  });

  it("campaign summary clearly reports safety-blocked leads", async () => {
    const summary = {
      campaignId: 12,
      urgentLeads: 1,
      meetingReadyLeads: 1,
      humanReviewNeeded: 2,
      safetyBlockedLeads: 1,
      recommendedCampaignAction: "Review safety-blocked leads and ensure no automation continues for them.",
      topOptimizationRecommendation: "Keep future touches reviewable and avoid autonomous send changes.",
      topPriorities: [recommendation],
    };
    vi.mocked(getCampaignAutonomousSummary).mockResolvedValue(summary as never);
    const response = res();

    await campaignAutonomousSummaryHandler(req({ params: { campaignId: "12" } }), response);

    expect(response.json).toHaveBeenCalledWith({ success: true, data: summary });
  });

  it("adaptation preview request remains preview-only", async () => {
    vi.mocked(getAutonomousLeadRecommendation).mockResolvedValue(recommendation as never);
    const response = res();

    await leadAutonomousRecommendationHandler(
      req({ params: { recipientId: "7" }, body: { campaignId: "12", scenario: "pricing_objection" } }),
      response,
    );

    expect(getAutonomousLeadRecommendation).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 7,
      campaignId: 12,
      scenario: "pricing_objection",
    }));
    expect(response.json).toHaveBeenCalledWith({ success: true, data: recommendation });
  });
});
