import type { Request, Response } from "express";
import {
  getAutonomousLeadRecommendation,
  getCampaignAutonomousRecommendations,
  getCampaignAutonomousSummary,
  type AutonomousScenario,
} from "../lib/autonomousRecommendations.js";

function parseId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function scenarioFromBody(value: unknown): AutonomousScenario | null {
  const allowed = new Set<AutonomousScenario>([
    "pricing_objection",
    "competitor_objection",
    "timing_objection",
    "meeting_interest",
    "positive_interest",
    "unsubscribe",
    "spam_complaint",
  ]);
  return allowed.has(value as AutonomousScenario) ? value as AutonomousScenario : null;
}

export async function leadAutonomousRecommendationHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const recipientId = parseId(req.params.recipientId);
    if (!recipientId) return res.status(400).json({ error: "Invalid recipientId" });

    const campaignId = parseId(req.body?.campaignId);
    const recommendation = await getAutonomousLeadRecommendation({
      userId,
      recipientId,
      campaignId,
      replyText: typeof req.body?.replyText === "string" ? req.body.replyText : null,
      scenario: scenarioFromBody(req.body?.scenario),
    });

    if (!recommendation) return res.status(404).json({ error: "Recipient not found" });

    return res.json({
      success: true,
      data: recommendation,
    });
  } catch (error) {
    console.error("Autonomous recommendation error:", error);
    return res.status(500).json({ error: "Failed to build autonomous recommendation" });
  }
}

export async function campaignAutonomousRecommendationsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const campaignId = parseId(req.params.campaignId);
    if (!campaignId) return res.status(400).json({ error: "Invalid campaignId" });

    const recommendations = await getCampaignAutonomousRecommendations(userId, campaignId);
    return res.json({
      success: true,
      data: {
        campaignId,
        recommendations,
      },
    });
  } catch (error) {
    console.error("Campaign autonomous recommendations error:", error);
    return res.status(500).json({ error: "Failed to build campaign autonomous recommendations" });
  }
}

export async function campaignAutonomousSummaryHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const campaignId = parseId(req.params.campaignId);
    if (!campaignId) return res.status(400).json({ error: "Invalid campaignId" });

    const summary = await getCampaignAutonomousSummary(userId, campaignId);
    return res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error("Campaign autonomous summary error:", error);
    return res.status(500).json({ error: "Failed to build campaign autonomous summary" });
  }
}
