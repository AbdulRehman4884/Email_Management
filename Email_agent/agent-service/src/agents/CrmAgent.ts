/**
 * src/agents/CrmAgent.ts
 *
 * Handles the CRM intents.
 *
 * Read-only (phase 1) — one tool, args from buildCrmToolArgs():
 *   crm_summary        → get_crm_summary
 *   crm_list_leads     → list_crm_contacts
 *   crm_lead_details   → get_crm_contact     (asks for a name/email when none is given)
 *   crm_needs_reply    → list_crm_needs_reply
 *   crm_list_pipelines → list_crm_pipelines
 *   crm_list_tags      → list_crm_tags
 *   show_hot_leads     → list_crm_contacts (hotOnly, sort hot); no CRM in the plan → old reply-intelligence tool
 *
 * Write actions (phase 2) — see lib/crmActions.ts:
 *   1. read the request (LLM args, then the message); ask when something is missing
 *   2. prepare_crm_action (read-only) turns names into ids
 *   3. unclear / unknown names → a reply, nothing changes
 *      otherwise one write tool with ids + state.crmAction (confirm text, approval yes/no)
 *
 * userId is never an argument; the MCP server uses the bearer token.
 */

import { BaseAgent } from "./BaseAgent.js";
import { buildCrmToolArgs, type CrmToolName } from "../lib/crmArgs.js";
import {
  effectiveCrmIntent,
  isCrmWriteIntent,
  missingInfoQuestion,
  planCrmAction,
  prepareArgsFor,
  readCrmAction,
  type CrmActionRequest,
  type CrmWriteIntent,
} from "../lib/crmActions.js";
import { ONE, pronounOf, type CrmLeadRef } from "../lib/crmContext.js";
import { crmErrorMessage } from "../lib/crmFormatters.js";
import { toUserSafeMcpMessage } from "../lib/mcpErrorMapping.js";
import { mcpClientService } from "../services/mcpClient.service.js";
import { asUserId, type AuthContext } from "../types/common.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { Intent } from "../config/intents.js";

const TOOL_MAP = {
  crm_summary:        "get_crm_summary",
  crm_list_leads:     "list_crm_contacts",
  crm_lead_details:   "get_crm_contact",
  crm_needs_reply:    "list_crm_needs_reply",
  crm_list_pipelines: "list_crm_pipelines",
  crm_list_tags:      "list_crm_tags",
  // CRM hot leads; executeTool falls back to the reply-intelligence tool when the plan has no CRM.
  show_hot_leads:     "list_crm_contacts",
} satisfies Partial<Record<Intent, CrmToolName>>;

type CrmReadIntent = keyof typeof TOOL_MAP;

function isCrmReadIntent(intent: Intent | undefined): intent is CrmReadIntent {
  return intent !== undefined && intent in TOOL_MAP;
}

export const CRM_LEAD_QUESTION =
  "Which lead do you mean? Give me a name or email, e.g. **details of ali@shop.com** or **details of Ali Khan**.";

export const CRM_CANCELLED = "Okay, cancelled — nothing was changed.";

/** "his details", "uski detail", "this lead's score" → the last lead shown. */
const SINGULAR_REF_RE = /\b(his|her|uski|uska|uske|iski|iska|iske|this lead|that lead|is lead|us lead)\b/i;

/** Chat reply that needs nothing more from the tools (question, "not found", choices). */
function needsInput(intent: string, message: string): string {
  return JSON.stringify({ status: "needs_input", intent, message });
}

type Obj = Record<string, unknown>;

export class CrmAgent extends BaseAgent {
  readonly domain = "crm" as const;

  constructor() {
    super("crm");
  }

  async handle(state: AgentGraphStateType): Promise<Partial<AgentGraphStateType>> {
    const { intent, userId, llmExtractedArgs, userMessage } = state;

    if (isCrmWriteIntent(intent)) return this.handleWrite(state, intent);

    if (!isCrmReadIntent(intent)) {
      const msg = `CrmAgent received unhandled intent: ${intent ?? "undefined"}`;
      this.log.error({ intent, userId }, msg);
      return { error: msg };
    }

    const toolName = TOOL_MAP[intent];

    // Answer to "which lead?" after a details search with several matches.
    if (toolName === "get_crm_contact" && state.crmSelection) {
      if (state.crmSelection.kind === "cancel") return { formattedResponse: needsInput(intent, CRM_CANCELLED) };
      return { toolName, toolArgs: { contactId: state.crmSelection.lead.id } };
    }

    const toolArgs = buildCrmToolArgs(toolName, { extractedArgs: llmExtractedArgs, userMessage });

    // "show hot leads" = the CRM Hot Leads panel: Interested or hot score, hottest first.
    if (intent === "show_hot_leads") {
      const tiers = toolArgs.scoreTiers;
      if (Array.isArray(tiers) && tiers.length === 1 && tiers[0] === "hot") delete toolArgs.scoreTiers;
      toolArgs.hotOnly = true;
      toolArgs.sort = "hot";
    }

    // "his details" / "uski detail" → the last lead shown.
    const lastLead = state.crmContext?.lastLead;
    if (
      toolName === "get_crm_contact" &&
      lastLead &&
      (pronounOf(String(toolArgs.query ?? "")) === ONE ||
        (toolArgs.query === undefined && SINGULAR_REF_RE.test(userMessage)))
    ) {
      return { toolName, toolArgs: { contactId: lastLead.id } };
    }

    if (toolName === "get_crm_contact" && toolArgs.contactId === undefined && toolArgs.query === undefined) {
      this.log.info({ intent, userId }, "CrmAgent: lead details without a name or email — asking");
      return { toolName: undefined, toolArgs: {}, error: CRM_LEAD_QUESTION };
    }

    this.log.debug({ intent, toolName, userId, argKeys: Object.keys(toolArgs) }, "CrmAgent resolved tool and args");
    return { toolName, toolArgs };
  }

  // ── Write actions ─────────────────────────────────────────────────────────

  private async handleWrite(state: AgentGraphStateType, detected: CrmWriteIntent): Promise<Partial<AgentGraphStateType>> {
    const pending = state.crmContext?.pendingSelection;
    let request: CrmActionRequest;
    if (state.crmSelection && pending) {
      // The user picked one lead from the list this action showed last turn.
      if (state.crmSelection.kind === "cancel") return { intent: detected, formattedResponse: needsInput(detected, CRM_CANCELLED) };
      const lead = state.crmSelection.lead;
      request = { ...pending.request, leadId: lead.id, lead: lead.name ?? lead.email };
    } else {
      request = readCrmAction(detected, state.llmExtractedArgs, state.userMessage, state.crmContext);
    }
    const intent = effectiveCrmIntent(detected, request);

    const question = missingInfoQuestion(intent, request);
    if (question) {
      this.log.info({ intent, userId: state.userId }, "CrmAgent: write action is missing information — asking");
      return { intent, toolName: undefined, toolArgs: {}, error: question };
    }

    let prep: Obj = {};
    const prepArgs = prepareArgsFor(intent, request);
    if (prepArgs) {
      const auth = authOf(state);
      if (!auth) return { intent, formattedResponse: needsInput(intent, "Please sign in again — I could not check your CRM.") };
      try {
        const result = await mcpClientService.dispatch("prepare_crm_action", prepArgs, auth);
        const data = (result.data ?? {}) as Obj;
        if (data.success === false || result.isToolError) {
          const error = (data.error ?? {}) as Obj;
          return { intent, formattedResponse: JSON.stringify({ status: "error", intent, message: crmErrorMessage(error) }) };
        }
        prep = (data.success === true && data.data && typeof data.data === "object" ? data.data : data) as Obj;
      } catch (err) {
        this.log.warn({ intent, err: err instanceof Error ? err.message : String(err) }, "CrmAgent: prepare_crm_action failed");
        return { intent, formattedResponse: JSON.stringify({ status: "error", intent, message: toUserSafeMcpMessage(err) }) };
      }
    }

    const plan = planCrmAction(intent, request, prep);
    if (plan.kind === "reply") {
      // Several leads matched: remember the choice so "2" / an email continues this action.
      const matches = Array.isArray(prep.leadMatches) ? (prep.leadMatches as CrmLeadRef[]) : [];
      if (!prep.lead && matches.length > 1) {
        const { lead: _lead, leadId: _leadId, ...rest } = request;
        return {
          intent,
          formattedResponse: needsInput(intent, plan.message),
          crmContext: {
            ...(state.crmContext ?? {}),
            pendingSelection: { intent, request: rest, matches, atIso: new Date().toISOString(), isNew: true },
          },
        };
      }
      return { intent, formattedResponse: needsInput(intent, plan.message) };
    }

    this.log.info(
      { intent, toolName: plan.toolName, userId: state.userId, requiresApproval: plan.requiresApproval },
      "CrmAgent: write action ready",
    );
    return {
      intent,
      toolName: plan.toolName,
      toolArgs: plan.toolArgs,
      crmAction: { confirmText: plan.confirmText, requiresApproval: plan.requiresApproval },
    };
  }
}

function authOf(state: AgentGraphStateType): AuthContext | undefined {
  if (!state.rawToken) return undefined;
  return { userId: state.userId ?? asUserId("unknown"), rawToken: state.rawToken };
}

export const crmAgent = new CrmAgent();
