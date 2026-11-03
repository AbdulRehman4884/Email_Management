/**
 * src/lib/leadgenArgs.ts
 *
 * Lead finder (Lead Engine) intents and tool arguments.
 *
 *   detectLeadGenIntent()   strict message shapes ("Lahore ke dental clinics dhundo", "mere schedules dikhao",
 *                           "hot leads CRM mein daal do"). Used before bulk / enrichment overrides and when the
 *                           LLM picked another domain, so lead-finder requests are never swallowed by other flows.
 *   parseLeadGenMessage()   category, city, time, frequency ... from the message (English + Roman Urdu),
 *                           used when OpenAI is off or did not extract them.
 *   buildLeadGenToolArgs()  LLM args first, then the message. Only keys the MCP schemas know (they are .strict()).
 *
 * Category words are passed as typed ("dental clinics"); the backend maps them to its category list.
 * The classifyIntent call already extracts the args — no extra OpenAI call.
 */

import type { Intent } from "../config/intents.js";
import type { LLMIntentArguments } from "../schemas/llmIntent.schema.js";
import { LEADS_PRONOUN, SEARCH_PRONOUN, type LeadGenContext } from "./leadgenContext.js";

export const LEADGEN_INTENTS = [
  "generate_leads",
  "run_lead_search",
  "schedule_lead_search",
  "list_lead_schedules",
  "pause_lead_schedule",
  "show_new_leads",
  "save_leads_to_crm",
  "add_leads_to_campaign",
  "lead_run_status",
] as const satisfies readonly Intent[];
export type LeadGenIntent = (typeof LEADGEN_INTENTS)[number];

export const LEADGEN_TOOL_NAMES = [
  "create_saved_search",
  "run_saved_search",
  "create_search_schedule",
  "list_search_schedules",
  "update_search_schedule",
  "get_lead_run",
  "list_workspace_leads",
  "save_leads_to_crm",
  "add_leads_to_campaign",
] as const;
export type LeadGenToolName = (typeof LEADGEN_TOOL_NAMES)[number];

/** Tools that change something: never planned, always through LeadGenAgent. */
export const LEADGEN_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_saved_search", "run_saved_search", "create_search_schedule", "update_search_schedule", "save_leads_to_crm", "add_leads_to_campaign",
]);

export function isLeadGenIntent(intent: string | undefined): intent is LeadGenIntent {
  return intent !== undefined && (LEADGEN_INTENTS as readonly string[]).includes(intent);
}

export function isLeadGenTool(name: string | undefined): name is LeadGenToolName {
  return name !== undefined && (LEADGEN_TOOL_NAMES as readonly string[]).includes(name);
}

// ── Message shapes ───────────────────────────────────────────────────────────

const norm = (m: string) => m.toLowerCase().replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();

const FIND_VERB = /\b(find|search\s+for|search|look\s+for|look\s+up|get\s+me|generate|scrape|collect|discover|dhund\w*|dhoond\w*|dhoon\w*|talash\w*|nikal\w*|chahiye|chahiyen|chahye)\b/;
const BUSINESS_NOUN =
  /\b(leads?|businesses|business|compan(y|ies)|clinics?|shops?|stores?|agenc(y|ies)|firms?|houses|offices|restaurants?|hotels?|schools?|dentists?|doctors?|lawyers?|realtors?|salons?|gyms?|hospitals?|pharmac(y|ies)|dealers?|builders?|manufacturers?|contractors?|accountants?|architects?|cafes?|bakeries|bakery|institutes?|academ(y|ies))\b/;
/** "in Lahore" (not "in CRM", "in campaign ...") or "Lahore ke/ki/mein". */
const PLACE = /\bin\s+(?!crm\b|the\s+crm\b|campaign\b|my\b|our\b|bulk\b|inbox\b)[a-z]{3,}|\b[a-z]{3,}\s+(ke|ki|ka|mein|me|main)\s+\S/;
const OTHER_DOMAIN = /\b(crm|pipeline|stage|tag|inbox|repl(y|ies)|campaigns?|smtp|follow[\s-]?ups?|recipients?|templates?|https?:\/\/)\b/;

/** Question words (English + Roman Urdu): a question only reads, it never saves or adds. */
const QUESTION = /\?|\b(konsi|konse|kaunsi|kaunse|kon\s+si|kitni|kitne|kya|kia|which|what|how\s+many|show|dikhao|dikha|list|batao|btao)\b/;

const SCHEDULE_WORD = /\b(schedules?|schedule\w*|lead\s+searches|saved\s+searches|lead\s+search|searches)\b/;
const FREQUENCY = /\b(daily|every\s*day|everyday|each\s+day|roz|rozana|har\s+roz|har\s+din|weekly|every\s+week|har\s+hafte|every\s+(mon|tues|wednes|thurs|fri|satur|sun)day|weekdays)\b/;
const TIME = /\b\d{1,2}(:\d{2})?\s*(am|pm|baje|bje)\b|\bat\s+\d{1,2}(:\d{2})?\b|\b\d{1,2}:\d{2}\b/;
const RUN_VERB = /\b(run|chala\w*|chal\w*|schedule|set|kar\s*do|karo|start)\b/;

/**
 * A lead-finder request by its shape, or undefined. Strict on purpose: a miss falls back to the LLM / keyword
 * rules, a wrong hit would take the message away from another flow.
 */
export function detectLeadGenIntent(message: string, ctx?: LeadGenContext): LeadGenIntent | undefined {
  const m = norm(message);
  if (!m) return undefined;
  const leadsWord = /\bleads?\b/.test(m);

  // A question about the CRM ("CRM ma konsi new leads add hui han?") is never a write: it lists the lead finder
  // leads that were saved to the CRM.
  if (leadsWord && /\bcrm\b/.test(m) && QUESTION.test(m)) return "show_new_leads";

  // With memory: "inhein campaign 22 mein daal do" / "inko CRM mein daal do" = the lead finder leads shown last.
  if (ctx?.lastLeads && LEADS_PRONOUN.test(m) && !/\b(stage|pipeline|tag|won|lost)\b/.test(m)) {
    if (/\bcrm\b/.test(m) && /\b(daal|dal|daalo|dalo|save|add|bhej\w*|put|move)\b/.test(m)) return "save_leads_to_crm";
    if (/\bcampaign\b/.test(m) && /\b(daal|dal|daalo|dalo|add|include|put)\b/.test(m)) return "add_leads_to_campaign";
  }
  // "run it now", "isay abhi chalao", "run the Lahore search now"
  if (/\b(now|abhi|right away|dobara)\b/.test(m) && /\b(run|chala\w*|search\s+again|start)\b/.test(m) && !/\b(campaign|email|follow[\s-]?ups?)\b/.test(m)
      && (SEARCH_PRONOUN.test(m) || /\bsearch\b/.test(m)) && !FREQUENCY.test(m)) {
    return "run_lead_search";
  }

  // "hot leads CRM mein daal do", "save today's leads to the CRM"
  if (leadsWord && /\bcrm\b/.test(m) && /\b(daal|dal|daalo|dalo|save|add|bhej\w*|import|move|put|transfer)\b/.test(m) && !/\b(stage|pipeline|tag)\b/.test(m)) {
    return "save_leads_to_crm";
  }
  // "add these leads to campaign 22", "leads ko campaign 22 mein daal do"
  if (leadsWord && /\bcampaign\b/.test(m) && /\b(add|daal|dal|daalo|dalo|include|put)\b/.test(m) && !/\bcrm\b/.test(m)) {
    return "add_leads_to_campaign";
  }
  // "aaj kitni nayi leads aayi?", "show today's new leads", "lead finder results"
  if (
    (/\b(nayi|naye|nai|new|fresh)\s+leads?\b/.test(m) && /\b(aaj|today|aayi|aaye|ayi|mili|mile|found|kitni|kitne|dikhao|show|list|how\s+many)\b/.test(m)) ||
    /\blead\s+finder\s+(leads|results)\b/.test(m) || /\bleads?\s+(found|mili|aayi)\s+(today|aaj)\b/.test(m)
  ) {
    return /\b(crm|campaign)\b/.test(m) ? undefined : "show_new_leads";
  }
  // "lead search status", "scraping kahan tak pohanchi"
  if (/\b(lead\s+(search|run|finder)|scraping|scrape|search\s+run)\b/.test(m) && /\b(status|progress|kahan\s+tak|kya\s+hua|done|finished|khatam)\b/.test(m)) {
    return "lead_run_status";
  }
  const scheduleTalk = SCHEDULE_WORD.test(m) && !/\b(campaign|follow[\s-]?ups?|email|send)\b/.test(m);
  // "Lahore wala schedule band kar do", "pause the dentist search"
  if (scheduleTalk && /\b(band|pause|stop|roko|rok\s+do|resume|chalu|phir\s+se|dobara|unpause|turn\s+off|turn\s+on|off|on\s+kar)\b/.test(m)) {
    return "pause_lead_schedule";
  }
  // "mere schedules dikhao", "show my lead searches"
  if (scheduleTalk && /\b(dikhao|dikha|show|list|mere|meri|my|all|kaun\s+kaun|which)\b/.test(m) && !FREQUENCY.test(m)) {
    return "list_lead_schedules";
  }
  const finding = FIND_VERB.test(m) && BUSINESS_NOUN.test(m) && PLACE.test(m) && !OTHER_DOMAIN.test(m);
  if (finding) return "generate_leads";
  // The "Find new leads" chip (and its typed forms): the agent then asks for the category and the city.
  if (/^(please\s+)?(find|generate|get)\s+(me\s+)?(new\s+)?leads(\s+for\s+me)?$|^lead\s+generation$|^leads?\s+(dhundo|dhoondo|nikalo)$/.test(m)) return "generate_leads";
  // "isay roz subah 9 baje chalao", "run the Lahore search daily at 9"
  if (FREQUENCY.test(m) && TIME.test(m) && RUN_VERB.test(m) && !/\b(campaign|email|follow[\s-]?ups?|send)\b/.test(m)) {
    return "schedule_lead_search";
  }
  return undefined;
}

// ── Message parsing ──────────────────────────────────────────────────────────

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Tier = "hot" | "warm" | "cold";

export interface ParsedLeadGenMessage {
  /** Optional questions already asked in this conversation (never asked twice): "focus" | "perRun" | "schedule". */
  asked?: string[];
  /** The user chose "run once now" instead of a schedule. */
  runNow?: boolean;
  category?: string;
  /** What the companies do within the category ("AI automation"). */
  focus?: string;
  city?: string;
  countryCode?: string;
  includePeople?: boolean;
  targetPerRun?: number;
  runAtLocal?: string;
  frequency?: "daily" | "weekly";
  weekdays?: Weekday[];
  tiers?: Tier[];
  foundToday?: boolean;
  /** Only leads already saved to the CRM ("CRM mein konsi leads add hui"). */
  inCrm?: boolean;
  isPaused?: boolean;
  campaign?: string;
  /** Saved search the user refers to ("Lahore wala" -> "Lahore"). */
  search?: string;
}

const COUNTRIES: Record<string, string> = {
  pakistan: "PK", uae: "AE", "united arab emirates": "AE", dubai: "AE", india: "IN", "saudi arabia": "SA", ksa: "SA",
  qatar: "QA", oman: "OM", bahrain: "BH", kuwait: "KW", uk: "GB", "united kingdom": "GB", england: "GB",
  usa: "US", us: "US", "united states": "US", america: "US", canada: "CA", australia: "AU", germany: "DE", turkey: "TR",
};

/** Words that end a city name ("in Lahore daily at 9" -> "Lahore"). */
const CITY_STOP = /\s+(daily|every|each|at|with|and|for|owners?|ceo|founders?|roz|har|weekly|subah|shaam|raat|bhi|ke|ki|ka|mein|me|main|\d).*$/i;

const WEEKDAY_WORDS: Array<[RegExp, Weekday]> = [
  [/\b(mon(day)?s?|somwar|peer|pir)\b/, "mon"],
  [/\b(tue(s(day)?)?s?|mangal)\b/, "tue"],
  [/\b(wed(nesday)?s?|budh)\b/, "wed"],
  [/\b(thu(rs(day)?)?s?|jumerat|jumeraat)\b/, "thu"],
  [/\b(fri(day)?s?|juma|jumma)\b/, "fri"],
  [/\b(sat(urday)?s?|hafta|haftay)\b/, "sat"],
  [/\b(sun(day)?s?|itwar|itwaar)\b/, "sun"],
];

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function cleanPhrase(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const out = s
    .replace(/\b(me|mujhe|kuch|some|all|the|any|leads?\s+(for|of)|leads?|list\s+of|\d+)\b/gi, " ")
    .replace(/[,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out.length >= 3 && out.length <= 100 ? out : undefined;
}

function parseTime(m: string): string | undefined {
  const hit = m.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|bje)?\b/g);
  if (!hit) return undefined;
  for (const raw of hit) {
    const p = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|bje)?/);
    if (!p) continue;
    const hasMarker = !!p[2] || !!p[3] || /^at\s/.test(raw);
    if (!hasMarker) continue;
    let h = Number(p[1]);
    const min = Number(p[2] ?? 0);
    if (h > 23 || min > 59) continue;
    const afternoon = p[3] === "pm" || ((p[3] === "baje" || p[3] === "bje") && /\b(shaam|sham|raat|dopahar|dopehar)\b/.test(m));
    if (afternoon && h < 12) h += 12;
    if (p[3] === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return undefined;
}

export function parseLeadGenMessage(message: string): ParsedLeadGenMessage {
  const m = norm(message);
  const out: ParsedLeadGenMessage = {};

  // "find dentists in Lahore, Pakistan daily at 9"
  const en = message.match(
    /\b(?:find|search(?:\s+for)?|look\s+for|get(?:\s+me)?|generate(?:\s+leads\s+for)?|scrape|collect|discover|list)\s+(?:me\s+)?(.+?)\s+in\s+([A-Za-z][A-Za-z .'-]*?)(?:\s*,\s*([A-Za-z ]+?))?(?=$|[.!?]|\s*,|\s+(?:daily|every|each|at|with|and|owners?|ceo|roz|har|weekly|\d))/i,
  );
  // "Lahore ke dental clinics dhundo", "Karachi mein software houses chahiye"
  const ur = message.match(
    /^(?:mujhe\s+)?([A-Za-z][A-Za-z .'-]*?)\s+(?:ke|ki|ka|mein|me|main)\s+(.+?)\s+(?:dhund\w*|dhoond\w*|dhoon\w*|talash\w*|nikal\w*|chahiye\w*|chahye|find\w*)\b/i,
  );
  if (en) {
    out.category = cleanPhrase(en[1]);
    out.city = titleCase(en[2]!.replace(CITY_STOP, "").trim());
    const country = en[3]?.trim().toLowerCase();
    if (country && COUNTRIES[country]) out.countryCode = COUNTRIES[country];
  } else if (ur) {
    out.city = titleCase(ur[1]!.replace(CITY_STOP, "").trim());
    out.category = cleanPhrase(ur[2]!.replace(/,.*$/, ""));
  }
  if (out.city && COUNTRIES[out.city.toLowerCase()] && out.city.toLowerCase() !== "dubai") {
    // "in Pakistan": a whole country — the agent asks for a city (use case UC-01).
    out.countryCode = COUNTRIES[out.city.toLowerCase()];
    delete out.city;
  }
  if (out.city?.toLowerCase() === "dubai") out.countryCode = "AE";
  if (!out.countryCode) {
    for (const [name, code] of Object.entries(COUNTRIES)) {
      if (name.length > 3 && new RegExp(`\\b${name}\\b`).test(m)) {
        out.countryCode = code;
        break;
      }
    }
  }

  // "IT companies working on AI automation in Lahore": the category phrase keeps everything; the backend splits it.
  // An explicit "focus: X" / "focus on X" is taken as the focus.
  const focus = message.match(/\bfocus(?:ed|ing)?\s*(?:on|:)\s*([^,.;]{2,80}?)(?=$|[,.;]|\s+(?:in|daily|every|at)\b)/i);
  if (focus) out.focus = focus[1]!.trim();
  // Roman Urdu: "IT companies ki jo app development pa kam krti hon" -> focus "app development".
  const urduFocus = message.match(/\bjo\s+(.{2,60}?)\s+(?:pa|par|pe|per|mein|me|main)\s+(?:kam|kaam)\s+(?:kr|kar)\w*/i);
  if (urduFocus && !out.focus) out.focus = urduFocus[1]!.trim();

  if (/\b(owners?|ceos?|founders?|decision\s+makers?|directors?|managing\s+directors?|malik|people\s+too|log\s+bhi)\b/.test(m)) out.includePeople = true;

  // "20 leads", "find 30 real estate agencies" (a few words between the number and the noun).
  const count = m.match(/\b(\d{1,3})\s+(?:[a-z]+\s+){0,3}?(leads?|businesses|compan(?:y|ies)|clinics?|results|records|agencies|shops|stores|firms|houses|dentists|doctors|restaurants|hotels|schools|salons|gyms)\b/);
  if (count) out.targetPerRun = Math.min(100, Math.max(1, Number(count[1])));

  const time = parseTime(m);
  if (time && (FREQUENCY.test(m) || TIME.test(m))) out.runAtLocal = time;

  const days = WEEKDAY_WORDS.filter(([re]) => re.test(m)).map(([, d]) => d);
  if (/\bweekdays\b/.test(m)) out.weekdays = ["mon", "tue", "wed", "thu", "fri"];
  else if (days.length && /\b(every|har|on|ko)\b/.test(m)) out.weekdays = days;
  if (out.weekdays || /\b(weekly|every\s+week|har\s+hafte)\b/.test(m)) out.frequency = "weekly";
  else if (/\b(daily|every\s*day|everyday|each\s+day|roz|rozana|har\s+roz|har\s+din)\b/.test(m)) out.frequency = "daily";

  const tiers = (["hot", "warm", "cold"] as const).filter((t) => new RegExp(`\\b${t}\\b`).test(m));
  if (tiers.length) out.tiers = [...tiers];
  if (/\b(today|aaj|today's)\b/.test(m)) out.foundToday = true;
  if (/\bcrm\b/.test(m) && QUESTION.test(m)) out.inCrm = true;

  if (/\b(resume|unpause|chalu|phir\s+se|dobara\s+(shuru|chala)|turn\s+on|on\s+kar)\b/.test(m)) out.isPaused = false;
  else if (/\b(band|pause|stop|roko|rok\s+do|turn\s+off|off\s+kar)\b/.test(m)) out.isPaused = true;

  const campaign =
    m.match(/\bcampaign\s+(?:#|no\.?\s*)?(\d+)\b/) ??
    message.match(/\bcampaign\s+["“']([^"”']{2,80})["”']/i) ??
    message.match(/\b(?:to|into|in)\s+(?:the\s+)?([A-Za-z0-9][\w .&-]{1,60}?)\s+campaign\b/i);
  if (campaign) out.campaign = campaign[1]!.trim();

  // "Lahore wala schedule", "the dentist search", "Karachi real estate schedule"
  const ref =
    message.match(/\b([A-Za-z][\w .&-]{1,60}?)\s+(?:wala|wali|wale)\b/i) ??
    message.match(/\b(?:the|my)\s+([A-Za-z][\w .&-]{1,60}?)\s+(?:search|schedule)\b/i) ??
    message.match(/\b(?:search|schedule)\s+(?:for\s+)?["“']([^"”']{2,80})["”']/i);
  if (ref) {
    const r = ref[1]!.replace(/^(?:mere|meri|my|the|isay|is|us|ye|yeh)\s+/i, "").trim();
    if (r.length >= 2 && !/^(lead|leads|my|the|this|that|it|isay|is)$/i.test(r)) out.search = r;
  }
  return out;
}

// ── Tool arguments ───────────────────────────────────────────────────────────

export interface LeadGenArgInput {
  extractedArgs: LLMIntentArguments | undefined;
  userMessage?: string;
}

type Obj = Record<string, unknown>;

const str = (v: unknown, max = 120): string | undefined =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const timeOf = (v: unknown): string | undefined => {
  const s = str(v, 10);
  const m = s?.match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1]!.padStart(2, "0")}:${m[2]}` : undefined;
};
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const weekdaysOf = (v: unknown): Weekday[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const days = v.map((d) => (typeof d === "string" ? d.toLowerCase().slice(0, 3) : "")).filter((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d));
  return days.length ? [...new Set(days)] : undefined;
};
const tiersOf = (v: unknown): Tier[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const t = v.filter((x): x is Tier => x === "hot" || x === "warm" || x === "cold");
  return t.length ? [...new Set(t)] : undefined;
};

/** Drops undefined values: the MCP schemas are strict and some fields must be absent, not undefined. */
function compact(o: Obj): Obj {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** The values the LLM put at the top level or inside `filters`. */
function llmValues(x: LLMIntentArguments | undefined): ParsedLeadGenMessage {
  const f = (x?.filters ?? {}) as Obj;
  const pick = <T>(key: string, conv: (v: unknown) => T | undefined): T | undefined =>
    conv((x as Obj | undefined)?.[key]) ?? conv(f[key]);
  const country = pick("country", (v) => str(v, 60)) ?? pick("countryCode", (v) => str(v, 2));
  const freq = pick("frequency", (v) => (v === "daily" || v === "weekly" ? v : undefined));
  const limit = x?.limit ?? (typeof f.limit === "number" ? f.limit : undefined);
  return {
    category: pick("category", (v) => str(v, 100)),
    focus: pick("focus", (v) => str(v, 300)),
    city: pick("city", (v) => str(v, 120)),
    countryCode: country ? (country.length === 2 ? country.toUpperCase() : COUNTRIES[country.toLowerCase()]) : undefined,
    includePeople: pick("includePeople", bool),
    targetPerRun: typeof limit === "number" && limit >= 1 ? Math.min(100, Math.floor(limit)) : undefined,
    runAtLocal: pick("runAt", timeOf) ?? pick("runAtLocal", timeOf),
    frequency: freq,
    weekdays: pick("weekdays", weekdaysOf),
    tiers: pick("tiers", tiersOf) ?? pick("scoreTiers", tiersOf),
    foundToday: pick("foundToday", bool),
    isPaused: pick("paused", bool) ?? pick("isPaused", bool),
    campaign: str(x?.campaignId, 255) ?? pick("campaign", (v) => str(v, 255) ?? (typeof v === "number" ? String(v) : undefined)),
    search: str(x?.query, 120) ?? pick("search", (v) => str(v, 120)),
  };
}

/** LLM values win; the message fills the gaps. */
export function readLeadGenRequest(input: LeadGenArgInput): ParsedLeadGenMessage {
  const llm = llmValues(input.extractedArgs);
  const msg = input.userMessage ? parseLeadGenMessage(input.userMessage) : {};
  const merged: ParsedLeadGenMessage = { ...msg };
  for (const [k, v] of Object.entries(llm)) if (v !== undefined) (merged as Obj)[k] = v;
  return merged;
}

const searchRef = (r: ParsedLeadGenMessage) => r.search ?? r.city;

/** Arguments for one lead-finder tool. Keys the tool does not accept are never added. */
export function buildLeadGenToolArgs(toolName: LeadGenToolName, input: LeadGenArgInput): Obj {
  return argsFromRequest(toolName, readLeadGenRequest(input));
}

/** Tool arguments from an already merged request (also used to continue a request after a question). */
export function argsFromRequest(toolName: LeadGenToolName, r: ParsedLeadGenMessage): Obj {
  const filters = { tiers: r.tiers, foundToday: r.foundToday };
  switch (toolName) {
    case "create_saved_search":
      return compact({
        category: r.category,
        focus: r.focus,
        city: r.city,
        countryCode: r.countryCode,
        includePeople: r.includePeople ?? false,
        targetPerRun: r.targetPerRun ?? 20,
        // A time means "schedule it" (approval first); otherwise start right away.
        runNow: !r.runAtLocal,
      });
    case "run_saved_search":
      return compact({ search: r.search });
    case "create_search_schedule":
      return compact({
        search: searchRef(r),
        runAtLocal: r.runAtLocal,
        frequency: r.frequency ?? (r.weekdays ? "weekly" : "daily"),
        weekdays: r.weekdays,
      });
    case "list_search_schedules":
      return {};
    case "update_search_schedule":
      return compact({
        search: searchRef(r),
        isPaused: r.isPaused ?? (r.runAtLocal ? undefined : true),
        runAtLocal: r.runAtLocal,
        frequency: r.weekdays ? "weekly" : undefined,
        weekdays: r.weekdays,
      });
    case "get_lead_run":
      return compact({ search: r.search });
    case "list_workspace_leads":
      if (r.inCrm) return compact({ search: r.search, tiers: r.tiers, foundToday: r.foundToday, statuses: ["saved_to_crm", "in_campaign"], limit: 50 });
      return compact({ search: r.search, ...filters, foundToday: r.foundToday ?? true, limit: Math.min(50, r.targetPerRun ?? 10) });
    case "save_leads_to_crm": {
      const f = compact({ search: r.search, ...filters });
      return Object.keys(f).length ? f : { foundToday: true };
    }
    case "add_leads_to_campaign": {
      const f = compact({ search: r.search, ...filters });
      return compact({ campaign: r.campaign, ...(Object.keys(f).length ? f : { foundToday: true }) });
    }
  }
}

/** A question when something the tool needs is missing (asked before any tool runs). */
export function missingLeadGenInfo(toolName: LeadGenToolName, args: Obj): string | undefined {
  return missingLeadGenField(toolName, args)?.question;
}

export type MissingField = "category" | "city" | "time" | "search" | "campaign" | "focus" | "perRun" | "schedule";

/**
 * The optional details of a new lead search, asked one by one after category and city:
 * focus (what they do), leads per run, schedule. Skipped when the message already said it or it was asked once.
 */
export function missingLeadSearchDetail(r: ParsedLeadGenMessage): { field: MissingField; question: string } | undefined {
  const asked = r.asked ?? [];
  if (!r.focus && !asked.includes("focus")) {
    return {
      field: "focus",
      question: `What should these **${r.category ?? "businesses"}** be working on? For example **app development**, **AI automation** or **e-commerce**. (Say **skip** for all of them.)`,
    };
  }
  if (r.targetPerRun === undefined && !asked.includes("perRun")) {
    return { field: "perRun", question: "How many new leads per run? **1-100** (default **20**, say **skip**)." };
  }
  if (!r.runAtLocal && !r.runNow && !asked.includes("schedule")) {
    return {
      field: "schedule",
      question: "Should I run it **daily at a time** (e.g. **daily at 9**, **every Monday at 10am**) or **just once now**?",
    };
  }
  return undefined;
}

/** The first thing the tool still needs, with the question to ask (the answer continues the same request). */
export function missingLeadGenField(toolName: LeadGenToolName, args: Obj): { field: MissingField; question: string } | undefined {
  switch (toolName) {
    case "create_saved_search":
      if (!args.category) {
        return {
          field: "category",
          question: "What kind of businesses should I find? For example **dental clinics**, **real estate agencies** or **IT companies that do app development**.",
        };
      }
      if (!args.city) return { field: "city", question: `In which city should I look for **${String(args.category)}**? (Kis shehar mein?)` };
      return undefined;
    case "create_search_schedule":
      if (!args.search) return { field: "search", question: "Which lead search should run on a schedule? Give its name, e.g. **Lahore dentists**, or say **show my lead searches**." };
      if (!args.runAtLocal) return { field: "time", question: "At what time should it run? For example **9:00**, **daily at 9** or **every Monday at 10am**." };
      return undefined;
    case "update_search_schedule":
    case "run_saved_search":
      if (!args.search) return { field: "search", question: "Which lead search do you mean? Give its name, or say **show my lead searches**." };
      return undefined;
    case "add_leads_to_campaign":
      if (!args.campaign) return { field: "campaign", question: "Which campaign should the leads go to? Give the campaign name or number (draft or paused campaigns only)." };
      return undefined;
    default:
      return undefined;
  }
}

const CANCEL = /^(cancel|stop|chhodo|chodo|rehne\s+do|rahne\s+do|never\s*mind|leave\s+it)[.!]*$/i;
/** "skip" for an optional question (here "nahi" / "no" means "none", not "cancel"). */
const SKIP = /^(skip|none|no|nahi|nahin|koi\s+nahi|kuch\s+nahi|any|all|sab|default|-|na)[.!]*$/i;

/**
 * The user's answer to the question the agent asked ("Karachi", "IT companies jo app development pa kam krti hon",
 * "9 baje", "campaign 22"), merged into the waiting request. Null = the user cancelled.
 */
export function applyAnswer(request: ParsedLeadGenMessage, field: MissingField, message: string): ParsedLeadGenMessage | null {
  const text = message.trim();
  if (CANCEL.test(text)) return null;
  const parsed = parseLeadGenMessage(text);
  const out: ParsedLeadGenMessage = { ...request };
  // Anything else the answer also says ("Karachi, owners bhi") is kept.
  for (const k of ["includePeople", "targetPerRun", "countryCode", "focus", "runAtLocal", "frequency", "weekdays"] as const) {
    if (parsed[k] !== undefined && out[k] === undefined) (out as Obj)[k] = parsed[k];
  }
  const clean = (s: string) => s.replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  if (field === "focus" || field === "perRun" || field === "schedule") out.asked = [...new Set([...(out.asked ?? []), field])];
  switch (field) {
    case "focus": {
      if (!SKIP.test(text)) out.focus = (parsed.focus ?? clean(text.replace(/^(focus|on|par|pa)\s*:?\s*/i, ""))).slice(0, 300);
      return out;
    }
    case "perRun": {
      const n = Number(text.match(/\d{1,3}/)?.[0]);
      out.targetPerRun = Number.isFinite(n) && n >= 1 ? Math.min(100, n) : 20;
      return out;
    }
    case "schedule": {
      if (/\b(now|abhi|once|ek\s+dafa|aik\s+dafa|skip|nahi|no|bas)\b/i.test(text) && !parsed.runAtLocal) {
        out.runNow = true;
        return out;
      }
      const bare = text.match(/(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|bje)?\b/i);
      if (parsed.runAtLocal) out.runAtLocal = parsed.runAtLocal;
      else if (bare && Number(bare[1]) <= 23) {
        let h = Number(bare[1]);
        if (bare[3]?.toLowerCase() === "pm" && h < 12) h += 12;
        out.runAtLocal = `${String(h).padStart(2, "0")}:${bare[2] ?? "00"}`;
      }
      if (out.runAtLocal) out.frequency ??= parsed.frequency ?? (parsed.weekdays ? "weekly" : "daily");
      else out.runNow = true;
      return out;
    }
    case "city": {
      let city = parsed.city ?? clean(text.replace(/\b(in|mein|me|main|city|shehar|shahar|ka|ki|ke|please|plz|search|karo|kro)\b/gi, " "));
      city = city.replace(/,.*$/, "").trim();
      const country = COUNTRIES[city.toLowerCase()];
      if (country && city.toLowerCase() !== "dubai") {
        out.countryCode = country;
        return out; // a country, not a city: the agent asks again
      }
      if (city && city.length <= 60 && !/\d/.test(city)) out.city = titleCase(city.toLowerCase());
      if (out.city?.toLowerCase() === "dubai") out.countryCode ??= "AE";
      return out;
    }
    case "category": {
      // "IT companies jo app development pa kam krti hon" -> category "IT companies", focus "app development".
      const head = clean(text.split(/\s+(?:jo|that|which|who|ki\s+jo|ke\s+jo)\s+/i)[0] ?? text).replace(/\s+(?:ki|ke|ka)$/i, "");
      if (head.length >= 2 && head.length <= 100) out.category = head;
      if (parsed.city && !out.city) out.city = parsed.city;
      return out;
    }
    case "time": {
      const bare = text.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|bje)?\b/i);
      if (parsed.runAtLocal) out.runAtLocal = parsed.runAtLocal;
      else if (bare && Number(bare[1]) <= 23) {
        let h = Number(bare[1]);
        if (bare[3]?.toLowerCase() === "pm" && h < 12) h += 12;
        out.runAtLocal = `${String(h).padStart(2, "0")}:${bare[2] ?? "00"}`;
      }
      return out;
    }
    case "search":
      out.search = clean(text).slice(0, 120);
      return out;
    case "campaign":
      out.campaign = parsed.campaign ?? (text.match(/\b(\d{1,9})\b/)?.[1] ?? clean(text.replace(/\bcampaign\b/gi, " ")).slice(0, 255));
      return out;
  }
}
