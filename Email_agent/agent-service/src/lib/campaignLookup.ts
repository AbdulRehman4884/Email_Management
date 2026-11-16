/**
 * src/lib/campaignLookup.ts
 *
 * Finds the campaign a user named in their message ("stats for the campaign DRY RUN",
 * "who replied to Black Friday"). The LLM puts names in llmExtractedArgs.campaignId,
 * but tool args only accept numeric ids, so names used to be dropped and the user got
 * the full campaign list (bug A-01).
 *
 *   campaignNameFrom()   — the name the user gave (LLM arg, quotes, or "campaign X")
 *   matchCampaigns()     — exact name match first, then unique partial match
 *   lookupCampaignByName() — fetches the user's campaigns (get_all_campaigns) and matches
 */

import type { LLMIntentArguments } from "../schemas/llmIntent.schema.js";
import type { AuthContext } from "../types/common.js";
import { mcpClientService } from "../services/mcpClient.service.js";

export interface CampaignRef {
  id: string;
  name: string;
  status: string;
}

const norm = (s: string) => s.toLowerCase().replace(/["'“”]/g, "").replace(/\s+/g, " ").trim();

/** "campaign" and its common misspellings ("compain", "campain", "campaing"). */
const CAMPAIGN_WORD = "(?:campaign|campaing|campain|compain|compaign|campagin)";
/** Roman Urdu postpositions after a name: "X pa / par / pe / mein / ke / ki / ka". */
const URDU_POST = "(?:pa|par|pe|mein|me|main|ke|ki|ka)";
/** Roman Urdu question words: "kitna / kitne / kis / kaun / kya". */
const URDU_Q = "(?:kitn[aei]|kis|kaun|kya)\\b";

/** Words that are not a campaign name ("stats for all campaigns", "my campaign"). */
const NOT_A_NAME = /^(all|my|the|this|that|it|every|each|latest|last|recent|campaigns?|overall|account|mere|meri|mera|meray|is|us|iss|uss|sab|sare|saray|tamam)$/i;

/**
 * The campaign name the user gave, if any. Numeric ids return undefined (handled
 * by the normal id path).
 */
export function campaignNameFrom(extracted: LLMIntentArguments | undefined, message: string): string | undefined {
  const fromLlm = typeof extracted?.campaignId === "string" ? extracted.campaignId.trim() : "";
  const candidates = [
    fromLlm,
    message.match(/["“]([^"”]{1,255})["”]/)?.[1],
    // Roman Urdu: "compain BM AI Services pa kitna replies", "Proving AI Services pa kitne replies han"
    // "Damo campaign ke replies dikhao" — name before the word campaign
    message.match(new RegExp(`^(?:show\\s+|dikhao\\s+)?["']?(.+?)["']?\\s+${CAMPAIGN_WORD}\\s+${URDU_POST}\\b`, "i"))?.[1],
    message.match(new RegExp(`\\b${CAMPAIGN_WORD}\\s+["']?(.+?)["']?\\s+${URDU_POST}\\b`, "i"))?.[1],
    message.match(new RegExp(`^(?:${CAMPAIGN_WORD}\\s+)?["']?(.+?)["']?\\s+(?:${CAMPAIGN_WORD}\\s+)?${URDU_POST}\\s+${URDU_Q}`, "i"))?.[1],
    // "Proving AI Services ke stats dikhao" — no word "campaign", no question word
    message.match(/^(?:show\s+|dikhao\s+)?["']?(.+?)["']?\s+(?:ke|ki|ka)\s+(?:stats?|statistics|analytics|report|performance|replies|reply)\b/i)?.[1],
    message.match(new RegExp(`\\b${CAMPAIGN_WORD}\\s+(?:named\\s+|called\\s+)?["']?(.+?)["']?\\s*[?.!]*$`, "i"))?.[1],
    message.match(/\b(?:stats?|statistics|analytics|report|replies|replied)\s+(?:of|for|to|on)\s+(?:the\s+)?["']?(.+?)["']?\s+campaign\b/i)?.[1],
    // "stats of BM AI Services" — no word "campaign" at all
    message.match(/\b(?:stats?|statistics|analytics|report|performance)\s+(?:of|for|on)\s+(?:the\s+)?["']?(.+?)["']?\s*[?.!]*$/i)?.[1],
  ];
  for (const c of candidates) {
    const v = (c ?? "")
      .trim()
      .replace(/^(?:the|my)\s+/i, "")
      .replace(new RegExp(`^${CAMPAIGN_WORD}\\s+(?:named\\s+|called\\s+)?`, "i"), "")
      .replace(/^(?:id|no\.?|number)\s*[:#]?\s*(?=\d+$)/i, "")
      .replace(/\s+campaign$/i, "")
      .trim();
    const core = v.replace(/\s*campaigns?$/i, "").trim();
    // "ke replies dikhao" is the rest of a Roman Urdu sentence, never a name.
    const startsWithPost = new RegExp(`^${URDU_POST}\\b`, "i").test(v);
    if (!v || v.length > 255 || /^#?\d+$/.test(v) || NOT_A_NAME.test(v) || !core || NOT_A_NAME.test(core) || startsWithPost) continue;
    return v;
  }
  return undefined;
}

/** Exact (case/space-insensitive) matches; if none, partial matches either way. */
export function matchCampaigns(name: string, campaigns: CampaignRef[]): CampaignRef[] {
  const wanted = norm(name);
  const exact = campaigns.filter((c) => norm(c.name) === wanted);
  if (exact.length) return exact;
  return campaigns.filter((c) => norm(c.name).includes(wanted) || (wanted.length >= 4 && wanted.includes(norm(c.name)) && norm(c.name).length >= 4));
}

function campaignsFrom(data: unknown): CampaignRef[] {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const raw = Array.isArray(data) ? data : Array.isArray(d.data) ? d.data : [];
  return (raw as Array<Record<string, unknown>>)
    .filter((c) => (typeof c.id === "string" || typeof c.id === "number") && typeof c.name === "string")
    .map((c) => ({ id: String(c.id), name: String(c.name), status: typeof c.status === "string" ? c.status : "unknown" }));
}

/**
 * Looks the name up among the user's campaigns. Returns undefined when the list
 * could not be loaded (the caller then falls back to its normal behaviour).
 */
export async function lookupCampaignByName(
  name: string,
  auth: AuthContext,
): Promise<{ matches: CampaignRef[]; all: CampaignRef[] } | undefined> {
  try {
    const result = await mcpClientService.dispatch("get_all_campaigns", {}, auth);
    const envelope = result.data as { success?: boolean; data?: unknown } | undefined;
    if (result.isToolError || envelope?.success === false) return undefined;
    const all = campaignsFrom(result.data);
    return { matches: matchCampaigns(name, all), all };
  } catch {
    return undefined;
  }
}

export type NamedCampaign =
  | { kind: "none" }
  | { kind: "one"; campaign: CampaignRef; name: string }
  | { kind: "many"; matches: CampaignRef[]; name: string }
  | { kind: "notFound"; all: CampaignRef[]; name: string };

/**
 * The campaign the user NAMED in this message. A name always wins over the
 * session's active campaign: "Proving AI Services pa kitne replies" after looking
 * at BM AI Services must not reuse BM AI Services. An explicit numeric id from
 * the LLM keeps the normal id path ("none").
 */
export async function resolveNamedCampaign(state: {
  llmExtractedArgs?: LLMIntentArguments | undefined;
  userMessage: string;
  rawToken?: string | undefined;
  userId?: unknown;
}): Promise<NamedCampaign> {
  const llmId = state.llmExtractedArgs?.campaignId;
  if (typeof llmId === "string" && /^\d+$/.test(llmId.trim())) return { kind: "none" };
  const name = campaignNameFrom(state.llmExtractedArgs, state.userMessage);
  const auth = authFromState(state);
  if (!name || !auth) return { kind: "none" };
  const found = await lookupCampaignByName(name, auth);
  if (!found) return { kind: "none" };
  if (found.matches.length === 1) return { kind: "one", campaign: found.matches[0]!, name };
  if (found.matches.length > 1) return { kind: "many", matches: found.matches, name };
  return { kind: "notFound", all: found.all, name };
}

/**
 * The campaigns that can be picked for an action, in display order. The numbered
 * list shown to the user and the reply "1" must use the SAME list — otherwise "1"
 * starts a different campaign than the one shown as 1.
 */
export function selectableCampaigns<T extends { status: string }>(list: T[], action: string | undefined): T[] {
  const status = (c: T) => c.status.toLowerCase();
  if (action === "start_campaign") return list.filter((c) => !["in_progress", "running", "completed"].includes(status(c)));
  if (action === "pause_campaign") return list.filter((c) => ["running", "in_progress"].includes(status(c)));
  if (action === "resume_campaign") return list.filter((c) => status(c) === "paused");
  return list;
}

/** Numbered list for a "which one?" reply; ids shown so duplicate names can be told apart. */
export function campaignChoiceList(campaigns: CampaignRef[]): string {
  return campaigns.map((c, i) => `${i + 1}. **${c.name}** (${c.status}) · #${c.id}`).join("\n");
}

export function authFromState(state: { rawToken?: string | undefined; userId?: unknown }): AuthContext | undefined {
  if (!state.rawToken) return undefined;
  return { userId: String(state.userId ?? "unknown") as AuthContext["userId"], rawToken: state.rawToken };
}
