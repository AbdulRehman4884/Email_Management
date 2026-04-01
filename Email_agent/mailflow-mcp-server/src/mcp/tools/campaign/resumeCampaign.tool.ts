/**
 * src/mcp/tools/campaign/resumeCampaign.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { ResumeCampaignSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";

export const resumeCampaignTool: McpToolDefinition<
  typeof ResumeCampaignSchema,
  Campaign
> = {
  name: TOOL_NAMES.RESUME_CAMPAIGN,

  description:
    "Resumes a paused email campaign. " +
    "The campaign must be in 'paused' status. " +
    "Returns the campaign with updated status ('running').",

  inputSchema: ResumeCampaignSchema,

  handler: async (input, context) => {
    const id = asCampaignId(input.campaignId);

    context.log.info({ campaignId: id }, "Resuming campaign");

    try {
      const campaign = await context.mailflow.resumeCampaign(id);

      context.log.info(
        { campaignId: campaign.id, status: campaign.status },
        "Campaign resumed successfully",
      );

      return toolSuccess(campaign);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ campaignId: id, error }, "Failed to resume campaign");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
