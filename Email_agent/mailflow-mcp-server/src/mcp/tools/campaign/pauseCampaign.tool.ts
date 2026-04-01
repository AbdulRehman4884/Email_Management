/**
 * src/mcp/tools/campaign/pauseCampaign.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { PauseCampaignSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";

export const pauseCampaignTool: McpToolDefinition<
  typeof PauseCampaignSchema,
  Campaign
> = {
  name: TOOL_NAMES.PAUSE_CAMPAIGN,

  description:
    "Pauses a running email campaign. " +
    "The campaign must be in 'running' status. " +
    "Returns the campaign with updated status ('paused'). " +
    "Use resume_campaign to continue sending.",

  inputSchema: PauseCampaignSchema,

  handler: async (input, context) => {
    const id = asCampaignId(input.campaignId);

    context.log.info({ campaignId: id }, "Pausing campaign");

    try {
      const campaign = await context.mailflow.pauseCampaign(id);

      context.log.info(
        { campaignId: campaign.id, status: campaign.status },
        "Campaign paused successfully",
      );

      return toolSuccess(campaign);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ campaignId: id, error }, "Failed to pause campaign");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
