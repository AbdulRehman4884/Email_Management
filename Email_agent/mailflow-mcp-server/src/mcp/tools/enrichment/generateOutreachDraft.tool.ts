/**
 * src/mcp/tools/enrichment/generateOutreachDraft.tool.ts
 *
 * Generates a targeted outreach email draft using company intelligence context.
 * Input accepts the intelligence already gathered (pain points, industry, summary)
 * and produces a ready-to-send subject + body.
 *
 * Graceful degradation: returns a generic draft if AI unavailable.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GenerateOutreachDraftSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import {
  getIntelligenceService,
  type OutreachDraftResult,
  type PainPoint,
} from "../../../services/openai/intelligenceService.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export type { OutreachDraftResult } from "../../../services/openai/intelligenceService.js";

export const generateOutreachDraftTool: McpToolDefinition<
  typeof GenerateOutreachDraftSchema,
  OutreachDraftResult
> = {
  name: TOOL_NAMES.GENERATE_OUTREACH_DRAFT,

  description:
    "Generates a professional outreach email (subject + body) using company intelligence. " +
    "Personalizes based on industry, detected pain points, and business context. " +
    "Output is plain-text, under 200 words, human-sounding.",

  inputSchema: GenerateOutreachDraftSchema,

  handler: async (input, context) => {
    const { companyName, industry, painPoints, businessSummary, tone } = input;
    context.log.info({ companyName, industry, tone, painPointCount: painPoints.length }, "generate_outreach_draft: starting");

    const svc = getIntelligenceService();

    if (!svc) {
      context.log.warn({ companyName }, "generate_outreach_draft: OPENAI_API_KEY not configured — generic draft");
      return toolSuccess<OutreachDraftResult>({
        subject:            `Quick question for ${companyName}`,
        emailBody:          `Hi,\n\nI wanted to reach out to ${companyName} about how we can help with your email marketing efforts.\n\nWould you have 15 minutes for a quick chat?\n\nBest regards`,
        tone,
        personalizationUsed: [],
        aiGenerated:        false,
      });
    }

    // Map schema pain-point objects to the service type
    const pts: PainPoint[] = painPoints.map((p) => ({
      title:       p.title,
      description: p.description,
      confidence:  p.confidence ?? "medium",
    }));

    const result = await svc.generateOutreachDraft(
      companyName,
      industry,
      pts,
      businessSummary ?? null,
      tone ?? "professional",
    );

    context.log.info({ companyName, aiGenerated: result.aiGenerated }, "generate_outreach_draft: complete");
    return toolSuccess(result);
  },
};
