/**
 * src/lib/automationFlow.ts
 *
 * Lead automations in chat: the same automations as the web app's CRM → Automations pages (backend
 * /api/crm/automations…, MCP tools in mcp/tools/crm/automation.tools.ts), plus emails written by the agent.
 *
 *   Summary + analysis  "automations", "automation summary", "automation X"     → read only, computed here
 *   Calls to make       "calls to make"                                          → read only
 *   Create              "create automation"                                      → flow below
 *   Change emails       "change the emails of automation X: <what>"             → flow (write → review → approval)
 *   Actions             turn on / off, delete, stop <lead>, send now <lead>, call result, use on form <name>
 *                       → each one approval card, then the tool runs (formatted by formatAutomationToolResult)
 *
 * Create flow (one question at a time, like "Create campaign"):
 *   kind (form leads / campaign follow-ups) → which form / campaign → template or own plan → [email account]
 *   → [what you offer] → [sender name] → the automation is created OFF (like "New automation" on the web)
 *   → emails written → review (approve / change / regenerate) → emails saved + attached → approval card turns it on.
 *
 * Emails:
 *   - form automations and scheduled campaigns: written once for every lead with placeholders ({{first_name}} …),
 *     checked (plain 1-to-1 shape, no spam / cliché words, no links), up to 3 tries.
 *   - draft campaigns: every recipient gets their OWN follow-ups, written from the first email they get
 *     (background job, the same follow-up writer and checks as "Generate personalized emails"). They are saved on
 *     each recipient as ai_followup_N (the recipients are saved again with their row unchanged) and the
 *     automation's email steps are {{ai_followup_N}}; the backend fills them per recipient when it sends.
 *
 * Nothing goes out without the user's approval: the automation stays OFF until the approval card is confirmed.
 */

import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import { getOpenAIService } from "../services/openai.service.js";
import { AUTOMATION_EMAILS_PROMPT, COLUMN_READER_PROMPT } from "../prompts/campaignCreation.prompt.js";
import {
  deleteJob,
  isRunningHere,
  loadJob,
  saveJob,
  startRun,
  type CreationJob,
  type GeneratedEmail,
} from "../services/campaignCreationJob.service.js";
import { guessLayout, layoutFromLlm, recipientKey, recipientsFromTable, type CampaignRecipient } from "./campaignCreationTable.js";
import { authOf, callTool } from "./campaignCreationFlow.js";
import { fillPlaceholders, offerFromEmails, purposeFromCampaign, signerOf } from "./personalizeEmailsFlow.js";
import { htmlToBody, normalizeBody, phraseHits, splitBody } from "./emailRealism.js";
import { CLICHE_PHRASES, SPAM_PHRASES } from "../config/emailRealism.config.js";
import { liveAutomationFlow, type AutomationFlowState, type FlowEmail } from "./automationContext.js";
import { createLogger } from "./logger.js";
import type { AuthContext } from "../types/common.js";

const log = createLogger("automationFlow");

type Obj = Record<string, unknown>;
type Patch = Partial<AgentGraphStateType>;

/** Recipients whose follow-ups are written one by one (larger campaigns get template follow-ups). */
const MAX_PER_RECIPIENT = 200;
/** custom_fields is varchar(5000) in the backend. */
const MAX_CUSTOM_FIELDS_CHARS = 4800;
const CANCEL_RE = /^(cancel|stop|abort|exit|quit|band karo|band kr do|chhoro|chodo|rehne do|cancel kar do|cancel kr do)\b/i;
const APPROVE_RE = /^(approve|approved|ok|okay|yes|yep|sure|confirm|looks good|good|great|perfect|theek|thik|theek hai|sahi|sahi hai|done|save|haan|han|ji)\b/i;

// ── Small helpers ────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const arr = (v: unknown) => (Array.isArray(v) ? (v as Obj[]) : []);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function envelope(status: "success" | "needs_input" | "error", message: string): string {
  return JSON.stringify({ status, intent: "automations", message });
}

function reply(ctx: AutomationFlowState, message: string, extra: Patch = {}): Patch {
  return {
    intent: "automations",
    toolName: undefined,
    toolArgs: {},
    formattedResponse: envelope("needs_input", message),
    automationFlow: { ...ctx, atIso: new Date().toISOString() },
    ...extra,
  };
}

function answer(message: string, extra: Patch = {}): Patch {
  return { intent: "automations", toolName: undefined, toolArgs: {}, formattedResponse: envelope("success", message), automationFlow: undefined, ...extra };
}

/** One approval card; the tool runs only after Confirm. */
function approval(toolName: string, toolArgs: Obj, confirmText: string): Patch {
  return {
    intent: "automations",
    toolName: toolName as Patch["toolName"],
    toolArgs,
    crmAction: { confirmText, requiresApproval: true } as Patch["crmAction"],
    automationFlow: undefined,
  };
}

/** The backend's reason in plain words (no "MailFlow API error on …" suffix), with the fix for known cases. */
export function friendlyError(message: string): string {
  const m = message.replace(/\s*\((?:MailFlow API error|The request failed)[^)]*\)\s*$/i, "").trim();
  if (/not set up yet|run the automation migration/i.test(m)) {
    return "Automations are not set up on the server yet. Run the automation migration once in the backend folder (`npx tsx scripts/run-automation-migration.ts`), then try again.";
  }
  if (/PLAN_FEATURE_REQUIRED|plan does not include|upgrade/i.test(m)) return "Your plan does not include the CRM, so automations are not available.";
  return m || "The request failed.";
}

type Tool = Parameters<typeof callTool>[0];
async function read(name: string, args: Obj, auth: AuthContext): Promise<{ ok: true; data: Obj } | { ok: false; message: string }> {
  const r = await callTool(name as Tool, args, auth);
  return r.ok ? r : { ok: false, message: friendlyError(r.message) };
}

// ── Detection ────────────────────────────────────────────────────────────────

/** A message about automations ("automations", "create automation", "calls to make", "automation X band karo"). */
export function isAutomationRequest(message: string): boolean {
  return /\bautomations?\b|\bautomation(?:s)?\s+(?:ka|ki|ke|ko)\b|\bcalls? to make\b|\bpending calls?\b/i.test(message);
}

export function isAutomationFlowActive(state: AgentGraphStateType): boolean {
  return liveAutomationFlow(state.automationFlow) !== undefined;
}

// ── Automations: reading and describing ──────────────────────────────────────

export interface AutomationRow {
  id: number;
  name: string;
  kind: "form" | "campaign";
  isActive: boolean;
  smtpSettingsId: number | null;
  steps: Obj[];
  usedBy: Array<{ id: number; name: string }>;
  usedByCampaigns: Array<{ id: number; name: string; status?: string }>;
  counts: { running: number; waitingCall: number; completed: number; stopped: number };
}

function toAutomation(a: Obj): AutomationRow {
  const c = (a.counts ?? {}) as Obj;
  return {
    id: num(a.id),
    name: str(a.name) || `Automation ${num(a.id)}`,
    kind: a.kind === "campaign" ? "campaign" : "form",
    isActive: a.isActive === true,
    smtpSettingsId: typeof a.smtpSettingsId === "number" ? a.smtpSettingsId : null,
    steps: arr(a.steps),
    usedBy: arr(a.usedBy).map((f) => ({ id: num(f.id), name: str(f.name) })),
    usedByCampaigns: arr(a.usedByCampaigns).map((f) => ({ id: num(f.id), name: str(f.name), status: str(f.status) })),
    counts: { running: num(c.running), waitingCall: num(c.waitingCall), completed: num(c.completed), stopped: num(c.stopped) },
  };
}

async function listAutomations(auth: AuthContext): Promise<{ ok: true; list: AutomationRow[] } | { ok: false; message: string }> {
  const r = await read("list_automations", {}, auth);
  return r.ok ? { ok: true, list: arr(r.data.automations).map(toAutomation) } : r;
}

const unitText = (amount: number, unit: string) => `${amount} ${amount === 1 ? unit.replace(/s$/, "") : unit}`;
const RESULT_LABEL: Record<string, string> = { interested: "Interested", no_answer: "No answer", not_interested: "Not interested" };

/** One line per step, e.g. "Wait 2 days → Email \"Thanks, {{first_name}}\" → Follow-up 1 (written per recipient)". */
export function outlineSteps(steps: Obj[]): string[] {
  let followUp = 0;
  const one = (s: Obj): string => {
    switch (s.type) {
      case "email": {
        const body = str(s.body).trim();
        const per = body.match(/^\{\{\s*ai_followup_(\d+)\s*\}\}$/i);
        if (per) return `Follow-up ${per[1]} (written for each recipient)`;
        followUp++;
        return str(s.subject).trim() ? `Email "${str(s.subject).trim()}"` : `Email (reply in the same thread)`;
      }
      case "wait":
        return `Wait ${unitText(num(s.amount), str(s.unit) || "days")}`;
      case "remind":
        return `Reminder to you: "${str(s.message)}"`;
      case "tag":
        return "Add a tag";
      case "stage":
        return "Move to a stage";
      case "call": {
        const outcomes = (s.outcomes ?? {}) as Record<string, Obj[]>;
        const branches = Object.keys(RESULT_LABEL).map((k) => `${RESULT_LABEL[k]}: ${arr(outcomes[k]).map(one).join(", ") || "nothing"}`);
        return `Call reminder${num(s.retries) ? ` (call again up to ${plural(num(s.retries), "time")})` : ""} → ${branches.join(" · ")}`;
      }
      default:
        return String(s.type ?? "step");
    }
  };
  void followUp;
  return steps.map(one);
}

const usedByText = (a: AutomationRow) =>
  a.kind === "campaign"
    ? a.usedByCampaigns.length ? `campaign${a.usedByCampaigns.length > 1 ? "s" : ""} ${a.usedByCampaigns.map((c) => `**${c.name}**`).join(", ")}` : "no campaign yet"
    : a.usedBy.length ? `form${a.usedBy.length > 1 ? "s" : ""} ${a.usedBy.map((f) => `**${f.name}**`).join(", ")}` : "no form yet";

/** Why runs stopped, from the backend's stop reason text. */
export function stopBucket(reason: string): "replied" | "unsubscribed" | "bounced" | "won_lost" | "crm" | "cancelled" | "manual" | "other" {
  const r = reason.toLowerCase();
  if (/replied/.test(r)) return "replied";
  if (/bounced/.test(r)) return "bounced";
  if (/unsubscribed|asked not to get emails/.test(r)) return "unsubscribed";
  if (/won|lost/.test(r)) return "won_lost";
  if (/stopped for this lead in the crm|stop follow-ups|crm/.test(r)) return "crm";
  if (/cancelled/.test(r)) return "cancelled";
  if (/stopped by you/.test(r)) return "manual";
  return "other";
}

export interface AutomationStats {
  leads: number;
  emailsSent: number;
  stops: Record<ReturnType<typeof stopBucket>, number>;
  /** Open leads with a problem, by message. */
  problems: Array<{ message: string; leads: number }>;
  sampled: boolean;
}

/** Analysis of one automation from its leads (up to 200 newest). */
export function statsFromRuns(runs: Obj[], total: number): AutomationStats {
  const stops = { replied: 0, unsubscribed: 0, bounced: 0, won_lost: 0, crm: 0, cancelled: 0, manual: 0, other: 0 };
  const problems = new Map<string, number>();
  let emailsSent = 0;
  for (const r of runs) {
    emailsSent += num(r.emailsSent);
    if (r.status === "stopped") stops[stopBucket(str(r.stopReason))]++;
    const err = str(r.lastError).trim();
    if (err && (r.status === "active" || r.status === "waiting_call")) {
      const key = err.replace(/\(\d+\/\d+ today\)/, "").replace(/:.*$/, "").trim();
      problems.set(key, (problems.get(key) ?? 0) + 1);
    }
  }
  return {
    leads: Math.max(total, runs.length),
    emailsSent,
    stops,
    problems: [...problems.entries()].map(([message, leads]) => ({ message, leads })).sort((a, b) => b.leads - a.leads),
    sampled: total > runs.length,
  };
}

async function statsFor(a: AutomationRow, auth: AuthContext): Promise<AutomationStats | undefined> {
  const c = a.counts;
  if (c.running + c.waitingCall + c.completed + c.stopped === 0) return undefined;
  const r = await read("list_automation_runs", { automationId: a.id, limit: 200 }, auth);
  if (!r.ok) return undefined;
  return statsFromRuns(arr(r.data.runs), num(r.data.total));
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

function statsLines(a: AutomationRow, s: AutomationStats | undefined): string[] {
  const c = a.counts;
  const lines = [
    `Leads: **${c.running}** in progress, **${c.waitingCall}** waiting for your call, **${c.completed}** finished, **${c.stopped}** stopped`,
  ];
  if (!s) return lines;
  const finished = c.completed + c.stopped;
  lines.push(`Emails sent: **${s.emailsSent}**${s.sampled ? " (newest 200 leads)" : ""}`);
  const stopParts = [
    s.stops.replied ? `${s.stops.replied} replied` : "",
    s.stops.won_lost ? `${s.stops.won_lost} reached Won/Lost` : "",
    s.stops.crm ? `${s.stops.crm} stopped by a CRM stage or rule` : "",
    s.stops.unsubscribed ? `${s.stops.unsubscribed} unsubscribed` : "",
    s.stops.bounced ? `${s.stops.bounced} bounced` : "",
    s.stops.manual ? `${s.stops.manual} stopped by you` : "",
    s.stops.cancelled ? `${s.stops.cancelled} campaign cancelled` : "",
  ].filter(Boolean);
  if (stopParts.length) lines.push(`Why leads stopped: ${stopParts.join(", ")}`);
  if (a.kind === "campaign" && finished + c.running > 0) lines.push(`Reply rate: **${pct(s.stops.replied, s.leads)}** of ${plural(s.leads, "lead")}`);
  for (const p of s.problems.slice(0, 2)) lines.push(`⚠ ${p.message} (${plural(p.leads, "lead")})`);
  return lines;
}

async function summary(state: AgentGraphStateType, auth: AuthContext): Promise<Patch> {
  const listed = await listAutomations(auth);
  if (!listed.ok) return answer(listed.message);
  const list = listed.list;
  if (list.length === 0) {
    return answer(
      [
        "You have no automations yet.",
        "",
        "An automation sends emails and reminders by itself — for **new leads from a form** (welcome email, follow-ups, a call reminder) or as **follow-ups for a campaign** (they stop when the lead replies).",
        "",
        "Say **create automation** to make one.",
      ].join("\n"),
    );
  }
  const shown = list.slice(0, 15);
  const stats = await Promise.all(shown.slice(0, 8).map((a) => statsFor(a, auth).catch(() => undefined)));
  const calls = await read("list_automation_calls", {}, auth);
  const callList = calls.ok ? arr(calls.data.calls) : [];

  const sum = (f: (a: AutomationRow) => number) => list.reduce((n, a) => n + f(a), 0);
  const on = list.filter((a) => a.isActive).length;
  const sent = stats.reduce((n, s) => n + (s?.emailsSent ?? 0), 0);
  const replied = stats.reduce((n, s) => n + (s?.stops.replied ?? 0), 0);
  const unsub = stats.reduce((n, s) => n + (s ? s.stops.unsubscribed + s.stops.bounced : 0), 0);

  const lines = [
    `**Your automations (${list.length})** — ${on} on, ${list.length - on} off`,
    "",
    `- Leads in progress: **${sum((a) => a.counts.running)}** · waiting for your call: **${sum((a) => a.counts.waitingCall)}** · finished: **${sum((a) => a.counts.completed)}** · stopped: **${sum((a) => a.counts.stopped)}**`,
    `- Emails sent by automations: **${sent}**${replied ? ` · leads who replied: **${replied}**` : ""}${unsub ? ` · unsubscribed/bounced: **${unsub}**` : ""}`,
    "",
  ];
  shown.forEach((a, i) => {
    lines.push(`**${i + 1}. ${a.name}** — ${a.kind === "campaign" ? "campaign follow-ups" : "form leads"} · ${a.isActive ? "🟢 on" : "⚪ off"} · used on ${usedByText(a)}`);
    lines.push(...statsLines(a, stats[i]).map((l) => `   ${l}`));
    lines.push("");
  });
  if (list.length > shown.length) lines.push(`…and ${list.length - shown.length} more.`, "");

  // What needs attention.
  const attention: string[] = [];
  for (const a of list) {
    if (!a.isActive && a.counts.running > 0) attention.push(`**${a.name}** is off but **${a.counts.running}** leads are waiting in it — say **turn on ${a.name}** to continue them.`);
    if (a.isActive && (a.kind === "form" ? a.usedBy.length === 0 : a.usedByCampaigns.length === 0)) {
      attention.push(`**${a.name}** is on but not used on any ${a.kind === "form" ? "form" : "campaign"} yet.`);
    }
  }
  const best = shown
    .map((a, i) => ({ a, s: stats[i] }))
    .filter((x) => x.a.kind === "campaign" && x.s && x.s.leads >= 5)
    .sort((x, y) => x.s!.stops.replied / x.s!.leads - y.s!.stops.replied / y.s!.leads)
    .pop();
  if (best?.s && best.s.stops.replied > 0) attention.push(`Best reply rate: **${best.a.name}** (${pct(best.s.stops.replied, best.s.leads)}).`);
  if (callList.length) {
    attention.push(
      `**${plural(callList.length, "call")} to make:** ${callList.slice(0, 3).map((c) => `${str(c.name) || str(c.email)}${str(c.phone) ? ` (${str(c.phone)})` : ""}`).join(", ")}${callList.length > 3 ? " …" : ""} — say **calls to make**.`,
    );
  }
  if (attention.length) lines.push("**Worth a look**", ...attention.map((t) => `- ${t}`), "");
  lines.push("Say **automation <name>** for one automation's details, **create automation**, or e.g. **turn off <name>**.");
  void state;
  return answer(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

async function detail(a: AutomationRow, auth: AuthContext): Promise<Patch> {
  const stats = await statsFor(a, auth).catch(() => undefined);
  const runs = await read("list_automation_runs", { automationId: a.id, status: "open", limit: 10 }, auth);
  const open = runs.ok ? arr(runs.data.runs) : [];
  const lines = [
    `**${a.name}** — ${a.kind === "campaign" ? "campaign follow-ups" : "form leads"} · ${a.isActive ? "🟢 on" : "⚪ off"} · used on ${usedByText(a)}`,
    "",
    "**Steps**",
    ...outlineSteps(a.steps).map((s, i) => `${i + 1}. ${s}`),
    "",
    "**How it is doing**",
    ...statsLines(a, stats).map((l) => `- ${l}`),
  ];
  if (open.length) {
    lines.push("", "**Leads in it now**");
    for (const r of open) {
      const who = str(r.name) ? `${str(r.name)} (${str(r.email)})` : str(r.email);
      const next = r.status === "waiting_call" ? "waiting for your call result" : r.nextRunAt ? `next step ${when(str(r.nextRunAt))}` : "in progress";
      lines.push(`- ${who} — ${next}${str(r.lastError) ? ` · ⚠ ${str(r.lastError)}` : ""}`);
    }
  }
  lines.push(
    "",
    `You can say: **turn ${a.isActive ? "off" : "on"} ${a.name}** · **change the emails of ${a.name}: <what to change>** · **stop <email> in ${a.name}** · **send now <email>** · **delete ${a.name}**`,
  );
  return answer(lines.join("\n"));
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  if (mins <= 1) return "now";
  if (mins < 60) return `in ${plural(mins, "minute")}`;
  if (mins < 48 * 60) return `in ${plural(Math.round(mins / 60), "hour")}`;
  return `in ${plural(Math.round(mins / 1440), "day")}`;
}

async function callsToMake(auth: AuthContext): Promise<Patch> {
  const r = await read("list_automation_calls", {}, auth);
  if (!r.ok) return answer(r.message);
  const calls = arr(r.data.calls);
  if (calls.length === 0) return answer("No calls to make right now. When an automation reaches a call step, the lead shows up here.");
  return answer(
    [
      `**${plural(calls.length, "call")} to make**`,
      "",
      ...calls.slice(0, 20).map((c, i) => {
        const who = str(c.name) ? `${str(c.name)} (${str(c.email)})` : str(c.email);
        return `${i + 1}. **${who}**${str(c.phone) ? ` · 📞 ${str(c.phone)}` : ""} · ${str(c.automationName)}${num(c.attempt) > 1 ? ` · try ${num(c.attempt)}` : ""}${str(c.message) ? ` — ${str(c.message)}` : ""}`;
      }),
      "",
      "After the call, tell me the result, e.g. **ali@shop.com interested**, **ali@shop.com no answer** or **ali@shop.com not interested**.",
    ].join("\n"),
  );
}

// ── Actions on existing automations (each one approval) ──────────────────────

/** The automation named in the message (longest name match), or "automation 2" by its number in the list. */
export function findAutomation(message: string, list: AutomationRow[]): AutomationRow | undefined {
  const t = message.toLowerCase();
  const byName = list
    .filter((a) => a.name.trim().length >= 2 && t.includes(a.name.toLowerCase().trim()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (byName) return byName;
  const n = Number(t.match(/\bautomation\s*#?(\d{1,3})\b/)?.[1] ?? t.match(/^#?(\d{1,3})$/)?.[1]);
  return n >= 1 && n <= list.length ? list[n - 1] : undefined;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const ON_RE = /\b(turn|switch)\s+(?:it\s+)?on\b|\b(enable|activate|chalu|on\s+k(?:a)?r(?:o|\s*do)?|start)\b/i;
const OFF_RE = /\b(turn|switch)\s+(?:it\s+)?off\b|\b(disable|deactivate|pause|band\s+k(?:a)?r(?:o|\s*do)?|off\s+k(?:a)?r(?:o|\s*do)?)\b/i;
const DELETE_RE = /\b(delete|remove|hata\s*do|mita\s*do|khatam\s+k(?:a)?r\s*do)\b/i;
const SEND_NOW_RE = /\bsend\s+(?:it\s+)?now\b|\babhi\s+bhej/i;
const STOP_LEAD_RE = /\b(stop|roko|rok\s*do)\b/i;
const CREATE_RE = /\b(create|new|make|set\s*up|setup|build|bana(?:o|\s*do)?|bna(?:o|\s*do)?)\b/i;
const EDIT_RE = /\b(change|edit|rewrite|improve|update|badlo|badal\s*do|theek\s+k(?:a)?ro)\b.*\b(emails?|messages?|text)\b|\b(emails?|messages?)\b.*\b(change|edit|rewrite|improve|badlo|badal\s*do)\b/i;
const CALL_RESULT_RE = /\b(not\s+interested|no\s+answer|interested)\b/i;

async function findRun(auth: AuthContext, list: AutomationRow[], message: string, only?: AutomationRow): Promise<{ run: Obj; automation: AutomationRow } | { error: string }> {
  const email = message.match(EMAIL_RE)?.[0]?.toLowerCase();
  if (!email) return { error: "Which lead? Write their email address, e.g. **stop ali@shop.com in Welcome**." };
  for (const a of only ? [only] : list) {
    if (a.counts.running + a.counts.waitingCall === 0) continue;
    const r = await read("list_automation_runs", { automationId: a.id, status: "open", limit: 200 }, auth);
    const hit = r.ok ? arr(r.data.runs).find((x) => str(x.email).toLowerCase() === email) : undefined;
    if (hit) return { run: hit, automation: a };
  }
  return { error: `**${email}** is not in progress in ${only ? `**${only.name}**` : "any automation"}.` };
}

async function manage(state: AgentGraphStateType, auth: AuthContext, msg: string): Promise<Patch | undefined> {
  const t = msg.toLowerCase();
  if (/\bcalls? to make\b|\bpending calls?\b|\bkis\s*(?:ko)?\s*call\b/.test(t)) return callsToMake(auth);

  // Create comes before everything else: "create automation for campaign X".
  if (CREATE_RE.test(msg) && /\bautomation\b/i.test(msg) && !DELETE_RE.test(msg)) return startCreate(state, auth, msg);

  const listed = await listAutomations(auth);
  if (!listed.ok) return answer(listed.message);
  const list = listed.list;
  const a = findAutomation(msg, list);

  // Call result: "ali@shop.com interested".
  const result = msg.match(CALL_RESULT_RE)?.[1]?.toLowerCase().replace(/\s+/g, "_");
  if (result && EMAIL_RE.test(msg)) {
    const calls = await read("list_automation_calls", {}, auth);
    if (!calls.ok) return answer(calls.message);
    const email = msg.match(EMAIL_RE)![0].toLowerCase();
    const call = arr(calls.data.calls).find((c) => str(c.email).toLowerCase() === email);
    if (!call) return answer(`**${email}** is not waiting for a call result. Say **calls to make** to see who is.`);
    const label = RESULT_LABEL[result] ?? result;
    return approval(
      "set_automation_call_result",
      { runId: num(call.runId), result },
      `Save the call result **${label}** for **${str(call.name) || email}** in **${str(call.automationName)}**? The steps for "${label}" run right after (they may send an email).`,
    );
  }

  if (SEND_NOW_RE.test(msg)) {
    const found = await findRun(auth, list, msg, a);
    if ("error" in found) return answer(found.error);
    return approval(
      "automation_send_now",
      { runId: num(found.run.id) },
      `Skip the wait for **${str(found.run.email)}** in **${found.automation.name}** and run the next step now? If it is an email, it is sent immediately.`,
    );
  }

  if (STOP_LEAD_RE.test(msg) && EMAIL_RE.test(msg)) {
    const found = await findRun(auth, list, msg, a);
    if ("error" in found) return answer(found.error);
    return approval("stop_automation_run", { runId: num(found.run.id) }, `Stop **${found.automation.name}** for **${str(found.run.email)}**? No more emails or reminders from it for this lead.`);
  }

  if (EDIT_RE.test(msg)) {
    if (!a) return answer(`Which automation? ${list.length ? `Your automations: ${list.map((x) => `**${x.name}**`).join(", ")}.` : "You have none yet."}`);
    return startEdit(state, auth, a, msg);
  }

  if (DELETE_RE.test(msg) && a) {
    const leads = a.counts.running + a.counts.waitingCall;
    return approval(
      "delete_automation",
      { automationId: a.id },
      `Delete the automation **${a.name}**?${leads ? ` **${leads}** leads in progress stop getting its emails.` : ""} Its history is deleted too and ${a.kind === "form" ? "forms using it get no automation" : "its campaigns get no follow-ups"}. This cannot be undone.`,
    );
  }

  // "stop automation X" without a lead's email = turn it off.
  const off = OFF_RE.test(msg) || (STOP_LEAD_RE.test(msg) && !EMAIL_RE.test(msg));
  const on = !off && ON_RE.test(msg);
  if ((on || off) && a) {
    if (a.isActive === on) return answer(`**${a.name}** is already ${on ? "on" : "off"}.`);
    return approval(
      "update_automation",
      { automationId: a.id, isActive: on },
      on
        ? `Turn on **${a.name}**? From now on it sends its emails by itself (${usedByText(a)}).${a.counts.running ? ` **${a.counts.running}** waiting leads continue.` : ""}`
        : `Turn off **${a.name}**? No more emails or reminders go out. Leads in it wait and continue when you turn it on again.`,
    );
  }

  // "use automation X on form Y"
  if (a && /\bform\b/i.test(msg) && /\b(use|add|attach|connect|lagao|laga\s*do|jodo|jod\s*do|on)\b/i.test(msg) && a.kind === "form") {
    const forms = await read("list_crm_forms", {}, auth);
    if (!forms.ok) return answer(forms.message);
    const t2 = msg.toLowerCase().replace(a.name.toLowerCase(), "");
    const form = arr(forms.data.forms).find((f) => str(f.name) && t2.includes(str(f.name).toLowerCase()));
    if (!form) return answer(`Which form? Your forms: ${arr(forms.data.forms).map((f) => `**${str(f.name)}**`).join(", ") || "none yet"}.`);
    return approval("set_form_automation", { formId: num(form.id), automationId: a.id }, `Use **${a.name}** on the form **${str(form.name)}**? Every new lead from this form goes through it${a.isActive ? "" : " once you turn it on"}.`);
  }

  if (a) return detail(a, auth);
  return undefined;
}

// ── Results of the approved actions (finalResponse) ──────────────────────────

const AUTOMATION_ACTION_TOOLS = new Set([
  "update_automation",
  "delete_automation",
  "set_automation_call_result",
  "stop_automation_run",
  "automation_send_now",
  "set_form_automation",
  "set_campaign_automation",
]);

/** Every automation tool (and the recipient replacement it uses): only this flow calls them, never the planner. */
const AUTOMATION_TOOLS = new Set([
  ...AUTOMATION_ACTION_TOOLS,
  "list_automations",
  "get_automation",
  "list_automation_templates",
  "create_automation",
  "list_automation_runs",
  "list_automation_calls",
  "get_automation_run_events",
  "get_campaign_automation",
  "list_crm_forms",
  "delete_campaign_recipients",
]);

export function isAutomationTool(name: string | undefined): boolean {
  return name !== undefined && AUTOMATION_TOOLS.has(name);
}

export function isAutomationActionTool(name: string | undefined): boolean {
  return name !== undefined && AUTOMATION_ACTION_TOOLS.has(name);
}

/** The chat message after an approved automation action ran (success or the backend's reason). */
export function formatAutomationToolResult(toolName: string, toolArgs: Obj, result: { data: unknown; isToolError?: boolean }): string {
  const d = (result.data && typeof result.data === "object" ? result.data : {}) as Obj;
  if (result.isToolError || d.success === false) {
    const e = (d.error && typeof d.error === "object" ? d.error : {}) as Obj;
    const details = (e.details && typeof e.details === "object" ? e.details : {}) as Obj;
    const reason = str(details.error) || str(details.message) || str(e.message) || "The request failed.";
    return envelope("error", `That did not work: ${friendlyError(reason)}`);
  }
  const p = (d.success === true && d.data && typeof d.data === "object" ? d.data : d) as Obj;
  const a = (p.automation && typeof p.automation === "object" ? p.automation : {}) as Obj;
  const name = str(a.name) ? `**${str(a.name)}**` : "The automation";
  switch (toolName) {
    case "update_automation":
      if (toolArgs.isActive === true) return envelope("success", `${name} is **on**. It now sends its emails by itself. Say **automations** any time to see how it is doing.`);
      if (toolArgs.isActive === false) return envelope("success", `${name} is **off**. Leads in it wait and continue when you turn it on again.`);
      return envelope("success", `Saved. ${name} uses the new emails from each lead's next email.`);
    case "delete_automation":
      return envelope("success", "The automation was deleted.");
    case "set_form_automation":
      return envelope("success", "Done — new leads from that form now go through the automation (while it is on).");
    case "set_campaign_automation":
      return envelope("success", "Done — the campaign now has this follow-up automation.");
    default:
      return envelope("success", str(p.message) || "Done.");
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────

export async function handleAutomations(state: AgentGraphStateType): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return answer("Please sign in again — I could not reach your automations.");
  const msg = state.userMessage.trim();
  const ctx = liveAutomationFlow(state.automationFlow);
  try {
    if (ctx) return await continueFlow(state, auth, ctx, msg);
    return (await manage(state, auth, msg)) ?? (await summary(state, auth));
  } catch (err) {
    log.error({ step: ctx?.step, err: err instanceof Error ? err.message : String(err) }, "automation flow failed");
    return ctx ? reply(ctx, "Something went wrong in this step. Please try again, or say **cancel** to stop.") : answer("Something went wrong while reading your automations. Please try again.");
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

const KIND_QUESTION = [
  "Let's set up an automation. **What should it do?**",
  "",
  "1. **New leads from a form** — when someone fills a form on your website: a welcome email, follow-ups, reminders, a call",
  "2. **Campaign follow-ups** — follow-ups that go out by themselves to people who did not reply to a campaign (they stop when someone replies)",
  "",
  "Reply **1** or **2**.",
].join("\n");

async function startCreate(state: AgentGraphStateType, auth: AuthContext, msg: string): Promise<Patch> {
  const ctx: AutomationFlowState = { step: "kind", mode: "create", atIso: new Date().toISOString() };
  const clear: Patch = { campaignCreation: undefined };
  if (/\bcampaign|follow[\s-]?ups?\b/i.test(msg) && !/\bform\b/i.test(msg)) return { ...(await askTarget(state, auth, { ...ctx, kind: "campaign" }, msg)), ...clear };
  if (/\bform\b/i.test(msg)) return { ...(await askTarget(state, auth, { ...ctx, kind: "form" }, msg)), ...clear };
  return reply(ctx, KIND_QUESTION, clear);
}

async function askTarget(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState, msg = ""): Promise<Patch> {
  if (ctx.kind === "form") {
    const forms = await read("list_crm_forms", {}, auth);
    if (!forms.ok) return answer(forms.message);
    const list = arr(forms.data.forms).map((f) => ({ id: String(num(f.id)), label: str(f.name) || `Form ${num(f.id)}`, has: f.automationId != null }));
    const named = list.find((f) => msg.toLowerCase().includes(f.label.toLowerCase()));
    if (named) return chooseTemplate(state, auth, { ...ctx, target: { type: "form", id: Number(named.id), name: named.label } });
    const choices = [...list.map(({ id, label }) => ({ id, label })), { id: "none", label: "No form yet (I'll add it to a form later)" }];
    return reply(
      { ...ctx, step: "target", choices },
      [
        "**Which form should start it?** Every new lead from that form goes through the automation.",
        "",
        ...choices.map((c, i) => `${i + 1}. ${c.id === "none" ? c.label : `**${c.label}**${list[i]?.has ? " *(has an automation now — it will be replaced)*" : ""}`}`),
        "",
        "Reply with the number or the form name.",
      ].join("\n"),
    );
  }
  const listed = await read("get_all_campaigns", {}, auth);
  if (!listed.ok) return answer(listed.message);
  const raw = Array.isArray(listed.data) ? (listed.data as Obj[]) : arr(listed.data.campaigns);
  const open = raw
    .filter((c) => ["draft", "scheduled"].includes(str(c.status)))
    .map((c) => ({ id: String(c.id), label: str(c.name) || `Campaign ${String(c.id)}`, status: str(c.status) }));
  if (open.length === 0) {
    return answer(
      "A campaign's follow-up automation has to be chosen **before the campaign starts**, and you have no draft or scheduled campaign right now. Say **create campaign** first, then **create automation** for it.",
    );
  }
  const named = open.find((c) => msg.toLowerCase().includes(c.label.toLowerCase()));
  if (named) return chooseTemplate(state, auth, { ...ctx, target: { type: "campaign", id: Number(named.id), name: named.label, status: named.status } });
  return reply(
    { ...ctx, step: "target", choices: open.map(({ id, label }) => ({ id, label })) },
    [
      "**Which campaign is it for?** (only campaigns that have not started can get an automation)",
      "",
      ...open.map((c, i) => `${i + 1}. **${c.label}** — ${c.status}`),
      "",
      "Reply with the number or the campaign name.",
    ].join("\n"),
  );
}

function pickChoice(msg: string, choices: Array<{ id: string; label: string }>): { id: string; label: string } | undefined {
  const t = msg.trim().toLowerCase();
  const n = Number(t.match(/^#?(\d{1,3})\b/)?.[1]);
  if (n >= 1 && n <= choices.length) return choices[n - 1];
  return choices.find((c) => c.label.toLowerCase() === t) ?? choices.find((c) => t.length >= 3 && c.label.toLowerCase().includes(t));
}

async function chooseTemplate(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState): Promise<Patch> {
  const r = await read("list_automation_templates", {}, auth);
  const templates = r.ok ? arr(r.data.templates).filter((t) => t.kind === ctx.kind) : [];
  const choices = [...templates.map((t) => ({ id: str(t.key), label: str(t.name) })), { id: "own", label: "My own plan" }];
  const lines = [
    ctx.target ? `For **${ctx.target.name}**.` : "Not on a form yet — you can add it later (say *use <automation> on form <name>*).",
    "",
    "**Start from a ready-made plan, or your own?** (I write all the emails for you either way)",
    "",
    ...templates.map((t, i) => `${i + 1}. **${str(t.name)}** — ${str(t.description)}`),
    `${templates.length + 1}. **My own plan** — you tell me how many follow-ups and how many days apart`,
    "",
    "Reply with the number.",
  ];
  void state;
  return reply({ ...ctx, step: "template", choices }, lines.join("\n"));
}

const PLAN_QUESTION = (kind: "form" | "campaign") =>
  kind === "form"
    ? "**How many follow-ups after the welcome email, and how many days apart?** e.g. *2 follow-ups, 2 days apart*. Add **with reminder** for a bell reminder to you after the welcome email."
    : "**How many follow-ups, and how many days apart?** e.g. *3 follow-ups, 2 days apart* (the first one goes that many days after the campaign email).";

/** "3 follow-ups, 2 days apart" → { followUps: 3, gapDays: 2 }. */
export function readPlan(msg: string): { followUps: number; gapDays: number; reminder: boolean } | undefined {
  const t = msg.toLowerCase();
  const nums = [...t.matchAll(/\d+/g)].map((m) => Number(m[0]));
  const followUps = Number(t.match(/(\d+)\s*(?:follow[\s-]?ups?|emails?|baar)/)?.[1] ?? nums[0]);
  const gapDays = Number(t.match(/(\d+)\s*(?:days?|din)/)?.[1] ?? nums[1] ?? 2);
  if (!Number.isInteger(followUps) || followUps < 1 || followUps > 5) return undefined;
  if (!Number.isInteger(gapDays) || gapDays < 1 || gapDays > 14) return undefined;
  return { followUps, gapDays, reminder: /\breminder\b|\byaad\b/.test(t) };
}

/** Steps of an own plan, with empty emails (written later). */
export function planSteps(kind: "form" | "campaign", plan: { followUps: number; gapDays: number; reminder: boolean }): Obj[] {
  const steps: Obj[] = [];
  const wait = (i: number) => ({ id: `wait${i}`, type: "wait", amount: plan.gapDays, unit: "days" });
  if (kind === "form") {
    steps.push({ id: "welcome", type: "email", subject: "Thanks, {{first_name}}", body: "Hi {{first_name}},\n\nThanks for reaching out.\n\nBest" });
    if (plan.reminder) steps.push({ id: "remind", type: "remind", message: "New lead from your form. Answer them soon." });
  }
  for (let i = 1; i <= plan.followUps; i++) {
    steps.push(wait(i));
    steps.push({ id: `follow_up_${i}`, type: "email", subject: "", body: "Hi {{first_name}},\n\nA quick follow-up.\n\nBest" });
  }
  return steps;
}

async function chooseSmtp(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState): Promise<Patch> {
  if (ctx.kind !== "form") return askPurpose(state, auth, ctx);
  const r = await read("get_smtp_settings", {}, auth);
  const accounts = r.ok ? arr(r.data.accounts) : [];
  const fallback = state.senderDefaults?.smtpSettingsId;
  if (accounts.length === 0 && !fallback) {
    return answer("Add an email account first (**Settings → Email accounts**): the automation's emails are sent from it. Then say **create automation** again.");
  }
  if (accounts.length <= 1) {
    const one = accounts[0];
    return askPurpose(state, auth, { ...ctx, smtpSettingsId: one ? num(one.id) : fallback, smtpLabel: one ? str(one.fromEmail) : state.senderDefaults?.fromEmail });
  }
  const choices = accounts.map((x) => ({ id: String(num(x.id)), label: str(x.fromEmail) }));
  return reply(
    { ...ctx, step: "smtp", choices },
    ["**Which email account should send the emails?**", "", ...choices.map((c, i) => `${i + 1}. **${c.label}**`), "", "Reply with the number or the address."].join("\n"),
  );
}

/** Campaign: its recipients and their first emails (for per-recipient follow-ups and the offer). */
async function loadCampaign(auth: AuthContext, ctx: AutomationFlowState, key: string): Promise<{ purpose?: string; signer?: string; perRecipient: boolean; count: number }> {
  const got = await read("get_campaign_recipients", { campaignId: String(ctx.target!.id), limit: MAX_PER_RECIPIENT + 1 }, auth);
  if (!got.ok) return { perRecipient: false, count: 0 };
  const campaign = (got.data.campaign ?? {}) as Obj;
  const all = arr(got.data.recipients);
  const total = num(got.data.total) || all.length;
  const keys = [...new Set(all.flatMap((r) => Object.keys((r.customFields ?? {}) as Obj)))].filter((k) => !/^ai_/i.test(k) && !/^(email|name)$/i.test(k));
  const header = ["email", "name", ...keys];
  const table = [header, ...all.map((r) => [str(r.email), str(r.name), ...keys.map((k) => String(((r.customFields ?? {}) as Obj)[k] ?? ""))])];
  let layout = guessLayout(table);
  const openai = getOpenAIService();
  if (openai) {
    try {
      layout = layoutFromLlm(await openai.completeJson(COLUMN_READER_PROMPT, JSON.stringify({ rows: table.slice(0, 8) }), 0), table);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "column reading failed — using the value-based guess");
    }
  }
  layout = { ...layout, hasHeader: true, columns: layout.columns.map((c) => ({ ...c, label: header[c.index] ?? c.label })) };
  const { recipients } = recipientsFromTable(table, layout);

  // Table row N (row 1 = the header) is all[N - 2]; rows, not emails, since an address may repeat.
  const existing: NonNullable<CreationJob["existing"]> = {};
  const rawFields: NonNullable<CreationJob["rawFields"]> = {};
  let signer: string | undefined;
  for (const r of recipients) {
    const raw = all[r.row - 2];
    const cf = ((raw?.customFields ?? {}) as Record<string, string>);
    rawFields[recipientKey(r)] = { name: str(raw?.name) || null, fields: { ...cf } };
    const own = str(cf.ai_body).trim() ? { subject: str(cf.ai_subject), html: cf.ai_body! } : undefined;
    const html = own?.html ?? fillPlaceholders(str(campaign.body), r, str(raw?.name) || undefined, cf);
    const subject = own?.subject || fillPlaceholders(str(campaign.subject), r, str(raw?.name) || undefined, cf);
    const body = htmlToBody(html).trim();
    if (!body || /\{\{\s*ai_body\s*\}\}/i.test(body)) continue;
    existing[recipientKey(r)] = { subject: subject.replace(/\{\{?\s*ai_subject\s*\}?\}/gi, "").trim(), body };
    signer ??= signerOf(body);
  }
  // Per recipient only when every recipient was read (they are saved again) and the campaign is still a draft.
  const perRecipient =
    ctx.target?.status === "draft" && total > 0 && total <= MAX_PER_RECIPIENT && recipients.length === all.length && all.length === total &&
    Object.keys(existing).length > 0;
  if (perRecipient) {
    const job: CreationJob = { status: "ready", kind: "followups", recipients, existing, rawFields, results: {}, doneInRun: [], updatedAt: "" };
    await saveJob(key, job);
  }
  const purpose = purposeFromCampaign(str(campaign.subject), str(campaign.body)) ?? offerFromEmails(existing);
  return { ...(purpose ? { purpose } : {}), ...(signer ? { signer } : {}), perRecipient, count: total };
}

async function askPurpose(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState): Promise<Patch> {
  const key = automationJobKey(state);
  if (ctx.kind === "campaign" && ctx.target && ctx.perRecipient === undefined) {
    const c = await loadCampaign(auth, ctx, key);
    ctx = { ...ctx, perRecipient: c.perRecipient, ...(c.purpose ? { purpose: c.purpose } : {}), ...(c.signer && !ctx.senderName ? { senderName: c.signer } : {}) };
  }
  if (!ctx.purpose) {
    return reply(
      { ...ctx, step: "purpose" },
      ctx.kind === "form"
        ? "**What does your business offer, and what do people ask for in this form?** e.g. *We build websites for clinics; people ask for a quote*. I use it to write the emails."
        : "**What does this campaign offer?** e.g. *I'm a React developer offering to rebuild their dashboard*. I use it to write the follow-ups.",
    );
  }
  return askSender(state, auth, ctx);
}

async function askSender(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState): Promise<Patch> {
  const sender = state.senderDefaults?.fromName?.trim().split(/\s+/)[0] || ctx.senderName;
  if (!sender) return reply({ ...ctx, step: "sender" }, "**What first name should sign the emails?** (e.g. *Bassam*)");
  return createAndWrite(state, auth, { ...ctx, senderName: sender });
}

/** Creates the automation OFF (like "New automation" on the web), then writes its emails. */
async function createAndWrite(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState): Promise<Patch> {
  if (!ctx.automationId) {
    const name = `${ctx.templateName ?? (ctx.kind === "campaign" ? "Follow-ups" : "Lead follow-ups")} – ${ctx.target?.name ?? "new leads"}`.slice(0, 255);
    const args: Obj = ctx.templateKey
      ? { name, kind: ctx.kind, templateKey: ctx.templateKey }
      : { name, kind: ctx.kind, steps: planSteps(ctx.kind!, ctx.plan ?? { followUps: 2, gapDays: 2, reminder: false }) };
    if (ctx.kind === "form" && ctx.smtpSettingsId) args.smtpSettingsId = ctx.smtpSettingsId;
    const created = await read("create_automation", args, auth);
    if (!created.ok) return answer(`I could not create the automation: ${created.message}`);
    const a = toAutomation((created.data.automation ?? created.data) as Obj);
    ctx = { ...ctx, automationId: a.id, automationName: a.name };
  }
  return writeEmails(state, auth, ctx);
}

// ── Writing the emails ───────────────────────────────────────────────────────

/** The email steps of an automation, in order (main steps, then each call result). */
export function emailSlots(steps: Obj[]): Array<{ path: Array<string | number>; role: string; needsSubject: boolean; hint: string; daysBefore: number }> {
  const out: Array<{ path: Array<string | number>; role: string; needsSubject: boolean; hint: string; daysBefore: number }> = [];
  let days = 0;
  let mainEmails = 0;
  steps.forEach((s, i) => {
    if (s.type === "wait") days += num(s.amount) * (s.unit === "hours" ? 1 / 24 : s.unit === "minutes" ? 1 / 1440 : 1);
    if (s.type === "email") {
      mainEmails++;
      out.push({
        path: [i],
        role: mainEmails === 1 ? "first email" : `follow-up ${mainEmails - 1}`,
        needsSubject: str(s.subject).trim() !== "",
        hint: str(s.body).slice(0, 400),
        daysBefore: Math.round(days),
      });
      days = 0;
    }
    if (s.type === "call") {
      const outcomes = (s.outcomes ?? {}) as Record<string, Obj[]>;
      for (const k of Object.keys(RESULT_LABEL)) {
        arr(outcomes[k]).forEach((o, j) => {
          if (o.type === "email") {
            out.push({ path: [i, "outcomes", k, j], role: `after the call: ${RESULT_LABEL[k]}`, needsSubject: str(o.subject).trim() !== "", hint: str(o.body).slice(0, 400), daysBefore: 0 });
          }
        });
      }
    }
  });
  return out;
}

/** The steps with the written emails put in (the structure, waits, calls, tags and stages are kept). */
export function applyEmails(steps: Obj[], emails: Array<{ subject: string; body: string }>, perRecipient: boolean): Obj[] {
  const copy = JSON.parse(JSON.stringify(steps)) as Obj[];
  emailSlots(copy).forEach((slot, n) => {
    let target: Obj = copy[slot.path[0] as number]!;
    if (slot.path.length > 1) target = arr(((target.outcomes ?? {}) as Record<string, Obj[]>)[slot.path[2] as string])[slot.path[3] as number]!;
    if (perRecipient) {
      target.subject = "";
      target.body = `{{ai_followup_${n + 1}}}`;
      return;
    }
    const e = emails[n];
    if (!e) return;
    target.subject = slot.needsSubject ? e.subject : "";
    target.body = e.body;
  });
  return copy;
}

const ALLOWED = { form: ["first_name", "name", "company", "form"], campaign: ["first_name", "name", "company"] };

/** Problems of one template email (empty = fine). */
export function templateEmailIssues(e: { subject: string; body: string }, o: { first: boolean; needsSubject: boolean; sender: string; kind: "form" | "campaign" }): string[] {
  const issues: string[] = [];
  const { greeting, paragraphs, signature } = splitBody(e.body);
  if (!/^hi \{\{first_name\}\},$/i.test(greeting.trim())) issues.push('start with the line "Hi {{first_name}},"');
  if (paragraphs.length < 1 || paragraphs.length > 3) issues.push(`write 1–3 short paragraphs (found ${paragraphs.length})`);
  const words = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  const [min, max] = o.first && o.kind === "form" ? [40, 115] : [15, 75];
  if (words < min || words > max) issues.push(`the text has ${words} words; it must have ${min}–${max}`);
  if (o.sender && !signature.slice(1).some((l) => l.toLowerCase().includes(o.sender.toLowerCase()))) issues.push(`end with "Best," and "${o.sender}" on the next line`);
  const used = [...`${e.subject} ${e.body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1]!.toLowerCase());
  const bad = used.filter((p) => !ALLOWED[o.kind].includes(p));
  if (bad.length) issues.push(`only these placeholders: ${ALLOWED[o.kind].map((p) => `{{${p}}}`).join(", ")} (remove ${[...new Set(bad)].map((p) => `{{${p}}}`).join(", ")})`);
  const stripped = `${e.subject}\n${e.body}`.replace(/\{\{\s*[a-z_]+\s*\}\}/gi, "");
  if (/[{}[\]]|<\s*[a-z]+[\s>]|\*\*|https?:\/\/|www\.|!|\.\.\.|…|\?\?/i.test(stripped)) issues.push('plain text only: no brackets, HTML, markdown, links, "!", "..." or "??"');
  const banned = phraseHits(stripped, [...SPAM_PHRASES, ...CLICHE_PHRASES, "just following up", "bumping this", "circling back", "touch base", "reach out"]);
  if (banned.length) issues.push(`remove: ${banned.join(", ")}`);
  if (o.needsSubject) {
    const sw = e.subject.replace(/\{\{\s*[a-z_]+\s*\}\}/gi, "x").split(/\s+/).filter(Boolean).length;
    if (sw < 2 || sw > 7) issues.push(`the subject must have 2–7 words (it has ${sw})`);
  }
  return issues;
}

/** Writes all template emails at once (one AI call, up to 3 tries with the problems as feedback). */
async function writeTemplates(ctx: AutomationFlowState, slots: ReturnType<typeof emailSlots>, instruction?: string): Promise<{ emails: FlowEmail[]; issues: string[] }> {
  const fallback = slots.map((s) => ({ role: s.role, subject: s.needsSubject ? "Thanks, {{first_name}}" : "", body: s.hint }));
  const openai = getOpenAIService();
  if (!openai) return { emails: fallback, issues: ["AI is not configured on the server; the template's own texts are used"] };
  const sender = ctx.senderName ?? "";
  let feedback: string[] | undefined;
  let last: FlowEmail[] = fallback;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = await openai.completeJson(
        AUTOMATION_EMAILS_PROMPT,
        JSON.stringify({
          sender: { first_name: sender, offer: ctx.purpose ?? "" },
          automation: { kind: ctx.kind },
          target: ctx.target?.name ?? "",
          emails: slots.map((s) => ({ role: s.role, needs_subject: s.needsSubject, original_text: s.hint, days_since_previous: s.daysBefore })),
          allowed_placeholders: ALLOWED[ctx.kind ?? "form"].map((p) => `{{${p}}}`),
          ...(instruction ? { change_request: instruction } : {}),
          ...(feedback ? { feedback: `Fix these problems: ${feedback.join(" | ")}` } : {}),
        }),
        0.6,
      );
      const list = arr(out.emails);
      const emails = slots.map((s, i) => ({
        role: s.role,
        subject: s.needsSubject ? str(list[i]?.subject).replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "",
        body: normalizeBody(str(list[i]?.body).slice(0, 4000)),
      }));
      const problems =
        list.length < slots.length
          ? [`write exactly ${slots.length} emails (got ${list.length})`]
          : emails.flatMap((e, i) =>
              templateEmailIssues(e, { first: i === 0, needsSubject: slots[i]!.needsSubject, sender, kind: ctx.kind ?? "form" }).map((p) => `email ${i + 1} (${slots[i]!.role}): ${p}`),
            );
      log.info({ attempt, problems }, "automation emails checked");
      if (list.length >= slots.length) last = emails;
      if (problems.length === 0) return { emails, issues: [] };
      feedback = problems;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "automation emails: AI call failed");
      feedback = ["the answer could not be read"];
    }
  }
  return { emails: last, issues: feedback ?? [] };
}

function automationJobKey(state: AgentGraphStateType): string {
  return `automation-flow:${String(state.userId ?? "unknown")}:${String(state.sessionId ?? "unknown")}`;
}

async function currentSteps(auth: AuthContext, id: number): Promise<Obj[] | undefined> {
  const r = await read("get_automation", { automationId: id }, auth);
  return r.ok ? toAutomation((r.data.automation ?? r.data) as Obj).steps : undefined;
}

async function writeEmails(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState, instruction?: string): Promise<Patch> {
  const steps = await currentSteps(auth, ctx.automationId!);
  if (!steps) return answer("I could not read the automation back. Please try again.");
  const slots = emailSlots(steps);
  if (slots.length === 0) return answer("This automation has no email steps to write.");
  const written = await writeTemplates(ctx, slots, instruction);
  ctx = { ...ctx, emails: written.emails, followUpCount: slots.length, ...(instruction ? { instruction } : {}) };

  if (ctx.perRecipient) {
    const key = automationJobKey(state);
    const job = await loadJob(key);
    if (!job) return reviewOrAsk({ ...ctx, perRecipient: false }, written.issues);
    job.kind = "followups";
    job.brief = {
      name: ctx.automationName ?? "",
      purpose: ctx.purpose ?? "",
      ...(ctx.senderName ? { senderName: ctx.senderName } : {}),
      language: "English, unless the first email is in another language",
      ...(instruction ? { structure: instruction } : {}),
      sequence: { type: "cold_outreach", count: slots.length, breakup: slots.length >= 3, short: false },
    };
    job.results = {};
    job.doneInRun = [];
    startRun(key, job, auth);
    const minutes = Math.max(1, Math.round((job.recipients.length * 8) / 3 / 60));
    return reply(
      { ...ctx, step: "writing" },
      [
        `Automation **${ctx.automationName}** is created (**off** — nothing is sent yet).`,
        "",
        `Now I'm writing **${plural(slots.length, "follow-up")} for each of the ${job.recipients.length} recipients**, from the first email each one gets. About **${plural(minutes, "minute")}** — send any message (e.g. **status**) to see the progress.`,
      ].join("\n"),
    );
  }
  return reviewOrAsk({ ...ctx, step: "review" }, written.issues);
}

function quote(text: string): string {
  return text.split("\n").map((l) => `> ${l}`).join("\n");
}

const REVIEW_OPTIONS = [
  "**What next?**",
  "- **approve** — save it (you then confirm turning it on)",
  "- or type a change for the emails (e.g. *make them shorter*, *mention the free consultation*)",
  "- **regenerate** — write them again · **cancel** — delete this draft automation",
].join("\n");

async function reviewText(ctx: AutomationFlowState, steps: Obj[] | undefined, job: CreationJob | undefined, issues: string[]): Promise<string> {
  const lines = [`**${ctx.automationName ?? "Your automation"}** — ${ctx.kind === "campaign" ? "campaign follow-ups" : "form leads"}${ctx.target ? ` for **${ctx.target.name}**` : ""}`, ""];
  if (steps) {
    const applied = applyEmails(steps, ctx.emails ?? [], !!ctx.perRecipient);
    lines.push("**Plan**", ...outlineSteps(applied).map((s, i) => `${i + 1}. ${s}`), "");
  }
  if (ctx.perRecipient && job) {
    const items = job.recipients.map((r) => ({ r, e: job.results[recipientKey(r)] }));
    const ok = items.filter((x) => x.e && !x.e.error && (x.e.followUps?.length ?? 0) > 0);
    const failed = items.length - ok.length;
    lines.push(`Follow-ups written for **${ok.length}/${items.length}** recipients, each from their own first email.`);
    if (failed) lines.push(`${failed} get the general follow-ups below instead (their first email was missing or the checks kept failing).`);
    lines.push("");
    for (const x of ok.slice(0, 2)) {
      lines.push(`**${x.r.name ? `${x.r.name} — ` : ""}${x.r.email}**`);
      (x.e!.followUps ?? []).forEach((f, i) => lines.push(`*Follow-up ${i + 1}:*`, quote(f.body), ""));
    }
    lines.push("**General follow-ups** (only for recipients without their own):", "");
  }
  for (const e of ctx.emails ?? []) {
    lines.push(`*${e.role[0]!.toUpperCase()}${e.role.slice(1)}*${e.subject ? ` — **Subject:** ${e.subject}` : ""}`, quote(e.body), "");
  }
  if (issues.length) lines.push(`*Some checks did not pass after 3 tries: ${issues.slice(0, 3).join("; ")}. You can type a change, or approve as it is.*`, "");
  lines.push("`{{first_name}}` is filled with each lead's first name when the email is sent.", "", REVIEW_OPTIONS);
  return lines.join("\n");
}

async function reviewOrAsk(ctx: AutomationFlowState, issues: string[]): Promise<Patch> {
  return reply({ ...ctx, step: "review" }, "__REVIEW__", { automationIssues: issues } as Patch);
}

// ── Continuing the flow ──────────────────────────────────────────────────────

async function continueFlow(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState, msg: string): Promise<Patch> {
  const key = automationJobKey(state);
  if (CANCEL_RE.test(msg) && msg.length <= 40) {
    await deleteJob(key);
    if (ctx.mode === "create" && ctx.automationId) {
      await read("delete_automation", { automationId: ctx.automationId }, auth);
      return answer("Stopped. The draft automation was deleted — nothing was sent or changed.");
    }
    return answer("Stopped. Nothing was changed.");
  }

  let out: Patch;
  switch (ctx.step) {
    case "kind": {
      const kind = /^1\b|\bform\b|lead/i.test(msg) ? "form" : /^2\b|campaign|follow/i.test(msg) ? "campaign" : undefined;
      if (!kind) return reply(ctx, KIND_QUESTION);
      out = await askTarget(state, auth, { ...ctx, kind });
      break;
    }
    case "target": {
      const c = pickChoice(msg, ctx.choices ?? []);
      if (!c) return reply(ctx, `Please reply with a number from 1 to ${(ctx.choices ?? []).length}, or the name.`);
      const target =
        c.id === "none"
          ? undefined
          : ctx.kind === "form"
            ? { type: "form" as const, id: Number(c.id), name: c.label }
            : { type: "campaign" as const, id: Number(c.id), name: c.label, status: "" };
      if (target?.type === "campaign") {
        const info = await read("get_campaign_automation", { campaignId: target.id }, auth);
        if (info.ok) {
          target.status = str(info.data.campaignStatus);
          if (info.data.canChange === false) return reply(ctx, `**${target.name}** has already started, so its automation can no longer be changed. Pick another campaign.`);
        }
      }
      const { target: _old, ...rest } = ctx;
      out = await chooseTemplate(state, auth, { ...rest, ...(target ? { target } : {}) });
      break;
    }
    case "template": {
      const c = pickChoice(msg, ctx.choices ?? []);
      if (!c) return reply(ctx, `Please reply with a number from 1 to ${(ctx.choices ?? []).length}.`);
      if (c.id === "own") return reply({ ...ctx, step: "plan" }, PLAN_QUESTION(ctx.kind ?? "form"));
      out = await chooseSmtp(state, auth, { ...ctx, templateKey: c.id, templateName: c.label });
      break;
    }
    case "plan": {
      const plan = readPlan(msg);
      if (!plan) return reply(ctx, `I could not read that. ${PLAN_QUESTION(ctx.kind ?? "form")} (1–5 follow-ups, 1–14 days apart)`);
      out = await chooseSmtp(state, auth, { ...ctx, plan, templateName: `${plan.followUps} follow-ups` });
      break;
    }
    case "smtp": {
      const c = pickChoice(msg, ctx.choices ?? []);
      if (!c) return reply(ctx, `Please reply with a number from 1 to ${(ctx.choices ?? []).length}, or the address.`);
      out = await askPurpose(state, auth, { ...ctx, smtpSettingsId: Number(c.id), smtpLabel: c.label });
      break;
    }
    case "purpose":
      if (msg.length < 3) return reply(ctx, "Please tell me in a sentence what you offer.");
      out = await askSender(state, auth, { ...ctx, purpose: msg.slice(0, 1000) });
      break;
    case "sender": {
      const name = msg.replace(/^["“']|["”']$/g, "").trim();
      if (!/^[\p{L}][\p{L} .'-]{0,40}$/u.test(name)) return reply(ctx, "Please send just the first name that should sign the emails (e.g. *Bassam*).");
      out = await createAndWrite(state, auth, { ...ctx, senderName: name.split(/\s+/)[0] });
      break;
    }
    case "writing": {
      const job = await loadJob(key);
      if (job && job.status === "running" && !isRunningHere(key)) startRun(key, job, auth);
      if (job && (job.status === "running" || job.status === "ready")) {
        return reply(ctx, `Writing the follow-ups: **${job.doneInRun.length}/${job.recipients.length}** recipients done. Send another message in a bit, or **cancel**.`);
      }
      out = await reviewOrAsk({ ...ctx, step: "review" }, []);
      break;
    }
    case "review":
      out = await reviewed(state, auth, ctx, msg);
      break;
    default:
      return reply(ctx, "Please answer the last question, or say **cancel** to stop.");
  }
  return render(auth, state, out);
}

/** Fills in the review text (it needs the automation's steps and the job). */
async function render(auth: AuthContext, state: AgentGraphStateType, out: Patch): Promise<Patch> {
  const ctx = out.automationFlow;
  if (!ctx || !String(out.formattedResponse ?? "").includes("__REVIEW__")) return out;
  const issues = ((out as Obj).automationIssues as string[] | undefined) ?? [];
  const { automationIssues: _x, ...rest } = out as Patch & { automationIssues?: unknown };
  const steps = ctx.automationId ? await currentSteps(auth, ctx.automationId) : undefined;
  const job = ctx.perRecipient ? await loadJob(automationJobKey(state)) : undefined;
  return { ...rest, formattedResponse: envelope("needs_input", await reviewText(ctx, steps, job, issues)) };
}

async function reviewed(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState, msg: string): Promise<Patch> {
  if (/^(regenerate|redo|again|dobara)\b/i.test(msg)) return writeEmails(state, auth, ctx, ctx.instruction);
  if (APPROVE_RE.test(msg) && msg.length <= 30) return save(state, auth, ctx);
  if (msg.length >= 4) return writeEmails(state, auth, ctx, msg.slice(0, 600));
  return reviewOrAsk(ctx, []);
}

// ── Saving ───────────────────────────────────────────────────────────────────

/** One recipient row saved again: its own row unchanged + its follow-ups; very long other columns go first. */
export function recipientRow(email: string, saved: { name: string | null; fields: Record<string, string> }, followUps: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(saved.fields)) {
    if (/^(email|name)$/i.test(k) || /^ai_followup_\d+$/i.test(k)) continue;
    fields[k] = String(v);
  }
  const extra: Record<string, string> = {};
  followUps.forEach((f, i) => (extra[`ai_followup_${i + 1}`] = f));
  const size = () => JSON.stringify({ ...fields, ...extra }).length;
  while (size() > MAX_CUSTOM_FIELDS_CHARS) {
    const longest = Object.keys(fields).filter((k) => !/^ai_/i.test(k)).sort((a, b) => fields[b]!.length - fields[a]!.length)[0];
    if (!longest) break;
    delete fields[longest];
  }
  return { email, ...(saved.name ? { name: saved.name } : {}), ...fields, ...extra };
}

/** The general follow-up for one recipient (their first name filled in; the backend does not fill nested placeholders). */
function generalFor(body: string, r: CampaignRecipient): string {
  return body.replace(/\{\{\s*first_name\s*\}\}/gi, r.firstName ?? "there").replace(/\{\{\s*name\s*\}\}/gi, r.name ?? "there").replace(/\{\{\s*company\s*\}\}/gi, r.company ?? "your team");
}

async function save(state: AgentGraphStateType, auth: AuthContext, ctx: AutomationFlowState): Promise<Patch> {
  const steps = await currentSteps(auth, ctx.automationId!);
  if (!steps) return reply(ctx, "I could not read the automation. Reply **approve** to try again, or **cancel**.");
  const finalSteps = applyEmails(steps, ctx.emails ?? [], !!ctx.perRecipient);

  // Edit: the new emails are saved after the approval card.
  if (ctx.mode === "edit") {
    return approval(
      "update_automation",
      { automationId: ctx.automationId, steps: finalSteps },
      `Save the new emails of **${ctx.automationName}**?${ctx.wasActive ? " It is on: leads get the new texts from their next email." : ""}`,
    );
  }

  // Draft campaign: every recipient is saved again with their own follow-ups (their row stays the same).
  let savedNote = "";
  if (ctx.perRecipient && ctx.target) {
    const job = await loadJob(automationJobKey(state));
    if (!job?.rawFields) return reply(ctx, "I lost the recipients' follow-ups (they may have expired). Say **regenerate**, or **cancel**.");
    const general = (ctx.emails ?? []).map((e) => e.body);
    let own = 0;
    const rows = job.recipients.map((r) => {
      const e: GeneratedEmail | undefined = job.results[recipientKey(r)];
      const mine = e && !e.error && (e.followUps?.length ?? 0) >= general.length ? e.followUps!.map((f) => f.body) : undefined;
      if (mine) own++;
      return recipientRow(r.email, job.rawFields![recipientKey(r)] ?? { name: r.name ?? null, fields: r.fields }, mine ?? general.map((g) => generalFor(g, r)));
    });
    const campaignId = String(ctx.target.id);
    const cleared = await read("delete_campaign_recipients", { campaignId }, auth);
    if (!cleared.ok) return reply(ctx, `I could not update the campaign's recipients: ${cleared.message}\n\nNothing was changed. Reply **approve** to try again, or **cancel**.`);
    const savedRows = await read("save_csv_recipients", { campaignId, rows, allowDuplicates: true }, auth);
    const added = savedRows.ok ? num(savedRows.data.added) : 0;
    if (!savedRows.ok || added === 0) {
      log.error({ campaignId, rows: rows.length, added }, "automation: saving recipients again failed");
      return reply(
        ctx,
        `Saving the recipients again did not work${savedRows.ok ? "" : `: ${savedRows.message}`}. Reply **approve** to try again — I still have every recipient's row.`,
      );
    }
    // The backend skips addresses that unsubscribed or bounced since the upload.
    const skipped = rows.length - added;
    savedNote = `${own} recipients got their own follow-ups${rows.length - own ? `, ${rows.length - own} the general ones` : ""}.${skipped > 0 ? ` ${skipped} were not saved again (unsubscribed or bounced meanwhile).` : ""}`;
  }

  const updated = await read("update_automation", { automationId: ctx.automationId, steps: finalSteps }, auth);
  if (!updated.ok) return reply(ctx, `I could not save the emails: ${updated.message}\n\nType a change, or **cancel**.`);

  let attached = "";
  if (ctx.target?.type === "form") {
    const r = await read("set_form_automation", { formId: ctx.target.id, automationId: ctx.automationId }, auth);
    attached = r.ok ? `It is set on the form **${ctx.target.name}**.` : `It could not be set on the form: ${r.message}`;
  } else if (ctx.target?.type === "campaign") {
    const r = await read("set_campaign_automation", { campaignId: ctx.target.id, automationId: ctx.automationId }, auth);
    attached = r.ok ? `It is set on the campaign **${ctx.target.name}**.` : `It could not be set on the campaign: ${r.message}`;
  }
  await deleteJob(automationJobKey(state));

  const confirm = [
    `**${ctx.automationName}** is saved (still off). ${attached} ${savedNote}`.trim(),
    "",
    ctx.kind === "campaign"
      ? "**Turn it on now?** When the campaign has sent its first email to someone, the follow-ups go out by themselves on the planned days, as replies in the same thread. They stop when the person replies, unsubscribes or bounces."
      : `**Turn it on now?** Every new lead from ${ctx.target ? "the form" : "a form using it"} then gets these emails by itself${ctx.smtpLabel ? `, sent from **${ctx.smtpLabel}**` : ""}.`,
    "",
    "If you cancel, it stays off — say **turn on <name>** any time.",
  ].join("\n");
  return { ...approval("update_automation", { automationId: ctx.automationId, isActive: true }, confirm), automationFlow: undefined };
}

// ── Edit an existing automation's emails ─────────────────────────────────────

async function startEdit(state: AgentGraphStateType, auth: AuthContext, a: AutomationRow, msg: string): Promise<Patch> {
  const slots = emailSlots(a.steps);
  const per = a.steps.some((s) => /\{\{\s*ai_followup_\d+\s*\}\}/i.test(str(s.body)));
  if (per) {
    return answer(
      `The follow-ups of **${a.name}** were written separately for each recipient, so they are not one text I can change. Create a new automation for the next campaign instead (**create automation**).`,
    );
  }
  if (slots.length === 0) return answer(`**${a.name}** has no emails to change.`);
  const instruction = msg.replace(/^.*?:\s*/, "").trim();
  const ctx: AutomationFlowState = {
    step: "review",
    mode: "edit",
    kind: a.kind,
    automationId: a.id,
    automationName: a.name,
    wasActive: a.isActive,
    perRecipient: false,
    senderName: state.senderDefaults?.fromName?.trim().split(/\s+/)[0] ?? "",
    purpose: slots.map((s) => s.hint).join(" | ").slice(0, 1200),
    atIso: new Date().toISOString(),
  };
  const out = await writeEmails(state, auth, ctx, instruction.length >= 4 ? instruction : undefined);
  return render(auth, state, { ...out, campaignCreation: undefined });
}
