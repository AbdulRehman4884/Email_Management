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
import { normalizeCommonTypos } from "./accountStats.js";

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
const NOT_A_NAME = /^(all|my|the|this|that|it|every|each|latest|last|recent|campaigns?|overall|account|mere|meri|mera|meray|is|us|iss|uss|sab|sare|saray|tamam|best|worst|top|newest|most recent|first|new|old|previous|current|active|running|paused|draft|completed|scheduled|sent|other|next)$/i;

/**
 * The campaign name the user gave, if any. Numeric ids return undefined (handled
 * by the normal id path).
 */
export function campaignNameFrom(extracted: LLMIntentArguments | undefined, message: string): string | undefined {
  message = normalizeCommonTypos(message);
  const fromLlm = typeof extracted?.campaignId === "string" ? extracted.campaignId.trim() : "";
  const explicitStatsName = message.match(/\b(?:stats?|statistics|analytics|report|performance)\s+(?:of|for|on)\s+(?:the\s+)?["']?(.+?)["']?\s*[?.!]*$/i)?.[1]?.trim();
  const llmReturnedOnlyPrefix = !!fromLlm && !!explicitStatsName &&
    explicitStatsName.length > fromLlm.length && norm(explicitStatsName).startsWith(norm(fromLlm));
  const candidates = [
    ...(llmReturnedOnlyPrefix ? [explicitStatsName] : []),
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
    // "tell me how my DRY RUN campaign did" — "my X campaign" (not "my campaigns")
    message.match(/\b(?:my|the)\s+["']?([^"'?.!,]+?)["']?\s+campaign\b(?!s)/i)?.[1],
    // "Summarize replies for DRY RUN", "replies of BM AI Services", "who replied to DRY RUN" — the name
    // was not read, so the WHOLE inbox was summarised as if it were that campaign (QA bug).
    message.match(/\b(?:repl(?:y|ies)|replied|responses?)\s+(?:for|of|to|from|on|in)\s+(?:the\s+)?["']?(.+?)["']?\s*[?.!]*$/i)?.[1],
    fromLlm,
  ];
  if (/\b(?:all\s+campaigns?|every\s+campaign|each\s+campaign|my\s+campaigns|mere\s+campaigns|meri\s+campaigns)\b/i.test(message)) return undefined;
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
    const allIsNamedCampaign = /^all$/i.test(v) && /\b(?:stats?|statistics|analytics|performance)\s+(?:for|of)\s+all\s*[?.!]*$/i.test(message);
    if (!v || v.length > 255 || /^#?\d+$/.test(v) || (NOT_A_NAME.test(v) && !allIsNamedCampaign) || !core || (NOT_A_NAME.test(core) && !allIsNamedCampaign) || startsWithPost) continue;
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

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Names one or two typos away ("dry rn" → "DRY RUN", "bm ai servces" → "BM AI Services"), closest
 * first. Used for "Did you mean …?" instead of the whole campaign list (QA P4 bug 4).
 */
export function closeCampaignMatches(name: string, campaigns: CampaignRef[]): CampaignRef[] {
  const wanted = norm(name);
  if (wanted.length < 3) return [];
  const allowed = Math.max(1, Math.floor(wanted.length / 4));
  const scored = campaigns
    .map((c) => ({ c, d: editDistance(wanted, norm(c.name)) }))
    .filter((x) => x.d <= allowed);
  const best = Math.min(...scored.map((x) => x.d));
  return scored.filter((x) => x.d === best).map((x) => x.c);
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

/** "which campaign has the best/most/lowest …", "the last / latest / most recent campaign", "campaign I created". */
const RANKING_OR_NEWEST =
  /\b(best|highest|top|most|worst|lowest|least|fewest)\b[^.?!]*\b(open|repl|click|bounce|sent|perform|rate)|\b(last|latest|most\s+recent|newest)\b[^.?!]{0,20}\bcampaign\b|\bcampaign\b[^.?!]{0,15}\b(i|we)\s+(just\s+)?(created|made)\b/i;

/**
 * The one campaign whose full name (4+ characters, whole words) appears in the message. Several different
 * campaigns, or a name shared by two campaigns, is "not sure" (undefined).
 */
export function mentionedCampaign(message: string, all: CampaignRef[]): CampaignRef | undefined {
  const text = ` ${norm(message)} `;
  const hits = all.filter((c) => {
    const n = norm(c.name);
    if (n.length < 4) return false;
    const re = new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^a-z0-9]|$)`, "i");
    return re.test(text);
  });
  const names = new Set(hits.map((c) => norm(c.name)));
  if (hits.length === 0 || names.size > 1) return undefined;
  const sameName = all.filter((c) => norm(c.name) === norm(hits[0]!.name));
  return sameName.length === 1 ? hits[0] : undefined;
}

export type NamedCampaign =
  | { kind: "none" }
  | { kind: "one"; campaign: CampaignRef; name: string }
  | { kind: "many"; matches: CampaignRef[]; name: string }
  | { kind: "notFound"; all: CampaignRef[]; name: string; close: CampaignRef[] };

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
  const auth = authFromState(state);
  // "Show stats for Campaign 3": a campaign NAMED "Campaign 3" (the 3 was read as id 3 and the name dropped).
  // A real id still wins: "campaign 431" stays the id when the user has a campaign #431.
  const numbered = state.userMessage.match(new RegExp(`\\b(${CAMPAIGN_WORD}\\s+#?(\\d{1,9}))\\b`, "i"));
  if (numbered && auth && !/\bid\b|#/i.test(numbered[1]!)) {
    const found = await lookupCampaignByName(numbered[1]!, auth);
    const exact = found?.matches.filter((c) => norm(c.name) === norm(numbered[1]!)) ?? [];
    if (found && exact.length === 1 && !found.all.some((c) => c.id === numbered[2])) {
      return { kind: "one", campaign: exact[0]!, name: exact[0]!.name };
    }
  }
  const llmId = state.llmExtractedArgs?.campaignId;
  if (typeof llmId === "string" && /^\d+$/.test(llmId.trim())) return { kind: "none" };
  // Ranking / "last campaign I created" questions name no campaign ("has the best open rate", "I created").
  if (RANKING_OR_NEWEST.test(state.userMessage)) return { kind: "none" };
  const name = campaignNameFrom(state.llmExtractedArgs, state.userMessage);
  // "DRY RUN stats please", "What is the open rate of DRY RUN?", "Can you show me DRY RUN numbers?": no pattern
  // named it, but the full name of ONE campaign is in the sentence (QA P3-2 bugs 22 / 26).
  if (!name && auth) {
    const found = await lookupCampaignByName("@@none@@", auth);
    const hit = found ? mentionedCampaign(state.userMessage, found.all) : undefined;
    if (hit) return { kind: "one", campaign: hit, name: hit.name };
    return { kind: "none" };
  }
  if (!name || !auth) return { kind: "none" };
  const found = await lookupCampaignByName(name, auth);
  if (!found) return { kind: "none" };
  if (found.matches.length === 1) return { kind: "one", campaign: found.matches[0]!, name };
  if (found.matches.length > 1) return { kind: "many", matches: found.matches, name };
  // The pattern read some other words as the name ("…how my DRY RUN campaign did?" → "did"): a campaign whose
  // full name is in the sentence still wins over a "not found" list (QA P3-2 bug 26).
  const mentioned = mentionedCampaign(state.userMessage, found.all);
  if (mentioned) return { kind: "one", campaign: mentioned, name: mentioned.name };
  return { kind: "notFound", all: found.all, name, close: closeCampaignMatches(name, found.all) };
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

/**
 * Normalises a campaign name or user reply for comparison: lowercased,
 * whitespace collapsed, and surrounding quotes / markdown / punctuation removed
 * so `**"Summer Sale"**` and `summer sale` compare equal.
 */
function normaliseSelectionText(text: string): string {
  return text
    .trim()
    .replace(/^[\s"'`*_]+/, "")
    .replace(/[\s"'`*_.!?,]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Shortest campaign name that may be matched as a *substring* of a longer
 * message. Names below this length (e.g. "n", "ok", "tf", "AR") are matched
 * by exact reply only.
 *
 * Without this guard a campaign literally named "n" matched the message
 * "show all campaigns" — "campaig(n)s" contains an "n" — so re-running a plain
 * list command silently selected that campaign instead of showing the list.
 */
const MIN_FUZZY_NAME_LENGTH = 4;

/** True when `needle` appears in `haystack` as a whole word/phrase, not mid-word. */
function containsWholePhrase(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * The campaign a reply picks from a list shown to the user: "3" (position), "#17" / "id 17",
 * the exact name, the start of a name ("eid" → "Eid Offer") or — unless `strict` — a long
 * name inside a sentence ("start the Summer Sale one").
 * `strict` is used to tell a pick from a NEW question asked while a list is open (bugs A-05, A-19).
 */
export function matchCampaignSelection<T extends CampaignRef>(
  userMessage: string,
  list: T[],
  opts: { strict?: boolean } = {},
): T | undefined {
  if (list.length === 0) return undefined;

  const trimmed = userMessage.trim();

  // 1. Positional selection — "3"
  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    if (num >= 1 && num <= list.length) return list[num - 1];
  }

  // "id 17" / "#17" / "campaign id 17" — the campaign id, not the list position.
  const byId = trimmed.match(/(?:#|\bid\s*[:#]?\s*)(\d+)\b/i)?.[1];
  if (byId) return list.find((c) => c.id === byId);

  const msg = normaliseSelectionText(trimmed);
  if (msg === "") return undefined;

  // 2. Exact name reply — always honoured, however short the name is.
  const exact = list.find((c) => normaliseSelectionText(c.name) === msg);
  if (exact) return exact;

  // 3. Fuzzy match — only for names long enough to be unambiguous, and only
  //    on whole-word boundaries, so an incidental letter never selects.
  return list.find((c) => {
    const name = normaliseSelectionText(c.name);
    if (name.length < MIN_FUZZY_NAME_LENGTH) return false;

    // The whole reply is a prefix of the name ("eid" → "Eid Offer").
    // Safe even for a short reply: the *entire* message has to be the prefix,
    // so a full sentence can never land here.
    if (name.startsWith(msg)) return true;

    // The full name appears as a whole phrase inside a longer sentence.
    return !opts.strict && containsWholePhrase(msg, name);
  });
}

/** General intents that are real questions with their own answer (not a reply to a list or menu). */
const ANSWERABLE_GENERAL_INTENTS = new Set(["recipient_status_help"]);

export function isAnswerableGeneralIntent(intent: string | undefined): boolean {
  return intent !== undefined && ANSWERABLE_GENERAL_INTENTS.has(intent);
}

/**
 * True when the message is a NEW request rather than an answer to the campaign list on
 * screen ("How many draft campaigns do I have?" while "which ok campaign?" is open).
 * The open list must then be dropped, or it swallows this and every later question
 * (bugs A-05, A-19). A pick ("2", "#431", the exact name) or a reply with no clear
 * intent of its own keeps the list; so does the same action again ("pause Summer Sale"
 * while the pause list is open), which the selection step matches by name.
 */
export function isNewRequestDuringSelection(state: {
  userMessage: string;
  intent?: string | undefined;
  domain?: string | undefined;
  pendingCampaignAction?: string | undefined;
  campaignSelectionList?: CampaignRef[] | undefined;
}): boolean {
  const list = state.campaignSelectionList ?? [];
  if (!state.pendingCampaignAction && list.length === 0) return false;
  if (list.length && matchCampaignSelection(state.userMessage, list, { strict: true })) return false;
  // "show stats for the second one" points INTO the list (QA P3 bug 57) — keep it.
  if (ordinalPick(state.userMessage, list)) return false;
  // "cancel" / "stop" is the answer to the list (the selection step cancels it), whatever intent it got.
  if (/^\s*(no|cancel|stop|abort|never\s*mind|forget it|discard)\b[\s.!]*$/i.test(state.userMessage)) return false;
  if (state.intent && state.intent === state.pendingCampaignAction) return false;
  const concrete =
    (state.domain !== undefined && state.domain !== "general") ||
    (state.intent !== undefined && ANSWERABLE_GENERAL_INTENTS.has(state.intent));
  return concrete;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1,
  pehla: 1, pehli: 1, pehle: 1, doosra: 2, doosri: 2, doosre: 2, dusra: 2, dusri: 2, teesra: 3, teesri: 3, teesre: 3, aakhri: -1, akhri: -1,
};

/**
 * "show stats for the second one", "open the first one", "pause the 3rd one", "number 2 in the list",
 * "doosri wali" → that item of the list the user was just shown (QA P3 bug 57: it was read as a
 * campaign NAMED "second one" and a new, differently numbered list was posted).
 */
export function ordinalPick<T>(message: string, list: readonly T[] | undefined): T | undefined {
  if (!list?.length) return undefined;
  const m = message.toLowerCase();
  const word = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|pehl[aie]|doosr[aie]|dusr[ai]|teesr[aie]|aakhri|akhri)\s+(?:one|item|campaign\s+(?:in|from|on)\s+the\s+list|wal[aie])\b/.exec(m);
  const num = /\b(\d{1,3})(?:st|nd|rd|th)\s+(?:one|item)\b|\b(?:number|no\.?|#)\s*(\d{1,3})\s+(?:in|from|on)\s+(?:the|that|this)\s+list\b/.exec(m);
  const n = word ? ORDINAL_WORDS[word[1]!] : num ? Number(num[1] ?? num[2]) : undefined;
  if (n === undefined) return undefined;
  return n === -1 ? list[list.length - 1] : n >= 1 && n <= list.length ? list[n - 1] : undefined;
}

/** A campaign id the backend can hold: a positive whole number within a 32-bit integer. */
export function isValidCampaignId(id: unknown): boolean {
  const s = String(id ?? "").trim();
  return /^[1-9]\d{0,9}$/.test(s) && Number(s) <= 2_147_483_647;
}

/**
 * "Show stats for campaign 0", "campaign id 99999999999999999999", "campaign -5", "campaign 4.34": an id that
 * can never exist. Returns it as typed, so every such case gets the same "I couldn't find campaign …" answer
 * (QA: 0 → "Something went wrong: Invalid campaign id", the long one → "Failed to retrieve campaign stats",
 * minus / decimal → the whole campaign list).
 */
export function impossibleCampaignIdIn(message: string): string | undefined {
  const m = message.match(/\bcampaign\s+(?:id\s*[:#]?\s*)?#?(-?\d+(?:[.,]\d+)?)\b|#(-?\d+(?:[.,]\d+)?)\b|\bid\s*[:#]?\s*(-?\d+(?:[.,]\d+)?)\b/i);
  const raw = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  return raw !== undefined && !isValidCampaignId(raw) ? raw : undefined;
}

export function campaignNotFoundMessage(id: string): string {
  return `I couldn't find campaign **#${id}** in your account. Campaign ids are whole numbers like 434. Say **list my campaigns** to see your campaigns.`;
}

/** Numbered list for a "which one?" reply; ids shown so duplicate names can be told apart. */
export function campaignChoiceList(campaigns: CampaignRef[]): string {
  return campaigns.map((c, i) => `${i + 1}. **${c.name}** (${c.status}) · #${c.id}`).join("\n");
}

export function authFromState(state: { rawToken?: string | undefined; userId?: unknown }): AuthContext | undefined {
  if (!state.rawToken) return undefined;
  return { userId: String(state.userId ?? "unknown") as AuthContext["userId"], rawToken: state.rawToken };
}
