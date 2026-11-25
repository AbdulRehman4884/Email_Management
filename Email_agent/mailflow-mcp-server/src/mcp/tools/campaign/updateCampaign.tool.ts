/**
 * src/mcp/tools/campaign/updateCampaign.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { UpdateCampaignSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import {
  asCampaignId,
  toolSuccess,
  toolFailure,
  type ISODateString,
} from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";
import { toScheduleWallClock } from "../../../lib/scheduleTime.js";

export const updateCampaignTool: McpToolDefinition<
  typeof UpdateCampaignSchema,
  Campaign
> = {
  name: TOOL_NAMES.UPDATE_CAMPAIGN,

  description:
    "Updates fields on an existing campaign. " +
    "Only provide fields that should change; omitted fields are left unchanged. " +
    "Pass null for replyToEmail or scheduledAt to clear those values. " +
    "Sending schedule: pauseAt, autoPauseAfterMinutes, dailySendLimit, sendWeekdays (1=Mon…7=Sun), " +
    "dailySendWindowStart/End (HH:mm); null turns a setting off. " +
    "Returns the updated campaign object.",

  inputSchema: UpdateCampaignSchema,

  handler: async (input, context) => {
    const { campaignId } = input;
    const updateFields = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.fromName !== undefined ? { fromName: input.fromName } : {}),
      ...(input.fromEmail !== undefined ? { fromEmail: input.fromEmail } : {}),
      ...(input.replyToEmail !== undefined
        ? { replyToEmail: input.replyToEmail }
        : {}),
      ...(input.bodyFormat !== undefined ? { bodyFormat: input.bodyFormat } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.scheduledAt !== undefined
        ? {
            scheduledAt:
              input.scheduledAt === null
                ? null
                : (toScheduleWallClock(input.scheduledAt) as ISODateString),
          }
        : {}),
      ...(input.smtpSettingsId !== undefined ? { smtpSettingsId: input.smtpSettingsId } : {}),
      ...(input.pauseAt !== undefined
        ? { pauseAt: input.pauseAt === null ? null : toScheduleWallClock(input.pauseAt) }
        : {}),
      ...(input.autoPauseAfterMinutes !== undefined ? { autoPauseAfterMinutes: input.autoPauseAfterMinutes } : {}),
      ...(input.dailySendLimit !== undefined ? { dailySendLimit: input.dailySendLimit } : {}),
      ...(input.sendWeekdays !== undefined ? { sendWeekdays: input.sendWeekdays } : {}),
      ...(input.dailySendWindowStart !== undefined ? { dailySendWindowStart: input.dailySendWindowStart } : {}),
      ...(input.dailySendWindowEnd !== undefined ? { dailySendWindowEnd: input.dailySendWindowEnd } : {}),
    };
    const id = asCampaignId(campaignId);

    context.log.info({ campaignId: id }, "Updating campaign");

    try {
      const campaign = await context.mailflow.updateCampaign(id, updateFields);

      context.log.info(
        { campaignId: campaign.id, status: campaign.status },
        "Campaign updated successfully",
      );

      return toolSuccess(campaign);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ campaignId: id, error }, "Failed to update campaign");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
