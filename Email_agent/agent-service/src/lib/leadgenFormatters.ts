/**
 * src/lib/leadgenFormatters.ts
 *
 * Chat answers for the lead finder tools (same JSON envelope as the CRM answers:
 * { status, intent, message, data }). 403 PLAN_FEATURE_REQUIRED becomes an upgrade message,
 * 404 (LEADGEN_ENABLED off) a "not switched on" message.
 */

import type { LeadGenToolName } from "./leadgenArgs.js";
import type { McpToolResult } from "../types/mcp.js";

type Obj = Record<string, unknown>;

export const LEADGEN_PLAN_MESSAGE =
  "Your current plan does not include the **Lead Finder**. Upgrade your plan on the **Packages** page to find new leads automatically.";
export const LEADGEN_OFF_MESSAGE = "The **Lead Finder** is not switched on for your account yet.";

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const TIER: Record<string, string> = { hot: "🔥 Hot", warm: "🌤️ Warm", cold: "❄️ Cold" };
const DAY_NAMES: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function payloadOf(raw: unknown): Obj {
  const d = obj(raw);
  return "success" in d && "data" in d ? obj(d.data) : d;
}

function failureOf(result: McpToolResult): Obj | undefined {
  const d = obj(result.data);
  if (d.success === false) return obj(d.error);
  if (result.isToolError) return Object.keys(d).length ? obj(d.error ?? d) : { message: result.rawContent.join(" ") };
  return undefined;
}

export function leadGenErrorMessage(error: Obj): string {
  const details = obj(error.details);
  const code = str(details.code) ?? str(error.code);
  const status = typeof error.httpStatus === "number" ? error.httpStatus : undefined;
  if (code === "PLAN_FEATURE_REQUIRED" || status === 403) return LEADGEN_PLAN_MESSAGE;
  if (status === 404 || code === "MAILFLOW_NOT_FOUND") return LEADGEN_OFF_MESSAGE;
  if (code === "UNKNOWN_SEARCH") return `${str(error.message) ?? "That lead search was not found"}. Say **show my lead searches** to see them.`;
  if (code === "MAILFLOW_TIMEOUT") return "The Lead Finder took too long to answer. Please try again.";
  if (code === "MAILFLOW_UNAVAILABLE" || status === 0) return "The Lead Finder is not reachable right now. Please try again in a moment.";
  const backend = str(details.error);
  if (backend && backend.length < 200) return `The Lead Finder could not do that: ${backend}`;
  return "Something went wrong in the Lead Finder. Please try again.";
}

function envelope(status: "success" | "error", intent: string | undefined, message: string, data?: unknown): string {
  return JSON.stringify({ status, intent: intent ?? "leadgen", message, ...(data !== undefined ? { data } : {}) });
}

/** "2026-10-30T04:03:00Z" in Asia/Karachi -> "Fri 30 Oct, 9:03 AM". */
function localTime(iso: unknown, timezone: unknown): string | undefined {
  const s = str(iso);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: str(timezone) ?? "Asia/Karachi", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
    }).format(d);
  } catch {
    return s.slice(0, 16).replace("T", " ");
  }
}

function whenText(schedule: Obj): string {
  const time = (str(schedule.runAtLocal) ?? "").slice(0, 5);
  const days = Array.isArray(schedule.weekdays) ? schedule.weekdays.filter((x): x is string => typeof x === "string") : [];
  const every = schedule.frequency === "weekly" && days.length && days.length < 7 ? `every ${days.map((d) => DAY_NAMES[d] ?? d).join(", ")}` : "every day";
  return `${every} at **${time}** (${str(schedule.timezone) ?? "Asia/Karachi"})`;
}

function unknownSearchText(d: Obj): string {
  const available = Array.isArray(d.availableSearches) ? (d.availableSearches as string[]) : [];
  if (available.length === 0) return `I couldn't find a lead search called "${str(d.unknownSearch) ?? ""}". Create one first, e.g. **find dental clinics in Lahore**.`;
  return `Which lead search do you mean? ${available.map((n) => `**${n}**`).join(", ")}`;
}

function searchLine(s: Obj): string {
  const what = [str(s.category) ?? (Array.isArray(s.keywords) ? (s.keywords as string[]).join(", ") : ""), str(s.city) ? `in ${s.city}` : ""].filter(Boolean).join(" ");
  return `**${str(s.name) ?? "Lead search"}**${what ? ` (${what})` : ""}`;
}

function runText(run: Obj): string {
  const stats = obj(run.stats);
  const status = str(run.status) ?? "queued";
  if (status === "queued" || status === "running") {
    return status === "queued" ? "The search is queued and starts in a moment. I'll put the new leads in your **Lead Finder** when it's done." : `Running now: ${plural(num(stats.discovered), "business")} found so far.`;
  }
  const line = `${plural(num(stats.new_leads), "new lead")} (${plural(num(stats.discovered), "business")} checked).`;
  if (status === "done") return `Finished: ${line}`;
  if (status === "partial") return `Finished with gaps: ${line} ${str(run.error) ?? ""}`.trim();
  if (status === "cancelled") return "This run was cancelled.";
  return `The run failed: ${str(run.error) ?? "no data could be collected"}.`;
}

function leadLine(l: Obj, i: number): string {
  const c = obj(l.company);
  const p = obj(l.person);
  const contact = [str(c.email), str(c.phone)].filter(Boolean).join(" · ");
  const person = str(p.fullName) ? ` — ${p.fullName}${str(p.title) ? `, ${p.title}` : ""}` : "";
  return `${i + 1}. **${str(c.name) ?? "Company"}**${str(c.city) ? `, ${c.city}` : ""} ${TIER[str(l.scoreTier) ?? ""] ?? ""} ${num(l.fitScore)}${person}${contact ? `\n   ${contact}` : ""}`;
}

function format(toolName: LeadGenToolName, d: Obj): string {
  switch (toolName) {
    case "create_saved_search": {
      const s = obj(d.search);
      const people = s.includePeople ? ", decision makers too" : "";
      const head = `Saved ${searchLine(s)}: ${plural(num(s.targetPerRun) || 20, "lead")} per run${people}.`;
      return d.run ? `${head}\n\n${runText(obj(d.run))}` : `${head}\n\nSay **run it now**, or **run it daily at 9** to schedule it.`;
    }
    case "run_saved_search":
      if (str(d.unknownSearch)) return unknownSearchText(d);
      return `Started ${searchLine(obj(d.search))}.\n\n${runText(obj(d.run))}`;
    case "create_search_schedule": {
      if (str(d.unknownSearch)) return unknownSearchText(d);
      const sch = obj(d.schedule);
      const next = localTime(sch.nextRunAt, sch.timezone);
      return `${searchLine(obj(d.search))} now runs ${whenText(sch)}.${next ? `\nNext run: **${next}**.` : ""}\nEach run uses your daily lead quota.`;
    }
    case "list_search_schedules": {
      const searches = arr(d.searches);
      if (searches.length === 0) return "You have no lead searches yet. Try **find dental clinics in Lahore**.";
      return `Your lead searches:\n${searches
        .map((s, i) => {
          const sch = obj(s.schedule);
          const when = Object.keys(sch).length === 0 ? "no schedule" : sch.isPaused ? "⏸️ paused" : `${whenText(sch)}, next ${localTime(sch.nextRunAt, sch.timezone) ?? "soon"}`;
          return `${i + 1}. ${searchLine(s)} — ${when}`;
        })
        .join("\n")}`;
    }
    case "update_search_schedule": {
      if (!d.schedule) return str(d.searchName) ? `**${d.searchName}** has no schedule yet. Say e.g. **run ${d.searchName} daily at 9**.` : unknownSearchText(d);
      const sch = obj(d.schedule);
      if (sch.isPaused) return `Paused **${str(d.searchName) ?? "the schedule"}**. A run that already started still finishes.`;
      const next = localTime(sch.nextRunAt, sch.timezone);
      return `**${str(d.searchName) ?? "The search"}** runs ${whenText(sch)}.${next ? ` Next run: **${next}**.` : ""}`;
    }
    case "get_lead_run": {
      const run = obj(d.run);
      if (!Object.keys(run).length) return "No lead search has run yet. Try **find dental clinics in Lahore**.";
      return `${str(d.searchName) ? `**${d.searchName}**: ` : ""}${runText(run)}`;
    }
    case "list_workspace_leads": {
      if (str(d.unknownSearch)) return unknownSearchText(d);
      const leads = arr(d.leads);
      if (leads.length === 0) return "No new leads yet. Runs add them to your **Lead Finder**; I'll notify you when they arrive.";
      const more = num(d.total) > leads.length ? `\n\n…and ${num(d.total) - leads.length} more in the **Lead Finder**.` : "";
      return `${plural(num(d.total), "lead")}${str(d.searchName) ? ` from **${d.searchName}**` : ""}:\n${leads.map(leadLine).join("\n")}${more}`;
    }
    case "save_leads_to_crm": {
      if (num(d.leadCount) === 0) return "There were no matching new leads to save.";
      const skipped = [
        num(d.skippedNoEmail) ? `${plural(num(d.skippedNoEmail), "lead")} without an email` : "",
        num(d.skippedSuppressed) ? `${num(d.skippedSuppressed)} on the suppression list` : "",
      ].filter(Boolean);
      return `Saved **${num(d.saved)}** to the CRM${num(d.updated) ? ` (${num(d.updated)} updated)` : ""}.${skipped.length ? ` Skipped ${skipped.join(" and ")}.` : ""}`;
    }
    case "get_lead_finder_crm_summary": {
      if (str(d.unknownSearch)) return unknownSearchText(d);
      const groups = arr(d.bySearch);
      if (groups.length === 0) {
        return "No lead finder leads are in your CRM yet. Find leads first (e.g. **find IT companies in Lahore**), then say **save them to the CRM**.";
      }
      const head = [
        `**${plural(num(d.total), "lead")}** in your CRM came from the **Lead Finder**${str(d.searchName) ? ` (search **${d.searchName}**)` : ""}`,
        num(d.inCampaign) ? ` — ${num(d.inCampaign)} already in a campaign` : "",
        ". They carry the **Lead Finder** tag in the CRM.",
      ].join("");
      const blocks = groups.map((g, i) => {
        const what = [str(g.category), str(g.city) ? `in ${g.city}` : "", Array.isArray(g.focus) && g.focus.length ? `· focus ${(g.focus as string[]).join(", ")}` : ""]
          .filter(Boolean).join(" ");
        const title = str(g.searchName) ? `**${g.searchName}**${what && !String(g.searchName).includes(String(g.city ?? "\u0000")) ? ` (${what})` : ""}` : "**Deleted / unknown search**";
        const tiers = [num(g.hot) ? `🔥 ${num(g.hot)} hot` : "", num(g.warm) ? `🌤️ ${num(g.warm)} warm` : "", num(g.cold) ? `❄️ ${num(g.cold)} cold` : ""].filter(Boolean).join(" · ");
        const sample = arr(g.sample).map((s) => {
          const who = [str(s.company), str(s.person)].filter(Boolean).join(" — ");
          return `   - ${who}${str(s.email) ? ` (${s.email})` : ""}${s.status === "in_campaign" ? " · in campaign" : ""}`;
        });
        const more = num(g.total) > sample.length ? [`   - …and ${num(g.total) - sample.length} more`] : [];
        return [
          `${i + 1}. ${title}: **${plural(num(g.total), "lead")}**${num(g.inCampaign) ? `, ${num(g.inCampaign)} in a campaign` : ""}${tiers ? ` · ${tiers}` : ""}`,
          ...sample,
          ...more,
        ].join("\n");
      });
      const tail = d.truncated === true ? "\n\n(Only the newest 1000 leads are counted.)" : "";
      return `${head}\n\n${blocks.join("\n")}${tail}`;
    }
    case "add_leads_to_campaign": {
      if (d.campaignId === null) {
        const list = Array.isArray(d.availableCampaigns) ? (d.availableCampaigns as string[]) : [];
        return `I couldn't find the campaign "${str(d.unknownCampaign) ?? ""}".${list.length ? ` Your campaigns: ${list.map((n) => `**${n}**`).join(", ")}.` : ""}`;
      }
      if (num(d.leadCount) === 0) return "There were no matching leads to add.";
      const skipped = num(d.skippedNoEmail) + num(d.skippedDuplicate) + num(d.skippedSuppressed);
      return `Added **${num(d.added)}** lead${num(d.added) === 1 ? "" : "s"} to **${str(d.campaignName) ?? `campaign ${d.campaignId}`}**${skipped ? ` (${skipped} skipped: no verified email, already in it, or suppressed)` : ""}. Nothing was sent — start the campaign when you're ready.`;
    }
  }
}

export function formatLeadGenResult(intent: string | undefined, toolName: LeadGenToolName, result: McpToolResult): string {
  const failure = failureOf(result);
  if (failure) return envelope("error", intent, leadGenErrorMessage(failure), result.data);
  const d = payloadOf(result.data);
  return envelope("success", intent, format(toolName, d), d);
}
