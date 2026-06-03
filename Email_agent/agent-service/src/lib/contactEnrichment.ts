/**
 * src/lib/contactEnrichment.ts
 *
 * In-process contact enrichment utilities.
 *
 * These functions replicate the MCP enrichment tool logic locally so that
 * a batch of N contacts can be enriched in a single function call rather
 * than N round-trip MCP calls.  They must stay in sync with the MCP tools
 * (enrichDomain, classifyIndustry, scoreLead, validateEmail).
 *
 * No external API calls are made — all logic is deterministic.
 */

// ── Personal email domains ────────────────────────────────────────────────────

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "ymail.com",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "outlook.com", "outlook.co.uk",
  "live.com", "live.co.uk", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "aim.com", "protonmail.com", "proton.me", "pm.me",
  "fastmail.com", "fastmail.fm", "tutanota.com", "tuta.io",
  "gmx.com", "gmx.net", "gmx.de", "mail.com", "inbox.com",
  "yandex.com", "yandex.ru", "rocketmail.com",
]);

const PERSONAL_SLDS = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "hotmail", "outlook", "live",
  "msn", "icloud", "me", "mac", "aol", "aim", "protonmail", "proton",
  "fastmail", "tutanota", "tuta", "gmx", "mail", "inbox", "yandex", "rocketmail",
]);

// ── Industry taxonomy ─────────────────────────────────────────────────────────

const DOMAIN_INDUSTRY_HINTS: Array<[string, string]> = [
  ["saas",       "Technology"],  ["fintech",    "Technology"],
  ["tech",       "Technology"],  ["software",   "Technology"],
  ["digital",    "Technology"],  ["cloud",      "Technology"],
  ["cyber",      "Technology"],  ["data",       "Technology"],
  ["bank",       "Finance & Banking"], ["finance",   "Finance & Banking"],
  ["capital",    "Finance & Banking"], ["invest",    "Finance & Banking"],
  ["wealth",     "Finance & Banking"], ["credit",    "Finance & Banking"],
  ["insurance",  "Insurance"],   ["insure",     "Insurance"],
  ["health",     "Healthcare"],  ["medical",    "Healthcare"],
  ["clinic",     "Healthcare"],  ["pharma",     "Healthcare"],
  ["hospital",   "Healthcare"],  ["bio",        "Healthcare"],
  ["retail",     "Retail & E-commerce"], ["shop", "Retail & E-commerce"],
  ["ecommerce",  "Retail & E-commerce"], ["market", "Retail & E-commerce"],
  ["logistics",  "Logistics & Supply Chain"], ["freight", "Logistics & Supply Chain"],
  ["supply",     "Logistics & Supply Chain"], ["transport", "Logistics & Supply Chain"],
  ["school",     "Education"],   ["academy",    "Education"],
  ["learn",      "Education"],   ["university", "Education"],
  ["legal",      "Legal Services"], ["law",      "Legal Services"],
  ["property",   "Real Estate"], ["realty",     "Real Estate"],
  ["construct",  "Construction"], ["build",     "Construction"],
  ["restaurant", "Food & Hospitality"], ["hotel", "Food & Hospitality"],
  ["food",       "Food & Hospitality"],
  ["media",      "Media & Creative"],   ["design", "Media & Creative"],
  ["consult",    "Consulting"],  ["advisory",   "Consulting"],
  ["energy",     "Energy"],      ["solar",      "Energy"],
  ["agri",       "Agriculture"], ["farm",       "Agriculture"],
  ["manufactur", "Manufacturing"], ["factory",  "Manufacturing"],
];

// ── Role seniority ────────────────────────────────────────────────────────────

const EXEC_KEYWORDS   = ["ceo", "coo", "cfo", "cto", "ciso", "president", "founder", "owner", "partner", "managing director"];
const SENIOR_KEYWORDS = ["vp", "vice president", "director", "head of", "principal", "chief"];
const MID_KEYWORDS    = ["manager", "lead", "senior", "sr.", "supervisor"];

const HIGH_VALUE_INDUSTRIES = new Set([
  "Technology", "Finance & Banking", "Insurance", "Healthcare", "Consulting", "Legal Services",
]);
const MEDIUM_VALUE_INDUSTRIES = new Set([
  "Real Estate", "Retail & E-commerce", "Media & Creative", "Energy", "Logistics & Supply Chain",
]);

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface EnrichedContact {
  // Original fields preserved as-is
  name?: string;
  email?: string;
  company?: string;
  role?: string;
  website?: string;
  // Enriched fields
  domain?: string;
  emailType?: "business" | "personal" | "unknown";
  industry?: string;
  inferredCompany?: string;
  score?: number;
  priority?: "hot" | "warm" | "cold";
  enrichmentSource?: string;
  // All other original fields
  [key: string]: unknown;
}

export interface EnrichmentSummary {
  byIndustry: Record<string, number>;
  hotLeads: number;
  warmLeads: number;
  coldLeads: number;
  businessEmails: number;
}

// ── Email validation ──────────────────────────────────────────────────────────

function validateEmail(email: string): {
  isValid: boolean;
  domain?: string;
  type: "business" | "personal" | "unknown";
} {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { isValid: false, type: "unknown" };
  }
  const atIdx = email.indexOf("@");
  const domainLower = email.slice(atIdx + 1).toLowerCase();
  const isPersonal = PERSONAL_DOMAINS.has(domainLower);
  return { isValid: true, domain: domainLower, type: isPersonal ? "personal" : "business" };
}

// ── Domain enrichment ─────────────────────────────────────────────────────────

function enrichDomain(domain: string): { companyName?: string; industry?: string } {
  const parts = domain.split(".");
  const sld = parts[parts.length - 2] ?? "";
  if (PERSONAL_SLDS.has(sld)) return {};

  const cleanSld = sld.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const sldLower = sld.toLowerCase();

  let industry: string | undefined;
  for (const [keyword, ind] of DOMAIN_INDUSTRY_HINTS) {
    if (sldLower.includes(keyword)) { industry = ind; break; }
  }

  return { companyName: cleanSld || undefined, industry };
}

// ── Industry classification ───────────────────────────────────────────────────

function classifyIndustry(companyName: string | undefined, domain: string | undefined): string | undefined {
  const corpus = [domain ?? "", companyName ?? ""].join(" ").toLowerCase();
  if (!corpus.trim()) return undefined;
  for (const [keyword, ind] of DOMAIN_INDUSTRY_HINTS) {
    if (corpus.includes(keyword)) return ind;
  }
  return undefined;
}

// ── Lead scoring ──────────────────────────────────────────────────────────────

function scoreLead(contact: {
  name?: string;
  email?: string;
  company?: string;
  role?: string;
  industry?: string;
  website?: string;
  hasBusinessEmail?: boolean;
}): { score: number; priority: "hot" | "warm" | "cold" } {
  let score = 0;

  if (contact.email) {
    score += contact.hasBusinessEmail === true ? 25 : contact.hasBusinessEmail === false ? 5 : 10;
  }
  if (contact.name?.trim()) {
    score += contact.name.trim().split(/\s+/).length >= 2 ? 5 : 2;
  }
  if (contact.role?.trim()) {
    const r = contact.role.toLowerCase();
    if (EXEC_KEYWORDS.some((k) => r.includes(k)))   score += 30;
    else if (SENIOR_KEYWORDS.some((k) => r.includes(k))) score += 20;
    else if (MID_KEYWORDS.some((k) => r.includes(k)))    score += 10;
    else score += 5;
  }
  if (contact.industry) {
    if (HIGH_VALUE_INDUSTRIES.has(contact.industry))   score += 20;
    else if (MEDIUM_VALUE_INDUSTRIES.has(contact.industry)) score += 10;
    else score += 5;
  }
  if (contact.company?.trim()) score += 5;
  if (contact.website?.trim()) score += 5;

  score = Math.min(100, Math.max(0, score));
  const priority: "hot" | "warm" | "cold" = score >= 60 ? "hot" : score >= 30 ? "warm" : "cold";
  return { score, priority };
}

// ── Single contact enrichment ─────────────────────────────────────────────────

export function enrichContact(raw: Record<string, string>): EnrichedContact {
  const contact: EnrichedContact = { ...raw };

  // Normalise email
  const emailRaw = raw.email ?? raw.Email ?? raw.EMAIL ?? "";
  if (emailRaw) {
    const { isValid, domain, type } = validateEmail(emailRaw.trim());
    if (isValid && domain) {
      contact.email     = emailRaw.trim().toLowerCase();
      contact.domain    = domain;
      contact.emailType = type;

      const domainEnrichment = enrichDomain(domain);
      if (domainEnrichment.industry && !contact.industry) {
        contact.industry = domainEnrichment.industry;
      }
      if (domainEnrichment.companyName && !contact.company) {
        contact.inferredCompany = domainEnrichment.companyName;
      }
    }
  }

  // Classify industry if still missing
  if (!contact.industry) {
    const company = (raw.company ?? raw.Company ?? raw.organization ?? "");
    const inferred = classifyIndustry(company, contact.domain);
    if (inferred) contact.industry = inferred;
  }

  // Score lead
  const { score, priority } = scoreLead({
    name:             typeof raw.name    === "string" ? raw.name    : undefined,
    email:            typeof contact.email === "string" ? contact.email : undefined,
    company:          typeof raw.company === "string" ? raw.company  : typeof contact.inferredCompany === "string" ? contact.inferredCompany : undefined,
    role:             typeof raw.role    === "string" ? raw.role    : typeof raw.title === "string" ? raw.title : undefined,
    industry:         typeof contact.industry === "string" ? contact.industry : undefined,
    website:          typeof raw.website  === "string" ? raw.website  : undefined,
    hasBusinessEmail: contact.emailType === "business" ? true : contact.emailType === "personal" ? false : undefined,
  });

  contact.score    = score;
  contact.priority = priority;
  contact.enrichmentSource = "heuristic:domain-analysis";

  return contact;
}

// ── Batch enrichment ──────────────────────────────────────────────────────────

export function enrichBatch(rows: Array<Record<string, string>>): {
  contacts: EnrichedContact[];
  totalProcessed: number;
  enrichedCount: number;
  summary: EnrichmentSummary;
} {
  const contacts = rows.map(enrichContact);

  const summary: EnrichmentSummary = {
    byIndustry:    {},
    hotLeads:      0,
    warmLeads:     0,
    coldLeads:     0,
    businessEmails: 0,
  };

  let enrichedCount = 0;
  for (const c of contacts) {
    if (c.industry || c.score !== undefined) enrichedCount++;
    if (c.industry) {
      summary.byIndustry[c.industry] = (summary.byIndustry[c.industry] ?? 0) + 1;
    }
    if (c.priority === "hot")  summary.hotLeads++;
    if (c.priority === "warm") summary.warmLeads++;
    if (c.priority === "cold") summary.coldLeads++;
    if (c.emailType === "business") summary.businessEmails++;
  }

  return { contacts, totalProcessed: rows.length, enrichedCount, summary };
}

// ── Outreach template generator ───────────────────────────────────────────────

type Tone = "formal" | "friendly" | "sales-focused" | "executive";

function detectDominantIndustry(contacts: EnrichedContact[]): string | undefined {
  const counts: Record<string, number> = {};
  for (const c of contacts) {
    if (typeof c.industry === "string") counts[c.industry] = (counts[c.industry] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function generateTemplate(
  contacts: EnrichedContact[],
  tone: Tone = "friendly",
  cta?: string,
  customInstructions?: string,
): { subject: string; body: string; variables: string[]; tone: string } {
  const industry = detectDominantIndustry(contacts);
  const industryPhrase = industry ? ` in the ${industry} sector` : "";
  const ctaLine = cta ?? "schedule a quick 15-minute call this week";

  const openings: Record<Tone, string> = {
    formal: "Dear {{name}},", friendly: "Hi {{name}},",
    "sales-focused": "Hi {{name}},", executive: "Dear {{name}},",
  };

  const intros: Record<Tone, string> = {
    formal:
      `I am reaching out to professionals${industryPhrase} who may benefit from our solutions. ` +
      "We help companies like {{company}} streamline operations and achieve measurable results.",
    friendly:
      `I came across {{company}} and thought I'd reach out — ` +
      `we've been working with a number of teams${industryPhrase} and the results have been great.`,
    "sales-focused":
      `Companies${industryPhrase} like {{company}} are seeing real ROI from our platform. ` +
      "I'd love to show you how we can deliver the same results for your team.",
    executive:
      `I'm contacting senior leaders${industryPhrase} to share how our solution is helping ` +
      "organisations similar to {{company}} drive measurable business impact.",
  };

  const closings: Record<Tone, string> = {
    formal: `I would welcome the opportunity to discuss this further. Please feel free to ${ctaLine}.`,
    friendly: `Would love to chat — happy to ${ctaLine} if that works!`,
    "sales-focused": `Let's connect — I can walk you through our ROI figures. Can we ${ctaLine}?`,
    executive: `I believe this warrants a brief conversation. I'd appreciate the chance to ${ctaLine}.`,
  };

  const subjects: Record<Tone, string> = {
    formal: "Partnership Opportunity for {{company}}",
    friendly: "Quick note for {{name}} at {{company}}",
    "sales-focused": "How {{company}} can achieve results — worth 15 mins?",
    executive: "Relevant opportunity for {{company}} leadership",
  };

  const body = [
    openings[tone], "",
    intros[tone], "",
    ...(customInstructions ? [customInstructions, ""] : []),
    closings[tone], "",
    "Best regards,", "{{sender_name}}",
  ].join("\n");

  const subject = subjects[tone];
  const tokenRe = /\{\{(\w+)\}\}/g;
  const vars = new Set<string>();
  for (const str of [subject, body]) {
    tokenRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(str)) !== null) vars.add(m[1]!);
  }

  return { subject, body, variables: Array.from(vars), tone };
}
