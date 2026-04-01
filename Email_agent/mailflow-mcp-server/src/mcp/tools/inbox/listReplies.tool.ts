/**
 * src/mcp/tools/inbox/listReplies.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { ListRepliesSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { asCampaignId, toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { ListRepliesResult } from "../../../types/mailflow.js";

export const listRepliesTool: McpToolDefinition<
  typeof ListRepliesSchema,
  ListRepliesResult
> = {
  name: TOOL_NAMES.LIST_REPLIES,

  description:
    "Lists email replies received for campaigns. " +
    "Optionally filter by campaignId and/or status (unread, read, archived). " +
    "Returns a paginated result with reply metadata and body text. " +
    "Use summarize_replies for an aggregated overview instead of individual items.",

  inputSchema: ListRepliesSchema,

  handler: async (input, context) => {
    context.log.info(
      { campaignId: input.campaignId, status: input.status, page: input.page },
      "Listing replies",
    );

    try {
      const result = await context.mailflow.listReplies({
        campaignId: input.campaignId
          ? asCampaignId(input.campaignId)
          : undefined,
        status: input.status,
        page: input.page,
        pageSize: input.pageSize,
      });

      context.log.info(
        { total: result.total, page: result.page, returned: result.items.length },
        "Replies listed",
      );

      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to list replies");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
