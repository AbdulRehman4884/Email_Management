/**
 * src/agents/LeadGenAgent.ts
 *
 * Handles the lead finder (Lead Engine) intents. One tool per intent, args from buildLeadGenToolArgs()
 * (LLM args first, then the message), then conversation memory (lib/leadgenContext.ts):
 *
 *   generate_leads        → create_saved_search (runs now); with a time ("daily at 9") →
 *                           create_search_schedule { newSearch } as ONE approved step (UC-01 + UC-02)
 *   run_lead_search       → run_saved_search          ("abhi chalao": counts towards the quota)
 *   schedule_lead_search  → create_search_schedule    (approval with what/when/timezone)
 *   list_lead_schedules   → list_search_schedules
 *   pause_lead_schedule   → update_search_schedule    (pause / resume / new time)
 *   show_new_leads        → list_workspace_leads      (found today by default)
 *   save_leads_to_crm     → save_leads_to_crm         ("inhein" = the leads shown last)
 *   add_leads_to_campaign → add_leads_to_campaign     (approval)
 *   lead_run_status       → get_lead_run
 *
 * "isay" / "it" = the last search. Missing information (city, time, campaign) is asked before any tool runs.
 * userId is never an argument; the MCP server uses the bearer token.
 */

import { BaseAgent } from "./BaseAgent.js";
import {
  applyAnswer,
  argsFromRequest,
  detectLeadGenIntent,
  isLeadGenIntent,
  missingLeadGenField,
  missingLeadSearchDetail,
  readLeadGenRequest,
  type LeadGenIntent,
  type LeadGenToolName,
  type MissingField,
  type ParsedLeadGenMessage,
} from "../lib/leadgenArgs.js";
import { LEADS_PRONOUN } from "../lib/leadgenContext.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";

export const LEADGEN_TOOL_MAP: Record<LeadGenIntent, LeadGenToolName> = {
  generate_leads:        "create_saved_search",
  run_lead_search:       "run_saved_search",
  schedule_lead_search:  "create_search_schedule",
  list_lead_schedules:   "list_search_schedules",
  pause_lead_schedule:   "update_search_schedule",
  show_new_leads:        "list_workspace_leads",
  save_leads_to_crm:     "save_leads_to_crm",
  add_leads_to_campaign: "add_leads_to_campaign",
  lead_run_status:       "get_lead_run",
};

/** Tools that name a saved search: "isay" / no name = the last search. */
const NEEDS_SEARCH: ReadonlySet<LeadGenToolName> = new Set(["run_saved_search", "create_search_schedule", "update_search_schedule", "get_lead_run"]);

const DAY_NAMES: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function isTimezone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function whenText(args: Record<string, unknown>): string {
  const days = Array.isArray(args.weekdays) ? (args.weekdays as string[]) : [];
  const every = args.frequency === "weekly" && days.length ? `every ${days.map((d) => DAY_NAMES[d] ?? d).join(", ")}` : "every day";
  return `${every} at ${String(args.runAtLocal)}`;
}

type Obj = Record<string, unknown>;

export class LeadGenAgent extends BaseAgent {
  readonly domain = "leadgen" as const;

  constructor() {
    super("leadgen");
  }

  async handle(state: AgentGraphStateType): Promise<Partial<AgentGraphStateType>> {
    const { intent, userId, llmExtractedArgs, userMessage } = state;
    if (!isLeadGenIntent(intent)) {
      const msg = `LeadGenAgent received unhandled intent: ${intent ?? "undefined"}`;
      this.log.error({ intent, userId }, msg);
      return { error: msg };
    }
    const input = { extractedArgs: llmExtractedArgs, userMessage };
    const ctx = state.leadGenContext;
    const timezone = isTimezone(state.clientTimezone) ? state.clientTimezone : undefined;
    // This turn always settles a waiting question: answered, asked again, or replaced by a new request.
    const memory = { ...(ctx ?? {}) };
    delete memory.pending;

    // The answer to the question asked last turn ("In which city?" -> "Karachi"): continue that request.
    let r: ParsedLeadGenMessage;
    const pending = ctx?.pending;
    if (pending && pending.intent === intent && !detectLeadGenIntent(userMessage, ctx)) {
      const answered = applyAnswer(pending.request, pending.missing, userMessage);
      if (!answered) {
        return { leadGenContext: memory, formattedResponse: JSON.stringify({ status: "needs_input", intent, message: "Okay, cancelled — no lead search was started." }) };
      }
      r = answered;
    } else {
      r = readLeadGenRequest(input);
    }

    /** A question whose answer continues this request next turn. */
    const ask = (field: MissingField, question: string): Partial<AgentGraphStateType> => {
      this.log.info({ intent, userId, field }, "LeadGenAgent: missing information — asking");
      return {
        toolName: undefined,
        toolArgs: {},
        error: question,
        leadGenContext: { ...memory, pending: { intent, request: r, missing: field, atIso: new Date().toISOString(), isNew: true } },
      };
    };

    let toolName = LEADGEN_TOOL_MAP[intent];
    let toolArgs: Obj = argsFromRequest(toolName, r);

    // New search: category and city first, then focus, leads per run and schedule (each asked once, skippable).
    if (intent === "generate_leads") {
      const next = missingLeadGenField("create_saved_search", toolArgs) ?? missingLeadSearchDetail(r);
      if (next) return ask(next.field, next.question);
    }

    // "find dentists in Lahore daily at 9": create + schedule as one step the user approves.
    if (intent === "generate_leads" && toolArgs.runNow === false) {
      const newSearch = Object.fromEntries(Object.entries(toolArgs).filter(([k]) => k !== "runNow"));
      const missing = missingLeadGenField("create_saved_search", newSearch);
      if (missing) return ask(missing.field, missing.question);
      toolName = "create_search_schedule";
      toolArgs = {
        newSearch,
        runAtLocal: r.runAtLocal,
        frequency: r.frequency ?? (r.weekdays ? "weekly" : "daily"),
        ...(r.weekdays ? { weekdays: r.weekdays } : {}),
        ...(timezone ? { timezone } : {}),
      };
      const people = newSearch.includePeople ? ", decision makers too" : "";
      const tz = timezone ?? "Asia/Karachi";
      return {
        intent: "schedule_lead_search",
        toolName,
        toolArgs,
        leadGenContext: memory,
        crmAction: {
          requiresApproval: true,
          confirmText:
            `I'll create the lead search **${String(newSearch.category)} in ${String(newSearch.city)}** ` +
            `(${String(newSearch.targetPerRun)} leads per run${people}) and run it **${whenText(toolArgs)}** (${tz}). ` +
            "Each run uses your daily lead quota.",
        },
      };
    }

    // "isay" / "it" / no name: the last search of this conversation.
    if (NEEDS_SEARCH.has(toolName) && toolArgs.search === undefined && ctx?.lastSearch) {
      toolArgs.search = String(ctx.lastSearch.id);
    }
    if (toolName === "create_search_schedule" && timezone) toolArgs.timezone = timezone;

    // "inhein campaign 22 mein daal do", "save these to the CRM": exactly the leads shown last.
    if ((toolName === "add_leads_to_campaign" || toolName === "save_leads_to_crm") && ctx?.lastLeads && LEADS_PRONOUN.test(userMessage)) {
      toolArgs = { ...(toolArgs.campaign !== undefined ? { campaign: toolArgs.campaign } : {}), leadIds: ctx.lastLeads.ids };
    }

    const missing = missingLeadGenField(toolName, toolArgs);
    if (missing) return ask(missing.field, missing.question);

    const patch: Partial<AgentGraphStateType> = { toolName, toolArgs, leadGenContext: memory };
    if (toolName === "create_search_schedule") {
      const name = ctx?.lastSearch && String(ctx.lastSearch.id) === String(toolArgs.search) ? ctx.lastSearch.name : String(toolArgs.search);
      patch.crmAction = {
        requiresApproval: true,
        confirmText: `**${name}** will run **${whenText(toolArgs)}** (${String(toolArgs.timezone ?? "Asia/Karachi")}). Each run uses your daily lead quota.`,
      };
    } else if (toolName === "add_leads_to_campaign") {
      const which = Array.isArray(toolArgs.leadIds)
        ? `the ${(toolArgs.leadIds as number[]).length} lead${(toolArgs.leadIds as number[]).length === 1 ? "" : "s"} shown last`
        : [toolArgs.tiers ? `${(toolArgs.tiers as string[]).join("/")} leads` : "leads", toolArgs.foundToday ? "found today" : ""].filter(Boolean).join(" ");
      patch.crmAction = {
        requiresApproval: true,
        confirmText: `Add ${which} to campaign **${String(toolArgs.campaign)}**? Only leads with a verified email are added, and nothing is sent until you start the campaign.`,
      };
    }
    this.log.debug({ intent, toolName, userId, argKeys: Object.keys(toolArgs) }, "LeadGenAgent resolved tool and args");
    return patch;
  }
}

export const leadGenAgent = new LeadGenAgent();
