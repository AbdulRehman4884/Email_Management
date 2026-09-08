import { TOOL_NAMES } from "../../../config/constants.js";
import { PreviewSequenceAdaptationSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { SequenceAdaptationPreviewResult } from "../../../types/mailflow.js";

export const previewSequenceAdaptationTool: McpToolDefinition<
  typeof PreviewSequenceAdaptationSchema,
  SequenceAdaptationPreviewResult
> = {
  name: TOOL_NAMES.PREVIEW_SEQUENCE_ADAPTATION,
  description: "Previews sequence adaptation recommendations without changing stored touches or sending emails.",
  inputSchema: PreviewSequenceAdaptationSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.previewSequenceAdaptation({
        recipientId: input.recipientId,
        campaignId: asCampaignId(input.campaignId),
        ...(input.replyText ? { replyText: input.replyText } : {}),
        ...(input.scenario ? { scenario: input.scenario } : {}),
      });
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
