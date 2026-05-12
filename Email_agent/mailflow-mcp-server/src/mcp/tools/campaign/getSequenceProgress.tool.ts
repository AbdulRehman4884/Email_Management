import { TOOL_NAMES } from "../../../config/constants.js";
import { GetSequenceProgressSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { SequenceProgressResult } from "../../../types/mailflow.js";

export const getSequenceProgressTool: McpToolDefinition<
  typeof GetSequenceProgressSchema,
  SequenceProgressResult
> = {
  name: TOOL_NAMES.GET_SEQUENCE_PROGRESS,
  description: "Returns recipient-level sequence progress, pending follow-up counts, completion metrics, and touch-by-touch performance for a campaign.",
  inputSchema: GetSequenceProgressSchema,
  handler: async (input, context) => {
    const campaignId = asCampaignId(input.campaignId);
    try {
      const result = await context.mailflow.getSequenceProgress(campaignId);
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
