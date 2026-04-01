/**
 * src/mcp/tools/analytics/getCampaignStats.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GetCampaignStatsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { CampaignStats } from "../../../types/mailflow.js";

export const getCampaignStatsTool: McpToolDefinition<
  typeof GetCampaignStatsSchema,
  CampaignStats
> = {
  name: TOOL_NAMES.GET_CAMPAIGN_STATS,

  description:
    "Retrieves delivery and engagement statistics for a campaign. " +
    "Returns sent, delivered, opened, clicked, bounced, unsubscribed, and replied counts, " +
    "along with calculated rates (openRate, clickRate, bounceRate, replyRate) as decimals 0–1.",

  inputSchema: GetCampaignStatsSchema,

  handler: async (input, context) => {
    const id = asCampaignId(input.campaignId);

    context.log.info({ campaignId: id }, "Fetching campaign stats");

    try {
      const stats = await context.mailflow.getCampaignStats(id);

      context.log.info(
        {
          campaignId: id,
          sent: stats.sent,
          openRate: stats.openRate,
          replyRate: stats.replyRate,
        },
        "Campaign stats retrieved",
      );

      return toolSuccess(stats);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ campaignId: id, error }, "Failed to fetch campaign stats");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
