/**
 * src/lib/crmArgs.ts
 *
 * Builds the arguments for the read-only CRM tools.
 *
 * Sources, in order:
 *   1. llmExtractedArgs (query, limit, campaignId, filters.{stage, labels, scoreTiers, tags, …})
 *   2. the user's message, parsed with plain rules (English + Roman Urdu) for anything the LLM
 *      did not give — this is the only source when OpenAI is not configured.
 *
 * Every value is checked here; the MCP server validates again. userId / auth keys are never read.
 */

import type { LLMIntentArguments } from "../schemas/llmIntent.schema.js";
import type { CrmContactSort, CrmReplyLabel, CrmScoreTier, KnownToolName } from "../types/tools.js";

export const CRM_TOOL_NAMES = [
  "get_crm_summary",
  "list_crm_contacts",
  "get_crm_contact",
  "list_crm_needs_reply",
  "list_crm_pipelines",
  "list_crm_tags",
] as const satisfies readonly KnownToolName[];

export type CrmToolName = (typeof CRM_TOOL_NAMES)[number];

export function isCrmTool(name: string | undefined): name is CrmToolName {
  return name !== undefined && (CRM_TOOL_NAMES as readonly string[]).includes(name);
}

const LABELS: readonly CrmReplyLabel[] = [
  "interested", "not_interested", "out_of_office", "question", "meeting_booked", "neutral", "bounce_unsubscribe",
];
const TIERS: readonly CrmScoreTier[] = ["hot", "warm", "cold"];
const SORTS: readonly CrmContactSort[] = ["recent", "score", "name", "hot", "waiting", "added"];
const MAX_LIMIT = 50;

// ── Value cleaning ───────────────────────────────────────────────────────────

/** "Meeting Booked", "meeting-booked", "OOO" → a known label, else undefined. */
export function toLabel(value: unknown): CrmReplyLabel | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase().trim().replace(/[\s-]+/g, "_");
  if ((LABELS as readonly string[]).includes(v)) return v as CrmReplyLabel;
  if (v === "ooo" || v === "out_office" || v === "auto_reply") return "out_of_office";
  if (v === "meeting" || v === "meeting_book") return "meeting_booked";
  if (v === "bounce" || v === "bounced" || v === "unsubscribe" || v === "unsubscribed") return "bounce_unsubscribe";
  if (v === "notinterested") return "not_interested";
  return undefined;
}

function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  return value === undefined || value === null ? [] : [value];
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function labelsOf(value: unknown): CrmReplyLabel[] {
  return uniq(toList(value).map(toLabel).filter((l): l is CrmReplyLabel => l !== undefined));
}

function tiersOf(value: unknown): CrmScoreTier[] {
  return uniq(
    toList(value)
      .map((t) => (typeof t === "string" ? t.toLowerCase().trim() : ""))
      .filter((t): t is CrmScoreTier => (TIERS as readonly string[]).includes(t)),
  );
}

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().replace(/^["']|["']$/g, "").trim();
  return v.length > 0 && v.length <= max ? v : undefined;
}

function tagsOf(value: unknown): string[] {
  return uniq(toList(value).map((t) => shortText(t, 50)).filter((t): t is string => t !== undefined)).slice(0, 10);
}

function bool(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return undefined;
}

function limitOf(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

// ── Message parsing (fallback) ───────────────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Words around a stage or tag name that are never part of it. */
const FILLER = new Set([
  "show", "list", "get", "give", "me", "my", "all", "the", "which", "who", "are", "is", "in", "at", "of", "from",
  "lead", "leads", "contacts", "dikhao", "dikha", "batao", "jo", "wale", "walay", "vale", "ke", "ki", "ka", "mein", "main",
  "kaun", "hain", "hai", "sab", "saare", "with", "tag", "tagged", "stage",
]);

/**
 * First candidate that is still a name after dropping filler words at its start
 * ("leads dikhao jo interested" → "interested"). `lower` = return it lower-cased.
 */
function firstName(candidates: Array<string | undefined>, lower = true): string | undefined {
  for (const c of candidates) {
    if (!c) continue;
    const words = c.trim().split(/\s+/);
    while (words.length && FILLER.has(words[0]!.toLowerCase())) words.shift();
    const name = words.join(" ");
    if (name && !FILLER.has(name.toLowerCase())) return lower ? name.toLowerCase() : name;
  }
  return undefined;
}

export interface ParsedCrmMessage {
  email?: string;
  labels: CrmReplyLabel[];
  scoreTiers: CrmScoreTier[];
  needsReply?: boolean;
  stage?: string;
  tags: string[];
  limit?: number;
  sort?: CrmContactSort;
  /** Person named in "Ali ki detail" / "details of Ali". */
  person?: string;
}

/** Reads CRM filters from a plain message. Only clear signals; unsure → left out. */
export function parseCrmMessage(message: string): ParsedCrmMessage {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  const out: ParsedCrmMessage = { labels: [], scoreTiers: [], tags: [] };

  const email = message.match(EMAIL_RE)?.[0];
  if (email) out.email = email.toLowerCase();

  // Stage first: words inside the stage name ("Interested stage") must not also become label filters.
  const stage = firstName([
    text.match(/\b(?:in|at) (?:the )?((?:[a-z]+ ){0,3}[a-z]+) stage\b/)?.[1],
    text.match(/((?:[a-z]+ ){0,3}[a-z]+) stage (?:me|mein|main|wale|ke|par|pe)\b/)?.[1],
    text.match(/\bstage\s*(?:[:=]|named|called)\s*["']?([a-z][a-z ]{0,29}?)["']?(?: leads\b|$|[?.!,])/)?.[1],
  ]);
  if (stage) out.stage = stage;
  let rest = stage ? text.replace(stage, " ") : text;

  // Labels: "not interested" first, so it never also counts as "interested".
  if (/\bnot[\s_-]?interested\b|\binterested nahi\b/.test(rest)) {
    out.labels.push("not_interested");
    rest = rest.replace(/\bnot[\s_-]?interested\b|\binterested nahi\b/g, " ");
  }
  if (/\binterested\b/.test(rest)) out.labels.push("interested");
  if (/\bout[\s-]of[\s-]office\b|\booo\b|\bauto[\s-]?repl(y|ies)\b/.test(rest)) out.labels.push("out_of_office");
  if (/\bquestions?\b|\bsawal\b/.test(rest)) out.labels.push("question");
  if (/\bmeetings?[\s_-]?(booked|book|set)\b|\bmeeting wale\b/.test(rest)) out.labels.push("meeting_booked");
  if (/\bbounced?\b|\bunsubscribed?\b/.test(rest)) out.labels.push("bounce_unsubscribe");

  for (const tier of TIERS) {
    if (new RegExp(`\\b${tier}\\b`).test(rest)) out.scoreTiers.push(tier);
  }

  if (/\bneeds? (a )?repl(y|ies)\b|\bwaiting for (my |a )?repl(y|ies)\b|\bunanswered\b|\bjawab (dena|nahi diya)\b|\breply nahi kiya\b/.test(text)) {
    out.needsReply = true;
  }

  const tag = firstName([
    message.match(/\btag(?:ged)?\s+(?:with\s+)?["']?([\w][\w -]{0,29}?)["']?(?:\s+(?:wale|leads|tag)\b|$|[?.!,])/i)?.[1],
    message.match(/["']?([\w][\w-]{0,29})["']?\s+tag\s+(?:wale|walay|lage|laga|vale)\b/i)?.[1],
  ], false);
  if (tag) out.tags.push(tag);

  const count = text.match(/\b(?:top|last|first|pehle|sirf)\s+(\d{1,3})\b/)?.[1] ?? text.match(/\b(\d{1,3})\s+leads?\b/)?.[1];
  const limit = limitOf(count === undefined ? undefined : Number(count));
  if (limit) out.limit = limit;

  if (/\b(by|highest|top) score\b|\bscore (wise|ke hisaab)\b|\bsab se zyada score\b/.test(text)) out.sort = "score";
  else if (/\bwaiting (the )?longest\b|\bsab se purane\b/.test(text)) out.sort = "waiting";

  const person =
    message.match(/\b(?:details?|info|history|score)\s+(?:of|for|about)\s+(.+?)\s*[?.!]*$/i)?.[1] ??
    message.match(/\btell me about\s+(.+?)\s*[?.!]*$/i)?.[1] ??
    message.match(/^(?:show\s+)?(.+?)\s+(?:ki|ka|ke)\s+(?:lead\s+)?(?:detail|details|score|history|info)\b/i)?.[1];
  const cleanPerson = person?.replace(/\b(the|lead|contact)\b/gi, " ").replace(/\s+/g, " ").trim();
  if (cleanPerson && cleanPerson.length <= 100) out.person = cleanPerson;

  return out;
}

// ── Tool args ────────────────────────────────────────────────────────────────

export interface CrmArgInput {
  readonly extractedArgs: LLMIntentArguments | undefined;
  /** Raw message; when given, fills values the LLM did not extract. */
  readonly userMessage?: string | undefined;
}

function filtersOf(extracted: LLMIntentArguments | undefined): Record<string, unknown> {
  const f = extracted?.filters;
  return f && typeof f === "object" ? (f as Record<string, unknown>) : {};
}

export function buildCrmToolArgs(toolName: CrmToolName, input: CrmArgInput): Record<string, unknown> {
  const x = input.extractedArgs;
  const f = filtersOf(x);
  const msg = input.userMessage ? parseCrmMessage(input.userMessage) : undefined;
  const args: Record<string, unknown> = {};
  const campaign = shortText(x?.campaignId, 255) ?? shortText(f.campaign, 255);
  const limit = limitOf(x?.limit) ?? limitOf(f.limit) ?? msg?.limit;

  switch (toolName) {
    case "get_crm_summary": {
      if (campaign) args.campaign = campaign;
      const pipelineId = positiveInt(f.pipelineId);
      if (pipelineId) args.pipelineId = pipelineId;
      return args;
    }

    case "list_crm_contacts": {
      const search = shortText(x?.query, 100) ?? shortText(f.search, 100) ?? msg?.email;
      if (search) args.search = search;

      const stage = shortText(f.stage, 100) ?? msg?.stage;
      if (stage) args.stage = stage;

      const labels = labelsOf(f.labels ?? f.label);
      const finalLabels = labels.length ? labels : msg?.labels ?? [];
      if (finalLabels.length) args.labels = finalLabels;

      const tiers = tiersOf(f.scoreTiers ?? f.scoreTier ?? f.tier);
      const finalTiers = tiers.length ? tiers : msg?.scoreTiers ?? [];
      if (finalTiers.length) args.scoreTiers = finalTiers;

      const tags = tagsOf(f.tags ?? f.tag);
      const finalTags = tags.length ? tags : msg?.tags ?? [];
      if (finalTags.length) args.tags = finalTags;

      if (campaign) args.campaign = campaign;
      const needsReply = bool(f.needsReply) ?? msg?.needsReply;
      if (needsReply) args.needsReply = true;
      if (bool(f.hotOnly)) args.hotOnly = true;

      const sort = typeof f.sort === "string" && (SORTS as readonly string[]).includes(f.sort) ? (f.sort as CrmContactSort) : msg?.sort;
      if (sort) args.sort = sort;
      if (limit) args.limit = limit;
      return args;
    }

    case "get_crm_contact": {
      const contactId = positiveInt(f.contactId);
      if (contactId) {
        args.contactId = contactId;
        return args;
      }
      const query =
        shortText(x?.recipientEmail, 100) ??
        shortText(f.email, 100) ??
        msg?.email ??
        shortText(x?.query, 100) ??
        shortText(f.name, 100) ??
        msg?.person;
      if (query) args.query = query;
      return args;
    }

    case "list_crm_needs_reply": {
      if (bool(f.includeSnoozed)) args.includeSnoozed = true;
      if (limit) args.limit = limit;
      return args;
    }

    case "list_crm_pipelines":
    case "list_crm_tags":
      return args;
  }
}
