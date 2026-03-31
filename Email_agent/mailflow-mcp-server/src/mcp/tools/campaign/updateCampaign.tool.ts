/**
 * src/mcp/tools/campaign/updateCampaign.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { UpdateCampaignSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";

export const updateCampaignTool: McpToolDefinition<
  typeof UpdateCampaignSchema,
  Campaign
> = {
  name: TOOL_NAMES.UPDATE_CAMPAIGN,

  description:
    "Updates fields on an existing campaign. " +
    "Only provide fields that should change; omitted fields are left unchanged. " +
    "Pass null for replyToEmail or scheduledAt to clear those values. " +
    "Returns the updated campaign object.",

  inputSchema: UpdateCampaignSchema,

  handler: async (input, context) => {
    const { campaignId, ...updateFields } = input;
    const id = asCampaignId(campaignId);

    context.log.info({ campaignId: id }, "Updating campaign");

    try {
      const campaign = await context.mailflow.updateCampaign(id, updateFields);

      context.log.info(
        { campaignId: campaign.id, status: campaign.status },
        "Campaign updated successfully",
      );

      return toolSuccess(campaign);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ campaignId: id, error }, "Failed to update campaign");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
