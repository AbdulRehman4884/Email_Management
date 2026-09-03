import { TOOL_NAMES } from "../../../config/constants.js";
import { MarkReplyHumanReviewSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export const markReplyHumanReviewTool: McpToolDefinition<
  typeof MarkReplyHumanReviewSchema,
  { message: string; replyId: number }
> = {
  name: TOOL_NAMES.MARK_REPLY_HUMAN_REVIEW,
  description: "Marks a reply intelligence item for human review.",
  inputSchema: MarkReplyHumanReviewSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.markReplyHumanReview({
        replyId: input.replyId,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
