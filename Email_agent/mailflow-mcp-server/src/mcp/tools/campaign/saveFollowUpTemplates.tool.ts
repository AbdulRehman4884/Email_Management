/**
 * src/mcp/tools/campaign/saveFollowUpTemplates.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { SaveFollowUpTemplatesSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { CampaignId } from "../../../types/common.js";

export const saveFollowUpTemplatesTool: McpToolDefinition<
  typeof SaveFollowUpTemplatesSchema,
  { saved: number }
> = {
  name: TOOL_NAMES.SAVE_FOLLOW_UP_TEMPLATES,

  description:
    "Replaces a campaign's follow-up email templates (subject + body each; placeholders such as {{name}} are filled per recipient when sent).",

  inputSchema: SaveFollowUpTemplatesSchema,

  handler: async (input, context) => {
    const campaignId = input.campaignId as CampaignId;
    try {
      const result = await context.mailflow.saveFollowUpTemplates(campaignId, input.templates);
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to save follow-up templates");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
