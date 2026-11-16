/**
 * src/lib/crmActions.ts
 *
 * CRM write actions (agent phase 2): from a chat message to one safe tool call.
 *
 *   1. readCrmAction()     — what the user wants (LLM args first, then plain rules on the message)
 *   2. prepareArgsFor()    — args for prepare_crm_action (names → ids, read-only)
 *   3. planCrmAction()     — from the preparation: a question for the user, or
 *                            { toolName, toolArgs, confirmText, requiresApproval }
 *
 * Approval: bulk changes, moves to Won / Lost or to a stage that stops follow-ups,
 * and campaign auto tags (they tag every lead of the campaign). Everything else runs at once.
 */

import type { LLMIntentArguments } from "../schemas/llmIntent.schema.js";
import type { CrmReplyLabel, CrmScoreTier, KnownToolName } from "../types/tools.js";
import { parseCrmMessage, toLabel } from "./crmArgs.js";
import { labelText } from "./crmFormatters.js";
import { normalizePronouns, ONE, pronounOf, splitCompound, THEM, type CrmCampaignChoice, type CrmContext } from "./crmContext.js";

export const CRM_WRITE_INTENTS = [
  "crm_move_lead",
  "crm_tag_lead",
  "crm_create_tag",
  "crm_snooze_lead",
  "crm_mark_done",
  "crm_change_label",
  "crm_bulk_update",
  "crm_campaign_settings",
] as const;
export type CrmWriteIntent = (typeof CRM_WRITE_INTENTS)[number];

export function isCrmWriteIntent(intent: string | undefined): intent is CrmWriteIntent {
  return intent !== undefined && (CRM_WRITE_INTENTS as readonly string[]).includes(intent);
}

export const CRM_WRITE_TOOL_NAMES = [
  "prepare_crm_action",
  "move_crm_lead",
  "tag_crm_lead",
  "create_crm_tag",
  "snooze_crm_lead",
  "mark_crm_lead_done",
  "set_crm_reply_label",
  "bulk_update_crm_leads",
  "set_crm_campaign_settings",
] as const satisfies readonly KnownToolName[];
export type CrmWriteToolName = (typeof CRM_WRITE_TOOL_NAMES)[number];

export function isCrmWriteTool(name: string | undefined): name is CrmWriteToolName {
  return name !== undefined && (CRM_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

// ── Detection by sentence shape (rule-based path only) ───────────────────────

/**
 * CRM change requests have a clear shape ("move X to Y", "X ko Y mein daal do", "tag X with Y",
 * "all … leads"). Keyword scores alone mix them up with read intents (e.g. "move all hot leads"
 * vs show_hot_leads), so the rule-based detector checks this first. The LLM path does not use it.
 */
export function detectCrmActionIntent(message: string): CrmWriteIntent | undefined {
  const m = message.toLowerCase().replace(/\s+/g, " ").trim();
  const many = /\b(all|every|saare|sare|sab|tamam|tamaam)\b/.test(m);
  const moveLike =
    /^move\s+\S/.test(m) ||
    /\bmove\s+.+\s+(to|into)\s+\S/.test(m) ||
    /\bmark\s+.+\s+as\s+(won|lost)\b/.test(m) ||
    /\s(ko|unko|inko)\s+.+\s+(mein|me|main|par|pe)\s+(daal|dal|le\s*ja|bhej|move)/.test(m) ||
    STAGE_SET.test(m) ||
    /\b(won|lost)\s+kar/.test(m);
  const tagLike =
    /\b(add|remove)\s+(the\s+)?tag\b/.test(m) ||
    /^tag\s+\S/.test(m) ||
    /\btag\s+\S+(\s+\S+)?\s+(with|as)\s+\S/.test(m) ||
    /\btag\s+(laga|lagao|hata|de\b|do\b)/.test(m);

  if (/\b(create|make|new|naya)\s+(a\s+)?(new\s+)?tag\b|\btag\s+bana/.test(m)) return "crm_create_tag";
  if (/\bauto[\s-]?tag\b|\bpipeline\s+for\s+(the\s+)?campaign\b/.test(m)) return "crm_campaign_settings";
  // "interested label wale email ki stage Engaged kar do": the label picks the leads, it is not a new label.
  const byLabel = LABEL_FILTER.test(m) && labelIn(m) !== undefined;
  if ((moveLike || tagLike) && (many || byLabel)) return "crm_bulk_update";
  if (/\bsnooze\b/.test(m)) return "crm_snooze_lead";
  if (/\b(change|set|update)\s+(the\s+)?(reply\s+)?label\b|\blabel\s+.+\s+reply\s+(as|to)\b|\b(ka|ki)\s+label\b/.test(m) || isReplyLabelRequest(m)) {
    return "crm_change_label";
  }
  if (
    /\bmark\s+.+\s+as\s+(done|answered|handled)\b/.test(m) ||
    /\bi\s+(have\s+)?(already\s+)?(replied|answered)\s+to\b/.test(m) ||
    /\bdone\s+kar/.test(m) ||
    /\bneeds?\s+reply\s+(hata|khatam|clear)/.test(m)
  ) {
    return "crm_mark_done";
  }
  if (moveLike) return "crm_move_lead";
  if (tagLike) return "crm_tag_lead";
  return undefined;
}

const LABEL_WORD = /\b(label|labels|lable|labal|labl)\b/;
/** "interested label wale", "question label vali": leads picked by their reply label. */
const LABEL_FILTER = /\b(?:label|labels|lable|labal|labl)\s+(?:wale|wali|wala|waly|walay|walon|vale|vali|wle)\b/;
/** "Ali ki stage Engaged kar do", "... ki state ko engaged kr do": a stage change said without "move". */
const STAGE_SET =
  /\s(?:ki|ka|ke)\s+(?:state|stage|status)\s+(?:ko\s+)?.+\s+(?:kar|kr|krdo|kardo|karo|kro|set|bana|change|badal)\w*/;

/** A stage move / tag for the leads with a reply label ("interested label wale ... Engaged kar do"). */
export function isLabelFilterAction(message: string): boolean {
  const m = message.toLowerCase().replace(/\s+/g, " ").trim();
  return LABEL_FILTER.test(m) && detectCrmActionIntent(m) === "crm_bulk_update";
}
const LABEL_VERB =
  /\b(laga\w*|lga\w*|lag\s*(?:do|de|jaye)|set|change|badal\w*|update|put|add|give|kar\s*do|kardo|karo|kr\s*do|krdo|mark|(?:de|da|dy|day|dey)\s*(?:do|du|den|dein|dena)|dedo|dado|dydo|dena|dein)\b/;

/**
 * "ali@x.com pa Interested label laga do", "is email ka label Question kar do", "set label Interested on Ali":
 * one lead's reply label (inbox or CRM). Not a bulk request ("all ...") and not a tag ("tag laga do").
 */
export function isReplyLabelRequest(message: string): boolean {
  const m = message.toLowerCase().replace(/\s+/g, " ").trim();
  if (!LABEL_WORD.test(m) || !LABEL_VERB.test(m) || LABEL_FILTER.test(m)) return false;
  if (/\b(all|every|saare|sare|sab|tamam|tamaam)\b/.test(m)) return false;
  if (/\b(create|naya|new)\s+(a\s+)?(label|tag)\b/.test(m) || /\b(label|labels)\s+(dikhao|show|list)\b/.test(m)) return false;
  return true;
}

/** Reply labels by the words people use, longest first ("not interested" before "interested"). */
/** "interested" as people type it: intrested, intersted, interseted, intrsted ... */
const INTERESTED = "(?:interested|intrested|intersted|interseted|intrsted|intrestd|interestd|intereseted|intrestid)";

const LABEL_PHRASES: Array<[RegExp, CrmReplyLabel]> = [
  [new RegExp(`\\bnot[\\s_-]*${INTERESTED}\\b|\\b${INTERESTED}\\s+nahi\\w*\\b|\\bna\\s*pasand\\b`), "not_interested"],
  [/\bout[\s_-]*of[\s_-]*office\b|\booo\b|\bauto[\s-]*reply\b/, "out_of_office"],
  [/\bmeeting[\s_-]*(booked|book\w*|fix\w*)?\b/, "meeting_booked"],
  [/\b(bounce\w*|unsubscrib\w*)\b/, "bounce_unsubscribe"],
  [/\bquestion\b|\bsawal\b/, "question"],
  [/\bneutral\b/, "neutral"],
  [new RegExp(`\\b${INTERESTED}\\b`), "interested"],
];

/** A reply label named anywhere in the message, if exactly one kind is named. */
function labelIn(text: string): CrmReplyLabel | undefined {
  const t = text.toLowerCase();
  for (const [re, label] of LABEL_PHRASES) if (re.test(t)) return label;
  return undefined;
}

/** "campaign 12" / "campaign #12" → 12. */
function campaignIdIn(text: string): number | undefined {
  const id = text.match(/\bcampaign\s*(?:#|id\s*)?(\d{1,9})\b/i)?.[1];
  return id ? Number(id) : undefined;
}

/** '"Ali with VIP"' -> 'Ali with VIP' (the whole message in quotes). */
function unquote(message: string): string {
  const t = message.trim();
  const inner = t.match(/^["“'](.*)["”']$/)?.[1];
  return inner !== undefined && !/["“”]/.test(inner) ? inner.trim() : t;
}

/**
 * Right after "create tag engaged" (or tagging a lead), "Bassamilyas90 with engaged" / "Ali ko engaged" names a lead
 * and that tag without any verb. True only for the tag just used, so other "X with Y" messages keep their meaning.
 */
export function isTagFollowUp(message: string, ctx: CrmContext | undefined): boolean {
  return tagFollowUp(message, ctx) !== undefined;
}

function tagFollowUp(message: string, ctx: CrmContext | undefined): { lead: string; tag: string } | undefined {
  const tag = ctx?.lastTag?.name;
  if (!tag) return undefined;
  const m = unquote(message).replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  const hit = m.match(/^(.+?)\s+(?:with|ko|pa|pe|par)\s+["']?([^"']+?)["']?(?:\s+(?:tag|laga\s*do|lagao|kar\s*do|de\s*do|da\s*do))?$/i);
  if (!hit || hit[1]!.split(" ").length > 6 || hit[2]!.trim().toLowerCase() !== tag.toLowerCase()) return undefined;
  const lead = clean(hit[1]);
  return lead ? { lead, tag } : undefined;
}

// ── What the user asked for ──────────────────────────────────────────────────

export interface CrmTargetFilters {
  search?: string;
  stage?: string;
  labels?: CrmReplyLabel[];
  scoreTiers?: CrmScoreTier[];
  tags?: string[];
  campaign?: string;
  needsReply?: boolean;
  hotOnly?: boolean;
}

export interface CrmActionRequest {
  lead?: string;
  /** Exact lead (picked from a list, or "him" = the last lead). Wins over `lead`. */
  leadId?: number;
  toStage?: string;
  tags?: string[];
  remove?: boolean;
  label?: CrmReplyLabel;
  /** Snooze end time (ISO). */
  until?: string;
  /** How the snooze was understood, for the reply ("until tomorrow 09:00"). */
  untilText?: string;
  tagName?: string;
  tagColor?: string;
  campaign?: string;
  /** Label a reply: the campaign picked from "in which campaign?" (or "campaign 12"). */
  campaignId?: number;
  /** Label a reply: a label that is not a reply label ("VIP") — it becomes a tag. */
  labelText?: string;
  /** Label a reply: the message, to find a campaign name in it ("... QA-TEST CRM E2E campaign ma"). */
  source?: string;
  pipeline?: string;
  targets?: CrmTargetFilters;
}

const COLORS: Record<string, string> = {
  indigo: "#6366f1", green: "#22c55e", red: "#ef4444", yellow: "#eab308", blue: "#3b82f6",
  purple: "#a855f7", pink: "#ec4899", teal: "#14b8a6", orange: "#f97316", gray: "#6b7280", grey: "#6b7280",
  hara: "#22c55e", laal: "#ef4444", lal: "#ef4444", peela: "#eab308", neela: "#3b82f6",
};

const MAX_SNOOZE_DAYS = 90;

function clean(value: string | undefined, max = 100): string | undefined {
  if (!value) return undefined;
  const v = value
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/'s$/i, "")
    .replace(/^(?:the\s+)?(?:lead|contact)\s+/i, "")
    .replace(/\s+(?:lead|contact)$/i, "")
    .trim();
  return v && v.length <= max ? v : undefined;
}

function str(v: unknown, max = 100): string | undefined {
  return typeof v === "string" ? clean(v, max) : undefined;
}

function strList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return [...new Set(raw.map((x) => str(x, 50)).filter((x): x is string => x !== undefined))].slice(0, 10);
}

const ALL_WORDS_RE = /^(?:all|every|saare|sare|sab|tamam|tamaam)\b/i;

/** Lead filters of a bulk request, read from the part of the message that names the leads. */
function targetsFromText(text: string): CrmTargetFilters {
  const p = parseCrmMessage(text);
  const t: CrmTargetFilters = {};
  if (p.stage) t.stage = p.stage;
  const label = p.labels.length ? undefined : labelIn(text);
  if (p.labels.length) t.labels = p.labels;
  else if (label) t.labels = [label];
  if (p.scoreTiers.length) t.scoreTiers = p.scoreTiers;
  if (p.tags.length) t.tags = p.tags;
  if (p.needsReply) t.needsReply = true;
  const campaign = text.match(/\b(?:campaign|of campaign|from campaign)\s+["']?([\w][\w -]{0,60}?)["']?(?:\s+(?:ke|ki|leads)\b|$)/i)?.[1]
    ?? text.match(/["']?([\w][\w -]{0,60}?)["']?\s+campaign\s+(?:ke|ki|wale)\b/i)?.[1];
  if (campaign) t.campaign = campaign.trim();
  return t;
}

const hasFilters = (t: CrmTargetFilters | undefined): t is CrmTargetFilters => !!t && Object.keys(t).length > 0;

/**
 * Snooze end from "for 3 days", "2 hours", "until tomorrow", "kal tak", "1 hafta".
 * Nothing understood → tomorrow 09:00. Never more than 90 days.
 */
export function snoozeUntil(text: string | undefined, now = new Date()): { until: Date; text: string } {
  const t = (text ?? "").toLowerCase();
  const n = Number(t.match(/(\d{1,3})/)?.[1] ?? "1");
  const add = (ms: number, label: string) => ({ until: new Date(now.getTime() + ms), text: label });
  const tomorrow9 = () => {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return { until: d, text: "tomorrow 09:00" };
  };
  if (/\b(hours?|hrs?|h|ghant[ae])\b/.test(t)) return add(n * 3_600_000, `${n} hour${n === 1 ? "" : "s"}`);
  if (/\b(weeks?|haft[ae])\b/.test(t)) return add(Math.min(n * 7, MAX_SNOOZE_DAYS) * 86_400_000, `${n} week${n === 1 ? "" : "s"}`);
  if (/\b(days?|din)\b/.test(t)) return add(Math.min(n, MAX_SNOOZE_DAYS) * 86_400_000, `${Math.min(n, MAX_SNOOZE_DAYS)} day${n === 1 ? "" : "s"}`);
  if (/\b(tomorrow|kal)\b/.test(t)) return tomorrow9();
  return tomorrow9();
}

/** Plain-rule reading of the message, per intent. Returns only what it is sure about. */
export function parseCrmActionMessage(intent: CrmWriteIntent, message: string): CrmActionRequest {
  const m = unquote(message).replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  const r: CrmActionRequest = {};
  const email = m.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];

  switch (intent) {
    case "crm_move_lead":
    case "crm_bulk_update": {
      const mv =
        m.match(/\bmove\s+(.+?)\s+(?:to|into)\s+(?:the\s+)?(.+?)(?:\s+stage)?$/i) ??
        m.match(/^(.+?)\s+(?:ko|unko|inko)\s+(.+?)\s+(?:stage\s+)?(?:mein|me|main|par|pe)\s+(?:daal|dal|kar|move|le\s*ja|bhej)\w*/i) ??
        m.match(/^(.+?)\s+(?:ki|ka|ke)\s+(?:state|stage|status)\s+(?:ko\s+)?["']?(.+?)["']?\s+(?:stage\s+)?(?:kar|kr|krdo|kardo|karo|kro|set|bana|change|badal)\w*(?:\s+(?:do|de|dein|den|dena))?$/i);
      const won = m.match(/\bmark\s+(.+?)\s+as\s+(won|lost)\b/i) ?? m.match(/^(.+?)\s+(?:ko\s+)?(won|lost)\s+(?:kar|mark)\w*/i);
      const hit = mv ?? won;
      if (hit) {
        r.toStage = clean(hit[2]);
        if (intent === "crm_bulk_update" || ALL_WORDS_RE.test(hit[1]!.trim())) r.targets = targetsFromText(hit[1]!);
        else r.lead = clean(hit[1]);
      }
      if (intent === "crm_bulk_update") {
        const tag = parseCrmActionMessage("crm_tag_lead", m);
        if (tag.tags?.length) {
          r.tags = tag.tags;
          if (tag.remove) r.remove = true;
          if (!r.targets && tag.lead) r.targets = targetsFromText(tag.lead);
        }
      }
      break;
    }

    case "crm_tag_lead": {
      const remove =
        m.match(/\bremove\s+(?:the\s+)?(?:tag\s+)?["']?([^"']+?)["']?(?:\s+tag)?\s+from\s+(.+)$/i) ??
        m.match(/^(.+?)\s+(?:se|say)\s+["']?([^"']+?)["']?\s+tag\s+(?:hata|nikal)\w*/i);
      if (remove) {
        r.remove = true;
        const fromUrdu = /\s(?:se|say)\s/i.test(remove[0]) && !/\bremove\b/i.test(remove[0]);
        r.tags = strList(fromUrdu ? remove[2] : remove[1]);
        r.lead = clean(fromUrdu ? remove[1] : remove[2]);
        break;
      }
      const add =
        m.match(/\badd\s+(?:the\s+)?(?:tag\s+)?["']?([^"']+?)["']?(?:\s+tag)?\s+to\s+(.+)$/i);
      if (add) {
        r.tags = strList(add[1]);
        r.lead = clean(add[2]);
        break;
      }
      const tagAs = m.match(/\btag\s+(.+?)\s+(?:as|with)\s+["']?([^"']+?)["']?(?:\s+tag)?$/i);
      if (tagAs) {
        r.lead = clean(tagAs[1]);
        r.tags = strList(tagAs[2]);
        break;
      }
      const urdu = m.match(/^(.+?)\s+(?:ko|unko|inko)\s+["']?([^"']+?)["']?\s+tag\s+(?:laga|de|do)\w*/i);
      if (urdu) {
        r.lead = clean(urdu[1]);
        r.tags = strList(urdu[2]);
        break;
      }
      // Follow-up without a verb: "Bassamilyas90 with engaged", "Ali ko engaged" (see tagFollowUp).
      const bare = m.match(/^["']?(.+?)["']?\s+with\s+["']?([^"']+?)["']?(?:\s+tag)?$/i);
      if (bare) {
        r.lead = clean(bare[1]);
        r.tags = strList(bare[2]);
      }
      break;
    }

    case "crm_create_tag": {
      const name =
        m.match(/\b(?:create|make|add)\s+(?:a\s+)?(?:new\s+)?tag\s+(?:called\s+|named\s+)?["']?(.+?)["']?$/i)?.[1] ??
        m.match(/\bnew\s+tag\s+(?:called\s+|named\s+)?["']?(.+?)["']?$/i)?.[1] ??
        m.match(/\bnaya\s+tag\s+["']?(.+?)["']?(?:\s+bana\w*)?$/i)?.[1] ??
        m.match(/^["']?(.+?)["']?\s+(?:naam\s+ka\s+)?(?:naya\s+)?tag\s+bana\w*/i)?.[1];
      if (name) {
        let n = name;
        const color = n.match(/\s+(?:in|with|color|colour|rang)\s+(?:color\s+|colour\s+)?(\w+)(?:\s+(?:color|colour|rang))?$/i);
        if (color && COLORS[color[1]!.toLowerCase()]) {
          r.tagColor = COLORS[color[1]!.toLowerCase()];
          n = n.slice(0, color.index);
        }
        r.tagName = clean(n, 50);
      }
      break;
    }

    case "crm_snooze_lead": {
      const en = m.match(/\bsnooze\s+(.+?)(?:\s+(?:for|until|till)\s+(.+))?$/i);
      const ur = m.match(/^(.+?)\s+ko\s+(?:(.+?)\s+(?:tak|ke\s+liye)\s+)?snooze/i);
      const hit = en ?? ur;
      if (hit) {
        r.lead = clean(hit[1]);
        const s = snoozeUntil(hit[2]);
        r.until = s.until.toISOString();
        r.untilText = hit[2] ? s.text : `${s.text} (default)`;
      }
      break;
    }

    case "crm_mark_done": {
      const hit =
        m.match(/\bmark\s+(.+?)\s+as\s+(?:done|answered|replied to|handled)\b/i) ??
        m.match(/\bi\s+(?:have\s+)?(?:already\s+)?(?:replied|answered)\s+(?:to\s+)?(.+)$/i) ??
        m.match(/^(.+?)\s+(?:ko\s+)?done\s+(?:kar|mark)\w*/i) ??
        m.match(/^(.+?)\s+(?:ka|ki)\s+needs?\s+reply\s+(?:hata|khatam|clear)\w*/i);
      if (hit) r.lead = clean(hit[1]);
      break;
    }

    case "crm_change_label": {
      const hit =
        m.match(/\b(?:change|set|update)\s+(?:the\s+)?(?:reply\s+)?label\s+(?:of|for|on)\s+(.+?)(?:'s)?(?:\s+(?:last\s+|latest\s+)?reply)?\s+to\s+(.+)$/i) ??
        m.match(/\blabel\s+(.+?)(?:'s)?\s+(?:last\s+|latest\s+)?reply\s+(?:as|to)\s+(.+)$/i) ??
        m.match(/^(.+?)\s+(?:ki|ka)\s+(?:last\s+|aakhri\s+|latest\s+)?(?:reply\s+)?(?:ka\s+)?label\s+(.+?)\s+(?:kar|set)\w*/i);
      if (hit) {
        r.lead = clean(hit[1]);
        r.label = toLabel(hit[2]) ?? labelIn(hit[2]!);
        if (!r.label) r.labelText = clean(hit[2]!.replace(/\b(label|lable|labal)\b/gi, ""), 50);
      }
      // Any other shape ("ali@x.com pa Interested label laga do", "is email ka label Question kar do"):
      // the email is the lead and the label is the reply label named in the message.
      if (!r.label) r.label = labelIn(m);
      // '"Bassamilyas90" ko ...', '"We are providing AI services" pa ...': the quoted words name the lead
      // (name, email or the subject of their reply).
      const quotedLead = m.match(/^\s*["'“‘]\s*(.+?)\s*["'”’]\s*(?:ko|pa|pe|par|ki|ka|ke|wali|wale|wala|on|to)\b/i)?.[1] ??
        m.match(/\b(?:on|to|for)\s+["'“‘]\s*(.+?)\s*["'”’]/i)?.[1];
      if (quotedLead && (!r.lead || !email)) r.lead = clean(quotedLead);
      if (!r.lead && email) r.lead = email;
      if (!r.lead) {
        const who = m.match(/^(.+?)\s+(?:pa|pe|par|ko|ki|ka|ke)\s+(?:reply\s+)?(?:pa\s+|par\s+)?/i)?.[1];
        if (who && !/\b(label|lable|is|us|this|that)\b/i.test(who) && who.split(" ").length <= 4) r.lead = clean(who);
      }
      // A quoted label that is not a reply label ("VIP"): a tag.
      if (!r.label && !r.labelText) {
        const quoted = quotedLead ? undefined : m.match(/["'“]([^"'”]{1,50})["'”]\s*(?:label|lable|labal)?/i)?.[1];
        const named = m.match(/\b(?:label|lable|labal)\s+["']?([\w -]{1,40}?)["']?\s+(?:laga|lga|set|kar|kr|add|lagao)\w*/i)?.[1] ??
          m.match(/\b([\w-]{2,30})\s+(?:label|lable|labal)\s+(?:laga|lga|set|kar|kr|add|lagao)\w*/i)?.[1];
        const text = clean(quoted ?? named, 50);
        if (text && !/^(ye|yeh|is|us|ka|ki|ko|pa|pe|par|the|a|new|naya)$/i.test(text)) r.labelText = text;
      }
      r.campaignId = campaignIdIn(m);
      r.source = m;
      break;
    }

    case "crm_campaign_settings": {
      const pipe = m.match(/\b(?:use|set|put)\s+(?:the\s+)?(.+?)\s+pipeline\s+for\s+(?:the\s+)?(?:campaign\s+)?(.+?)(?:\s+campaign)?$/i);
      if (pipe) {
        r.pipeline = clean(pipe[1], 255);
        r.campaign = clean(pipe[2], 255);
      }
      const auto = m.match(/\b(?:auto[\s-]?tag|tag)\s+(?:all\s+)?(?:new\s+)?leads\s+(?:of|from|in)\s+(?:the\s+)?(?:campaign\s+)?(.+?)(?:\s+campaign)?\s+(?:with|as)\s+(.+)$/i);
      if (auto) {
        r.campaign = clean(auto[1], 255);
        r.tags = strList(auto[2]);
      }
      break;
    }
  }

  if (email && r.lead && !r.targets) r.lead = email.toLowerCase();
  return r;
}

/**
 * LLM args first (query = lead, filters.*), the message fills the gaps.
 * `ctx` resolves "them" / "inko" (last list, or the first half of "show X and tag them")
 * and "him" / "isko" (last lead).
 */
export function readCrmAction(
  intent: CrmWriteIntent,
  extracted: LLMIntentArguments | undefined,
  message: string,
  ctx?: CrmContext,
): CrmActionRequest {
  const r = readRaw(intent, extracted, message);
  if (intent === "crm_tag_lead" && !r.tags?.length) {
    const follow = tagFollowUp(message, ctx);
    if (follow) {
      r.lead = follow.lead;
      r.tags = [follow.tag];
    }
  }
  const compound = splitCompound(message);
  const lead = pronounOf(r.lead);
  const plural = lead === THEM || (intent === "crm_bulk_update" && !hasFilters(r.targets) && /\b(them|these|those|inko|unko|in sab|un sab|inhe|unhe)\b/i.test(message));

  if (plural && (intent === "crm_move_lead" || intent === "crm_tag_lead" || intent === "crm_bulk_update")) {
    delete r.lead;
    const fromList = compound ? targetsFromText(compound.listPart) : undefined;
    const targets = hasFilters(fromList) ? fromList : ctx?.lastList?.targets;
    // Empty targets still mark it as a many-leads request, so the question is "Which leads?".
    r.targets = hasFilters(targets) ? targets : {};
  } else if (lead === ONE || lead === THEM) {
    delete r.lead;
    const last = ctx?.lastLead;
    if (last) {
      r.leadId = last.id;
      r.lead = last.name ?? (last.email || `lead #${last.id}`);
    }
  }
  return r;
}

function readRaw(
  intent: CrmWriteIntent,
  extracted: LLMIntentArguments | undefined,
  message: string,
): CrmActionRequest {
  const f = (extracted?.filters && typeof extracted.filters === "object" ? extracted.filters : {}) as Record<string, unknown>;
  const compound = splitCompound(message);
  const fromMsg = parseCrmActionMessage(intent, normalizePronouns(compound?.actionPart ?? message));
  const r: CrmActionRequest = { ...fromMsg };

  const lead = str(extracted?.recipientEmail) ?? str(extracted?.query) ?? str(f.lead);
  if (lead && intent !== "crm_bulk_update" && intent !== "crm_create_tag" && intent !== "crm_campaign_settings") r.lead = lead;

  const toStage = str(f.toStage) ?? str(f.stage);
  if (toStage && (intent === "crm_move_lead" || intent === "crm_bulk_update")) r.toStage = toStage;

  const tags = strList(f.tags ?? f.tag ?? f.addTags);
  if (tags.length) r.tags = tags;
  const removeTags = strList(f.removeTags);
  if (removeTags.length) {
    r.tags = removeTags;
    r.remove = true;
  }
  if (f.remove === true || f.remove === "true") r.remove = true;

  const label = toLabel(f.label) ?? (typeof f.label === "string" ? labelIn(f.label) : undefined);
  if (label) {
    r.label = label;
    delete r.labelText;
  } else if (intent === "crm_change_label" && !r.label && str(f.label, 50)) {
    r.labelText = str(f.label, 50);
  }

  if (intent === "crm_snooze_lead") {
    const iso = typeof f.until === "string" && !Number.isNaN(Date.parse(f.until)) ? new Date(f.until) : undefined;
    if (iso && iso.getTime() > Date.now()) {
      r.until = iso.toISOString();
      r.untilText = iso.toISOString().slice(0, 16).replace("T", " ");
    } else if (str(f.duration)) {
      const s = snoozeUntil(str(f.duration));
      r.until = s.until.toISOString();
      r.untilText = s.text;
    } else if (!r.until) {
      const s = snoozeUntil(undefined);
      r.until = s.until.toISOString();
      r.untilText = `${s.text} (default)`;
    }
  }

  if (intent === "crm_create_tag") {
    const name = str(f.name, 50) ?? str(extracted?.name, 50) ?? (tags.length === 1 ? tags[0] : undefined);
    if (name) r.tagName = name;
    const color = typeof f.color === "string" ? (COLORS[f.color.toLowerCase()] ?? (/^#[0-9a-f]{6}$/i.test(f.color) ? f.color : undefined)) : undefined;
    if (color) r.tagColor = color;
  }

  const campaign = str(extracted?.campaignId, 255) ?? str(f.campaign, 255);
  if (campaign && intent === "crm_campaign_settings") r.campaign = campaign;
  if (campaign && intent === "crm_change_label") {
    if (/^\d+$/.test(campaign)) r.campaignId = Number(campaign);
    else r.campaign = campaign;
  }
  const pipeline = str(f.pipeline, 255);
  if (pipeline) r.pipeline = pipeline;

  if (intent === "crm_bulk_update") {
    const t = (f.targets && typeof f.targets === "object" ? f.targets : {}) as Record<string, unknown>;
    const fromLlm: CrmTargetFilters = {};
    const tStage = str(t.stage);
    if (tStage) fromLlm.stage = tStage;
    const tLabels = (Array.isArray(t.labels) ? t.labels : []).map(toLabel).filter((l): l is CrmReplyLabel => !!l);
    if (tLabels.length) fromLlm.labels = tLabels;
    const tTiers = (Array.isArray(t.scoreTiers) ? t.scoreTiers : []).filter((x): x is CrmScoreTier => x === "hot" || x === "warm" || x === "cold");
    if (tTiers.length) fromLlm.scoreTiers = tTiers;
    const tTags = strList(t.tags);
    if (tTags.length) fromLlm.tags = tTags;
    const tCampaign = str(t.campaign, 255) ?? campaign;
    if (tCampaign) fromLlm.campaign = tCampaign;
    if (t.needsReply === true) fromLlm.needsReply = true;
    if (t.hotOnly === true) fromLlm.hotOnly = true;
    if (hasFilters(fromLlm)) r.targets = fromLlm;
  }

  // "move all hot leads …" / "tag saare interested leads …" is a bulk change, whatever the intent said.
  if (r.lead && ALL_WORDS_RE.test(r.lead) && (intent === "crm_move_lead" || intent === "crm_tag_lead")) {
    r.targets = targetsFromText(r.lead);
    delete r.lead;
  }
  return r;
}

/** Move / tag requests that name many leads ("all …") run as a bulk change. */
export function effectiveCrmIntent(intent: CrmWriteIntent, r: CrmActionRequest): CrmWriteIntent {
  if ((intent === "crm_move_lead" || intent === "crm_tag_lead") && !r.lead && r.targets) return "crm_bulk_update";
  // "VIP label laga do": not a reply label, so it is the lead's tag.
  if (intent === "crm_change_label" && !r.label && r.labelText) {
    r.tags = [r.labelText];
    return "crm_tag_lead";
  }
  return intent;
}

// ── Questions when something is missing ──────────────────────────────────────

/** A question for the user when the request is not complete, else undefined. */
export function missingInfoQuestion(intent: CrmWriteIntent, r: CrmActionRequest): string | undefined {
  const needLead = "Which lead? Give me a name or email, e.g. ";
  switch (intent) {
    case "crm_move_lead":
      if (!r.lead && r.leadId === undefined) return `${needLead}**move ali@shop.com to Interested**.`;
      if (!r.toStage) return `To which stage should I move **${r.lead}**? For example *move ${r.lead} to Meeting Booked*.`;
      return undefined;
    case "crm_tag_lead":
      if (!r.lead && r.leadId === undefined) return `${needLead}**tag ali@shop.com with VIP**.`;
      if (!r.tags?.length) return `Which tag should I ${r.remove ? "remove from" : "add to"} **${r.lead}**?`;
      return undefined;
    case "crm_create_tag":
      return r.tagName ? undefined : "What should the new tag be called? For example *create tag Real Estate*.";
    case "crm_snooze_lead":
      return r.lead || r.leadId !== undefined ? undefined : `${needLead}**snooze ali@shop.com for 3 days**.`;
    case "crm_mark_done":
      return r.lead || r.leadId !== undefined ? undefined : `${needLead}**mark ali@shop.com as done**.`;
    case "crm_change_label":
      if (!r.lead && r.leadId === undefined) return `${needLead}**change the label of ali@shop.com to Question**.`;
      if (!r.label) {
        return (
          `Which label should **${r.lead}**'s reply get? Interested, Not Interested, Out of Office, Question, Meeting Booked, ` +
          "Neutral or Bounce / Unsubscribe. (For your own label, e.g. VIP, say *tag " + `${r.lead} with VIP*.)`
        );
      }
      return undefined;
    case "crm_bulk_update":
      if (!hasFilters(r.targets)) {
        return "Which leads? Say it with a filter, e.g. *move all hot leads to Engaged* or *tag all interested leads with VIP*.";
      }
      if (!r.toStage && !r.tags?.length) return "What should I do with these leads — move them to a stage, or add / remove a tag?";
      return undefined;
    case "crm_campaign_settings":
      if (!r.campaign) return "Which campaign? For example *use the Recruiting pipeline for campaign Summer Sale*.";
      if (!r.pipeline && !r.tags?.length) return `What should change for campaign **${r.campaign}** — its pipeline or its auto tags?`;
      return undefined;
  }
}

/** Arguments for prepare_crm_action, or undefined when no lookup is needed. */
export function prepareArgsFor(intent: CrmWriteIntent, r: CrmActionRequest): Record<string, unknown> | undefined {
  switch (intent) {
    case "crm_create_tag":
      return undefined;
    case "crm_bulk_update":
      return {
        targets: r.targets,
        ...(r.toStage ? { toStage: r.toStage } : {}),
        ...(r.tags?.length ? { tags: r.tags } : {}),
      };
    case "crm_campaign_settings":
      return {
        campaign: r.campaign,
        ...(r.pipeline ? { pipeline: r.pipeline } : {}),
        ...(r.tags?.length ? { tags: r.tags } : {}),
      };
    default:
      return {
        ...(r.leadId !== undefined ? { leadId: r.leadId } : { lead: r.lead }),
        ...(intent === "crm_move_lead" && r.toStage ? { toStage: r.toStage } : {}),
        ...(intent === "crm_tag_lead" && r.tags?.length ? { tags: r.tags } : {}),
        ...(intent === "crm_change_label" ? { needLatestReply: true } : {}),
      };
  }
}

// ── From the preparation to one tool call ────────────────────────────────────

type Obj = Record<string, unknown>;

export type CrmActionPlan =
  | { kind: "reply"; message: string }
  /** The lead replied in several campaigns: ask which one (the answer continues the action). */
  | { kind: "chooseCampaign"; message: string; leadId: number; leadName: string; choices: CrmCampaignChoice[] }
  | { kind: "tool"; toolName: CrmWriteToolName; toolArgs: Obj; confirmText: string; requiresApproval: boolean };

interface ReplyInCampaign extends CrmCampaignChoice {
  replyId: number;
  label: string | null;
  subject: string | null;
  receivedAt: string | null;
}

/** The lead's newest reply per campaign (prepare_crm_action), or the one latest reply from an older MCP server. */
function repliesByCampaign(p: Obj): ReplyInCampaign[] {
  if (Array.isArray(p.replyCampaigns)) {
    return arr(p.replyCampaigns)
      .filter((c) => typeof c.replyId === "number" && typeof c.campaignId === "number")
      .map((c) => ({
        campaignId: c.campaignId as number,
        campaignName: typeof c.campaignName === "string" ? c.campaignName : null,
        replyId: c.replyId as number,
        label: typeof c.label === "string" ? c.label : null,
        subject: typeof c.subject === "string" ? c.subject : null,
        receivedAt: typeof c.receivedAt === "string" ? c.receivedAt : null,
      }));
  }
  const latest = p.latestReply === null ? null : obj(p.latestReply);
  if (!latest || typeof latest.id !== "number") return [];
  return [{
    campaignId: 0, campaignName: null, replyId: latest.id,
    label: typeof latest.label === "string" ? latest.label : null,
    subject: typeof latest.subject === "string" ? latest.subject : null,
    receivedAt: typeof latest.receivedAt === "string" ? latest.receivedAt : null,
  }];
}

const normWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The campaign the user named: id, or a name / words that fit exactly one of the lead's campaigns. */
function pickCampaign(choices: ReplyInCampaign[], r: CrmActionRequest): ReplyInCampaign | undefined {
  if (r.campaignId !== undefined) return choices.find((c) => c.campaignId === r.campaignId);
  if (r.campaign) {
    const want = normWords(r.campaign);
    const exact = choices.filter((c) => c.campaignName && normWords(c.campaignName) === want);
    if (exact.length === 1) return exact[0];
    const part = choices.filter((c) => c.campaignName && (normWords(c.campaignName).includes(want) || want.includes(normWords(c.campaignName))));
    return part.length === 1 ? part[0] : undefined;
  }
  if (r.source) {
    // "... QA-TEST CRM E2E campaign ma": a campaign name written in the message.
    const text = ` ${normWords(r.source)} `;
    const named = choices.filter((c) => c.campaignName && normWords(c.campaignName).length >= 3 && text.includes(` ${normWords(c.campaignName)} `));
    return named.length === 1 ? named[0] : undefined;
  }
  return undefined;
}

function campaignTitle(c: CrmCampaignChoice): string {
  return c.campaignName ? `**${c.campaignName}**` : `campaign #${c.campaignId}`;
}

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function leadTitle(lead: Obj): string {
  const name = typeof lead.name === "string" && lead.name ? lead.name : undefined;
  return name ? `**${name}** (${lead.email})` : `**${lead.email}**`;
}

function leadShort(lead: Obj): string {
  return typeof lead.name === "string" && lead.name ? lead.name : String(lead.email);
}

/** Problems shared by every action (unknown lead / stage / tag / campaign / pipeline). */
function problemReply(p: Obj, r: CrmActionRequest, needLead: boolean): string | undefined {
  if (needLead && !p.lead) {
    const matches = arr(p.leadMatches);
    if (matches.length === 0) return `I couldn't find a lead matching **${p.leadQuery ?? r.lead}**.`;
    return [
      `I found ${matches.length} leads matching **${p.leadQuery ?? r.lead}**. Which one do you mean?`,
      "",
      ...matches.map((m, i) => `${i + 1}. ${leadTitle(m)}${m.stageName ? ` · ${m.stageName}` : ""}`),
      "",
      `Reply with the number (1–${matches.length}) or the email, or say **cancel**.`,
    ].join("\n");
  }
  if (typeof p.unknownCampaign === "string") {
    const list = names(p.availableCampaigns);
    return `I couldn't find one campaign called **${p.unknownCampaign}**.${list.length ? `\n\nYour campaigns: ${list.join(", ")}` : ""}`;
  }
  if (typeof p.unknownPipeline === "string") {
    return `There is no pipeline called **${p.unknownPipeline}**. Your pipelines: ${names(p.availablePipelines).join(", ") || "none"}.`;
  }
  if (typeof p.unknownStage === "string") {
    return `There is no stage called **${p.unknownStage}**. Your stages: ${names(p.availableStages).join(", ") || "none"}.`;
  }
  if (Array.isArray(p.unknownTags) && p.unknownTags.length) {
    const missing = names(p.unknownTags);
    const avail = names(p.availableTags);
    return [
      `There is no tag called **${missing.join(", ")}**.`,
      avail.length ? `Your lead tags: ${avail.join(", ")}.` : "You have no lead tags yet.",
      "",
      `To make it, say *create tag ${missing[0]}*.`,
    ].join("\n");
  }
  return undefined;
}

function filterText(applied: Obj, t: CrmTargetFilters | undefined): string {
  const parts = [
    typeof applied.stageName === "string" ? `stage ${applied.stageName}` : undefined,
    t?.labels?.length ? t.labels.map((l) => labelText(l)).join(" or ") : undefined,
    t?.scoreTiers?.length ? t.scoreTiers.join("/") : undefined,
    Array.isArray(applied.tagNames) && applied.tagNames.length ? `tag ${applied.tagNames.join(", ")}` : undefined,
    typeof applied.campaignName === "string" ? `campaign ${applied.campaignName}` : t?.campaign ? `campaign ${t.campaign}` : undefined,
    t?.needsReply ? "waiting for your reply" : undefined,
    t?.hotOnly ? "Interested or hot" : undefined,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(" · ")})` : "";
}

/**
 * Turns the request + preparation into one tool call (or a reply).
 * `p` is the prepare_crm_action payload; ignored for crm_create_tag.
 */
export function planCrmAction(intent: CrmWriteIntent, r: CrmActionRequest, p: Obj): CrmActionPlan {
  const reply = (message: string): CrmActionPlan => ({ kind: "reply", message });
  const needLead = !["crm_create_tag", "crm_bulk_update", "crm_campaign_settings"].includes(intent);
  const problem = intent === "crm_create_tag" ? undefined : problemReply(p, r, needLead);
  if (problem) return reply(problem);

  const lead = obj(p.lead);
  const leadId = typeof lead.id === "number" ? lead.id : undefined;

  switch (intent) {
    case "crm_move_lead": {
      const stage = obj(p.stage);
      if (lead.stageName === stage.name) return reply(`${leadTitle(lead)} is already in **${stage.name}**.`);
      const notes = [
        stage.type === "won" ? "This marks the deal as **Won**." : stage.type === "lost" ? "This marks the deal as **Lost**." : undefined,
        stage.stopFollowUps === true ? "Automatic follow-up emails to this lead will stop." : undefined,
      ].filter(Boolean);
      return {
        kind: "tool",
        toolName: "move_crm_lead",
        toolArgs: { contactId: leadId, stageId: stage.id, leadName: leadShort(lead) },
        confirmText: [`Move ${leadTitle(lead)} from **${lead.stageName ?? "no stage"}** to **${stage.name}**?`, ...notes].join("\n\n"),
        requiresApproval: stage.type === "won" || stage.type === "lost" || stage.stopFollowUps === true,
      };
    }

    case "crm_tag_lead": {
      const tag = arr(p.tags)[0] ?? {};
      return {
        kind: "tool",
        toolName: "tag_crm_lead",
        toolArgs: { contactId: leadId, tagId: tag.id, remove: r.remove === true, leadName: leadShort(lead), tagName: tag.name },
        confirmText: `${r.remove ? "Remove" : "Add"} tag **${tag.name}** ${r.remove ? "from" : "to"} ${leadTitle(lead)}.`,
        requiresApproval: false,
      };
    }

    case "crm_create_tag":
      return {
        kind: "tool",
        toolName: "create_crm_tag",
        toolArgs: { name: r.tagName, ...(r.tagColor ? { color: r.tagColor } : {}) },
        confirmText: `Create tag **${r.tagName}**.`,
        requiresApproval: false,
      };

    case "crm_snooze_lead":
      return {
        kind: "tool",
        toolName: "snooze_crm_lead",
        toolArgs: { contactId: leadId, until: r.until, leadName: leadShort(lead) },
        confirmText: `Snooze ${leadTitle(lead)} for ${r.untilText ?? "a while"}.`,
        requiresApproval: false,
      };

    case "crm_mark_done":
      return {
        kind: "tool",
        toolName: "mark_crm_lead_done",
        toolArgs: { contactId: leadId, leadName: leadShort(lead) },
        confirmText: `Mark ${leadTitle(lead)} as answered.`,
        requiresApproval: false,
      };

    case "crm_change_label": {
      const choices = repliesByCampaign(p);
      if (choices.length === 0) return reply(`${leadTitle(lead)} has no reply yet, so there is no label to set.`);
      const named = r.campaignId !== undefined || !!r.campaign;
      // Found through the inbox (the reply's subject): the campaign of that thread, when it is one.
      const searched = Array.isArray(obj(p.replySearch).campaignIds) ? (obj(p.replySearch).campaignIds as unknown[]) : [];
      const bySearch = named ? [] : choices.filter((c) => searched.includes(c.campaignId));
      const pick = pickCampaign(choices, r) ?? (bySearch.length === 1 ? bySearch[0] : undefined) ??
        (choices.length === 1 && !named ? choices[0] : undefined);
      if (!pick) {
        const list = choices.map((c, i) => `${i + 1}. ${campaignTitle(c)}${c.label ? ` — now ${labelText(c.label)}` : " — no label yet"}`);
        const intro = named
          ? `${leadTitle(lead)} has no reply in **${r.campaign ?? `campaign #${r.campaignId}`}**. They replied in:`
          : `${leadTitle(lead)} replied in ${choices.length} campaigns. In which campaign should the reply get ${labelText(r.label)}?`;
        return {
          kind: "chooseCampaign",
          leadId: leadId!,
          leadName: leadShort(lead),
          choices: choices.map(({ campaignId, campaignName }) => ({ campaignId, campaignName })),
          message: [intro, "", ...list, "", `Reply with the number (1–${choices.length}) or the campaign name, or say **cancel**.`].join("\n"),
        };
      }
      const where = pick.campaignName ? ` in ${campaignTitle(pick)}` : "";
      if (pick.label === r.label) return reply(`${leadTitle(lead)}'s reply${where} is already ${labelText(r.label)}.`);
      return {
        kind: "tool",
        toolName: "set_crm_reply_label",
        toolArgs: { replyId: pick.replyId, label: r.label, leadName: leadShort(lead) },
        confirmText: `Set the label of ${leadTitle(lead)}'s reply${where} from ${labelText(pick.label) ?? "no label"} to ${labelText(r.label)}.`,
        requiresApproval: false,
      };
    }

    case "crm_bulk_update": {
      const targets = obj(p.targets);
      const ids = Array.isArray(targets.ids) ? (targets.ids as number[]) : [];
      const total = typeof targets.total === "number" ? targets.total : ids.length;
      if (ids.length === 0) return reply(`No leads match${filterText(obj(targets.appliedFilters), r.targets)}, so nothing was changed.`);
      const stage = p.stage ? obj(p.stage) : undefined;
      const tags = arr(p.tags);
      const what = [
        stage ? `move them to **${stage.name}**` : undefined,
        tags.length ? `${r.remove ? "remove" : "add"} tag **${tags.map((t) => t.name).join(", ")}**` : undefined,
      ].filter(Boolean).join(" and ");
      const sample = arr(targets.sample).map((s) => (typeof s.name === "string" && s.name ? s.name : String(s.email)));
      const lines = [
        `This will change **${ids.length} lead${ids.length === 1 ? "" : "s"}**${filterText(obj(targets.appliedFilters), r.targets)}: ${what}.`,
        sample.length ? `For example: ${sample.join(", ")}${ids.length > sample.length ? ", …" : ""}` : undefined,
        targets.truncated === true ? `⚠️ ${total} leads match; only the first ${ids.length} will be changed.` : undefined,
        stage?.stopFollowUps === true ? "Automatic follow-up emails to these leads will stop." : undefined,
      ].filter(Boolean);
      return {
        kind: "tool",
        toolName: "bulk_update_crm_leads",
        toolArgs: {
          contactIds: ids,
          ...(stage ? { moveToStageId: stage.id } : {}),
          ...(tags.length ? { [r.remove ? "removeTagIds" : "addTagIds"]: tags.map((t) => t.id) } : {}),
        },
        confirmText: lines.join("\n\n"),
        requiresApproval: true,
      };
    }

    case "crm_campaign_settings": {
      const campaign = obj(p.campaign);
      const campaignName = typeof campaign.name === "string" && campaign.name ? campaign.name : r.campaign;
      const pipeline = p.pipeline ? obj(p.pipeline) : undefined;
      const tags = arr(p.tags);
      const lines = [
        pipeline ? `New leads of campaign **${campaignName}** will start in the **${pipeline.name}** pipeline.` : undefined,
        tags.length
          ? `Every lead of campaign **${campaignName}** — the ones it has now and new ones — will get tag **${tags.map((t) => t.name).join(", ")}**.`
          : undefined,
      ].filter(Boolean);
      return {
        kind: "tool",
        toolName: "set_crm_campaign_settings",
        toolArgs: {
          campaignId: campaign.id,
          ...(pipeline ? { pipelineId: pipeline.id } : {}),
          ...(tags.length ? { addTagIds: tags.map((t) => t.id) } : {}),
          ...(campaignName ? { campaignName } : {}),
        },
        confirmText: lines.join("\n\n"),
        requiresApproval: tags.length > 0,
      };
    }
  }
}
