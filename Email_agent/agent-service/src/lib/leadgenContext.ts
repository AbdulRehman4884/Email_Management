/**
 * src/lib/leadgenContext.ts
 *
 * Lead finder conversation memory. Persisted in the session as `leadGenContext`.
 *
 *   lastSearch  — the search the user just created / ran / scheduled / looked at, so
 *                 "isay roz 9 baje chalao", "run it now", "pause it" need no name. Valid 2 hours.
 *   lastLeads   — the lead ids of the last lead finder list shown, so "inhein campaign 22 mein daal do" /
 *                 "save these to the CRM" act on exactly those leads. Valid 30 minutes.
 *   pending     — a request waiting for one answer ("In which city?" -> "Karachi"). Valid 10 minutes and one turn:
 *                 a reply that is not the answer drops it.
 */

import type { McpToolResult } from "../types/mcp.js";
import type { MissingField, ParsedLeadGenMessage } from "./leadgenArgs.js";

export interface LeadGenPending {
  intent: string;
  request: ParsedLeadGenMessage;
  missing: MissingField;
  atIso: string;
  /** Set on the turn that asked; a question left from an older turn is dropped on save. */
  isNew?: boolean;
}

export interface LeadGenContext {
  lastSearch?: { id: number; name: string; atIso: string };
  lastLeads?: { ids: number[]; atIso: string };
  pending?: LeadGenPending;
}

const SEARCH_TTL_MS = 2 * 60 * 60_000;
const LEADS_TTL_MS = 30 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_IDS = 500;

const age = (iso: string, now: number) => now - Date.parse(iso);

/** Drops what is too old (on load). */
export function liveLeadGenContext(ctx: LeadGenContext | undefined, now = Date.now()): LeadGenContext | undefined {
  if (!ctx) return undefined;
  const out: LeadGenContext = {};
  if (ctx.lastSearch && age(ctx.lastSearch.atIso, now) < SEARCH_TTL_MS) out.lastSearch = ctx.lastSearch;
  if (ctx.lastLeads && age(ctx.lastLeads.atIso, now) < LEADS_TTL_MS) out.lastLeads = ctx.lastLeads;
  if (ctx.pending && age(ctx.pending.atIso, now) < PENDING_TTL_MS) out.pending = ctx.pending;
  return out.lastSearch || out.lastLeads || out.pending ? out : undefined;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

function payloadOf(result: McpToolResult | undefined): Obj | undefined {
  if (!result || result.isToolError) return undefined;
  const d = obj(result.data);
  if (d.success === false) return undefined;
  return "success" in d && "data" in d ? obj(d.data) : d;
}

function searchOf(v: unknown): { id: number; name: string } | undefined {
  const s = obj(v);
  return typeof s.id === "number" && typeof s.name === "string" ? { id: s.id, name: s.name } : undefined;
}

/** Memory after this turn's tool call. */
export function nextLeadGenContext(
  prev: LeadGenContext | undefined,
  turn: { toolName: string | undefined; toolResult: McpToolResult | undefined },
  now = new Date(),
): LeadGenContext | undefined {
  const d = payloadOf(turn.toolResult);
  const ctx: LeadGenContext = { ...(liveLeadGenContext(prev, now.getTime()) ?? {}) };
  // A question lives for one answer: keep it only on the turn that asked it.
  if (ctx.pending?.isNew) ctx.pending = { ...ctx.pending, isNew: false };
  else delete ctx.pending;
  if (!d || !turn.toolName) return ctx.lastSearch || ctx.lastLeads || ctx.pending ? ctx : undefined;
  const atIso = now.toISOString();
  switch (turn.toolName) {
    case "create_saved_search":
    case "run_saved_search":
    case "create_search_schedule": {
      const s = searchOf(d.search);
      if (s) ctx.lastSearch = { ...s, atIso };
      break;
    }
    case "list_search_schedules": {
      const list = Array.isArray(d.searches) ? d.searches : [];
      const only = list.length === 1 ? searchOf(list[0]) : undefined;
      if (only) ctx.lastSearch = { ...only, atIso };
      break;
    }
    case "list_workspace_leads": {
      const ids = (Array.isArray(d.leads) ? d.leads : []).map((l) => obj(l).id).filter((x): x is number => typeof x === "number");
      if (ids.length) ctx.lastLeads = { ids: ids.slice(0, MAX_IDS), atIso };
      break;
    }
  }
  return ctx.lastSearch || ctx.lastLeads || ctx.pending ? ctx : undefined;
}

/** "inhein", "inko", "them", "these", "ye leads", "unhe": the leads shown last. */
export const LEADS_PRONOUN = /\b(inhein|inhen|inhe|inko|in\s+ko|unhein|unhe|unko|them|these|those|ye\s+leads|yeh\s+leads|in\s+leads|these\s+leads)\b/i;

/** "isay", "isko", "it", "this search", "us search": the last search. */
export const SEARCH_PRONOUN = /\b(isay|ise|isey|isko|is\s+ko|usay|usko|it|this\s+(one|search)|that\s+(one|search)|is\s+search|us\s+search)\b/i;
