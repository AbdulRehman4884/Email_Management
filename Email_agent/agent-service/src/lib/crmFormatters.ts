/**
 * src/lib/crmFormatters.ts
 *
 * Chat messages for the read-only CRM tools (phase 1).
 *
 * formatCrmResult() returns the usual response envelope as a JSON string:
 *   { status: "success" | "error", intent, message, data }
 *
 * Tool failures arrive two ways (isToolError, or { success: false, error }); both are handled.
 * The backend's 403 PLAN_FEATURE_REQUIRED becomes a plan-upgrade message.
 */

import type { CrmToolName } from "./crmArgs.js";
import type { CrmWriteToolName } from "./crmActions.js";
import type { McpToolResult } from "../types/mcp.js";

type Obj = Record<string, unknown>;

const LABEL_META: Record<string, { name: string; emoji: string }> = {
  interested:         { name: "Interested",           emoji: "🟢" },
  not_interested:     { name: "Not Interested",       emoji: "🔴" },
  out_of_office:      { name: "Out of Office",        emoji: "🟡" },
  question:           { name: "Question",             emoji: "🔵" },
  meeting_booked:     { name: "Meeting Booked",       emoji: "🟣" },
  neutral:            { name: "Neutral",              emoji: "⚪" },
  bounce_unsubscribe: { name: "Bounce / Unsubscribe", emoji: "⚫" },
};

const TIER_META: Record<string, string> = { hot: "🔥 Hot", warm: "🌤️ Warm", cold: "❄️ Cold" };

export const CRM_PLAN_MESSAGE =
  "Your current plan does not include the **CRM**. Upgrade your plan on the **Packages** page to use CRM leads, pipelines and reminders.";

// ── Small helpers ────────────────────────────────────────────────────────────

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The MCP envelope is { success, data }; older transports return the payload directly. */
function payloadOf(raw: unknown): Obj {
  const d = obj(raw);
  return "success" in d && "data" in d ? obj(d.data) : d;
}

export function labelText(label: unknown): string | undefined {
  const l = str(label);
  if (!l) return undefined;
  const meta = LABEL_META[l];
  return meta ? `${meta.emoji} ${meta.name}` : l;
}

function tierText(tier: unknown, score: unknown): string | undefined {
  const t = str(tier);
  const s = num(score);
  if (!t && s === undefined) return undefined;
  return `${t ? TIER_META[t] ?? t : "Score"}${s !== undefined ? ` ${s}` : ""}`;
}

export function hoursText(hours: unknown): string {
  const h = num(hours) ?? 0;
  if (h < 1) return "under 1h";
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)} days`;
}

const day = (iso: unknown): string => (str(iso) ?? "").slice(0, 10);

function personName(c: Obj): string {
  return str(c.name) ?? str(c.email) ?? "Unknown lead";
}

function envelope(status: "success" | "error", intent: string | undefined, message: string, data?: unknown): string {
  return JSON.stringify({ status, intent: intent ?? "crm", message, ...(data !== undefined ? { data } : {}) });
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** The failure part of a tool result, or undefined when the tool succeeded. */
function failureOf(result: McpToolResult): Obj | undefined {
  const d = obj(result.data);
  if (d.success === false) return obj(d.error);
  if (result.isToolError) return Object.keys(d).length ? obj(d.error ?? d) : { message: result.rawContent.join(" ") };
  return undefined;
}

export function crmErrorMessage(error: Obj): string {
  const details = obj(error.details);
  const code = str(details.code) ?? str(error.code);
  const status = num(error.httpStatus);
  if (code === "PLAN_FEATURE_REQUIRED" || /does not include this feature/i.test(str(details.error) ?? "")) {
    return CRM_PLAN_MESSAGE;
  }
  if (status === 403) return CRM_PLAN_MESSAGE;
  if (status === 404 || code === "MAILFLOW_NOT_FOUND") {
    return str(details.error) ? `${details.error}.` : "That CRM item was not found.";
  }
  if (code === "MAILFLOW_TIMEOUT") return "The CRM took too long to answer. Please try again.";
  if (code === "MAILFLOW_UNAVAILABLE" || status === 0) return "The CRM is not reachable right now. Please try again in a moment.";
  const backend = str(details.error);
  if (backend && backend.length < 200) return `The CRM could not do that: ${backend}`;
  return "Something went wrong in the CRM. Please try again.";
}

/** True when the tool failed because the user's plan has no CRM (backend 403 PLAN_FEATURE_REQUIRED). */
export function isCrmPlanError(result: McpToolResult | undefined): boolean {
  if (!result) return false;
  const failure = failureOf(result);
  return failure !== undefined && crmErrorMessage(failure) === CRM_PLAN_MESSAGE;
}

// ── Summary ──────────────────────────────────────────────────────────────────

function formatSummary(d: Obj): string {
  if (str(d.unknownCampaign)) return unknownCampaignText(d);
  const pipeline = obj(d.pipeline);
  const kpis = obj(d.kpis);
  if (!str(pipeline.name)) {
    return "You don't have a CRM pipeline yet. Open the **CRM** page once and the default **Sales Pipeline** is created for you.";
  }

  const scope = str(d.campaignName) ? ` · campaign **${d.campaignName}**` : "";
  const winRate = num(kpis.winRate);
  const lines = [
    `**CRM overview — ${pipeline.name}**${scope}`,
    "",
    `- Total leads: **${num(kpis.total) ?? 0}**`,
    `- Interested: **${num(kpis.interested) ?? 0}** · Meetings booked: **${num(kpis.meetings) ?? 0}**`,
    `- Won: **${num(kpis.won) ?? 0}** · Lost: **${num(kpis.lost) ?? 0}** · Win rate: **${winRate === undefined ? "—" : `${winRate}%`}**`,
    `- 🔥 Hot leads: **${num(kpis.hot) ?? 0}** · Waiting for your reply: **${num(kpis.needsReply) ?? 0}**`,
  ];

  const stages = arr(d.stages);
  if (stages.length) {
    lines.push("", "**Leads per stage**");
    for (const s of stages) {
      const avg = num(s.avgDaysInStage);
      lines.push(`- ${s.name}: **${num(s.count) ?? 0}**${avg !== undefined && avg > 0 ? ` (avg ${avg} days in stage)` : ""}`);
    }
  }

  const funnel = arr(d.funnel).filter((f) => num(f.reached) !== undefined);
  if (funnel.length > 1) {
    const steps = funnel.map((f) => {
      const conv = num(f.conversionFromPrev);
      return `${f.name} ${num(f.reached)}${conv !== undefined && conv !== null ? ` (${conv}%)` : ""}`;
    });
    lines.push("", `**Funnel:** ${steps.join(" → ")}`);
  }

  const labels = obj(d.labels);
  const labelParts = Object.entries(labels)
    .filter(([key, n]) => key !== "none" && typeof n === "number" && n > 0)
    .map(([key, n]) => `${labelText(key)} ${n}`);
  if (labelParts.length) lines.push("", `**Latest reply labels:** ${labelParts.join(" · ")}`);

  lines.push("", "Ask me for leads by stage, label or tag — for example *show interested leads* or *who needs a reply?*");
  return lines.join("\n");
}

// ── Leads list ───────────────────────────────────────────────────────────────

function unknownCampaignText(d: Obj): string {
  const names = (Array.isArray(d.availableCampaigns) ? d.availableCampaigns : []).filter((n) => typeof n === "string");
  return [
    `I couldn't find one campaign called **${d.unknownCampaign}**.`,
    ...(names.length ? ["", "Did you mean one of these?", ...names.map((n) => `- ${n}`)] : []),
  ].join("\n");
}

function leadLine(c: Obj, i: number): string {
  const head = `${i + 1}. **${personName(c)}**${str(c.name) && str(c.email) ? ` — ${c.email}` : ""}${str(c.company) ? ` · ${c.company}` : ""}`;
  const facts = [
    str(c.stageName) ? `Stage: ${c.stageName}` : undefined,
    tierText(c.scoreTier, c.score),
    labelText(c.lastReplyLabel),
    c.needsReply === true ? "⏳ needs your reply" : undefined,
    arr(c.tags).length ? `tags: ${arr(c.tags).map((t) => t.name).join(", ")}` : undefined,
  ].filter(Boolean);
  return facts.length ? `${head}\n   ${facts.join(" · ")}` : head;
}

function formatLeadList(d: Obj, intent?: string): string {
  if (intent === "show_hot_leads" && !str(d.unknownCampaign) && !str(d.unknownStage) && !(Array.isArray(d.unknownTags) && d.unknownTags.length)) {
    return formatHotLeads(d);
  }
  return formatFilteredLeads(d);
}

/** "show hot leads": the CRM Hot Leads panel (Interested or hot score, hottest first). */
function formatHotLeads(d: Obj): string {
  const contacts = arr(d.contacts);
  const total = num(d.total) ?? contacts.length;
  const campaign = str(obj(d.appliedFilters).campaignName);
  const scope = campaign ? ` — campaign **${campaign}**` : "";
  if (contacts.length === 0) {
    return `No hot leads yet${scope}. A lead becomes hot when it replies **Interested** or its score reaches the hot level.`;
  }
  const lines = [
    `**🔥 ${total} hot lead${total === 1 ? "" : "s"}**${scope} (Interested or hot score, hottest first)`,
    "",
    ...contacts.map(leadLine),
  ];
  if (total > contacts.length) {
    lines.push("", `Showing ${contacts.length} of ${total}. Open the **CRM** page for all of them.`);
  }
  lines.push("", "You can act on this list, e.g. *tag them with VIP* or *move them to Meeting Booked*.");
  return lines.join("\n");
}

function formatFilteredLeads(d: Obj): string {
  if (str(d.unknownCampaign)) return unknownCampaignText(d);
  if (str(d.unknownStage)) {
    const stages = (Array.isArray(d.availableStages) ? d.availableStages : []).filter((s) => typeof s === "string");
    return [
      `There is no stage called **${d.unknownStage}**.`,
      ...(stages.length ? ["", `Your stages: ${stages.join(", ")}`] : []),
    ].join("\n");
  }
  if (Array.isArray(d.unknownTags) && d.unknownTags.length) {
    const tags = (Array.isArray(d.availableTags) ? d.availableTags : []).filter((t) => typeof t === "string");
    return [
      `I couldn't find the tag${d.unknownTags.length > 1 ? "s" : ""} **${d.unknownTags.join(", ")}**.`,
      "",
      tags.length ? `Your lead tags: ${tags.join(", ")}` : "You have no lead tags yet.",
    ].join("\n");
  }

  const applied = obj(d.appliedFilters);
  const scope = [
    str(applied.stageName) ? `stage **${applied.stageName}**` : undefined,
    Array.isArray(applied.tagNames) && applied.tagNames.length ? `tag **${applied.tagNames.join(", ")}**` : undefined,
    str(applied.campaignName) ? `campaign **${applied.campaignName}**` : undefined,
  ].filter(Boolean);
  const contacts = arr(d.contacts);
  const total = num(d.total) ?? contacts.length;

  if (contacts.length === 0) {
    return `No leads match${scope.length ? ` (${scope.join(", ")})` : " these filters"}.`;
  }

  const lines = [
    `**${total} lead${total === 1 ? "" : "s"}**${scope.length ? ` — ${scope.join(", ")}` : ""}`,
    "",
    ...contacts.map(leadLine),
  ];
  if (total > contacts.length) {
    lines.push("", `Showing ${contacts.length} of ${total}. Ask for more (e.g. *top 30 …*) or open the **CRM** page for the full list.`);
  }
  return lines.join("\n");
}

// ── One lead ─────────────────────────────────────────────────────────────────

function formatLead(d: Obj): string {
  const detail = obj(d.detail);
  const matches = arr(d.matches);
  const query = str(d.query);

  if (!str(obj(detail.contact).email)) {
    if (matches.length === 0) return `I couldn't find a lead matching **${query ?? "that"}**.`;
    return [
      `I found ${matches.length} leads matching **${query ?? "that"}**. Which one do you mean?`,
      "",
      ...matches.slice(0, 10).map((m, i) => `${i + 1}. **${personName(m)}**${str(m.name) ? ` — ${m.email}` : ""}${str(m.stageName) ? ` · ${m.stageName}` : ""}`),
      "",
      `Reply with the number (1–${Math.min(matches.length, 10)}) or the email.`,
    ].join("\n");
  }

  const c = obj(detail.contact);
  const lines = [
    `**${personName(c)}**${str(c.name) ? ` — ${c.email}` : ""}${str(c.company) ? ` · ${c.company}` : ""}`,
    "",
    `- Stage: **${str(c.stageName) ?? "none"}**${str(c.pipelineName) ? ` (${c.pipelineName})` : ""}${str(c.stageEnteredAt) ? ` since ${day(c.stageEnteredAt)}` : ""}`,
    `- Score: **${tierText(c.scoreTier, c.score) ?? "—"}**`,
  ];
  const label = labelText(c.lastReplyLabel);
  if (label) lines.push(`- Last reply: ${label}${str(c.lastInboundAt) ? ` on ${day(c.lastInboundAt)}` : ""}`);
  if (c.needsReply === true) lines.push(`- ⏳ Waiting for your reply since ${day(c.needsReplySince)}`);
  if (c.followUpsStopped === true) lines.push("- Follow-ups are stopped for this lead");
  const tags = arr(c.tags);
  if (tags.length) lines.push(`- Tags: ${tags.map((t) => t.name).join(", ")}`);
  lines.push(`- Opens: ${num(c.openCount) ?? 0} · Campaigns: ${num(c.campaignCount) ?? arr(detail.campaigns).length}`);

  const events = arr(obj(detail.score).events).slice(0, 5);
  if (events.length) {
    lines.push("", "**Why this score** (latest changes)");
    for (const e of events) {
      const p = num(e.points) ?? 0;
      lines.push(`- ${p > 0 ? "+" : ""}${p} ${str(e.reason) ?? ""}`);
    }
  }

  const replies = arr(detail.replies).filter((r) => r.direction !== "outbound").slice(0, 3);
  if (replies.length) {
    lines.push("", "**Latest replies**");
    for (const r of replies) {
      const snippet = (str(r.snippet) ?? "").replace(/\s+/g, " ").slice(0, 120);
      lines.push(`- ${day(r.receivedAt)} ${labelText(r.label) ?? ""} ${str(r.subject) ? `*${r.subject}*` : ""}${snippet ? ` — "${snippet}"` : ""}`.replace(/\s+/g, " ").trim());
    }
  }

  const history = arr(detail.history).slice(0, 5);
  if (history.length) {
    lines.push("", "**Stage history**");
    for (const h of history) {
      const by = str(h.ruleName) ? `rule "${h.ruleName}"` : str(h.reason) ?? "";
      lines.push(`- ${day(h.at)}: ${str(h.fromName) ?? "—"} → **${str(h.toName) ?? "—"}**${by ? ` (${by})` : ""}`);
    }
  }

  const campaigns = arr(detail.campaigns).slice(0, 5);
  if (campaigns.length) lines.push("", `**Campaigns:** ${campaigns.map((x) => x.name).join(", ")}`);

  return lines.join("\n");
}

// ── Needs reply ──────────────────────────────────────────────────────────────

function formatNeedsReply(d: Obj): string {
  const leads = arr(d.leads);
  const counts = obj(d.counts);
  const waiting = num(counts.waiting) ?? leads.length;
  const overdue = num(counts.overdue) ?? 0;
  const snoozed = num(counts.snoozed) ?? 0;

  if (leads.length === 0) {
    return `Nobody is waiting for your reply right now.${snoozed ? ` (${snoozed} snoozed)` : ""}`;
  }

  const lines = [
    `**${waiting} lead${waiting === 1 ? " is" : "s are"} waiting for your reply**${overdue ? ` — ${overdue} overdue` : ""}`,
    "",
  ];
  leads.forEach((l, i) => {
    const facts = [
      `waiting ${hoursText(l.waitingHours)}`,
      labelText(l.label),
      l.priority === "high" ? "high priority" : undefined,
      l.overdue === true ? "⚠️ overdue" : undefined,
    ].filter(Boolean);
    lines.push(`${i + 1}. **${personName(l)}**${str(l.name) ? ` — ${l.email}` : ""} · ${facts.join(" · ")}`);
    const snippet = (str(l.snippet) ?? "").replace(/\s+/g, " ").slice(0, 120);
    if (snippet) lines.push(`   "${snippet}"`);
  });
  if (waiting > leads.length) lines.push("", `Showing ${leads.length} of ${waiting}. The **Inbox → Needs reply** tab has all of them.`);
  if (snoozed) lines.push("", `${snoozed} more ${snoozed === 1 ? "is" : "are"} snoozed.`);
  return lines.join("\n");
}

// ── Pipelines and tags ───────────────────────────────────────────────────────

function formatPipelines(d: Obj): string {
  const pipelines = arr(d.pipelines);
  if (pipelines.length === 0) {
    return "You don't have a CRM pipeline yet. Open the **CRM Pipelines** page to create one from a template.";
  }
  const lines: string[] = [];
  for (const p of pipelines) {
    lines.push(
      `**${p.name}**${p.isDefault === true ? " (default)" : ""} — ${num(p.contactCount) ?? 0} leads, ${num(p.ruleCount) ?? 0} rules`,
    );
    arr(p.stages).forEach((s, i) => {
      const flags = [
        s.type === "won" ? "Won" : s.type === "lost" ? "Lost" : undefined,
        s.manualOnly === true ? "manual only" : undefined,
        s.stopFollowUps === true ? "stops follow-ups" : undefined,
      ].filter(Boolean);
      lines.push(`${i + 1}. ${s.name} — ${num(s.contactCount) ?? 0} leads${flags.length ? ` (${flags.join(", ")})` : ""}`);
    });
    lines.push("");
  }
  lines.push("Edit stages and rules on the **CRM Pipelines** page.");
  return lines.join("\n");
}

function formatTags(d: Obj): string {
  const tags = arr(d.tags);
  if (tags.length === 0) return "You have no tags yet. Create one on the **CRM** leads page (Manage tags) or on a campaign page.";
  return [
    `**Your tags (${tags.length})**`,
    "",
    ...tags.map((t) => {
      const scope = t.scope === "campaign" ? " · campaigns only" : t.scope === "contact" ? " · leads only" : "";
      return `- **${t.name}** — ${num(t.contactCount) ?? 0} leads, ${num(t.campaignCount) ?? 0} campaigns${scope}`;
    }),
  ].join("\n");
}

// ── Write actions (phase 2) ──────────────────────────────────────────────────

function whenText(iso: unknown): string {
  const s = str(iso);
  if (!s) return "later";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatWriteResult(toolName: CrmWriteToolName, d: Obj): string {
  const lead = str(d.lead) ? `**${d.lead}**` : "The lead";
  switch (toolName) {
    case "move_crm_lead": {
      const stage = str(obj(d.stage).name) ?? "the new stage";
      if (d.moved === false) return `${lead} is already in **${stage}** — nothing changed.`;
      const extra = obj(d.stage).type === "won" ? " 🎉" : "";
      return `Moved ${lead} to **${stage}**.${extra} The stage's rules and score update run now.`;
    }
    case "tag_crm_lead":
      return d.removed === true
        ? `Removed tag **${str(d.tag) ?? "the tag"}** from ${lead}.`
        : `Added tag **${str(d.tag) ?? "the tag"}** to ${lead}.`;
    case "create_crm_tag": {
      const tag = obj(d.tag);
      return `Created tag **${str(tag.name) ?? "new tag"}**. You can now add it to leads, e.g. *tag ali@shop.com with ${str(tag.name) ?? "it"}*.`;
    }
    case "snooze_crm_lead":
      return `Snoozed ${lead} until **${whenText(d.snoozedUntil)}**. No reminder for this lead until then.`;
    case "mark_crm_lead_done":
      return `Marked ${lead} as answered — it is no longer waiting for your reply.`;
    case "set_crm_reply_label":
      return `Changed ${lead}'s latest reply to ${labelText(d.label) ?? str(d.label) ?? "the new label"}. The lead's rules and score were updated.`;
    case "bulk_update_crm_leads": {
      const parts = [
        num(d.moved) ? `moved **${d.moved}**` : undefined,
        num(d.tagsAdded) ? `added **${d.tagsAdded}** tag${d.tagsAdded === 1 ? "" : "s"}` : undefined,
        num(d.tagsRemoved) ? `removed **${d.tagsRemoved}** tag${d.tagsRemoved === 1 ? "" : "s"}` : undefined,
      ].filter(Boolean);
      const matched = num(d.matched) ?? 0;
      return [
        `Updated **${matched} lead${matched === 1 ? "" : "s"}**${parts.length ? `: ${parts.join(", ")}` : " — they already matched, nothing changed"}.`,
        num(d.skipped) ? `${d.skipped} lead(s) were skipped (not found).` : undefined,
      ].filter(Boolean).join("\n\n");
    }
    case "set_crm_campaign_settings": {
      const name = str(d.campaign) ? ` **${d.campaign}**` : "";
      const tagged = num(d.tagged) ?? 0;
      return `Saved the CRM settings of campaign${name}.${tagged ? ` ${tagged} existing lead tag${tagged === 1 ? " was" : "s were"} added.` : ""}`;
    }
    case "prepare_crm_action":
      return "Checked.";
  }
}

/** Short message for one CRM step inside a multi-step plan summary. */
export function crmStepMessage(toolName: CrmToolName | CrmWriteToolName, result: McpToolResult): string {
  try {
    return (JSON.parse(formatCrmResult(undefined, toolName, result)) as { message: string }).message;
  } catch {
    return "Done.";
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function formatCrmResult(intent: string | undefined, toolName: CrmToolName | CrmWriteToolName, result: McpToolResult): string {
  const failure = failureOf(result);
  if (failure) return envelope("error", intent, crmErrorMessage(failure), result.data);

  const d = payloadOf(result.data);
  const message =
    toolName === "get_crm_summary" ? formatSummary(d)
    : toolName === "list_crm_contacts" ? formatLeadList(d, intent)
    : toolName === "get_crm_contact" ? formatLead(d)
    : toolName === "list_crm_needs_reply" ? formatNeedsReply(d)
    : toolName === "list_crm_pipelines" ? formatPipelines(d)
    : toolName === "list_crm_tags" ? formatTags(d)
    : formatWriteResult(toolName, d);
  return envelope("success", intent, message, d);
}
