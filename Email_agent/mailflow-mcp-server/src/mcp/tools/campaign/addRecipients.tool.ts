/**
 * src/mcp/tools/campaign/addRecipients.tool.ts
 *
 * Adds one or more recipients (email + optional name) to an existing campaign
 * via the MailFlow /campaigns/:id/recipients/bulk endpoint.
 *
 * Intended for AI-workflow use when the user supplies email addresses inline
 * in their prompt (e.g. "create a campaign and send it to user@example.com").
 * For large recipient lists, use the CSV upload flow (parse_csv_file →
 * save_csv_recipients) instead.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { AddRecipientsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { BulkSaveResult } from "../../../types/mailflow.js";
import type { CampaignId } from "../../../types/common.js";

export const addRecipientsTool: McpToolDefinition<
  typeof AddRecipientsSchema,
  BulkSaveResult
> = {
  name: TOOL_NAMES.ADD_RECIPIENTS,

  description:
    "Adds one or more recipients (email + optional name) to an existing campaign. " +
    "Use this when the user supplies email addresses directly in their message. " +
    "For bulk imports, use parse_csv_file → save_csv_recipients instead. " +
    "Returns: saved (count inserted), skipped (duplicates), rejected (invalid entries).",

  inputSchema: AddRecipientsSchema,

  handler: async (input, context) => {
    const campaignId = input.campaignId as CampaignId;
    const { recipients } = input;

    context.log.info(
      { campaignId, count: recipients.length },
      "addRecipients: starting",
    );

    try {
      const result = await context.mailflow.saveRecipientsBulk(
        campaignId,
        recipients as Array<Record<string, unknown>>,
      );

      context.log.info(
        { campaignId, saved: result.saved, skipped: result.skipped },
        "addRecipients: done",
      );

      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "addRecipients: failed");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
