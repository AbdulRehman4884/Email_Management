/**
 * src/mcp/tools/enrichment/generateOutreachScript.tool.ts
 *
 * Generates one outreach script for one company from its website content:
 *   cold_email — medium length, with a subject line
 *   cold_call  — long, spoken
 *   linkedin   — short message
 * Also returns the main problem and 1-2 matching services.
 *
 * Graceful degradation: returns status "insufficient_data" if AI is unavailable
 * or the website shows no clear problem our services solve.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GenerateOutreachScriptSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import {
  fallbackOutreachScript,
  getIntelligenceService,
  type OutreachScriptResult,
} from "../../../services/openai/intelligenceService.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export const generateOutreachScriptTool: McpToolDefinition<
  typeof GenerateOutreachScriptSchema,
  OutreachScriptResult
> = {
  name: TOOL_NAMES.GENERATE_OUTREACH_SCRIPT,

  description:
    "Reads a company's website content and writes one outreach script for the chosen channel " +
    "(cold_email: medium with subject, cold_call: long spoken, linkedin: short), plus the main " +
    "problem and 1-2 matching services. Returns status 'insufficient_data' when the site shows no clear problem.",

  inputSchema: GenerateOutreachScriptSchema,

  handler: async (input, context) => {
    const { companyName, scriptType } = input;
    context.log.info({ companyName, scriptType }, "generate_outreach_script: starting");

    const svc = getIntelligenceService();

    if (!svc) {
      context.log.warn({ companyName }, "generate_outreach_script: OPENAI_API_KEY not configured — insufficient_data");
      return toolSuccess(fallbackOutreachScript(scriptType));
    }

    const result = await svc.generateOutreachScript(input);

    context.log.info(
      { companyName, scriptType, status: result.status, wordCount: result.wordCount },
      "generate_outreach_script: complete",
    );

    return toolSuccess(result);
  },
};
