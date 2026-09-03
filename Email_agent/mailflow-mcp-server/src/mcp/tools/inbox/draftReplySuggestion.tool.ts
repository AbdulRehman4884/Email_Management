import { TOOL_NAMES } from "../../../config/constants.js";
import { DraftReplySuggestionSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { ReplySuggestionResult } from "../../../types/mailflow.js";

export const draftReplySuggestionTool: McpToolDefinition<typeof DraftReplySuggestionSchema, ReplySuggestionResult> = {
  name: TOOL_NAMES.DRAFT_REPLY_SUGGESTION,
  description: "Generates or retrieves a short, deliverability-safe AI reply suggestion for a specific inbound reply.",
  inputSchema: DraftReplySuggestionSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.draftReplySuggestion(input.replyId);
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
