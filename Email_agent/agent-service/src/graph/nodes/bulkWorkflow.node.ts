import { createLogger } from "../../lib/logger.js";
import { mcpClientService } from "../../services/mcpClient.service.js";
import { asUserId } from "../../types/common.js";
import type { AgentGraphStateType, BulkWorkflowState } from "../state/agentGraph.state.js";
import type { AuthContext } from "../../types/common.js";
import type { KnownToolName } from "../../types/tools.js";
import { parseManualBulkRows } from "../../lib/parseManualBulkRows.js";

const log = createLogger("node:bulkWorkflow");

interface NormalizedBulkJobCreateResponse {
  jobId: number;
  summary: Record<string, number>;
  detectedGroups: unknown[];
  templateOptions: unknown[];
}

const TEMPLATE_LABELS: Record<string, string> = {
  executive_consultative: "Executive Consultative",
  soft_relationship: "Soft Relationship Outreach",
  enterprise_transformation: "Enterprise Transformation",
  cfo_finance_visibility: "CFO Finance Visibility",
  fintech_compliance: "Fintech Compliance / Lending Workflow",
  product_engineering_delivery: "Product Engineering / Delivery Scale",
  ai_workflow_intelligence: "AI Automation / Workflow Intelligence",
  operational_visibility: "Operational Visibility / Delivery Coordination",
  revops_pipeline: "RevOps / Pipeline Efficiency",
  reengagement_followup: "Re-engagement / Follow-up",
};

export async function bulkWorkflowNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const auth = makeAuth(state);
  if (!auth) {
    return { error: "Authentication credentials are not available. Please log in again." };
  }

  try {
    const intent = state.intent ?? "start_bulk_template_workflow";
    const workflow = state.bulkWorkflow;

    if (intent === "bulk_file_intake" && state.pendingCsvFile) {
      return await handleFileIntake(state, auth);
    }

    if (!workflow || intent === "bulk_manual_rows_intake" || intent === "start_bulk_template_workflow") {
      return await handleManualRowsIntake(state, auth);
    }

    if (workflow.awaitingFinalConfirm || workflow.currentStep === "awaiting_final_confirm") {
      return await handleFinalConfirmation(state, auth, workflow);
    }

    if (intent === "bulk_select_template_strategy" || workflow.currentStep === "awaiting_template_strategy") {
      return await handleStrategySelection(state, auth, workflow);
    }

    if (intent === "bulk_create_campaign_draft" || (/approve/i.test(state.userMessage) && /draft|campaign/i.test(state.userMessage))) {
      return await handleApproveAndDraft(state, auth, workflow);
    }

    if (intent === "bulk_approve_templates") {
      return await handleApprovalOnly(state, auth, workflow);
    }

    if (intent === "bulk_regenerate_template" || intent === "bulk_customize_template") {
      return await handleRegenerate(state, auth, workflow);
    }

    return await handleStatusPreview(state, auth, workflow);
  } catch (err) {
    log.error({ err, sessionId: state.sessionId }, "bulk workflow failed");
    return { error: "I could not complete the bulk workflow step. Please try again." };
  }
}

function makeAuth(state: AgentGraphStateType): AuthContext | undefined {
  if (!state.rawToken) return undefined;
  return {
    userId: state.userId ?? asUserId("unknown"),
    rawToken: state.rawToken,
  };
}

async function handleManualRowsIntake(state: AgentGraphStateType, auth: AuthContext): Promise<Partial<AgentGraphStateType>> {
  const rows = parseManualBulkRows(state.userMessage);
  if (rows.length === 0) {
    return {
      activeCampaignId: undefined,
      bulkWorkflow: { currentStep: "awaiting_rows", sourceType: "manual_rows" },
      formattedResponse:
          "I could not detect valid rows. Please provide:\n\n" +
          "Company / Website / Email\n\n" +
          "Example:\nSystems Limited / https://www.systemsltd.com / test1@example.com",
    };
  }

  const result = await callData("create_bulk_manual_rows_job", { rows, batchSize: 50 }, auth);
  const normalized = normalizeBulkJobCreateResponse(result);
  if (!normalized.ok) {
    log.warn(
      { sessionId: state.sessionId, missingFields: normalized.missingFields, rawResponse: result },
      "create_bulk_manual_rows_job response incomplete",
    );
    return {
      bulkWorkflow: { currentStep: "awaiting_rows", sourceType: "manual_rows" },
      formattedResponse: "Bulk workflow response was incomplete. Please try again.",
    };
  }
  const { jobId, summary, detectedGroups, templateOptions: options } = normalized.value;
  log.info(
    { sessionId: state.sessionId, jobId, summary, detectedGroupsCount: detectedGroups.length },
    "create_bulk_manual_rows_job response normalized",
  );
  const industryTemplateMap = Object.fromEntries(
    detectedGroups.map((g) => {
      const item = objectValue(g);
      return [String(item.group ?? "unknown"), String(item.recommendedTemplate ?? "executive_consultative")];
    }),
  );

  const workflow: BulkWorkflowState = {
    jobId,
    sourceType: "manual_rows",
    rowsSummary: summary,
    currentStep: "awaiting_template_strategy",
    industryTemplateMap,
  };

  return {
    activeCampaignId: undefined,
    bulkWorkflow: workflow,
    formattedResponse: renderValidationAndStrategy(jobId, summary, options, detectedGroups),
  };
}

async function handleFileIntake(state: AgentGraphStateType, auth: AuthContext): Promise<Partial<AgentGraphStateType>> {
  const file = state.pendingCsvFile;
  if (!file) return handleManualRowsIntake(state, auth);
  const result = await callData("create_bulk_file_job", { filename: file.filename, fileContent: file.fileContent, batchSize: 50 }, auth);
  const normalized = normalizeBulkJobCreateResponse(result);
  if (!normalized.ok) {
    log.warn(
      { sessionId: state.sessionId, missingFields: normalized.missingFields, rawResponse: result },
      "create_bulk_file_job response incomplete",
    );
    return {
      pendingCsvFile: undefined,
      bulkWorkflow: { currentStep: "awaiting_rows", sourceType: "csv_upload" },
      formattedResponse: "Bulk workflow response was incomplete. Please try again.",
    };
  }
  const { jobId, summary, detectedGroups, templateOptions: options } = normalized.value;
  const industryTemplateMap = Object.fromEntries(
    detectedGroups.map((g) => {
      const item = objectValue(g);
      return [String(item.group ?? "unknown"), String(item.recommendedTemplate ?? "executive_consultative")];
    }),
  );
  return {
    activeCampaignId: undefined,
    pendingCsvFile: undefined,
    bulkWorkflow: { jobId, sourceType: "csv_upload", rowsSummary: summary, currentStep: "awaiting_template_strategy", industryTemplateMap },
    formattedResponse: renderValidationAndStrategy(jobId, summary, options, detectedGroups),
  };
}

async function handleStrategySelection(
  state: AgentGraphStateType,
  auth: AuthContext,
  workflow: BulkWorkflowState,
): Promise<Partial<AgentGraphStateType>> {
  if (!workflow.jobId) return { formattedResponse: "I need a validated bulk job before selecting a template strategy." };
  const strategy = parseStrategy(state.userMessage, workflow);
  await callData("select_bulk_template_strategy", { jobId: String(workflow.jobId), strategy }, auth, 60_000);
  const nextWorkflow: BulkWorkflowState = {
    ...workflow,
    currentStep: "generating_templates",
    selectedTemplateStrategy: strategy.globalTemplate ?? "recommended_mapping",
    selectedTone: strategy.globalTone,
    selectedCTA: strategy.globalCTAStyle,
    industryTemplateMap: strategy.industryTemplateMap ?? workflow.industryTemplateMap,
  };
  const preview = await pollPreview(workflow.jobId, auth);
  if (preview) {
    return {
      bulkWorkflow: { ...nextWorkflow, currentStep: "awaiting_template_approval", previewTemplateIds: preview.ids },
      formattedResponse:
        "Great. I generated templates in batches using the selected strategy. No emails were sent.\n\n" +
        preview.markdown +
        "\n\nApprove all, edit one, regenerate one, or change template strategy?",
    };
  }
  const status = await callData("get_bulk_status", { jobId: String(workflow.jobId) }, auth) as Record<string, unknown>;
  return {
    bulkWorkflow: nextWorkflow,
    formattedResponse: renderProgress(status),
  };
}

async function handleStatusPreview(
  _state: AgentGraphStateType,
  auth: AuthContext,
  workflow: BulkWorkflowState,
): Promise<Partial<AgentGraphStateType>> {
  if (!workflow.jobId) return { formattedResponse: "No bulk job is active yet." };
  const preview = await pollPreview(workflow.jobId, auth, 1);
  if (preview) {
    return {
      bulkWorkflow: { ...workflow, currentStep: "awaiting_template_approval", previewTemplateIds: preview.ids },
      formattedResponse: preview.markdown + "\n\nApprove all, edit one, regenerate one, or change template strategy?",
    };
  }
  const status = await callData("get_bulk_status", { jobId: String(workflow.jobId) }, auth) as Record<string, unknown>;
  return { bulkWorkflow: workflow, formattedResponse: renderProgress(status) };
}

async function handleApprovalOnly(
  _state: AgentGraphStateType,
  auth: AuthContext,
  workflow: BulkWorkflowState,
): Promise<Partial<AgentGraphStateType>> {
  if (!workflow.jobId) return { formattedResponse: "No bulk job is active yet." };
  const approved = await callData("approve_bulk_templates", { jobId: String(workflow.jobId), mode: "all" }, auth) as Record<string, unknown>;
  const count = Number(approved.approved ?? 0);
  return {
    bulkWorkflow: { ...workflow, approvedCount: count, currentStep: "templates_approved" },
    formattedResponse: `Approved ${count} templates. No campaign has been created and no emails have been sent.\n\nSay **create campaign draft** when you are ready.`,
  };
}

async function handleApproveAndDraft(
  state: AgentGraphStateType,
  auth: AuthContext,
  workflow: BulkWorkflowState,
): Promise<Partial<AgentGraphStateType>> {
  if (!workflow.jobId) return { formattedResponse: "No bulk job is active yet." };
  const approved = await callData("approve_bulk_templates", { jobId: String(workflow.jobId), mode: "all" }, auth) as Record<string, unknown>;
  const smtp = await callData("get_smtp_settings", {}, auth) as Record<string, unknown>;
  const smtpData = objectValue(smtp.data ?? smtp);
  const smtpSettingsId = Number(smtpData.id);
  if (!Number.isFinite(smtpSettingsId) || smtpSettingsId < 1) {
    return {
      bulkWorkflow: { ...workflow, approvedCount: Number(approved.approved ?? 0), currentStep: "templates_approved" },
      formattedResponse: "Templates were approved, but I could not find a valid SMTP profile for the campaign draft. Please configure SMTP settings first.",
    };
  }
  const draft = await callData("create_bulk_campaign_draft", {
    jobId: String(workflow.jobId),
    smtpSettingsId,
    campaignName: `Bulk Executive Outreach - ${new Date().toISOString().slice(0, 10)}`,
    dailySendLimit: 50,
  }, auth, 60_000) as Record<string, unknown>;
  const campaignId = Number(draft.campaignId);
  return {
    activeCampaignId: String(campaignId),
    bulkWorkflow: {
      ...workflow,
      approvedCount: Number(approved.approved ?? draft.recipients ?? 0),
      campaignDraftId: campaignId,
      currentStep: "awaiting_final_confirm",
      awaitingFinalConfirm: true,
    },
    formattedResponse:
      "# Campaign Draft Created\n\n" +
      `Campaign ID: ${campaignId}\n` +
      `Approved recipients: ${draft.recipients ?? approved.approved ?? 0}\n` +
      `Status: ${draft.status ?? "draft"}\n` +
      `Estimated send duration: ${draft.estimatedSendDurationDays ?? 1} day(s)\n\n` +
      "No emails have been sent.\n\n" +
      "Final confirmation is required before starting. Type **CONFIRM** to start campaign, or say edit/cancel.",
  };
}

async function handleFinalConfirmation(
  state: AgentGraphStateType,
  auth: AuthContext,
  workflow: BulkWorkflowState,
): Promise<Partial<AgentGraphStateType>> {
  if ((workflow.pendingStartConflictCampaigns?.length ?? 0) > 0 || workflow.pendingStartConflictCampaignId) {
    return await handlePendingStartConflict(state, auth, workflow);
  }
  if (state.userMessage.trim() !== "CONFIRM") {
    return {
      bulkWorkflow: workflow,
      formattedResponse:
        "I have not started the campaign. Final send approval requires the exact word **CONFIRM**.\n\n" +
        "Type **CONFIRM** to start, or say edit/cancel.",
    };
  }
  const campaignId = workflow.campaignDraftId;
  if (!campaignId) return { formattedResponse: "No campaign draft is ready to start." };
  log.info({ campaignId }, "bulk final CONFIRM received; running readiness check");
  const readinessResult = await callRaw(
    "repair_bulk_campaign_readiness",
    { campaignId: String(campaignId) },
    auth,
    60_000,
  );
  log.info({
    campaignId,
    isToolError: readinessResult.isToolError,
    rawReadinessResponse: readinessResult.data,
  }, "bulk final readiness MCP response received");
  const readinessFailure = extractToolFailure(readinessResult);
  if (readinessFailure) {
    return {
      bulkWorkflow: workflow,
      formattedResponse: `Campaign could not start because the final readiness check failed: ${readinessFailure.message}`,
    };
  }
  const readiness = normalizeReadiness(objectValue(readinessResult.data).data ?? readinessResult.data);
  log.info({
    campaignId,
    ready: readiness.ready,
    issues: readiness.issues,
    unsupportedPlaceholders: readiness.unsupportedPlaceholders,
    repairedFields: readiness.repairedFields,
    repairedSenderName: readiness.repairedSenderName,
  }, "bulk final readiness check completed");

  if (!readiness.ready) {
    return {
      bulkWorkflow: workflow,
      formattedResponse: renderReadinessFailure(readiness),
    };
  }

  const blockers = await findRunningCampaignBlockers(auth, campaignId);
  if (blockers.length > 0) {
    log.warn({ campaignId, blockers }, "bulk final start blocked by running campaigns before start call");
    return {
      bulkWorkflow: {
        ...workflow,
        currentStep: "awaiting_final_confirm",
        awaitingFinalConfirm: true,
        pendingStartConflictCampaigns: blockers,
        pendingStartConflictCampaignId: blockers[0]?.id,
        pendingStartConflictCampaignName: blockers[0]?.name,
      },
      formattedResponse: renderStartConflicts(blockers),
    };
  }

  const startResult = await callRaw("start_campaign", { campaignId: String(campaignId) }, auth, 60_000);
  log.info({
    campaignId,
    isToolError: startResult.isToolError,
    rawStartResponse: startResult.data,
  }, "bulk final start_campaign response received");
  const startFailure = extractToolFailure(startResult);
  if (startFailure) {
    const conflicts = extractStartConflicts(startFailure);
    if (conflicts.length > 0) {
      log.warn({
        campaignId,
        conflicts,
      }, "bulk final start blocked by running campaign conflict");
      return {
        bulkWorkflow: {
          ...workflow,
          currentStep: "awaiting_final_confirm",
          awaitingFinalConfirm: true,
          pendingStartConflictCampaigns: conflicts,
          pendingStartConflictCampaignId: conflicts[0]?.id,
          pendingStartConflictCampaignName: conflicts[0]?.name,
        },
        formattedResponse: renderStartConflicts(conflicts),
      };
    }
    return {
      bulkWorkflow: workflow,
      formattedResponse: renderStartFailure(startFailure),
    };
  }
  return {
    bulkWorkflow: { ...workflow, currentStep: "campaign_started", awaitingFinalConfirm: false },
    formattedResponse: "Campaign started using the existing MailFlow worker/SMTP pipeline.",
  };
}

async function handlePendingStartConflict(
  state: AgentGraphStateType,
  auth: AuthContext,
  workflow: BulkWorkflowState,
): Promise<Partial<AgentGraphStateType>> {
  const campaignId = workflow.campaignDraftId;
  const conflictCampaigns = normalizePendingConflictCampaigns(workflow);
  if (!campaignId || conflictCampaigns.length === 0) return { formattedResponse: "No campaign draft conflict is active." };

  if (state.userMessage.trim() !== "PAUSE ALL AND START") {
    return {
      bulkWorkflow: workflow,
      formattedResponse:
        renderStartConflicts(conflictCampaigns) +
        "\n\nI have not paused or started anything. To pause all blocking campaigns and start this draft, type **PAUSE ALL AND START** exactly.",
    };
  }

  log.warn({ campaignId, conflictCampaigns }, "bulk conflict override approved; pausing all blockers before start");
  const pausedCampaignIds: number[] = [];
  for (const blocker of conflictCampaigns) {
    const pauseResult = await callRaw("pause_campaign", { campaignId: String(blocker.id) }, auth, 60_000);
    const pauseFailure = extractToolFailure(pauseResult);
    if (pauseFailure) {
      return {
        bulkWorkflow: workflow,
        formattedResponse: `Campaign #${campaignId} was not started because campaign #${blocker.id} could not be paused: ${pauseFailure.message}`,
      };
    }
    pausedCampaignIds.push(blocker.id);
  }

  const retryWorkflow: BulkWorkflowState = {
    ...workflow,
    pendingStartConflictCampaigns: undefined,
    pendingStartConflictCampaignId: undefined,
    pendingStartConflictCampaignName: undefined,
  };
  const readinessResult = await callRaw(
    "repair_bulk_campaign_readiness",
    { campaignId: String(campaignId) },
    auth,
    60_000,
  );
  const readinessFailure = extractToolFailure(readinessResult);
  if (readinessFailure) {
    return {
      bulkWorkflow: retryWorkflow,
      formattedResponse: `Campaigns ${formatCampaignIdList(pausedCampaignIds)} were paused, but campaign #${campaignId} could not start because the final readiness check failed: ${readinessFailure.message}`,
    };
  }
  const readiness = normalizeReadiness(objectValue(readinessResult.data).data ?? readinessResult.data);
  if (!readiness.ready) {
    return {
      bulkWorkflow: retryWorkflow,
      formattedResponse: `Campaigns ${formatCampaignIdList(pausedCampaignIds)} were paused, but campaign #${campaignId} is still not ready.\n\n${renderReadinessFailure(readiness)}`,
    };
  }

  const remainingBlockers = await findRunningCampaignBlockers(auth, campaignId);
  if (remainingBlockers.length > 0) {
    return {
      bulkWorkflow: {
        ...retryWorkflow,
        currentStep: "awaiting_final_confirm",
        awaitingFinalConfirm: true,
        pendingStartConflictCampaigns: remainingBlockers,
        pendingStartConflictCampaignId: remainingBlockers[0]?.id,
        pendingStartConflictCampaignName: remainingBlockers[0]?.name,
      },
      formattedResponse:
        `Campaigns ${formatCampaignIdList(pausedCampaignIds)} were paused, but another running campaign is still blocking this draft.\n\n` +
        renderStartConflicts(remainingBlockers),
    };
  }

  const startResult = await callRaw("start_campaign", { campaignId: String(campaignId) }, auth, 60_000);
  log.info({ campaignId, rawStartResponse: startResult.data, isToolError: startResult.isToolError }, "bulk conflict retry start_campaign response received");
  const startFailure = extractToolFailure(startResult);
  if (startFailure) {
    const blockers = extractStartConflicts(startFailure);
    if (blockers.length > 0) {
      return {
        bulkWorkflow: {
          ...retryWorkflow,
          currentStep: "awaiting_final_confirm",
          awaitingFinalConfirm: true,
          pendingStartConflictCampaigns: blockers,
          pendingStartConflictCampaignId: blockers[0]?.id,
          pendingStartConflictCampaignName: blockers[0]?.name,
        },
        formattedResponse:
          `Campaigns ${formatCampaignIdList(pausedCampaignIds)} were paused, but MailFlow found another running conflict after retry.\n\n` +
          renderStartConflicts(blockers),
      };
    }
    return {
      bulkWorkflow: retryWorkflow,
      formattedResponse: renderStartFailure(startFailure),
    };
  }

  return {
    bulkWorkflow: { ...retryWorkflow, currentStep: "campaign_started", awaitingFinalConfirm: false },
    formattedResponse: `Campaigns ${formatCampaignIdList(pausedCampaignIds)} were paused. Campaign #${campaignId} started using the existing MailFlow worker/SMTP pipeline.`,
  };
}

async function handleRegenerate(
  state: AgentGraphStateType,
  auth: AuthContext,
  workflow: BulkWorkflowState,
): Promise<Partial<AgentGraphStateType>> {
  if (!workflow.jobId) return { formattedResponse: "No bulk job is active yet." };
  const templates = await callData("get_bulk_templates", { jobId: String(workflow.jobId), limit: 50 }, auth) as Record<string, unknown>;
  const list = arrayValue(templates.templates);
  const target = findTemplateForMessage(list, state.userMessage);
  if (!target) {
    return { bulkWorkflow: workflow, formattedResponse: "Which company should I regenerate? For example: **Regenerate NETSOL**." };
  }
  await callData("regenerate_bulk_template", { templateId: String(target.id), instructions: state.userMessage }, auth, 60_000);
  const preview = await pollPreview(workflow.jobId, auth, 1);
  return {
    bulkWorkflow: { ...workflow, currentStep: "awaiting_template_approval" },
    formattedResponse: `Regenerated ${target.company ?? "the selected row"}.\n\n${preview?.markdown ?? "Preview is ready."}`,
  };
}

async function pollPreview(jobId: number, auth: AuthContext, attempts = 5): Promise<{ markdown: string; ids: number[] } | undefined> {
  for (let i = 0; i < attempts; i += 1) {
    const status = await callData("get_bulk_status", { jobId: String(jobId) }, auth) as Record<string, unknown>;
    if (String(status.status) === "completed" || Number(status.processed ?? 0) > 0) {
      const templates = await callData("get_bulk_templates", { jobId: String(jobId), limit: 3 }, auth) as Record<string, unknown>;
      const list = arrayValue(templates.templates);
      if (list.length > 0) {
        return { markdown: renderTemplatePreview(status, list), ids: list.map((t) => Number(objectValue(t).id)).filter(Number.isFinite) };
      }
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return undefined;
}

async function callData(toolName: string, args: Record<string, unknown>, auth: AuthContext, timeoutMs = 30_000): Promise<unknown> {
  const result = await callRaw(toolName, args, auth, timeoutMs);
  log.debug({ toolName, args, rawMcpResponse: result.data, isToolError: result.isToolError }, "bulk MCP response received");
  if (result.isToolError) throw new Error(`MCP tool failed: ${toolName}`);
  const envelope = objectValue(result.data);
  if (envelope.success === false) throw new Error(String(objectValue(envelope.error).message ?? `Tool failed: ${toolName}`));
  return envelope.data ?? result.data;
}

async function callRaw(toolName: string, args: Record<string, unknown>, auth: AuthContext, timeoutMs = 30_000) {
  return mcpClientService.dispatch(toolName as KnownToolName, args, auth, { timeoutMs });
}

interface ToolFailureInfo {
  code?: string;
  message: string;
  details?: unknown;
}

function extractToolFailure(result: Awaited<ReturnType<typeof callRaw>>): ToolFailureInfo | undefined {
  if (result.isToolError) {
    const data = objectValue(result.data);
    const error = objectValue(data.error);
    return {
      code: typeof error.code === "string" ? error.code : undefined,
      message: String(error.message ?? data.message ?? "MCP tool failed"),
      details: error.details,
    };
  }
  const envelope = objectValue(result.data);
  if (envelope.success === false) {
    const error = objectValue(envelope.error);
    return {
      code: typeof error.code === "string" ? error.code : undefined,
      message: String(error.message ?? envelope.message ?? "Tool failed"),
      details: error.details,
    };
  }
  return undefined;
}

function normalizeBulkJobCreateResponse(result: unknown):
  | { ok: true; value: NormalizedBulkJobCreateResponse }
  | { ok: false; missingFields: string[] } {
  const data = unwrapBulkData(result);
  const jobId = toPositiveNumber(data.jobId ?? data.id);
  const summary = normalizeBulkSummary(data.summary ?? data.validationSummary ?? data.rowsSummary);
  const missingFields: string[] = [];
  if (!jobId) missingFields.push("jobId");
  if (!summary) missingFields.push("summary");

  if (missingFields.length > 0 || !jobId || !summary) {
    return { ok: false, missingFields };
  }

  return {
    ok: true,
    value: {
      jobId,
      summary,
      detectedGroups: arrayValue(data.detectedGroups),
      templateOptions: arrayValue(data.templateOptions ?? data.options),
    },
  };
}

function unwrapBulkData(result: unknown): Record<string, unknown> {
  let current = objectValue(result);
  for (let i = 0; i < 3; i += 1) {
    const nested = objectValue(current.data);
    if (Object.keys(nested).length === 0) break;
    current = nested;
  }
  return current;
}

function normalizeBulkSummary(value: unknown): Record<string, number> | undefined {
  const raw = objectValue(value);
  const totalRows = toNonNegativeNumber(raw.totalRows ?? raw.total ?? raw.rowsTotal);
  const validRows = toNonNegativeNumber(raw.validRows ?? raw.valid);
  const invalidRows = toNonNegativeNumber(raw.invalidRows ?? raw.invalid);
  const duplicateRows = toNonNegativeNumber(raw.duplicateRows ?? raw.duplicates);
  if (totalRows === undefined || validRows === undefined || invalidRows === undefined || duplicateRows === undefined) {
    return undefined;
  }
  return {
    totalRows,
    validRows,
    invalidRows,
    duplicateRows,
    valid: validRows,
    invalid: invalidRows,
    duplicates: duplicateRows,
  };
}

interface NormalizedCampaignReadiness {
  ready: boolean;
  campaignFound: boolean;
  smtpConfigured: boolean;
  recipientsExist: boolean;
  recipientCount: number;
  pendingRecipientCount: number;
  unsupportedPlaceholders: string[];
  repairedSenderName: boolean;
  repairedFields: string[];
  issues: string[];
}

function normalizeReadiness(value: unknown): NormalizedCampaignReadiness {
  const data = unwrapBulkData(value);
  return {
    ready: data.ready === true,
    campaignFound: data.campaignFound !== false,
    smtpConfigured: data.smtpConfigured === true,
    recipientsExist: data.recipientsExist === true,
    recipientCount: Number(data.recipientCount ?? 0),
    pendingRecipientCount: Number(data.pendingRecipientCount ?? 0),
    unsupportedPlaceholders: arrayValue(data.unsupportedPlaceholders).map(String).filter(Boolean),
    repairedSenderName: data.repairedSenderName === true,
    repairedFields: arrayValue(data.repairedFields).map(String).filter(Boolean),
    issues: arrayValue(data.issues).map(String).filter(Boolean),
  };
}

function renderReadinessFailure(readiness: NormalizedCampaignReadiness): string {
  if (!readiness.campaignFound || readiness.issues.includes("campaign_not_found")) {
    return "Campaign could not start because the campaign draft was not found. Please create a new campaign draft and try again.";
  }
  if (readiness.unsupportedPlaceholders.length > 0 || readiness.issues.includes("unsupported_placeholders")) {
    return `Campaign could not start because unsupported placeholders remain: ${readiness.unsupportedPlaceholders.join(", ")}.\n\nAllowed placeholders are: name, email, company, website, role, industry, persona.`;
  }
  if (!readiness.smtpConfigured || readiness.issues.includes("smtp_not_configured")) {
    return "Campaign could not start because SMTP is not configured for this draft. Please select or configure an SMTP profile, then try again.";
  }
  if (!readiness.recipientsExist || readiness.issues.includes("no_pending_recipients")) {
    return "Campaign could not start because there are no pending recipients available for this draft. Please add or approve recipients before starting.";
  }
  return `Campaign could not start because the readiness check failed: ${readiness.issues.join(", ") || "unknown readiness issue"}.`;
}

interface StartConflictInfo {
  conflictCampaignId: number;
  conflictCampaignName?: string;
}

interface RunningCampaignBlocker {
  id: number;
  name?: string;
}

async function findRunningCampaignBlockers(auth: AuthContext, currentCampaignId: number): Promise<RunningCampaignBlocker[]> {
  const campaigns = await callData("get_all_campaigns", {}, auth, 60_000);
  return arrayValue(campaigns)
    .map((campaign) => objectValue(campaign))
    .map((campaign) => ({
      id: Number(campaign.id),
      name: typeof campaign.name === "string" ? campaign.name : undefined,
      status: String(campaign.status ?? "").toLowerCase(),
    }))
    .filter((campaign) => Number.isFinite(campaign.id) && campaign.id > 0)
    .filter((campaign) => campaign.id !== currentCampaignId)
    .filter((campaign) => campaign.status === "running" || campaign.status === "in_progress")
    .map(({ id, name }) => ({ id, name }));
}

function normalizePendingConflictCampaigns(workflow: BulkWorkflowState): RunningCampaignBlocker[] {
  const list = arrayValue(workflow.pendingStartConflictCampaigns)
    .map((campaign) => objectValue(campaign))
    .map((campaign) => ({
      id: Number(campaign.id),
      name: typeof campaign.name === "string" ? campaign.name : undefined,
    }))
    .filter((campaign) => Number.isFinite(campaign.id) && campaign.id > 0);
  if (list.length > 0) return dedupeCampaignBlockers(list);
  if (workflow.pendingStartConflictCampaignId) {
    return [{ id: workflow.pendingStartConflictCampaignId, name: workflow.pendingStartConflictCampaignName }];
  }
  return [];
}

function dedupeCampaignBlockers(blockers: RunningCampaignBlocker[]): RunningCampaignBlocker[] {
  const seen = new Set<number>();
  const result: RunningCampaignBlocker[] = [];
  for (const blocker of blockers) {
    if (seen.has(blocker.id)) continue;
    seen.add(blocker.id);
    result.push(blocker);
  }
  return result;
}

function extractStartConflict(failure: ToolFailureInfo): StartConflictInfo | undefined {
  const details = objectValue(failure.details);
  const nested = objectValue(details.error).conflictCampaignId ? objectValue(details.error) : details;
  const id = Number(nested.conflictCampaignId ?? details.conflictCampaignId);
  if ((failure.code === "MAILFLOW_CONFLICT" || /already running|smtp.*already running|smtp.*in use/i.test(failure.message)) && Number.isFinite(id) && id > 0) {
    return {
      conflictCampaignId: id,
      conflictCampaignName: typeof nested.conflictCampaignName === "string"
        ? nested.conflictCampaignName
        : typeof details.conflictCampaignName === "string"
          ? details.conflictCampaignName
          : undefined,
    };
  }
  return undefined;
}

function extractStartConflicts(failure: ToolFailureInfo): RunningCampaignBlocker[] {
  const details = objectValue(failure.details);
  const nested = objectValue(details.error).conflictCampaignId || arrayValue(objectValue(details.error).conflictCampaigns).length > 0
    ? objectValue(details.error)
    : details;
  const listed = arrayValue(nested.conflictCampaigns ?? details.conflictCampaigns)
    .map((campaign) => objectValue(campaign))
    .map((campaign) => ({
      id: Number(campaign.id),
      name: typeof campaign.name === "string" ? campaign.name : undefined,
    }))
    .filter((campaign) => Number.isFinite(campaign.id) && campaign.id > 0);
  if (listed.length > 0 && (failure.code === "MAILFLOW_CONFLICT" || /already running|smtp.*already running|smtp.*in use/i.test(failure.message))) {
    return dedupeCampaignBlockers(listed);
  }
  const single = extractStartConflict(failure);
  return single ? [{ id: single.conflictCampaignId, name: single.conflictCampaignName }] : [];
}

function renderStartConflicts(conflicts: RunningCampaignBlocker[]): string {
  const lines = dedupeCampaignBlockers(conflicts).map((conflict) => {
    const name = conflict.name ? ` ${conflict.name}` : "";
    return `- #${conflict.id}${name}`;
  });
  return (
    "Campaign cannot start because these campaigns are already running:\n\n" +
    `${lines.join("\n")}\n\n` +
    "Options:\n" +
    "A. Type **PAUSE ALL AND START** to pause every blocking campaign and start this one\n" +
    "B. Keep this campaign as draft\n" +
    "C. Show running campaigns"
  );
}

function formatCampaignIdList(ids: number[]): string {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return "(none)";
  return unique.map((id) => `#${id}`).join(", ");
}

function renderStartFailure(failure: ToolFailureInfo): string {
  const message = failure.message;
  const lower = message.toLowerCase();
  if (/placeholder|missing column|invalid placeholders/.test(lower)) {
    return `Campaign could not start because the MailFlow placeholder validation failed: ${message}`;
  }
  if (/smtp|from email|sender|mailbox/.test(lower)) {
    return `Campaign could not start because SMTP is not ready: ${message}`;
  }
  if (/not found|404/.test(lower)) {
    return `Campaign could not start because the campaign was not found: ${message}`;
  }
  if (/no pending|no recipients|recipient/.test(lower)) {
    return `Campaign could not start because there are no pending recipients: ${message}`;
  }
  return `Campaign could not start because MailFlow returned an error: ${message}`;
}

function toPositiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function toNonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function parseStrategy(message: string, workflow: BulkWorkflowState) {
  const lower = message.toLowerCase();
  let globalTemplate: string | undefined;
  if (/cfo|finance/.test(lower)) globalTemplate = "cfo_finance_visibility";
  else if (/fintech|lending|compliance/.test(lower)) globalTemplate = "fintech_compliance";
  else if (/product|engineering|delivery/.test(lower)) globalTemplate = "product_engineering_delivery";
  else if (/enterprise|transformation/.test(lower)) globalTemplate = "enterprise_transformation";
  else if (/ai|automation/.test(lower)) globalTemplate = "ai_workflow_intelligence";
  else if (/visibility|coordination|operations/.test(lower)) globalTemplate = "operational_visibility";

  if (/apply recommendations/i.test(message)) {
    return {
      industryTemplateMap: workflow.industryTemplateMap ?? {},
      globalTone: "professional_soft",
      globalCTAStyle: "strategic_review",
    };
  }

  return {
    globalTemplate: globalTemplate ?? "executive_consultative",
    globalTone: /soft|relationship/.test(lower) ? "professional_soft" : "executive_consultative",
    globalCTAStyle: /direct/.test(lower) ? "direct_cta" : "strategic_review",
  };
}

function renderValidationAndStrategy(jobId: number, summary: Record<string, unknown>, options: unknown[], detectedGroups: unknown[]): string {
  const optionLines = options.length
    ? options.slice(0, 10).map((opt, index) => {
      const o = objectValue(opt);
      return `${index + 1}. ${o.name ?? TEMPLATE_LABELS[String(o.id)] ?? o.id}\n   Best for: ${o.bestFor ?? "executive campaign outreach"}\n   Tone: ${o.tone ?? "professional"}\n   CTA: ${o.ctaStyle ?? "brief review"}`;
    }).join("\n")
    : Object.entries(TEMPLATE_LABELS).slice(0, 8).map(([id, label], index) => `${index + 1}. ${label} (${id})`).join("\n");
  const groupLines = detectedGroups.map((group) => {
    const g = objectValue(group);
    return `- ${formatGroup(String(g.group ?? "Unknown"))}: ${g.count ?? 0} rows -> ${TEMPLATE_LABELS[String(g.recommendedTemplate)] ?? g.recommendedTemplate}`;
  }).join("\n");

  return `# Bulk Campaign Workflow\n\nJob ID: ${jobId}\n\nValidation summary:\n- Total rows: ${summary.totalRows ?? 0}\n- Valid: ${summary.valid ?? 0}\n- Invalid: ${summary.invalid ?? 0}\n- Duplicates: ${summary.duplicates ?? 0}\n\nBefore generating emails, please select a template strategy:\n\n${optionLines}\n\nRecommended mapping:\n${groupLines || "- Executive Consultative for all valid rows"}\n\nReply with:\n- Apply recommendations\n- Use one template for all\n- Choose manually\n\nNo emails have been generated or sent.`;
}

function renderProgress(status: Record<string, unknown>): string {
  return `# Template Generation Progress\n\nProcessing in batches. No emails are being sent.\n\n- Total: ${status.total ?? 0}\n- Generated: ${status.processed ?? 0}\n- Failed: ${status.failed ?? 0}\n- Remaining: ${status.remaining ?? 0}\n- Status: ${status.status ?? "queued"}\n\nAsk for **preview templates** when processing completes.`;
}

function renderTemplatePreview(status: Record<string, unknown>, templates: unknown[]): string {
  const cards = templates.map((raw, index) => {
    const t = objectValue(raw);
    return `## ${index + 1}. ${t.company ?? "Company"}\n\nRecipient: ${t.email ?? "unknown"}\nTemplate type: ${t.templateName ?? t.selectedTemplateId ?? "Executive Consultative"}\nConfidence: ${t.confidence ?? "n/a"}\n\n**Subject:** ${t.subject ?? ""}\n\n**Email body:**\n\n${t.body ?? ""}\n\n**Follow-up 1:**\n${t.followup1 ?? ""}\n\n**Follow-up 2:**\n${t.followup2 ?? ""}\n\n**CTA:** ${t.cta ?? ""}`;
  }).join("\n\n---\n\n");
  return `# Template Preview\n\n- Total: ${status.total ?? 0}\n- Generated: ${status.processed ?? 0}\n- Failed: ${status.failed ?? 0}\n- Status: ${status.status ?? "completed"}\n\n${cards}`;
}

function findTemplateForMessage(templates: unknown[], message: string): Record<string, unknown> | undefined {
  const lower = message.toLowerCase();
  return templates.map(objectValue).find((t) => {
    const company = String(t.company ?? "").toLowerCase();
    return company && lower.includes(company.split(/\s+/)[0] ?? company);
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatGroup(group: string): string {
  return group.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
