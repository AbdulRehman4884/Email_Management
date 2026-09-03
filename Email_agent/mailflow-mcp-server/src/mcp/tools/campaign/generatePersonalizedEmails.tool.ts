/**
 * src/mcp/tools/campaign/generatePersonalizedEmails.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GeneratePersonalizedEmailsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { PersonalizedEmailGenerationResult } from "../../../types/mailflow.js";
import type { CampaignId } from "../../../types/common.js";

export const generatePersonalizedEmailsTool: McpToolDefinition<
  typeof GeneratePersonalizedEmailsSchema,
  PersonalizedEmailGenerationResult
> = {
  name: TOOL_NAMES.GENERATE_PERSONALIZED_EMAILS,

  description:
    "Generates a personalized email body for every recipient in a campaign using OpenAI. " +
    "Personalization uses ONLY the data present in each recipient's CSV row — no invented facts. " +
    "Requires recipients to be uploaded first (upload CSV via the web interface) and an AI prompt " +
    "to be saved (save_ai_prompt). Returns a count of generated and failed emails.",

  inputSchema: GeneratePersonalizedEmailsSchema,

  handler: async (input, context) => {
    const campaignId = input.campaignId as CampaignId;
    const overwrite  = input.overwrite === true;
    const mode = input.mode;
    const tone = input.tone;
    const ctaType = input.ctaType;
    const sequenceType = input.sequenceType;
    const sequenceLength = input.sequenceLength;
    const includeBreakupEmail = input.includeBreakupEmail;
    const removeBreakupEmail = input.removeBreakupEmail;
    const shortenEmails = input.shortenEmails;
    const intent = input.intent;

    context.log.info(
      { campaignId, overwrite, mode, tone, ctaType, sequenceType, sequenceLength, includeBreakupEmail, removeBreakupEmail, shortenEmails },
      "Triggering personalized email generation",
    );

    try {
      // Guard: if not explicitly overwriting, check whether emails already exist.
      // Returning early prevents accidental regeneration and lets the agent prompt
      // the user to choose: review existing, regenerate, or start the campaign.
      if (!overwrite) {
        const existing = await context.mailflow.getPersonalizedEmails(campaignId, 1);
        if (existing.total > 0) {
          context.log.info(
            { campaignId, existingCount: existing.total },
            "Existing personalized emails found — skipping generation",
          );
          return toolSuccess({
            alreadyExists:   true,
            existingCount:   existing.total,
            generatedCount:  0,
            failedCount:     0,
            totalRecipients: 0,
            message:         `Campaign already has ${existing.total} personalized email${existing.total !== 1 ? "s" : ""}`,
            campaignId:      Number(campaignId),
          });
        }
      }

      const generationOptions = Object.fromEntries(
        Object.entries({
          mode,
          tone,
          ctaType,
          sequenceType,
          sequenceLength,
          includeBreakupEmail,
          removeBreakupEmail,
          shortenEmails,
          intent,
        }).filter(([, value]) => value !== undefined),
      ) as Record<string, unknown>;
      const result = await context.mailflow.generatePersonalizedEmails(
        campaignId,
        Object.keys(generationOptions).length > 0 ? generationOptions as never : undefined,
      );
      context.log.info(
        { campaignId, generatedCount: result.generatedCount, failedCount: result.failedCount },
        "Personalized email generation complete",
      );
      return toolSuccess(result);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to generate personalized emails");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
