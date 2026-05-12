/**
 * src/schemas/index.ts
 *
 * Re-exports all Zod schemas and their inferred input types.
 * Import from this barrel in tool files and tests.
 */

export {
  GetAllCampaignsSchema,
  CreateCampaignSchema,
  GetCampaignStatsSchema,
  GetSequenceProgressSchema,
  GetPendingFollowUpsSchema,
  GetRecipientTouchHistorySchema,
  MarkRecipientRepliedSchema,
  MarkRecipientBouncedSchema,
  PauseCampaignSchema,
  ResumeCampaignSchema,
  StartCampaignSchema,
  UpdateCampaignSchema,
  GetRecipientCountSchema,
  SaveAiPromptSchema,
  GeneratePersonalizedEmailsSchema,
  GetPersonalizedEmailsSchema,
  type GetAllCampaignsInput,
  type CreateCampaignInput,
  type GetCampaignStatsInput,
  type GetSequenceProgressInput,
  type GetPendingFollowUpsInput,
  type GetRecipientTouchHistoryInput,
  type MarkRecipientRepliedInput,
  type MarkRecipientBouncedInput,
  type PauseCampaignInput,
  type ResumeCampaignInput,
  type StartCampaignInput,
  type UpdateCampaignInput,
  type GetRecipientCountInput,
  type SaveAiPromptInput,
  type GeneratePersonalizedEmailsInput,
  type GetPersonalizedEmailsInput,
  ParseCsvFileSchema,
  SaveCsvRecipientsSchema,
  type ParseCsvFileInput,
  type SaveCsvRecipientsInput,
} from "./campaign.schemas.js";

export {
  ListRepliesSchema,
  SummarizeRepliesSchema,
  ReplyIntelligenceSummarySchema,
  ReplyLeadListSchema,
  DraftReplySuggestionSchema,
  MarkReplyHumanReviewSchema,
  AutonomousRecommendationSchema,
  CampaignAutonomousSummarySchema,
  PreviewSequenceAdaptationSchema,
  type ListRepliesInput,
  type SummarizeRepliesInput,
  type ReplyIntelligenceSummaryInput,
  type ReplyLeadListInput,
  type DraftReplySuggestionInput,
  type MarkReplyHumanReviewInput,
  type AutonomousRecommendationInput,
  type CampaignAutonomousSummaryInput,
  type PreviewSequenceAdaptationInput,
} from "./inbox.schemas.js";

export {
  GetSmtpSettingsSchema,
  UpdateSmtpSettingsSchema,
  type GetSmtpSettingsInput,
  type UpdateSmtpSettingsInput,
} from "./settings.schemas.js";

export {
  ValidateEmailSchema,
  EnrichDomainSchema,
  SearchCompanySchema,
  ClassifyIndustrySchema,
  ScoreLeadSchema,
  GenerateOutreachTemplateSchema,
  SaveEnrichedContactsSchema,
  type ValidateEmailInput,
  type EnrichDomainInput,
  type SearchCompanyInput,
  type ClassifyIndustryInput,
  type ScoreLeadInput,
  type GenerateOutreachTemplateInput,
  type SaveEnrichedContactsInput,
} from "./enrichment.schemas.js";
