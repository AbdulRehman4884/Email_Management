import { TOOL_NAMES } from "../../../config/constants.js";
import { MarkRecipientBouncedSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export const markRecipientBouncedTool: McpToolDefinition<
  typeof MarkRecipientBouncedSchema,
  { message: string }
> = {
  name: TOOL_NAMES.MARK_RECIPIENT_BOUNCED,
  description: "Manually marks a recipient as bounced, adds suppression, and stops all future sequence touches for that recipient.",
  inputSchema: MarkRecipientBouncedSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.markRecipientBounced({
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
