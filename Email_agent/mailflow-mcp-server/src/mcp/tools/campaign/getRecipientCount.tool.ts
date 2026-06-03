/**
 * src/mcp/tools/campaign/getRecipientCount.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GetRecipientCountSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { RecipientCountResult } from "../../../types/mailflow.js";
import type { CampaignId } from "../../../types/common.js";

export const getRecipientCountTool: McpToolDefinition<
  typeof GetRecipientCountSchema,
  RecipientCountResult
> = {
  name: TOOL_NAMES.GET_RECIPIENT_COUNT,

  description:
    "Returns the number of recipients uploaded to a campaign. " +
    "Use this after uploading a CSV to confirm how many recipients are ready. " +
    "Returns pendingCount (not yet sent) and totalCount.",

  inputSchema: GetRecipientCountSchema,

  handler: async (input, context) => {
    const campaignId = input.campaignId as CampaignId;
    context.log.info({ campaignId }, "Getting recipient count");

    try {
      const result = await context.mailflow.getRecipientCount(campaignId);
      context.log.info(
        { campaignId, pendingCount: result.pendingCount, totalCount: result.totalCount },
        "Recipient count retrieved",
      );
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to get recipient count");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
