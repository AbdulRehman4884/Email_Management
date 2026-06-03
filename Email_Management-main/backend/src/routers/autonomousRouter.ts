import { Router } from "express";
import {
  campaignAutonomousRecommendationsHandler,
  campaignAutonomousSummaryHandler,
  leadAutonomousRecommendationHandler,
} from "../controllers/autonomousController.js";

const router = Router();

router.post("/autonomous/leads/:recipientId/recommendation", leadAutonomousRecommendationHandler);
router.get("/autonomous/campaigns/:campaignId/recommendations", campaignAutonomousRecommendationsHandler);
router.get("/autonomous/campaigns/:campaignId/summary", campaignAutonomousSummaryHandler);

export default router;
