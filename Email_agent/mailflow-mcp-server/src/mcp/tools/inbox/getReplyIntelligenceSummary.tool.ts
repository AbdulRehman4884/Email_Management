import { TOOL_NAMES } from "../../../config/constants.js";
import { ReplyIntelligenceSummarySchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { ReplyIntelligenceSummary } from "../../../types/mailflow.js";

export const getReplyIntelligenceSummaryTool: McpToolDefinition<
  typeof ReplyIntelligenceSummarySchema,
  ReplyIntelligenceSummary
> = {
  name: TOOL_NAMES.GET_REPLY_INTELLIGENCE_SUMMARY,
  description: "Returns reply intelligence analytics including positive reply rate, objection breakdown, sentiment distribution, and meeting-ready conversion.",
  inputSchema: ReplyIntelligenceSummarySchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.getReplyIntelligenceSummary({
        ...(input.campaignId ? { campaignId: asCampaignId(input.campaignId) } : {}),
      });
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
