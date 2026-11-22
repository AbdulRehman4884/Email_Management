/**
 * src/mcp/tools/campaign/getAllCampaigns.tool.ts
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GetAllCampaignsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { Campaign } from "../../../types/mailflow.js";

/** "QA-Auto" / "qa auto" / "qa_auto" compare equal. */
const tagKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export const getAllCampaignsTool: McpToolDefinition<
  typeof GetAllCampaignsSchema,
  Campaign[]
> = {
  name: TOOL_NAMES.GET_ALL_CAMPAIGNS,

  description:
    "Returns all email campaigns belonging to the authenticated user. " +
    "Each campaign includes its id, name, subject, status, and timestamps. " +
    "With `tag`, only the campaigns that have that campaign tag (same as the Campaigns page tag filter).",

  inputSchema: GetAllCampaignsSchema,

  handler: async (input, context) => {
    context.log.info({ tag: input.tag }, "Fetching all campaigns");

    try {
      const campaigns = await context.mailflow.getAllCampaigns();

      // "Show campaigns tagged QA-Auto": the tag in the question was ignored and all campaigns were listed.
      if (input.tag) {
        const map = await context.mailflow.getCampaignTagMap();
        const wanted = tagKey(input.tag);
        const tag = map.tags.find((t) => t.scope !== "contact" && tagKey(t.name) === wanted);
        const tagged = tag
          ? campaigns.filter((c) => (map.campaigns[String(c.id)] ?? []).includes(tag.id))
          : [];
        context.log.info({ tag: input.tag, known: !!tag, count: tagged.length }, "Campaigns filtered by tag");
        return toolSuccess(tagged);
      }

      context.log.info({ count: campaigns.length }, "Campaigns fetched successfully");

      return toolSuccess(campaigns);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to fetch campaigns");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
