/**
 * src/mcp/tools/campaign/createCampaign.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { CreateCampaignSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import {
  toolSuccess,
  toolFailure,
  type ISODateString,
} from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";

export const createCampaignTool: McpToolDefinition<
  typeof CreateCampaignSchema,
  Campaign
> = {
  name: TOOL_NAMES.CREATE_CAMPAIGN,

  description:
    "Creates a new email campaign in MailFlow. " +
    "Returns the full campaign object including the assigned id and initial status. " +
    "The campaign is created in 'draft' status; call start_campaign to send it.",

  inputSchema: CreateCampaignSchema,

  handler: async (input, context) => {
    context.log.info(
      { name: input.name, subject: input.subject, hasBody: !!input.body, hasScheduledAt: !!input.scheduledAt },
      "Creating campaign",
    );

    try {
      // Resolve which SMTP profile to use for this campaign.
      const profiles = await context.mailflow.listSmtpProfiles();

      let smtpSettingsId: number;
      if (input.smtpSettingsId) {
        // Caller (agent) already chose a profile from a prior selection turn.
        smtpSettingsId = input.smtpSettingsId;
        context.log.info({ smtpSettingsId }, "createCampaign: using caller-provided smtpSettingsId");
      } else if (profiles.length === 0) {
        return toolFailure(
          "NO_SMTP_PROFILES",
          "No SMTP account configured. Please add an SMTP account in Settings first.",
        );
      } else if (profiles.length === 1) {
        smtpSettingsId = profiles[0]!.id;
        context.log.info(
          { smtpSettingsId, fromEmail: profiles[0]!.fromEmail },
          "createCampaign: auto-selected single SMTP profile",
        );
      } else {
        // Multiple profiles — ask user to choose.
        const choices = profiles.map((p) => ({ id: p.id, fromEmail: p.fromEmail, fromName: p.fromName }));
        return toolFailure(
          "SMTP_SELECTION_REQUIRED",
          `You have ${profiles.length} SMTP accounts. Please choose which one to use for this campaign.`,
          { choices },
        );
      }

      // Backend derives fromName/fromEmail from the user's SMTP settings — do not send them.
      // Backend expects `emailContent`, not `body`.
      const payload = {
        name: input.name,
        subject: input.subject,
        emailContent: input.body,
        smtpSettingsId,
        ...(input.scheduledAt !== undefined
          ? { scheduledAt: input.scheduledAt as ISODateString }
          : {}),
      };
      const campaign = await context.mailflow.createCampaign(payload);

      // Guard: only report success when the backend returned a persisted campaign ID.
      // If no ID is present the campaign was not actually saved.
      if (!campaign.id) {
        context.log.error(
          { responseKeys: Object.keys(campaign as unknown as Record<string, unknown>) },
          "createCampaign: backend returned no campaign ID — treating as failure",
        );
        return toolFailure(
          "NO_ID",
          "Campaign creation failed: the server did not return a campaign ID. Please try again.",
        );
      }

      context.log.info(
        { campaignId: campaign.id, name: campaign.name, status: campaign.status },
        "Campaign created successfully",
      );

      return toolSuccess(campaign);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to create campaign");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
