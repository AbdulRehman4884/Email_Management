/**
 * src/mcp/tools/campaign/createCampaign.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { CreateCampaignSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";

export const createCampaignTool: McpToolDefinition<
  typeof CreateCampaignSchema,
  Campaign
> = {
  name: TOOL_NAMES.CREATE_CAMPAIGN,

  description:
    "Creates a new email campaign in MailFlow. " +
    "Returns the full campaign object including the assigned id and initial status. " +
    "The campaign is created in 'draft' status; call start_campaign to send it.",

  inputSchema: CreateCampaignSchema,

  handler: async (input, context) => {
    context.log.info(
      { name: input.name, fromEmail: input.fromEmail },
      "Creating campaign",
    );

    try {
      const campaign = await context.mailflow.createCampaign({
        name: input.name,
        subject: input.subject,
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        replyToEmail: input.replyToEmail,
        bodyFormat: input.bodyFormat,
        body: input.body,
        scheduledAt: input.scheduledAt,
      });

      context.log.info(
        { campaignId: campaign.id, status: campaign.status },
        "Campaign created successfully",
      );

      return toolSuccess(campaign);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to create campaign");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
