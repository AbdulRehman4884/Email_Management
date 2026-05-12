/**
 * src/mcp/tools/enrichment/detectPainPoints.tool.ts
 *
 * Focused pain-point detection: infers business needs from website messaging.
 * Use this when you need only pain points without the full company intelligence.
 *
 * Graceful degradation: returns empty pain-points list if AI unavailable.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { DetectPainPointsSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import {
  getIntelligenceService,
  type PainPointsResult,
} from "../../../services/openai/intelligenceService.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export type { PainPointsResult } from "../../../services/openai/intelligenceService.js";

export const detectPainPointsTool: McpToolDefinition<
  typeof DetectPainPointsSchema,
  PainPointsResult
> = {
  name: TOOL_NAMES.DETECT_PAIN_POINTS,

  description:
    "Detects business pain points and likely needs from website content using AI. " +
    "Pain points are inferred only from actual site content — no hallucinations. " +
    "Returns 3-6 pain points with confidence levels.",

  inputSchema: DetectPainPointsSchema,

  handler: async (input, context) => {
    const { companyName, websiteContent, industry, businessSummary: _bs } = input;
    context.log.info({ companyName, contentLength: websiteContent.length }, "detect_pain_points: starting");

    const svc = getIntelligenceService();

    if (!svc) {
      context.log.warn({ companyName }, "detect_pain_points: OPENAI_API_KEY not configured — empty result");
      return toolSuccess<PainPointsResult>({ painPoints: [], aiGenerated: false });
    }

    const result = await svc.detectPainPoints(companyName, websiteContent, industry);

    context.log.info(
      { companyName, count: result.painPoints.length },
      "detect_pain_points: complete",
    );

    return toolSuccess(result);
  },
};
