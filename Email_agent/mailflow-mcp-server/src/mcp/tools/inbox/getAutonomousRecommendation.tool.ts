import { TOOL_NAMES } from "../../../config/constants.js";
import { AutonomousRecommendationSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { AutonomousRecommendationResult } from "../../../types/mailflow.js";

export const getAutonomousRecommendationTool: McpToolDefinition<
  typeof AutonomousRecommendationSchema,
  AutonomousRecommendationResult
> = {
  name: TOOL_NAMES.GET_AUTONOMOUS_RECOMMENDATION,
  description: "Returns a review-only autonomous SDR recommendation for one recipient.",
  inputSchema: AutonomousRecommendationSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.getAutonomousRecommendation({
        recipientId: input.recipientId,
      });
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
