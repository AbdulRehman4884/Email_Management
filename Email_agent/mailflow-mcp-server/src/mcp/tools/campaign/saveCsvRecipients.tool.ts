/**
 * src/mcp/tools/campaign/saveCsvRecipients.tool.ts
 *
 * Saves pre-parsed recipient rows to a campaign via the MailFlow backend.
 *
 * Always call parse_csv_file first. The rows array from that result is passed
 * here — the raw file buffer is never stored in session memory.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { SaveCsvRecipientsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { CsvSaveResult } from "../../../types/mailflow.js";
import type { CampaignId } from "../../../types/common.js";

export const saveCsvRecipientsTool: McpToolDefinition<
  typeof SaveCsvRecipientsSchema,
  CsvSaveResult
> = {
  name: TOOL_NAMES.SAVE_CSV_RECIPIENTS,

  description:
    "Saves pre-parsed recipient rows (from parse_csv_file) to a campaign. " +
    "Call parse_csv_file first to validate the file, then pass its rows array here. " +
    "Returns: added (recipient count inserted), rejected (invalid rows skipped).",

  inputSchema: SaveCsvRecipientsSchema,

  handler: async (input, context) => {
    const campaignId = input.campaignId as CampaignId;
    const { rows } = input;
    context.log.info({ campaignId, rowCount: rows.length }, "saveCsvRecipients: starting");

    try {
      const result = await context.mailflow.saveRecipientsCsv(campaignId, rows);
      context.log.info(
        { campaignId, added: result.added, rejected: result.rejected },
        "saveCsvRecipients: done",
      );
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "saveCsvRecipients: failed");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
