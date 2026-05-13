import { TOOL_NAMES } from "../../../config/constants.js";
import { CampaignAutonomousSummarySchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { CampaignAutonomousSummaryResult } from "../../../types/mailflow.js";

export const getCampaignAutonomousSummaryTool: McpToolDefinition<
  typeof CampaignAutonomousSummarySchema,
  CampaignAutonomousSummaryResult
> = {
  name: TOOL_NAMES.GET_CAMPAIGN_AUTONOMOUS_SUMMARY,
  description: "Returns a review-only autonomous SDR summary for a campaign.",
  inputSchema: CampaignAutonomousSummarySchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.getCampaignAutonomousSummary({
        campaignId: asCampaignId(input.campaignId),
      });
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
