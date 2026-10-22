/**
 * src/lib/crmContext.ts
 *
 * CRM conversation memory (agent phase 3). Persisted in the session as `crmContext`.
 *
 *   pendingSelection — several leads matched a name; the next reply ("2", an email, "doosra",
 *                      "cancel") picks one and the same action continues. Valid 10 minutes, one turn.
 *   lastList         — the filters of the last lead list shown, so "tag them with VIP" /
 *                      "inko Won kar do" act on exactly those leads. Valid 30 minutes.
 *   lastLead         — the last single lead shown or changed, for "him" / "isko". Valid 30 minutes.
 *
 * Also: compound requests ("hot leads dikhao aur unko VIP tag laga do") are split into the
 * part that names the leads and the action.
 */

import type { CrmActionRequest, CrmTargetFilters, CrmWriteIntent } from "./crmActions.js";
import type { McpToolResult } from "../types/mcp.js";

export interface CrmLeadRef {
  id: number;
  email: string;
  name: string | null;
  stageName?: string | null;
}

export interface CrmContext {
  pendingSelection?: {
    intent: CrmWriteIntent | "crm_lead_details";
    request: CrmActionRequest;
    matches: CrmLeadRef[];
    atIso: string;
    /** Set on the turn that asked the question; a choice left from an older turn is dropped on save. */
    isNew?: boolean;
  };
  lastList?: { targets: CrmTargetFilters; total: number; atIso: string };
  lastLead?: CrmLeadRef & { atIso: string };
}

/** What the user's reply did with a pending selection. Transient (one turn). */
export type CrmSelection = { kind: "pick"; lead: CrmLeadRef } | { kind: "cancel" };

const SELECTION_TTL_MS = 10 * 60_000;
const CONTEXT_TTL_MS = 30 * 60_000;

const fresh = (atIso: string | undefined, ttl: number, now: number) =>
  !!atIso && now - new Date(atIso).getTime() <= ttl;

/** Drops expired parts; returns undefined when nothing is left. */
export function liveCrmContext(ctx: CrmContext | undefined, now = Date.now()): CrmContext | undefined {
  if (!ctx) return undefined;
  const out: CrmContext = {};
  if (ctx.pendingSelection && fresh(ctx.pendingSelection.atIso, SELECTION_TTL_MS, now)) out.pendingSelection = ctx.pendingSelection;
  if (ctx.lastList && fresh(ctx.lastList.atIso, CONTEXT_TTL_MS, now)) out.lastList = ctx.lastList;
  if (ctx.lastLead && fresh(ctx.lastLead.atIso, CONTEXT_TTL_MS, now)) out.lastLead = ctx.lastLead;
  return Object.keys(out).length ? out : undefined;
}

// ── Picking one lead from a list ─────────────────────────────────────────────

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  pehla: 1, pehli: 1, pehle: 1, doosra: 2, dusra: 2, doosri: 2, dusri: 2, teesra: 3, tisra: 3, teesri: 3,
  chautha: 4, chotha: 4, chauthi: 4, paanchwa: 5, panchwa: 5, paanchwi: 5,
};

const CANCEL_RE = /^(cancel|no|nope|nahi|nahin|chhodo|chodo|rehne do|rehnay do|stop|never ?mind|koi nahi)\b/i;

/**
 * The user's answer to "which one?": a number, an ordinal (English / Roman Urdu), an email,
 * or a name that fits exactly one match. undefined = the reply is not a selection.
 */
export function readSelection(message: string, matches: CrmLeadRef[]): CrmSelection | undefined {
  const text = message.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (CANCEL_RE.test(text)) return { kind: "cancel" };

  const num = text.match(/^(?:#|no\.?\s*|number\s*|option\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:one|wala|wali|walay))?$/)?.[1];
  const ordinal = text.match(/^(?:the\s+)?([a-z]+)(?:\s+(?:one|wala|wali|walay|lead))?$/)?.[1];
  const index = num ? Number(num) : ordinal ? ORDINALS[ordinal] : undefined;
  if (index !== undefined) {
    const lead = matches[index - 1];
    return lead ? { kind: "pick", lead } : undefined;
  }

  const email = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0];
  if (email) {
    const lead = matches.find((m) => m.email.toLowerCase() === email);
    return lead ? { kind: "pick", lead } : undefined;
  }

  if (text.length >= 2 && text.length <= 60 && !/\s(to|ko|with|and|aur)\s/.test(` ${text} `)) {
    // A name counts only when no other lead in the list contains it ("ali" with Ali Khan + Ali Raza = unclear).
    const mentions = matches.filter((m) => (m.name ?? "").toLowerCase().includes(text) || m.email.toLowerCase().includes(text));
    const hits = matches.filter((m) => (m.name ?? "").toLowerCase() === text || m.email.toLowerCase().startsWith(`${text}@`));
    if (hits.length === 1 && mentions.length === 1) return { kind: "pick", lead: hits[0]! };
  }
  return undefined;
}

// ── "them" / "him" and compound requests ─────────────────────────────────────

export const THEM = "__them__";
export const ONE = "__one__";

const PLURAL_RE = /^(them|these|those|these leads|those leads|all of them|sab|in sab|un sab|in sabko|un sabko|inko|unko|inhe|unhe|in leads|un leads|in sab leads|un sab leads)$/i;
const SINGULAR_RE = /^(him|her|this lead|that lead|this one|that one|is lead|us lead|isko|usko|ise|use|iss|uss)$/i;

/** "them" / "inko" → THEM, "him" / "isko" → ONE, anything else unchanged. */
export function pronounOf(lead: string | undefined): string | undefined {
  if (!lead) return lead;
  const v = lead.trim();
  if (PLURAL_RE.test(v)) return THEM;
  if (SINGULAR_RE.test(v)) return ONE;
  return lead;
}

/**
 * Rewrites leading Roman Urdu pronouns so the normal parsers see "<pronoun> ko …":
 * "inko VIP tag laga do" → "__them__ ko VIP tag laga do".
 */
export function normalizePronouns(message: string): string {
  return message
    .replace(/^\s*(?:in|un)\s+sab\s*ko\b/i, `${THEM} ko`)
    .replace(/^\s*(?:inko|unko|inhe|unhe)\b/i, `${THEM} ko`)
    .replace(/^\s*(?:isko|usko|ise|use)\b/i, `${ONE} ko`);
}

const SPLIT_RE = /\s+(?:and then|and|then|aur phir|aur|phir|, then|,)\s+/i;
const ACTION_RE = /\b(tag|move|mark|snooze|label|daal|dal|laga|hata|won|lost|done)\b/i;
const PRONOUN_IN_ACTION_RE = /\b(them|these|those|inko|unko|in sab|un sab|inhe|unhe|un|in)\b/i;

/**
 * "show hot leads and tag them with VIP" / "hot leads dikhao aur unko VIP tag laga do"
 * → { listPart: "show hot leads", actionPart: "tag them with VIP" }. undefined = not compound.
 */
export function splitCompound(message: string): { listPart: string; actionPart: string } | undefined {
  const m = message.trim();
  const parts = m.split(SPLIT_RE);
  if (parts.length < 2) return undefined;
  const actionPart = parts[parts.length - 1]!.trim();
  const listPart = parts.slice(0, -1).join(" ").trim();
  if (!ACTION_RE.test(actionPart) || !PRONOUN_IN_ACTION_RE.test(actionPart)) return undefined;
  if (!/\bleads?\b|\bcontacts?\b|\bwale\b|\bstage\b/i.test(listPart)) return undefined;
  return { listPart, actionPart };
}

// ── Building the context after a turn ────────────────────────────────────────

type Obj = Record<string, unknown>;

function payloadOf(result: McpToolResult | undefined): Obj | undefined {
  if (!result || result.isToolError) return undefined;
  const d = result.data && typeof result.data === "object" ? (result.data as Obj) : undefined;
  if (!d || d.success === false) return undefined;
  return d.success === true && d.data && typeof d.data === "object" ? (d.data as Obj) : d;
}

function targetsFromArgs(args: Obj): CrmTargetFilters {
  const t: CrmTargetFilters = {};
  if (typeof args.search === "string") t.search = args.search;
  if (typeof args.stage === "string") t.stage = args.stage;
  if (Array.isArray(args.labels) && args.labels.length) t.labels = args.labels as CrmTargetFilters["labels"];
  if (Array.isArray(args.scoreTiers) && args.scoreTiers.length) t.scoreTiers = args.scoreTiers as CrmTargetFilters["scoreTiers"];
  if (Array.isArray(args.tags) && args.tags.length) t.tags = args.tags as string[];
  if (typeof args.campaign === "string") t.campaign = args.campaign;
  if (args.needsReply === true) t.needsReply = true;
  if (args.hotOnly === true) t.hotOnly = true;
  return t;
}

function leadRef(v: unknown): CrmLeadRef | undefined {
  const o = v && typeof v === "object" ? (v as Obj) : undefined;
  if (!o || typeof o.id !== "number" || typeof o.email !== "string") return undefined;
  return { id: o.id, email: o.email, name: typeof o.name === "string" ? o.name : null, stageName: typeof o.stageName === "string" ? o.stageName : null };
}

/**
 * The context to save after this turn. `ctx` is the context as this turn left it
 * (detectIntent already consumed any pending selection; CrmAgent may have set a new one).
 */
export function nextCrmContext(
  ctx: CrmContext | undefined,
  turn: { toolName?: string | undefined; toolArgs?: Obj | undefined; toolResult?: McpToolResult | undefined; intent?: string | undefined },
  now = new Date(),
): CrmContext | undefined {
  const out: CrmContext = { ...(liveCrmContext(ctx, now.getTime()) ?? {}) };
  const atIso = now.toISOString();

  // A choice lives for one answer only: keep it only when this turn asked it.
  if (out.pendingSelection?.isNew) {
    const { isNew: _isNew, ...kept } = out.pendingSelection;
    out.pendingSelection = kept;
  } else {
    delete out.pendingSelection;
  }
  const data = payloadOf(turn.toolResult);
  const args = turn.toolArgs ?? {};

  if (data) {
    switch (turn.toolName) {
      case "list_crm_contacts": {
        const targets = targetsFromArgs(args);
        if (Object.keys(targets).length && Array.isArray(data.contacts) && data.contacts.length) {
          out.lastList = { targets, total: typeof data.total === "number" ? data.total : data.contacts.length, atIso };
        }
        break;
      }
      case "list_crm_needs_reply":
        if (Array.isArray(data.leads) && data.leads.length) {
          out.lastList = { targets: { needsReply: true }, total: data.leads.length, atIso };
        }
        break;
      case "get_crm_contact": {
        const detail = data.detail && typeof data.detail === "object" ? (data.detail as Obj) : undefined;
        const lead = leadRef(detail?.contact);
        if (lead) out.lastLead = { ...lead, atIso };
        else if (Array.isArray(data.matches) && data.matches.length > 1) {
          out.pendingSelection = {
            intent: "crm_lead_details",
            request: {},
            matches: data.matches.map(leadRef).filter((m): m is CrmLeadRef => !!m),
            atIso,
          };
        }
        break;
      }
      default:
        if (typeof args.contactId === "number") {
          out.lastLead = {
            id: args.contactId,
            email: typeof args.leadEmail === "string" ? args.leadEmail : "",
            name: typeof args.leadName === "string" ? args.leadName : null,
            atIso,
          };
        }
    }
  }
  return Object.keys(out).length ? out : undefined;
}
