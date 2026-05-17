/**
 * src/mcp/tools/enrichment/extractCompanyProfile.tool.ts
 *
 * AI-powered compound analysis tool: extracts company profile, classifies
 * industry, detects pain points, scores the lead, generates outreach angle,
 * and produces a ready-to-send email draft — all in one OpenAI call.
 *
 * Input:  { companyName, sourceUrl, websiteContent }
 * Output: CompanyProfileResult (see IntelligenceService)
 *
 * Graceful degradation: if OPENAI_API_KEY is absent or the AI call fails,
 * returns a safe partial result with aiGenerated=false instead of crashing.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { ExtractCompanyProfileSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import {
  getIntelligenceService,
  fallbackProfile as buildFallback,
  type CompanyProfileResult,
} from "../../../services/openai/intelligenceService.js";
import type { McpToolDefinition } from "../../../types/tool.js";

// Re-export so callers can import the result type from the tool file.
export type { CompanyProfileResult } from "../../../services/openai/intelligenceService.js";

export const extractCompanyProfileTool: McpToolDefinition<
  typeof ExtractCompanyProfileSchema,
  CompanyProfileResult
> = {
  name: TOOL_NAMES.EXTRACT_COMPANY_PROFILE,

  description:
    "AI-powered company intelligence: extracts profile, industry, pain points, " +
    "lead score, outreach angle, and email draft from website content in one call. " +
    "Requires OPENAI_API_KEY; returns safe partial result if AI is unavailable.",

  inputSchema: ExtractCompanyProfileSchema,

  handler: async (input, context) => {
    const { companyName, sourceUrl, websiteContent } = input;
    context.log.info({ companyName, sourceUrl, contentLength: websiteContent.length }, "extract_company_profile: starting");

    const svc = getIntelligenceService();

    if (!svc) {
      context.log.warn({ companyName }, "extract_company_profile: OPENAI_API_KEY not configured — returning fallback");
      return toolSuccess<CompanyProfileResult>(buildFallback(companyName));
    }

    try {
      const result = await svc.extractCompanyProfile(companyName, sourceUrl, websiteContent);
      context.log.info(
        { companyName, score: result.score, category: result.category, aiGenerated: result.aiGenerated },
        "extract_company_profile: complete",
      );
      return toolSuccess(result);
    } catch {
      context.log.warn({ companyName }, "extract_company_profile: AI call failed — returning fallback");
      return toolSuccess<CompanyProfileResult>(buildFallback(companyName));
    }
  },
};
