import { TOOL_NAMES } from "../../../config/constants.js";
import { MarkRecipientRepliedSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export const markRecipientRepliedTool: McpToolDefinition<
  typeof MarkRecipientRepliedSchema,
  { message: string }
> = {
  name: TOOL_NAMES.MARK_RECIPIENT_REPLIED,
  description: "Manually marks a recipient as replied and stops all future sequence touches for that recipient.",
  inputSchema: MarkRecipientRepliedSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.markRecipientReplied({
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
