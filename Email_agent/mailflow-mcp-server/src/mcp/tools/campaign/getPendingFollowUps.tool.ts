import { TOOL_NAMES } from "../../../config/constants.js";
import { GetPendingFollowUpsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { PendingFollowUpsResult } from "../../../types/mailflow.js";

export const getPendingFollowUpsTool: McpToolDefinition<
  typeof GetPendingFollowUpsSchema,
  PendingFollowUpsResult
> = {
  name: TOOL_NAMES.GET_PENDING_FOLLOW_UPS,
  description: "Lists recipients with scheduled or due follow-up touches for a campaign, including next touch timing and objective.",
  inputSchema: GetPendingFollowUpsSchema,
  handler: async (input, context) => {
    const campaignId = asCampaignId(input.campaignId);
    try {
      const result = await context.mailflow.getPendingFollowUps(campaignId, input.limit);
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
