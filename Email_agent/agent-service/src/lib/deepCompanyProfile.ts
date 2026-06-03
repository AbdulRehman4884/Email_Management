import {
  extractCompanyNameFromUrl,
  extractWebsiteSignals,
  type WebsiteIntelligence,
  type WebsiteSignals,
} from "./companyWebsiteEnrichment.js";
import { generateHiringSummary, type HiringIntelligence } from "./hiringIntelligence.js";
import { inferPrimaryBuyer, inferSecondaryBuyers } from "./personaIntelligence.js";
import { buildTriggerIntelligence, type TriggerIntelligence } from "./triggerIntelligence.js";

export interface DeepCompanyProfile {
  companyName: string;
  domain: string;
  website: string;
  confidence: number;
  industry: string;
  subIndustry: string;
  businessModel: string;
  services: string[];
  products: string[];
  targetCustomers: string[];
  likelyBuyerPersonas: string[];
  keySignals: string[];
  technologySignals: string[];
  growthSignals: string[];
  operationalSignals: string[];
  financeWorkflowSignals: string[];
  salesWorkflowSignals: string[];
  hiringSignals: string[];
  hiringDepartments: string[];
  triggerSignals: string[];
  urgencySignals: string[];
  aiMaturitySignals: string[];
  financeTransformationSignals: string[];
  likelyInitiatives: string[];
  primaryBuyerPersona: string;
  secondaryBuyerPersonas: string[];
  whyNowSignals: string[];
  confidenceBreakdown: string[];
  hiringIntelligence: HiringIntelligence;
  triggerIntelligence: TriggerIntelligence;
  risks: string[];
  assumptions: string[];
}

type DomainHint = {
  companyName: string;
  industry: string;
  subIndustry: string;
  businessModel: string;
  services: string[];
  products?: string[];
  targetCustomers: string[];
  personas: string[];
  signals: string[];
};

export function buildDeepCompanyProfile(intelligence: WebsiteIntelligence): DeepCompanyProfile {
  const signals = extractWebsiteSignals(intelligence.combinedText);
  const hint = domainHints[intelligence.domain.toLowerCase()];
  const content = intelligence.combinedText.toLowerCase();

  const industry = hint?.industry ?? classifyIndustry(content, signals, intelligence.domain);
  const subIndustry = hint?.subIndustry ?? classifySubIndustry(industry, content, signals);
  const businessModel = hint?.businessModel ?? inferBusinessModel(industry, content, signals);
  const companyName = hint?.companyName ?? extractCompanyNameFromUrl(intelligence.normalizedUrl);

  const services = unique([
    ...(hint?.services ?? []),
    ...servicesFromSignals(industry, signals),
  ]).slice(0, 7);

  const products = unique([
    ...(hint?.products ?? []),
    ...productsFromSignals(industry, signals),
  ]).slice(0, 5);

  const targetCustomers = unique([
    ...(hint?.targetCustomers ?? []),
    ...targetCustomersFromSignals(industry, signals),
  ]).slice(0, 5);

  const likelyBuyerPersonas = unique([
    ...(hint?.personas ?? []),
    ...buyerPersonasForIndustry(industry),
  ]).slice(0, 5);

  const keySignals = unique([
    ...(hint?.signals ?? []),
    ...signals.industrySignals,
    ...signals.serviceKeywords,
    ...signals.caseStudySignals,
  ]).slice(0, 8);

  const assumptions = buildAssumptions(intelligence, hint, signals);
  const confidence = scoreConfidence(intelligence, hint, signals, industry);
  const baseProfile = {
    companyName,
    domain: intelligence.domain,
    website: intelligence.normalizedUrl,
    confidence,
    industry,
    subIndustry,
    businessModel,
    services,
    products,
    targetCustomers,
    likelyBuyerPersonas,
    keySignals,
    technologySignals: unique(signals.technologySignals).slice(0, 6),
    growthSignals: unique(signals.hiringOrGrowthSignals).slice(0, 6),
    operationalSignals: unique(signals.operationalSignals).slice(0, 6),
    financeWorkflowSignals: unique(signals.financeSignals).slice(0, 6),
    salesWorkflowSignals: unique(signals.salesSignals).slice(0, 6),
    risks: buildRisks(intelligence, industry, signals),
    assumptions,
  };
  const hiringIntelligence = generateHiringSummary(intelligence);
  const triggerIntelligence = buildTriggerIntelligence(baseProfile, hiringIntelligence, intelligence.combinedText);
  const primaryBuyerPersona = inferPrimaryBuyer(baseProfile, triggerIntelligence, hiringIntelligence);
  const secondaryBuyerPersonas = inferSecondaryBuyers(baseProfile, triggerIntelligence, hiringIntelligence)
    .filter((persona) => persona !== primaryBuyerPersona)
    .slice(0, 6);

  return {
    ...baseProfile,
    hiringSignals: unique([
      hiringIntelligence.summary,
      ...hiringIntelligence.growthSignalsFromJobs,
      ...hiringIntelligence.operationalStressSignals,
    ]).slice(0, 8),
    hiringDepartments: hiringIntelligence.departmentsHiring,
    growthSignals: unique([...baseProfile.growthSignals, ...triggerIntelligence.growthSignals]).slice(0, 8),
    triggerSignals: unique([
      ...triggerIntelligence.expansionSignals,
      ...triggerIntelligence.transformationSignals,
      ...triggerIntelligence.partnershipSignals,
      ...triggerIntelligence.productLaunchSignals,
      ...triggerIntelligence.hiringBurstSignals,
    ]).slice(0, 8),
    urgencySignals: triggerIntelligence.urgencySignals,
    aiMaturitySignals: triggerIntelligence.aiMaturitySignals,
    financeTransformationSignals: triggerIntelligence.financeTransformationSignals,
    likelyInitiatives: triggerIntelligence.likelyInitiatives,
    primaryBuyerPersona,
    secondaryBuyerPersonas,
    whyNowSignals: triggerIntelligence.whyNowSignals,
    confidenceBreakdown: buildConfidenceBreakdown(intelligence, hint, signals, hiringIntelligence, triggerIntelligence),
    hiringIntelligence,
    triggerIntelligence,
  };
}

function classifyIndustry(content: string, signals: WebsiteSignals, domain: string): string {
  const haystack = `${content} ${signals.industrySignals.join(" ")} ${signals.serviceKeywords.join(" ")} ${domain}`.toLowerCase();

  if (/(healthcare|clinical|patient|provider|practice|revenue cycle|claims|ehr|emr|pharmacy|curemd)/.test(haystack)) return "healthcare SaaS";
  if (/(lending|leasing|loan|asset finance|fintech|banking|payments|financial services|netsol)/.test(haystack)) return "fintech platform";
  if (/(decisioning|prediction|artificial intelligence|machine learning|generative ai|computer vision|afiniti|qlu)/.test(haystack)) return "AI decisioning platform";
  if (/(bpo|contact center|call center|customer experience|outsourcing|trgworld)/.test(haystack)) return "BPO/contact center";
  if (/(devops|cloud|managed services|cybersecurity|systems ltd|systemsltd|confiz)/.test(haystack)) return "enterprise IT services";
  if (/(product engineering|software development|digital product|mobile app|10pearls|arbisoft)/.test(haystack)) return "software product engineering";
  if (/(digital transformation|erp|crm|implementation|consulting|systems integration)/.test(haystack)) return "digital transformation consulting";
  if (/(salesforce|sap|oracle|microsoft dynamics|implementation partner)/.test(haystack)) return "ERP/CRM implementation";

  return "B2B services or technology provider";
}

function classifySubIndustry(industry: string, content: string, signals: WebsiteSignals): string {
  const haystack = `${content} ${signals.serviceKeywords.join(" ")}`.toLowerCase();
  if (industry === "healthcare SaaS") return /(claims|revenue cycle|billing)/.test(haystack) ? "healthcare revenue cycle and practice workflows" : "clinical and provider workflow software";
  if (industry === "fintech platform") return /(leasing|asset finance)/.test(haystack) ? "asset finance and leasing software" : "banking, lending, and finance workflows";
  if (industry === "AI decisioning platform") return /(customer|contact center|cx)/.test(haystack) ? "customer interaction decisioning" : "enterprise AI decision support";
  if (industry === "enterprise IT services") return /(cloud|devops)/.test(haystack) ? "cloud, DevOps, and managed IT delivery" : "enterprise systems integration";
  if (industry === "software product engineering") return "custom product design, engineering, and delivery";
  if (industry === "BPO/contact center") return "outsourced customer operations and contact center delivery";
  return "specialized B2B operations";
}

function inferBusinessModel(industry: string, content: string, signals: WebsiteSignals): string {
  const haystack = `${content} ${signals.serviceKeywords.join(" ")}`.toLowerCase();
  if (industry.includes("SaaS") || /(platform|subscription|software product)/.test(haystack)) return "software platform with recurring enterprise/customer accounts";
  if (industry.includes("platform")) return "enterprise platform sales with implementation and customer success motion";
  if (industry.includes("BPO")) return "service delivery model with enterprise contracts and operational SLAs";
  if (industry.includes("IT services") || industry.includes("engineering") || industry.includes("consulting")) return "project and managed-services delivery model";
  return "B2B solution sales with consultative delivery";
}

function servicesFromSignals(industry: string, signals: WebsiteSignals): string[] {
  const mapped = signals.serviceKeywords.map((term) => normalizeService(term));
  if (mapped.length > 0) return mapped;

  if (industry === "healthcare SaaS") return ["Healthcare workflow software", "Patient and provider operations", "Revenue cycle support"];
  if (industry === "fintech platform") return ["Financial workflow platform", "Lending or leasing operations", "Customer and portfolio reporting"];
  if (industry === "AI decisioning platform") return ["AI decision support", "Model-driven recommendations", "Enterprise analytics"];
  if (industry === "enterprise IT services") return ["Digital transformation", "Cloud and DevOps services", "Enterprise application delivery"];
  if (industry === "software product engineering") return ["Product strategy", "Software engineering", "Data and AI implementation"];
  if (industry === "BPO/contact center") return ["Customer operations", "Contact center support", "Managed business process delivery"];
  return ["B2B solution delivery", "Client onboarding", "Account and operations management"];
}

function productsFromSignals(industry: string, signals: WebsiteSignals): string[] {
  const products: string[] = [];
  if (signals.serviceKeywords.some((term) => /platform|software|SaaS|ERP|CRM/i.test(term))) products.push("Workflow or enterprise software platform");
  if (signals.technologySignals.some((term) => /AI|machine learning|decisioning|analytics/i.test(term))) products.push("AI or analytics-enabled offering");
  if (industry === "fintech platform") products.push("Finance lifecycle management tools");
  if (industry === "healthcare SaaS") products.push("Healthcare operations modules");
  return products.length > 0 ? products : ["Packaged service offering", "Client delivery workflows"];
}

function targetCustomersFromSignals(industry: string, signals: WebsiteSignals): string[] {
  const customers = signals.buyerSignals.filter((term) => !/CFO|teams|leaders|developers/i.test(term));
  if (customers.length > 0) return customers;
  if (industry === "healthcare SaaS") return ["health systems", "clinics", "medical practices"];
  if (industry === "fintech platform") return ["banks", "lenders", "leasing companies"];
  if (industry === "AI decisioning platform") return ["enterprise operations teams", "customer experience leaders"];
  if (industry.includes("IT") || industry.includes("engineering")) return ["enterprise technology teams", "digital product leaders"];
  return ["B2B leadership teams", "operations teams"];
}

function buyerPersonasForIndustry(industry: string): string[] {
  if (industry === "healthcare SaaS") return ["COO", "VP Customer Success", "Revenue Cycle Director", "Implementation Lead"];
  if (industry === "fintech platform") return ["CFO", "Head of Operations", "Chief Risk Officer", "VP Sales"];
  if (industry === "AI decisioning platform") return ["Chief Data Officer", "VP Operations", "Head of Customer Experience", "CIO"];
  if (industry === "enterprise IT services") return ["Chief Digital Officer", "VP Sales", "Delivery Director", "CFO"];
  if (industry === "software product engineering") return ["CTO", "VP Engineering", "Head of Product", "Client Partner"];
  if (industry === "BPO/contact center") return ["COO", "VP Customer Experience", "Workforce Operations Lead", "CFO"];
  return ["Founder", "COO", "VP Sales", "CFO"];
}

function buildRisks(intelligence: WebsiteIntelligence, industry: string, signals: WebsiteSignals): string[] {
  const risks: string[] = [];
  if (intelligence.limited) risks.push("Limited website text was available, so several insights rely on domain and category inference.");
  if (industry === "AI decisioning platform") risks.push("Enterprise prospects may require explainability, security, and ROI proof before adopting AI workflows.");
  if (industry === "healthcare SaaS") risks.push("Healthcare workflow claims should avoid implying HIPAA or clinical compliance without verification.");
  if (signals.caseStudySignals.length === 0) risks.push("No strong case-study signal was detected in fetched content.");
  return risks.slice(0, 4);
}

function buildAssumptions(intelligence: WebsiteIntelligence, hint: DomainHint | undefined, signals: WebsiteSignals): string[] {
  const assumptions: string[] = [];
  if (hint) assumptions.push("Domain matched a known company-category pattern.");
  if (intelligence.combinedText.length > 0) assumptions.push("Website copy was used for service, industry, and workflow signals.");
  if (signals.serviceKeywords.length === 0) assumptions.push("Services were inferred from industry and domain because service keywords were sparse.");
  if (intelligence.limited) assumptions.push("Fetch coverage was limited; verify against LinkedIn and recent news before high-volume outreach.");
  return assumptions.slice(0, 4);
}

function scoreConfidence(
  intelligence: WebsiteIntelligence,
  hint: DomainHint | undefined,
  signals: WebsiteSignals,
  industry: string,
): number {
  let score = 42;
  if (hint) score += 18;
  if (intelligence.combinedText.length > 1_500) score += 20;
  else if (intelligence.combinedText.length > 400) score += 10;
  score += Math.min(12, signals.serviceKeywords.length * 2);
  score += Math.min(8, signals.industrySignals.length * 2);
  if (industry !== "B2B services or technology provider") score += 8;
  if (intelligence.errors.length > 2) score -= 8;
  return Math.max(35, Math.min(94, score));
}

function normalizeService(term: string): string {
  if (/DevOps/i.test(term)) return "DevOps and cloud delivery";
  if (/ERP|CRM/i.test(term)) return `${term.toUpperCase()} implementation and workflow support`;
  if (/AI|machine learning/i.test(term)) return "AI and data automation";
  return term.charAt(0).toUpperCase() + term.slice(1);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildConfidenceBreakdown(
  intelligence: WebsiteIntelligence,
  hint: DomainHint | undefined,
  signals: WebsiteSignals,
  hiring: HiringIntelligence,
  trigger: TriggerIntelligence,
): string[] {
  const breakdown = [
    hint ? "Known-domain category hint increased confidence." : "No known-domain hint; classification relies on fetched content and URL signals.",
    intelligence.combinedText.length > 600 ? "Website content was available for enrichment." : "Limited website content was available.",
    signals.serviceKeywords.length > 0 ? "Service keywords were detected." : "Service keywords were sparse.",
    hiring.openRoles.length > 0 ? "Hiring signals were detected from careers/job content." : "No hiring signals detected from available public website content.",
    trigger.whyNowSignals.length > 0 ? "Timing triggers were detected." : "Timing triggers are moderate and should be manually verified.",
  ];
  return breakdown;
}

const domainHints: Record<string, DomainHint> = {
  "systemsltd.com": {
    companyName: "Systems Limited",
    industry: "enterprise IT services",
    subIndustry: "digital transformation, cloud, data, and enterprise application services",
    businessModel: "project and managed-services delivery model",
    services: ["Digital transformation", "Enterprise application delivery", "Cloud and data services", "Business process services"],
    targetCustomers: ["enterprise IT leaders", "banks", "telecoms", "public sector teams"],
    personas: ["Chief Digital Officer", "CIO", "Delivery Director", "CFO"],
    signals: ["large enterprise delivery footprint", "systems integration", "managed transformation programs"],
  },
  "netsoltech.com": {
    companyName: "NETSOL Technologies",
    industry: "fintech platform",
    subIndustry: "asset finance and leasing software",
    businessModel: "enterprise platform sales with implementation and support",
    services: ["Asset finance platform", "Leasing lifecycle automation", "Implementation and managed support"],
    products: ["Finance lifecycle management platform"],
    targetCustomers: ["auto finance companies", "banks", "equipment lenders", "leasing companies"],
    personas: ["CFO", "Head of Lending Operations", "Chief Risk Officer", "VP Sales"],
    signals: ["leasing workflow specialization", "finance lifecycle complexity", "enterprise implementation motion"],
  },
  "10pearls.com": {
    companyName: "10Pearls",
    industry: "software product engineering",
    subIndustry: "digital product engineering, AI, and modernization services",
    businessModel: "project and managed-services delivery model",
    services: ["Product engineering", "AI and data services", "Digital transformation", "Application modernization"],
    targetCustomers: ["growth-stage companies", "enterprise product teams", "digital transformation leaders"],
    personas: ["CTO", "VP Engineering", "Head of Product", "Client Partner"],
    signals: ["product engineering delivery", "AI practice positioning", "multi-service digital work"],
  },
  "confiz.com": {
    companyName: "Confiz",
    industry: "enterprise IT services",
    subIndustry: "retail, data, cloud, and Microsoft ecosystem services",
    businessModel: "project and managed-services delivery model",
    services: ["Cloud engineering", "Data analytics", "Retail technology", "Enterprise application services"],
    targetCustomers: ["retail enterprises", "enterprise IT teams", "operations leaders"],
    personas: ["CIO", "VP Sales", "Delivery Director", "Head of Data"],
    signals: ["enterprise delivery", "data and cloud implementation", "retail technology context"],
  },
  "afiniti.com": {
    companyName: "Afiniti",
    industry: "AI decisioning platform",
    subIndustry: "customer interaction pairing and enterprise decisioning",
    businessModel: "enterprise platform sales with implementation and customer success motion",
    services: ["AI decisioning", "Customer interaction optimization", "Enterprise analytics"],
    products: ["AI decisioning platform"],
    targetCustomers: ["contact centers", "telecoms", "financial services", "enterprise CX teams"],
    personas: ["Chief Data Officer", "VP Customer Experience", "CIO", "COO"],
    signals: ["AI-led decisioning", "contact center outcome optimization", "enterprise buyer education needed"],
  },
  "venturediversity.com": {
    companyName: "Venture Diversity",
    industry: "digital transformation consulting",
    subIndustry: "business growth, inclusion, and advisory services",
    businessModel: "consultative B2B service delivery",
    services: ["Advisory services", "Growth program design", "Client research and reporting"],
    targetCustomers: ["founders", "business leaders", "program teams"],
    personas: ["Founder", "COO", "Program Director", "Head of Partnerships"],
    signals: ["advisory-led sales", "relationship-driven delivery", "research-heavy client work"],
  },
  "arbisoft.com": {
    companyName: "Arbisoft",
    industry: "software product engineering",
    subIndustry: "custom software, data, education technology, and travel technology",
    businessModel: "project and managed-services delivery model",
    services: ["Custom software development", "Data engineering", "Product engineering", "QA and managed delivery"],
    targetCustomers: ["software companies", "education platforms", "travel platforms", "enterprise product teams"],
    personas: ["CTO", "VP Engineering", "Head of Product", "Delivery Director"],
    signals: ["engineering services", "long-cycle project scoping", "resource planning needs"],
  },
  "qlu.ai": {
    companyName: "QLU.ai",
    industry: "AI decisioning platform",
    subIndustry: "AI research and prospect intelligence",
    businessModel: "AI SaaS platform with sales and research workflow use cases",
    services: ["AI prospect research", "Relationship intelligence", "Automated lead context generation"],
    products: ["AI sales intelligence platform"],
    targetCustomers: ["sales teams", "recruiters", "founders", "business development teams"],
    personas: ["VP Sales", "Founder", "RevOps Lead", "Head of Business Development"],
    signals: ["AI research workflow", "sales intelligence", "persona and relationship discovery"],
  },
  "curemd.com": {
    companyName: "CureMD",
    industry: "healthcare SaaS",
    subIndustry: "EHR, practice management, and revenue cycle workflows",
    businessModel: "healthcare software platform with implementation and support",
    services: ["EHR software", "Practice management", "Revenue cycle management", "Patient engagement workflows"],
    products: ["Healthcare operations platform"],
    targetCustomers: ["medical practices", "health systems", "providers", "billing teams"],
    personas: ["Practice Administrator", "Revenue Cycle Director", "COO", "Implementation Lead"],
    signals: ["provider workflow complexity", "billing and claims context", "compliance-sensitive operations"],
  },
  "trgworld.com": {
    companyName: "TRG World",
    industry: "BPO/contact center",
    subIndustry: "outsourced customer operations and business process services",
    businessModel: "service delivery model with enterprise contracts and operational SLAs",
    services: ["Contact center operations", "Business process outsourcing", "Customer support workflows"],
    targetCustomers: ["enterprise CX teams", "operations leaders", "global service organizations"],
    personas: ["COO", "VP Customer Experience", "Workforce Operations Lead", "CFO"],
    signals: ["high-volume operations", "workforce planning", "SLA reporting and client governance"],
  },
};
