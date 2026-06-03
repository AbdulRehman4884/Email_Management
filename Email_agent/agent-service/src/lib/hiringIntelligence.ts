import type { WebsiteIntelligence, WebsitePageResult } from "./companyWebsiteEnrichment.js";

export interface HiringIntelligence {
  careersPageDetected: boolean;
  openRoles: string[];
  departmentsHiring: string[];
  hiringVolume: "none" | "low" | "moderate" | "high";
  growthSignalsFromJobs: string[];
  operationalStressSignals: string[];
  technologyAdoptionSignals: string[];
  financeExpansionSignals: string[];
  summary: string;
}

export function detectCareersPage(intelligence: WebsiteIntelligence): boolean {
  return careerPages(intelligence).some((page) => page.ok && page.content.trim().length > 20);
}

export function extractOpenRoles(intelligence: WebsiteIntelligence): string[] {
  const text = careerText(intelligence);
  const roles = ROLE_PATTERNS.filter((role) => new RegExp(`\\b${escapeRegex(role)}s?\\b`, "i").test(text));
  const titled = [...text.matchAll(/\b(?:Senior|Lead|Principal|Staff|Junior)?\s*(?:[A-Z][a-z]+(?:\s|\/|-)){0,4}(?:Engineer|Manager|Specialist|Analyst|Consultant|Executive|Representative|Director|Architect|Developer)\b/g)]
    .map((match) => match[0].trim())
    .filter((role) => role.length >= 6 && role.length <= 70);
  return unique([...roles, ...titled]).slice(0, 16);
}

export function classifyDepartmentsHiring(openRoles: string[]): string[] {
  const joined = openRoles.join(" ").toLowerCase();
  const departments: string[] = [];
  if (/(sdr|sales|account executive|business development|revops|revenue operations|marketing)/.test(joined)) departments.push("GTM / revenue");
  if (/(customer success|implementation|onboarding|professional services|solution|support)/.test(joined)) departments.push("customer success / delivery");
  if (/(ai|machine learning|ml engineer|data scientist|data engineer|analytics)/.test(joined)) departments.push("AI / data");
  if (/(finance|accounting|billing|reconciliation|controller|fp&a)/.test(joined)) departments.push("finance operations");
  if (/(cloud|devops|platform|software|developer|architect|security)/.test(joined)) departments.push("engineering / technology");
  if (/(operations|workforce|project manager|program manager)/.test(joined)) departments.push("operations");
  return departments.length > 0 ? departments : [];
}

export function detectHiringVolume(openRoles: string[]): HiringIntelligence["hiringVolume"] {
  if (openRoles.length === 0) return "none";
  if (openRoles.length <= 2) return "low";
  if (openRoles.length <= 7) return "moderate";
  return "high";
}

export function inferGrowthSignalsFromJobs(openRoles: string[], departments: string[]): string[] {
  const signals: string[] = [];
  if (departments.includes("GTM / revenue")) signals.push("Revenue team hiring suggests active GTM scaling or pipeline expansion.");
  if (departments.includes("customer success / delivery")) signals.push("Delivery and onboarding hiring suggests implementation volume or customer expansion pressure.");
  if (departments.includes("AI / data")) signals.push("AI/data hiring suggests active automation, analytics, or AI product initiatives.");
  if (departments.includes("engineering / technology")) signals.push("Engineering hiring suggests product, platform, or implementation capacity expansion.");
  if (openRoles.length >= 8) signals.push("High visible hiring volume suggests near-term scaling pressure.");
  return signals;
}

export function inferOperationalStressSignals(openRoles: string[], departments: string[]): string[] {
  const text = openRoles.join(" ").toLowerCase();
  const signals: string[] = [];
  if (/(implementation|onboarding|professional services|solution)/.test(text)) signals.push("Implementation/onboarding roles imply delivery handoff and customer rollout pressure.");
  if (/(support|customer success|account manager)/.test(text)) signals.push("Customer-facing hiring implies retention, support, and reporting load is increasing.");
  if (departments.includes("operations")) signals.push("Operations hiring implies workflow standardization and resource planning needs.");
  return signals;
}

export function inferTechnologyAdoptionSignals(openRoles: string[]): string[] {
  const text = openRoles.join(" ").toLowerCase();
  const signals: string[] = [];
  if (/(ai|machine learning|ml engineer|data scientist|llm|generative)/.test(text)) signals.push("AI/ML hiring points to AI initiative or product intelligence investment.");
  if (/(cloud|devops|kubernetes|platform|site reliability|security)/.test(text)) signals.push("Cloud/platform hiring points to modernization, reliability, or security initiatives.");
  if (/(salesforce|sap|oracle|dynamics|erp|crm)/.test(text)) signals.push("Enterprise app hiring points to CRM/ERP workflow modernization.");
  return signals;
}

export function inferFinanceExpansionSignals(openRoles: string[]): string[] {
  const text = openRoles.join(" ").toLowerCase();
  const signals: string[] = [];
  if (/(finance|accounting|billing|reconciliation|controller|fp&a|accounts payable|accounts receivable)/.test(text)) {
    signals.push("Finance/accounting hiring suggests reporting, reconciliation, billing, or controls workload is growing.");
  }
  return signals;
}

export function generateHiringSummary(intelligence: WebsiteIntelligence): HiringIntelligence {
  const careersPageDetected = detectCareersPage(intelligence);
  const openRoles = extractOpenRoles(intelligence);
  const departmentsHiring = classifyDepartmentsHiring(openRoles);
  const hiringVolume = detectHiringVolume(openRoles);
  const growthSignalsFromJobs = inferGrowthSignalsFromJobs(openRoles, departmentsHiring);
  const operationalStressSignals = inferOperationalStressSignals(openRoles, departmentsHiring);
  const technologyAdoptionSignals = inferTechnologyAdoptionSignals(openRoles);
  const financeExpansionSignals = inferFinanceExpansionSignals(openRoles);
  const summary = openRoles.length === 0
    ? "No hiring signals detected from available public website content."
    : `${hiringVolume} visible hiring signal across ${departmentsHiring.length > 0 ? departmentsHiring.join(", ") : "unclear departments"}; signals suggest ${growthSignalsFromJobs[0]?.toLowerCase() ?? "possible team expansion."}`;

  return {
    careersPageDetected,
    openRoles,
    departmentsHiring,
    hiringVolume,
    growthSignalsFromJobs,
    operationalStressSignals,
    technologyAdoptionSignals,
    financeExpansionSignals,
    summary,
  };
}

function careerPages(intelligence: WebsiteIntelligence): WebsitePageResult[] {
  return intelligence.pagesFetched.filter((page) => /\/(careers|jobs|join-us|work-with-us|open-positions|life-at|team)\b/i.test(new URL(page.url).pathname));
}

function careerText(intelligence: WebsiteIntelligence): string {
  const text = careerPages(intelligence)
    .filter((page) => page.ok)
    .map((page) => page.content)
    .join(" ");
  return text || intelligence.combinedText;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ROLE_PATTERNS = [
  "SDR",
  "Sales Development Representative",
  "Account Executive",
  "Revenue Operations",
  "RevOps",
  "Customer Success Manager",
  "Implementation Manager",
  "Onboarding Specialist",
  "Professional Services Consultant",
  "Solution Engineer",
  "AI Engineer",
  "ML Engineer",
  "Machine Learning Engineer",
  "Data Scientist",
  "Data Engineer",
  "Finance Operations Analyst",
  "Accounting Analyst",
  "Billing Specialist",
  "Controller",
  "Cloud Engineer",
  "DevOps Engineer",
  "Security Engineer",
  "Project Manager",
  "Program Manager",
] as const;
