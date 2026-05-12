import { TOOL_NAMES } from "../../../config/constants.js";
import { GetRecipientTouchHistorySchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { RecipientSequenceHistoryResult } from "../../../types/mailflow.js";

export const getRecipientTouchHistoryTool: McpToolDefinition<
  typeof GetRecipientTouchHistorySchema,
  RecipientSequenceHistoryResult
> = {
  name: TOOL_NAMES.GET_RECIPIENT_TOUCH_HISTORY,
  description: "Shows a single recipient's touch-by-touch sequence history, current sequence state, next scheduled touch, and execution outcomes.",
  inputSchema: GetRecipientTouchHistorySchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.getRecipientTouchHistory({
        campaignId: asCampaignId(input.campaignId),
        ...(input.recipientId ? { recipientId: input.recipientId } : {}),
        ...(input.recipientEmail ? { recipientEmail: input.recipientEmail } : {}),
      });
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
