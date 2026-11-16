/**
 * src/mcp/tools/campaign/getCampaignRecipients.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GetCampaignRecipientsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { CampaignRecipientsResult } from "../../../types/mailflow.js";
import type { CampaignId } from "../../../types/common.js";

export const getCampaignRecipientsTool: McpToolDefinition<
  typeof GetCampaignRecipientsSchema,
  CampaignRecipientsResult
> = {
  name: TOOL_NAMES.GET_CAMPAIGN_RECIPIENTS,

  description:
    "Returns a campaign (name, status, subject, body, sender profile) and its recipients, " +
    "each with the row uploaded for it (customFields). Read-only.",

  inputSchema: GetCampaignRecipientsSchema,

  handler: async (input, context) => {
    const campaignId = input.campaignId as CampaignId;
    try {
      const result = await context.mailflow.getCampaignRecipients(campaignId, input.limit);
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to get campaign recipients");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
