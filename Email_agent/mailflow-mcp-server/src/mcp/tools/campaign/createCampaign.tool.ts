/**
 * src/mcp/tools/campaign/createCampaign.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { CreateCampaignSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import {
  toolSuccess,
  toolFailure,
  type ISODateString,
} from "../../../types/common.js";
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
      { name: input.name, subject: input.subject, hasBody: !!input.body, hasScheduledAt: !!input.scheduledAt },
      "Creating campaign",
    );

    try {
      // Backend derives fromName/fromEmail from the user's SMTP settings — do not send them.
      // Backend expects `emailContent`, not `body`.
      const payload = {
        name: input.name,
        subject: input.subject,
        emailContent: input.body,
        ...(input.scheduledAt !== undefined
          ? { scheduledAt: input.scheduledAt as ISODateString }
          : {}),
      };
      const campaign = await context.mailflow.createCampaign(payload);

      // Guard: only report success when the backend returned a persisted campaign ID.
      // If no ID is present the campaign was not actually saved.
      if (!campaign.id) {
        context.log.error(
          { responseKeys: Object.keys(campaign as unknown as Record<string, unknown>) },
          "createCampaign: backend returned no campaign ID — treating as failure",
        );
        return toolFailure(
          "NO_ID",
          "Campaign creation failed: the server did not return a campaign ID. Please try again.",
        );
      }

      context.log.info(
        { campaignId: campaign.id, name: campaign.name, status: campaign.status },
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
