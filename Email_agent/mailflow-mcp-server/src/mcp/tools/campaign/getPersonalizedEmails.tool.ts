/**
 * src/mcp/tools/campaign/getPersonalizedEmails.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GetPersonalizedEmailsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { PersonalizedEmailsResult } from "../../../types/mailflow.js";
import type { CampaignId } from "../../../types/common.js";

export const getPersonalizedEmailsTool: McpToolDefinition<
  typeof GetPersonalizedEmailsSchema,
  PersonalizedEmailsResult
> = {
  name: TOOL_NAMES.GET_PERSONALIZED_EMAILS,

  description:
    "Retrieves a sample of the AI-generated personalized emails for a campaign. " +
    "Use this after generate_personalized_emails to show the user a preview before approving. " +
    "Returns up to `limit` emails with recipient details and personalized bodies.",

  inputSchema: GetPersonalizedEmailsSchema,

  handler: async (input, context) => {
    const campaignId = input.campaignId as CampaignId;
    const limit = input.limit ?? 3;
    context.log.info({ campaignId, limit }, "Fetching personalized email samples");

    try {
      const result = await context.mailflow.getPersonalizedEmails(campaignId, limit);
      context.log.info(
        { campaignId, total: result.total, returned: result.emails.length },
        "Personalized emails retrieved",
      );
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to retrieve personalized emails");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
