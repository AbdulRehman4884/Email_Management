import { TOOL_NAMES } from "../../../config/constants.js";
import { ReplyLeadListSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { ReplyLeadListResult } from "../../../types/mailflow.js";

export const showMeetingReadyLeadsTool: McpToolDefinition<typeof ReplyLeadListSchema, ReplyLeadListResult> = {
  name: TOOL_NAMES.SHOW_MEETING_READY_LEADS,
  description: "Lists meeting-ready leads detected from inbound replies.",
  inputSchema: ReplyLeadListSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.listMeetingReadyLeads({
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
