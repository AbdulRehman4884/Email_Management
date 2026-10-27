/**
 * src/mcp/tools/analytics/getAccountStats.tool.ts
 *
 * Account-level numbers across ALL campaigns: emails sent, open/reply rates and
 * how many campaigns are in each status ("how many drafts do I have?").
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GetAccountStatsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { AccountStats } from "../../../types/mailflow.js";

export const getAccountStatsTool: McpToolDefinition<
  typeof GetAccountStatsSchema,
  AccountStats
> = {
  name: TOOL_NAMES.GET_ACCOUNT_STATS,

  description:
    "Retrieves totals across all of the user's campaigns: emails sent, delivered, opened, " +
    "replied, bounced, open/reply/bounce rates (decimals 0–1), and campaignsByStatus " +
    "(e.g. { draft: 3, completed: 4 }). Use for account-wide questions, not a single campaign.",

  inputSchema: GetAccountStatsSchema,

  handler: async (_input, context) => {
    context.log.info("Fetching account stats");

    try {
      const [totals, campaigns] = await Promise.all([
        context.mailflow.getDashboardStats(),
        context.mailflow.getAllCampaigns(),
      ]);

      const campaignsByStatus: Record<string, number> = {};
      for (const c of campaigns) {
        const status = c.status || "unknown";
        campaignsByStatus[status] = (campaignsByStatus[status] ?? 0) + 1;
      }

      const rate = (n: number) => (totals.sent > 0 ? n / totals.sent : 0);
      return toolSuccess({
        ...totals,
        totalCampaigns: campaigns.length || totals.totalCampaigns,
        campaignsByStatus,
        openRate:   rate(totals.opened),
        replyRate:  rate(totals.replied),
        bounceRate: rate(totals.bounced),
      });
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to fetch account stats");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
