import { TOOL_NAMES } from "../../../config/constants.js";
import { ReplyLeadListSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { ReplyLeadListResult } from "../../../types/mailflow.js";

export const showHotLeadsTool: McpToolDefinition<typeof ReplyLeadListSchema, ReplyLeadListResult> = {
  name: TOOL_NAMES.SHOW_HOT_LEADS,
  description: "Lists hot leads detected from inbound reply intelligence, sorted by hot lead score.",
  inputSchema: ReplyLeadListSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.listHotLeads({
        ...(input.campaignId ? { campaignId: asCampaignId(input.campaignId) } : {}),
        limit: input.limit,
      });
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
