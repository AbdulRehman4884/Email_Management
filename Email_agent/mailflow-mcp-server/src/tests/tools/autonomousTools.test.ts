import { describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "../../config/constants.js";
import { createMockToolContext } from "../helpers.js";
import { getAutonomousRecommendationTool } from "../../mcp/tools/inbox/getAutonomousRecommendation.tool.js";
import { getCampaignAutonomousSummaryTool } from "../../mcp/tools/inbox/getCampaignAutonomousSummary.tool.js";
import { previewSequenceAdaptationTool } from "../../mcp/tools/inbox/previewSequenceAdaptation.tool.js";

const recommendation = {
  recipientId: 7,
  campaignId: 12,
  priority: { priorityLevel: "urgent", recommendedAction: "Review manually.", confidence: 0.9, reasons: ["Meeting intent."] },
  recommendedAction: "escalate_to_human",
  autonomousDecision: { action: "escalate_to_human", confidence: 0.9, reasons: ["Meeting intent."] },
  safety: { allowed: true, status: "allowed", requiresHumanApproval: false },
  adaptationPreview: null,
  humanEscalation: { escalate: true, priority: "urgent", reason: "High meeting intent.", suggestedOwner: "account_executive" },
  reasons: ["Meeting intent."],
  nextBestAction: "Review and respond to this lead before sending further follow-ups.",
  replyContext: { meetingReady: true },
};

describe("autonomous MCP tools", () => {
  it("get_autonomous_recommendation calls the backend client with recipientId", async () => {
    const mailflow = { getAutonomousRecommendation: vi.fn().mockResolvedValue(recommendation) };
    const context = createMockToolContext({ mailflow: createMockToolContext().mailflow });
    context.mailflow.getAutonomousRecommendation = mailflow.getAutonomousRecommendation;

    const result = await getAutonomousRecommendationTool.handler({ recipientId: "7" }, context);

    expect(getAutonomousRecommendationTool.name).toBe(TOOL_NAMES.GET_AUTONOMOUS_RECOMMENDATION);
    expect(mailflow.getAutonomousRecommendation).toHaveBeenCalledWith({ recipientId: "7" });
    expect(result).toEqual({ success: true, data: recommendation });
  });

  it("get_campaign_autonomous_summary validates campaignId and calls the backend client", async () => {
    const summary = {
      campaignId: 12,
      urgentLeads: 1,
      meetingReadyLeads: 1,
      humanReviewNeeded: 1,
      safetyBlockedLeads: 0,
      recommendedCampaignAction: "Review meeting-ready leads first.",
      topOptimizationRecommendation: "Keep future touches reviewable.",
      topPriorities: [recommendation],
    };
    const context = createMockToolContext();
    context.mailflow.getCampaignAutonomousSummary = vi.fn().mockResolvedValue(summary);

    const result = await getCampaignAutonomousSummaryTool.handler({ campaignId: "12" }, context);

    expect(result).toEqual({ success: true, data: summary });
    expect(context.mailflow.getCampaignAutonomousSummary).toHaveBeenCalledWith({ campaignId: "12" });
  });

  it("preview_sequence_adaptation sends scenario and reply text without applying changes", async () => {
    const preview = {
      recipientId: 7,
      campaignId: 12,
      safety: recommendation.safety,
      priority: recommendation.priority,
      recommendedAction: "switch_to_value_cta",
      adaptationPreview: { recommendedAction: "switch_to_value_cta", safetyBlocked: false },
      humanEscalation: recommendation.humanEscalation,
      nextBestAction: "Review the adapted future-touch preview before applying any sequence changes.",
    };
    const context = createMockToolContext();
    context.mailflow.previewSequenceAdaptation = vi.fn().mockResolvedValue(preview);

    const result = await previewSequenceAdaptationTool.handler({
      recipientId: "7",
      campaignId: "12",
      scenario: "pricing_objection",
      replyText: "Too expensive",
    }, context);

    expect(previewSequenceAdaptationTool.name).toBe(TOOL_NAMES.PREVIEW_SEQUENCE_ADAPTATION);
    expect(context.mailflow.previewSequenceAdaptation).toHaveBeenCalledWith({
      recipientId: "7",
      campaignId: "12",
      scenario: "pricing_objection",
      replyText: "Too expensive",
    });
    expect(result).toEqual({ success: true, data: preview });
  });

  it("humanizes backend errors", async () => {
    const context = createMockToolContext();
    context.mailflow.getAutonomousRecommendation = vi.fn().mockRejectedValue(new Error("backend unavailable"));

    const result = await getAutonomousRecommendationTool.handler({ recipientId: "7" }, context);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("backend unavailable");
  });
});
