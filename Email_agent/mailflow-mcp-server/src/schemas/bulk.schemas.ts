import { z } from "zod";

export const BulkLeadRowSchema = z.object({
  rowNumber: z.number().int().positive().optional(),
  name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().min(1),
  company: z.string().min(1),
  website: z.string().min(1),
  role: z.string().optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  notes: z.string().optional(),
});

export const CreateBulkManualRowsJobSchema = z.object({
  rows: z.array(BulkLeadRowSchema).min(1).max(5000),
  batchSize: z.number().int().min(10).max(200).optional(),
});

export const CreateBulkFileJobSchema = z.object({
  filename: z.string().min(1),
  fileContent: z.string().min(1),
  batchSize: z.number().int().min(10).max(200).optional(),
});

export const GetBulkTemplateOptionsSchema = z.object({});

export const BulkTemplateStrategySchema = z.object({
  globalTemplate: z.string().optional(),
  globalTone: z.string().optional(),
  globalCTAStyle: z.string().optional(),
  industryTemplateMap: z.record(z.string(), z.string()).optional(),
  rowTemplateMap: z.record(z.string(), z.string()).optional(),
  userCustomizationInstructions: z.string().optional(),
  approvedStyleExamples: z.array(z.string()).optional(),
});

export const SelectBulkTemplateStrategySchema = z.object({
  jobId: z.string().regex(/^\d+$/),
  strategy: BulkTemplateStrategySchema,
});

export const GetBulkStatusSchema = z.object({
  jobId: z.string().regex(/^\d+$/),
});

export const GetBulkTemplatesSchema = z.object({
  jobId: z.string().regex(/^\d+$/),
  page: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  templateType: z.string().optional(),
});

export const RegenerateBulkTemplateSchema = z.object({
  templateId: z.string().regex(/^\d+$/),
  instructions: z.string().optional(),
});

export const ApproveBulkTemplatesSchema = z.object({
  jobId: z.string().regex(/^\d+$/),
  mode: z.enum(["all", "selected"]).optional(),
  templateIds: z.array(z.number().int().positive()).optional(),
});

export const CreateBulkCampaignDraftSchema = z.object({
  jobId: z.string().regex(/^\d+$/),
  smtpSettingsId: z.number().int().positive(),
  campaignName: z.string().optional(),
  dailySendLimit: z.number().int().positive().max(1000).optional(),
});

export const RepairBulkCampaignReadinessSchema = z.object({
  campaignId: z.string().regex(/^\d+$/),
});

export type CreateBulkManualRowsJobInput = z.infer<typeof CreateBulkManualRowsJobSchema>;
export type CreateBulkFileJobInput = z.infer<typeof CreateBulkFileJobSchema>;
export type GetBulkTemplateOptionsInput = z.infer<typeof GetBulkTemplateOptionsSchema>;
export type SelectBulkTemplateStrategyInput = z.infer<typeof SelectBulkTemplateStrategySchema>;
export type GetBulkStatusInput = z.infer<typeof GetBulkStatusSchema>;
export type GetBulkTemplatesInput = z.infer<typeof GetBulkTemplatesSchema>;
export type RegenerateBulkTemplateInput = z.infer<typeof RegenerateBulkTemplateSchema>;
export type ApproveBulkTemplatesInput = z.infer<typeof ApproveBulkTemplatesSchema>;
export type CreateBulkCampaignDraftInput = z.infer<typeof CreateBulkCampaignDraftSchema>;
export type RepairBulkCampaignReadinessInput = z.infer<typeof RepairBulkCampaignReadinessSchema>;
