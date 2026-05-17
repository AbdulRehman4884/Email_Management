/**
 * src/schemas/index.ts
 *
 * Re-exports all Zod schemas and their inferred input types.
 * Import from this barrel in tool files and tests.
 */

export {
  CreateCampaignSchema,
  GetCampaignStatsSchema,
  PauseCampaignSchema,
  ResumeCampaignSchema,
  StartCampaignSchema,
  UpdateCampaignSchema,
  type CreateCampaignInput,
  type GetCampaignStatsInput,
  type PauseCampaignInput,
  type ResumeCampaignInput,
  type StartCampaignInput,
  type UpdateCampaignInput,
} from "./campaign.schemas.js";

export {
  ListRepliesSchema,
  SummarizeRepliesSchema,
  type ListRepliesInput,
  type SummarizeRepliesInput,
} from "./inbox.schemas.js";

export {
  GetSmtpSettingsSchema,
  UpdateSmtpSettingsSchema,
  type GetSmtpSettingsInput,
  type UpdateSmtpSettingsInput,
} from "./settings.schemas.js";
