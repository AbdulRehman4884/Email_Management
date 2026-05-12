/**
 * src/mcp/tools/campaign/getAllCampaigns.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GetAllCampaignsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";

export const getAllCampaignsTool: McpToolDefinition<
  typeof GetAllCampaignsSchema,
  Campaign[]
> = {
  name: TOOL_NAMES.GET_ALL_CAMPAIGNS,

  description:
    "Returns all email campaigns belonging to the authenticated user. " +
    "Each campaign includes its id, name, subject, status, and timestamps.",

  inputSchema: GetAllCampaignsSchema,

  handler: async (_input, context) => {
    context.log.info("Fetching all campaigns");

    try {
      const campaigns = await context.mailflow.getAllCampaigns();

      context.log.info({ count: campaigns.length }, "Campaigns fetched successfully");

      return toolSuccess(campaigns);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to fetch campaigns");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
