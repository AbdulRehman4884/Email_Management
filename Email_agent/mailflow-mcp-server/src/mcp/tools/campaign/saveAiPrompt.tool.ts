/**
 * src/mcp/tools/campaign/saveAiPrompt.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { SaveAiPromptSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { AiPromptSaveResult } from "../../../types/mailflow.js";

export const saveAiPromptTool: McpToolDefinition<
  typeof SaveAiPromptSchema,
  AiPromptSaveResult
> = {
  name: TOOL_NAMES.SAVE_AI_PROMPT,

  description:
    "Saves the AI personalization configuration for a campaign. " +
    "Set the template type (promotional/newsletter/event/announcement/follow_up), " +
    "tone instructions, and any custom prompt for OpenAI to follow when generating emails. " +
    "Call this before generate_personalized_emails.",

  inputSchema: SaveAiPromptSchema,

  handler: async (input, context) => {
    context.log.info(
      { campaignId: input.campaignId, templateType: input.templateType },
      "Saving AI prompt configuration",
    );

    try {
      const result = await context.mailflow.saveAiPrompt({
        campaignId: input.campaignId,
        ...(input.templateType    !== undefined && { templateType:    input.templateType }),
        ...(input.toneInstruction !== undefined && { toneInstruction: input.toneInstruction }),
        ...(input.customPrompt    !== undefined && { customPrompt:    input.customPrompt }),
      });
      context.log.info({ campaignId: input.campaignId }, "AI prompt saved");
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to save AI prompt");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
