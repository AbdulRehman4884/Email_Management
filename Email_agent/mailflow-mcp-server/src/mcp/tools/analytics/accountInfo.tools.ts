/**
 * src/mcp/tools/analytics/accountInfo.tools.ts
 *
 * Read-only account facts the chat used to answer with a generic menu (QA P4 bug 22):
 *   get_account_plan    — the plan the user is on and what it includes (/auth/me)
 *   get_best_send_time  — the hour the user's leads open emails most (/dashboard/best-send-time)
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GetAccountPlanSchema, GetBestSendTimeSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { AccountPlan, BestSendTime } from "../../../types/mailflow.js";

function failure(err: unknown) {
  const error = serializeError(err);
  return toolFailure(error.code, error.message, error.details);
}

export const getAccountPlanTool: McpToolDefinition<typeof GetAccountPlanSchema, { plan: AccountPlan | null }> = {
  name: TOOL_NAMES.GET_ACCOUNT_PLAN,
  description: "The user's current plan: name, email accounts and daily email limit, and whether Inbox, follow-ups, CRM and Lead Finder are included. Read-only.",
  inputSchema: GetAccountPlanSchema,
  handler: async (_input, context) => {
    try {
      return toolSuccess({ plan: await context.mailflow.getAccountPlan() });
    } catch (err) {
      return failure(err);
    }
  },
};

export const getBestSendTimeTool: McpToolDefinition<typeof GetBestSendTimeSchema, BestSendTime> = {
  name: TOOL_NAMES.GET_BEST_SEND_TIME,
  description: "The hour of day the user's leads open emails most (first opens per hour, in the given time zone). Read-only.",
  inputSchema: GetBestSendTimeSchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.getBestSendTime(input.timezone));
    } catch (err) {
      return failure(err);
    }
  },
};
