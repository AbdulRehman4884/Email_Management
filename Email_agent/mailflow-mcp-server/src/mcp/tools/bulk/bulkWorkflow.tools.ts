import { TOOL_NAMES } from "../../../config/constants.js";
import {
  ApproveBulkTemplatesSchema,
  CreateBulkCampaignDraftSchema,
  CreateBulkFileJobSchema,
  CreateBulkManualRowsJobSchema,
  GetBulkStatusSchema,
  GetBulkTemplateOptionsSchema,
  GetBulkTemplatesSchema,
  RepairBulkCampaignReadinessSchema,
  RegenerateBulkTemplateSchema,
  SelectBulkTemplateStrategySchema,
} from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { createLogger } from "../../../lib/logger.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type {
  BulkApproveResult,
  BulkCampaignDraftResult,
  BulkCampaignReadinessResult,
  BulkJobCreateResult,
  BulkRegenerateResult,
  BulkStatusResult,
  BulkTemplateOption,
  BulkTemplatesResult,
  BulkTemplateStrategyResult,
} from "../../../types/mailflow.js";

function failure(err: unknown) {
  const error = serializeError(err);
  return toolFailure(error.code, error.message, error.details);
}

const log = createLogger("bulkWorkflow.tools");

export const createBulkManualRowsJobTool: McpToolDefinition<
  typeof CreateBulkManualRowsJobSchema,
  BulkJobCreateResult
> = {
  name: TOOL_NAMES.CREATE_BULK_MANUAL_ROWS_JOB,
  description: "Creates a bulk import job from manual lead rows. This validates rows only and does not send email.",
  inputSchema: CreateBulkManualRowsJobSchema,
  handler: async (input, context) => {
    try {
      log.info({ rowCount: input.rows.length, batchSize: input.batchSize }, "create_bulk_manual_rows_job called");
      const result = await context.mailflow.createBulkManualRowsJob(input);
      log.info({
        jobId: result.jobId,
        summary: result.summary,
        detectedGroupsCount: result.detectedGroups?.length ?? 0,
      }, "create_bulk_manual_rows_job succeeded");
      return toolSuccess(result);
    } catch (err) {
      log.error({ err }, "create_bulk_manual_rows_job failed");
      return failure(err);
    }
  },
};

export const createBulkFileJobTool: McpToolDefinition<
  typeof CreateBulkFileJobSchema,
  BulkJobCreateResult
> = {
  name: TOOL_NAMES.CREATE_BULK_FILE_JOB,
  description: "Creates a bulk import job from an uploaded CSV/XLSX file. This validates rows only and does not send email.",
  inputSchema: CreateBulkFileJobSchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.createBulkFileJob(input));
    } catch (err) {
      return failure(err);
    }
  },
};

export const getBulkTemplateOptionsTool: McpToolDefinition<
  typeof GetBulkTemplateOptionsSchema,
  { options: BulkTemplateOption[] }
> = {
  name: TOOL_NAMES.GET_BULK_TEMPLATE_OPTIONS,
  description: "Lists bulk campaign template strategies available for a validated import job.",
  inputSchema: GetBulkTemplateOptionsSchema,
  handler: async (_input, context) => {
    try {
      return toolSuccess(await context.mailflow.getBulkTemplateOptions());
    } catch (err) {
      return failure(err);
    }
  },
};

export const selectBulkTemplateStrategyTool: McpToolDefinition<
  typeof SelectBulkTemplateStrategySchema,
  BulkTemplateStrategyResult
> = {
  name: TOOL_NAMES.SELECT_BULK_TEMPLATE_STRATEGY,
  description: "Saves one global or category-based template strategy and starts bulk template generation. No email is sent.",
  inputSchema: SelectBulkTemplateStrategySchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.selectBulkTemplateStrategy(input));
    } catch (err) {
      return failure(err);
    }
  },
};

export const getBulkStatusTool: McpToolDefinition<
  typeof GetBulkStatusSchema,
  BulkStatusResult
> = {
  name: TOOL_NAMES.GET_BULK_STATUS,
  description: "Gets progress for a bulk import/template generation job.",
  inputSchema: GetBulkStatusSchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.getBulkStatus(input));
    } catch (err) {
      return failure(err);
    }
  },
};

export const getBulkTemplatesTool: McpToolDefinition<
  typeof GetBulkTemplatesSchema,
  BulkTemplatesResult
> = {
  name: TOOL_NAMES.GET_BULK_TEMPLATES,
  description: "Lists generated bulk templates for preview, pagination, search, and approval.",
  inputSchema: GetBulkTemplatesSchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.getBulkTemplates(input));
    } catch (err) {
      return failure(err);
    }
  },
};

export const regenerateBulkTemplateTool: McpToolDefinition<
  typeof RegenerateBulkTemplateSchema,
  BulkRegenerateResult
> = {
  name: TOOL_NAMES.REGENERATE_BULK_TEMPLATE,
  description: "Regenerates one generated bulk template with optional instructions. No email is sent.",
  inputSchema: RegenerateBulkTemplateSchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.regenerateBulkTemplate(input));
    } catch (err) {
      return failure(err);
    }
  },
};

export const approveBulkTemplatesTool: McpToolDefinition<
  typeof ApproveBulkTemplatesSchema,
  BulkApproveResult
> = {
  name: TOOL_NAMES.APPROVE_BULK_TEMPLATES,
  description: "Approves generated bulk templates for campaign draft creation. This does not create or start a campaign.",
  inputSchema: ApproveBulkTemplatesSchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.approveBulkTemplates(input));
    } catch (err) {
      return failure(err);
    }
  },
};

export const createBulkCampaignDraftTool: McpToolDefinition<
  typeof CreateBulkCampaignDraftSchema,
  BulkCampaignDraftResult
> = {
  name: TOOL_NAMES.CREATE_BULK_CAMPAIGN_DRAFT,
  description: "Creates a normal MailFlow campaign draft from approved bulk templates. It never starts sending.",
  inputSchema: CreateBulkCampaignDraftSchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.createBulkCampaignDraft(input));
    } catch (err) {
      return failure(err);
    }
  },
};

export const repairBulkCampaignReadinessTool: McpToolDefinition<
  typeof RepairBulkCampaignReadinessSchema,
  BulkCampaignReadinessResult
> = {
  name: TOOL_NAMES.REPAIR_BULK_CAMPAIGN_READINESS,
  description: "Runs a final readiness check for a bulk campaign draft and repairs legacy sender-name placeholders. It never sends email.",
  inputSchema: RepairBulkCampaignReadinessSchema,
  handler: async (input, context) => {
    try {
      const result = await context.mailflow.repairBulkCampaignReadiness(input);
      log.info({
        campaignId: input.campaignId,
        ready: result.ready,
        issues: result.issues,
        unsupportedPlaceholders: result.unsupportedPlaceholders,
        repairedFields: result.repairedFields,
      }, "repair_bulk_campaign_readiness succeeded");
      return toolSuccess(result);
    } catch (err) {
      log.error({ campaignId: input.campaignId, err }, "repair_bulk_campaign_readiness failed");
      return failure(err);
    }
  },
};
