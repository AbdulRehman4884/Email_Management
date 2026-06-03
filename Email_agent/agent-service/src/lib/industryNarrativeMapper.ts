export interface IndustryNarrative {
  vertical: string;
  executiveFrame: string;
  pressures: string[];
  valueThemes: string[];
  subjectThemes: string[];
  avoidedLanguage: string[];
}

const DEFAULT_NARRATIVE: IndustryNarrative = {
  vertical: "business services",
  executiveFrame: "commercial teams need sharper account context, clearer buyer relevance, and cleaner review before outreach goes live",
  pressures: ["message quality", "buyer relevance", "pipeline focus", "review consistency"],
  valueThemes: ["account-specific outreach", "sales review quality", "buyer-message alignment"],
  subjectThemes: ["Improving outbound quality without adding review drag", "Sharper account context for executive outreach"],
  avoidedLanguage: ["workflow automation", "campaign intelligence", "operational readiness"],
};

const NARRATIVES: Array<{ pattern: RegExp; narrative: IndustryNarrative }> = [
  {
    pattern: /\b(lending|leasing|fintech|financial technology|banking|payments|loan|asset finance)\b/i,
    narrative: {
      vertical: "fintech and lending operations",
      executiveFrame: "growth depends on explaining complex lending workflows clearly while keeping compliance, implementation, and account handoff risk under control",
      pressures: ["lending workflow complexity", "compliance-aware messaging", "financial platform implementation", "sales-to-operations handoff clarity"],
      valueThemes: ["lending operations context", "finance buyer relevance", "implementation-ready account narratives"],
      subjectThemes: ["Reducing coordination drag in lending operations", "Improving buyer clarity across lending platform deals"],
      avoidedLanguage: ["execution rhythm", "workflow map", "AI workflow readiness"],
    },
  },
  {
    pattern: /\b(enterprise transformation|enterprise it|digital transformation|cloud|devops|erp|crm|managed services|systems integration)\b/i,
    narrative: {
      vertical: "enterprise transformation services",
      executiveFrame: "large transformation programs need credible buyer context, delivery visibility, and governance language before outreach reaches senior accounts",
      pressures: ["delivery visibility", "operational governance", "large-scale execution coordination", "transformation messaging"],
      valueThemes: ["enterprise account narratives", "delivery governance positioning", "transformation buyer alignment"],
      subjectThemes: ["Improving delivery visibility during enterprise scale-up", "Delivery governance during rapid scaling"],
      avoidedLanguage: ["campaign personalization", "public positioning points to", "operating cadence"],
    },
  },
  {
    pattern: /\b(product engineering|software product|application development|innovation|digital product|10pearls|engineering)\b/i,
    narrative: {
      vertical: "product engineering and innovation services",
      executiveFrame: "product-led services firms win when engineering depth is translated into business outcomes that product, technology, and innovation buyers recognize quickly",
      pressures: ["engineering velocity", "product delivery alignment", "innovation scaling", "product team coordination"],
      valueThemes: ["product delivery context", "engineering-to-business messaging", "innovation buyer relevance"],
      subjectThemes: ["Engineering alignment during product growth", "Improving product delivery conversations at scale"],
      avoidedLanguage: ["finance workflow", "handoff workflow", "operational follow-through"],
    },
  },
  {
    pattern: /\b(healthcare|ehr|emr|clinical|patient|claims|revenue cycle|medical)\b/i,
    narrative: {
      vertical: "healthcare technology",
      executiveFrame: "healthcare buyers need outreach that respects compliance, onboarding complexity, support continuity, and revenue-cycle realities",
      pressures: ["implementation complexity", "compliance-sensitive support", "revenue-cycle visibility", "customer onboarding quality"],
      valueThemes: ["healthcare buyer context", "implementation readiness", "support and revenue-cycle alignment"],
      subjectThemes: ["Improving implementation clarity for healthcare buyers", "Reducing onboarding friction in healthcare workflows"],
      avoidedLanguage: ["generic AI", "campaign intelligence", "workflow map"],
    },
  },
  {
    pattern: /\b(ai|machine learning|decisioning|data platform|predictive|automation platform)\b/i,
    narrative: {
      vertical: "AI and data platforms",
      executiveFrame: "enterprise AI conversations need practical proof, explainability, security confidence, and a clear path from interest to adoption",
      pressures: ["buyer education", "ROI proof", "security review", "explainability objections"],
      valueThemes: ["AI readiness messaging", "governance-aware outreach", "enterprise proof points"],
      subjectThemes: ["Making AI adoption easier for enterprise buyers", "Improving buyer confidence in AI platform conversations"],
      avoidedLanguage: ["AI buzzwords", "unlock", "revolutionary"],
    },
  },
  {
    pattern: /\b(bpo|contact center|customer operations|outsourcing|support operations)\b/i,
    narrative: {
      vertical: "customer operations and BPO",
      executiveFrame: "customer operations firms need clear messaging around service consistency, workforce coordination, reporting, and client outcomes",
      pressures: ["service consistency", "workforce coordination", "client reporting", "support handoff clarity"],
      valueThemes: ["customer operations visibility", "client-specific outreach", "support performance narratives"],
      subjectThemes: ["Improving client visibility across support operations", "Sharper outreach for customer operations buyers"],
      avoidedLanguage: ["workflow map", "operating cadence", "campaign personalization"],
    },
  },
];

export function mapIndustryNarrative(input: {
  companyName?: string;
  industry?: string;
  services?: string[];
  signals?: string[];
}): IndustryNarrative {
  const text = [input.companyName, input.industry, ...(input.services ?? []), ...(input.signals ?? [])].filter(Boolean).join(" ");
  return NARRATIVES.find((item) => item.pattern.test(text))?.narrative ?? DEFAULT_NARRATIVE;
}

export function executiveSubjectFor(input: {
  companyName?: string;
  industry?: string;
  persona?: string;
  signals?: string[];
  offset?: number;
}): string {
  const narrative = mapIndustryNarrative(input);
  const themes = narrative.subjectThemes;
  const seed = stableSeed([input.companyName, input.industry, input.persona, String(input.offset ?? 0)]);
  const subject = themes[seed % themes.length] ?? themes[0]!;
  return antiSpamSubject(subject);
}

export function antiSpamSubject(subject: string): string {
  return subject
    .replace(/\b(idea|quick|free|guaranteed|10x|unlock|revolutionary|game-changing)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([:;,.])/g, "$1")
    .trim();
}

function stableSeed(parts: Array<string | undefined>): number {
  const text = parts.filter(Boolean).join("|");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 33 + text.charCodeAt(i)) % 7919;
  return hash;
}
