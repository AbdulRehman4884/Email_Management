/**
 * src/mcp/tools/campaign/startCampaign.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { StartCampaignSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";

export const startCampaignTool: McpToolDefinition<
  typeof StartCampaignSchema,
  Campaign
> = {
  name: TOOL_NAMES.START_CAMPAIGN,

  description:
    "Starts sending an email campaign. " +
    "The campaign must be in 'draft' or 'scheduled' status. " +
    "Returns the campaign with updated status ('running').",

  inputSchema: StartCampaignSchema,

  handler: async (input, context) => {
    const id = asCampaignId(input.campaignId);

    context.log.info({ campaignId: id }, "Starting campaign");

    try {
      const campaign = await context.mailflow.startCampaign(id);

      context.log.info(
        { campaignId: campaign.id, status: campaign.status },
        "Campaign started successfully",
      );

      return toolSuccess(campaign);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ campaignId: id, error }, "Failed to start campaign");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
