/**
 * src/mcp/tools/crm/automation.tools.ts
 *
 * Lead automations (backend /api/crm/automations…, migrations 0040 + 0041), the same actions as the web app's
 * Automations pages. Every tool is one backend call; the backend checks the input and the user's ownership.
 * Before the migrations the backend answers 503 "Automations are not set up yet" (a tool failure).
 *
 *   read:  list_automations, get_automation, list_automation_templates, list_automation_runs, list_automation_calls,
 *          get_automation_run_events, get_campaign_automation, list_crm_forms
 *   write: create_automation (always created OFF), update_automation, delete_automation, set_automation_call_result,
 *          stop_automation_run, automation_send_now, set_campaign_automation, set_form_automation,
 *          delete_campaign_recipients (draft campaigns only; used to save personalized follow-ups on each recipient)
 *
 * The user is always taken from the bearer token; no tool accepts a userId.
 */

import { z } from "zod";
import { TOOL_NAMES, type ToolName } from "../../../config/constants.js";
import { serializeError } from "../../../lib/errors.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { ToolContext } from "../../types/toolContext.js";
import type { CampaignId } from "../../../types/common.js";

const id = (label: string) => z.coerce.number().int().positive({ message: `${label} must be a positive number` });
const step = z.record(z.unknown());

function define<S extends z.ZodTypeAny>(
  name: ToolName,
  description: string,
  inputSchema: S,
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>,
): McpToolDefinition<S, unknown> {
  return {
    name,
    description,
    inputSchema,
    handler: async (input, context) => {
      try {
        return toolSuccess(await run(input, context));
      } catch (err) {
        const error = serializeError(err);
        context.log.error({ tool: name, error }, "automation tool failed");
        return toolFailure(error.code, error.message, error.details);
      }
    },
  };
}

const api = (ctx: ToolContext) => ctx.mailflow;

export const AUTOMATION_TOOLS = [
  define(TOOL_NAMES.LIST_AUTOMATIONS, "The user's automations with the forms / campaigns using them and lead counts.", z.object({}), (_i, c) =>
    api(c).automationRequest("GET", "/crm/automations"),
  ),
  define(TOOL_NAMES.GET_AUTOMATION, "One automation.", z.object({ automationId: id("automationId") }), (i, c) =>
    api(c).automationRequest("GET", `/crm/automations/${i.automationId}`),
  ),
  define(TOOL_NAMES.LIST_AUTOMATION_TEMPLATES, "Ready-made automations (key, kind, name, description, outline).", z.object({}), (_i, c) =>
    api(c).automationRequest("GET", "/crm/automation-templates"),
  ),
  define(
    TOOL_NAMES.CREATE_AUTOMATION,
    "Creates an automation, always OFF (turn it on with update_automation). kind form | campaign; steps as in the web builder, or templateKey.",
    z.object({
      name: z.string().min(1).max(255),
      kind: z.enum(["form", "campaign"]),
      smtpSettingsId: id("smtpSettingsId").nullable().optional(),
      steps: z.array(step).max(20).optional(),
      templateKey: z.string().max(60).optional(),
    }),
    (i, c) => api(c).automationRequest("POST", "/crm/automations", { data: { ...i, isActive: false } }),
  ),
  define(
    TOOL_NAMES.UPDATE_AUTOMATION,
    "Changes an automation: name, on/off (isActive), email account, steps. What is not sent keeps its value.",
    z.object({
      automationId: id("automationId"),
      name: z.string().min(1).max(255).optional(),
      isActive: z.boolean().optional(),
      smtpSettingsId: id("smtpSettingsId").nullable().optional(),
      steps: z.array(step).max(20).optional(),
    }),
    ({ automationId, ...rest }, c) => api(c).automationRequest("PATCH", `/crm/automations/${automationId}`, { data: rest }),
  ),
  define(TOOL_NAMES.DELETE_AUTOMATION, "Deletes an automation and its history; forms using it get no automation.", z.object({ automationId: id("automationId") }), (i, c) =>
    api(c).automationRequest("DELETE", `/crm/automations/${i.automationId}`),
  ),
  define(
    TOOL_NAMES.LIST_AUTOMATION_RUNS,
    "Leads in an automation (status open | completed | stopped).",
    z.object({
      automationId: id("automationId"),
      status: z.enum(["open", "completed", "stopped"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    ({ automationId, ...params }, c) => api(c).automationRequest("GET", `/crm/automations/${automationId}/runs`, { params }),
  ),
  define(TOOL_NAMES.LIST_AUTOMATION_CALLS, "Leads waiting for the user's call result, in all automations.", z.object({}), (_i, c) =>
    api(c).automationRequest("GET", "/crm/automation-calls"),
  ),
  define(TOOL_NAMES.GET_AUTOMATION_RUN_EVENTS, "What happened to one lead in an automation.", z.object({ runId: id("runId") }), (i, c) =>
    api(c).automationRequest("GET", `/crm/automation-runs/${i.runId}/events`),
  ),
  define(
    TOOL_NAMES.SET_AUTOMATION_CALL_RESULT,
    "The result of a call for a lead waiting on a call step.",
    z.object({ runId: id("runId"), result: z.enum(["interested", "no_answer", "not_interested"]) }),
    (i, c) => api(c).automationRequest("POST", `/crm/automation-runs/${i.runId}/call-result`, { data: { result: i.result } }),
  ),
  define(TOOL_NAMES.STOP_AUTOMATION_RUN, "Stops one lead's automation.", z.object({ runId: id("runId") }), (i, c) =>
    api(c).automationRequest("POST", `/crm/automation-runs/${i.runId}/stop`),
  ),
  define(TOOL_NAMES.AUTOMATION_SEND_NOW, "A waiting lead skips its wait; its next step runs now.", z.object({ runId: id("runId") }), (i, c) =>
    api(c).automationRequest("POST", `/crm/automation-runs/${i.runId}/send-now`),
  ),
  define(TOOL_NAMES.GET_CAMPAIGN_AUTOMATION, "A campaign's automation and whether it can still change.", z.object({ campaignId: id("campaignId") }), (i, c) =>
    api(c).automationRequest("GET", `/crm/campaigns/${i.campaignId}/automation`),
  ),
  define(
    TOOL_NAMES.SET_CAMPAIGN_AUTOMATION,
    "Sets (or removes with null) the campaign's automation; only while the campaign is a draft or scheduled.",
    z.object({ campaignId: id("campaignId"), automationId: id("automationId").nullable() }),
    (i, c) => api(c).automationRequest("PUT", `/crm/campaigns/${i.campaignId}/automation`, { data: { automationId: i.automationId } }),
  ),
  define(TOOL_NAMES.LIST_CRM_FORMS, "The user's lead capture forms (with their automation).", z.object({}), (_i, c) =>
    api(c).automationRequest("GET", "/crm/forms"),
  ),
  define(
    TOOL_NAMES.SET_FORM_AUTOMATION,
    "Sets (or removes with null) the automation a form starts. Nothing else of the form changes.",
    z.object({ formId: id("formId"), automationId: id("automationId").nullable() }),
    (i, c) => api(c).automationRequest("PATCH", `/crm/forms/${i.formId}`, { data: { automationId: i.automationId } }),
  ),
  define(
    TOOL_NAMES.DELETE_CAMPAIGN_RECIPIENTS,
    "Removes every recipient of a DRAFT campaign (the backend refuses other statuses).",
    z.object({ campaignId: z.string().min(1) }),
    (i, c) => api(c).deleteCampaignRecipients(i.campaignId as CampaignId),
  ),
  define(
    TOOL_NAMES.DELETE_CAMPAIGN,
    "Deletes a campaign with its recipients, replies and stats. Only after the user confirmed; never a running campaign.",
    z.object({ campaignId: z.string().min(1) }),
    (i, c) => api(c).deleteCampaign(i.campaignId as CampaignId),
  ),
] as const;
