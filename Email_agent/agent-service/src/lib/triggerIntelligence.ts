import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import type { HiringIntelligence } from "./hiringIntelligence.js";
import { interpretExecutiveSignal } from "./executiveSignalInterpreter.js";

type ProfileForTriggers = Pick<
  DeepCompanyProfile,
  "industry" | "operationalSignals" | "financeWorkflowSignals"
>;

export interface TriggerIntelligence {
  growthSignals: string[];
  expansionSignals: string[];
  transformationSignals: string[];
  aiMaturitySignals: string[];
  partnershipSignals: string[];
  productLaunchSignals: string[];
  hiringBurstSignals: string[];
  operationalComplexitySignals: string[];
  urgencySignals: string[];
  financeTransformationSignals: string[];
  likelyInitiatives: string[];
  whyNowSignals: string[];
  urgencyScore: number;
}

export function detectGrowthSignals(content: string, hiring: HiringIntelligence): string[] {
  return unique([
    ...matches(content, [
      ["growth", "Public positioning points to growth or scaling themes."],
      ["global", "Global footprint suggests multi-region operating complexity."],
      ["enterprise clients", "Enterprise-client messaging suggests larger account motion."],
      ["customers", "Customer proof suggests active commercial expansion."],
    ]),
    ...hiring.growthSignalsFromJobs,
  ]);
}

export function detectExpansionSignals(content: string): string[] {
  return matches(content, [
    ["new office", "A new office reference points to geographic expansion."],
    ["expansion", "Expansion positioning points to timing-sensitive growth."],
    ["global delivery", "Global delivery messaging suggests scale and delivery coordination needs."],
    ["new markets", "New market positioning points to GTM and operations pressure."],
  ]);
}

export function detectTransformationSignals(content: string): string[] {
  return matches(content, [
    ["digital transformation", "Digital transformation positioning suggests modernization initiatives."],
    ["cloud migration", "Cloud migration signal suggests infrastructure modernization work."],
    ["ERP", "Enterprise systems positioning points to modernization and operational integration work."],
    ["CRM", "CRM positioning points to revenue process modernization."],
    ["security", "Security positioning points to governance and compliance priorities."],
  ]);
}

export function detectAIMaturitySignals(content: string, hiring: HiringIntelligence): string[] {
  return unique([
    ...matches(content, [
      ["artificial intelligence", "AI messaging suggests active AI adoption or AI-led positioning."],
      ["generative AI", "Generative AI positioning points to experimentation or AI-supported operating models."],
      ["machine learning", "Machine learning positioning points to technical AI maturity."],
      ["decisioning", "Decisioning positioning points to AI-supported operational decisions."],
      ["automation", "Automation positioning points to process orchestration appetite."],
    ]),
    ...hiring.technologyAdoptionSignals.filter((signal) => /AI|ML/i.test(signal)),
  ]);
}

export function detectPartnershipSignals(content: string): string[] {
  return matches(content, [
    ["partner", "Partnership positioning points to channel, ecosystem, or implementation leverage."],
    ["alliance", "Alliance positioning points to strategic ecosystem motion."],
    ["microsoft partner", "Microsoft partner signal suggests enterprise implementation opportunities."],
    ["aws partner", "AWS partner signal suggests cloud transformation opportunities."],
    ["salesforce partner", "Salesforce partner signal suggests CRM modernization opportunities."],
  ]);
}

export function detectProductLaunchSignals(content: string): string[] {
  return matches(content, [
    ["launch", "Launch references point to new product or service timing."],
    ["new product", "New product positioning points to active GTM motion."],
    ["platform", "Platform messaging suggests repeatable productized workflow opportunity."],
    ["release", "Release references point to product roadmap activity."],
  ]);
}

export function detectHiringBurstSignals(hiring: HiringIntelligence): string[] {
  if (hiring.hiringVolume === "high") return ["High visible hiring volume suggests immediate scaling pressure."];
  if (hiring.hiringVolume === "moderate") return ["Moderate hiring volume suggests active team expansion."];
  return [];
}

export function detectOperationalComplexitySignals(profile: ProfileForTriggers, hiring: HiringIntelligence): string[] {
  return unique([
    ...profile.operationalSignals.map((signal) => interpretExecutiveSignal(signal)),
    ...hiring.operationalStressSignals,
    ...(profile.industry === "BPO/contact center" ? ["High-volume service delivery suggests SLA, staffing, QA, and billing complexity."] : []),
    ...(profile.industry === "enterprise IT services" ? ["Project delivery model suggests proposal, resource, and handoff complexity."] : []),
    ...(profile.industry === "healthcare SaaS" ? ["Healthcare workflow model suggests onboarding, claims, billing, and compliance complexity."] : []),
  ]).slice(0, 7);
}

export function detectUrgencySignals(trigger: Omit<TriggerIntelligence, "urgencySignals" | "urgencyScore">): string[] {
  const signals: string[] = [];
  if (trigger.hiringBurstSignals.length > 0) signals.push("Hiring activity creates a near-term reason to address repeatable workflows now.");
  if (trigger.expansionSignals.length > 0) signals.push("Expansion signals create timing pressure around scalable operating processes.");
  if (trigger.aiMaturitySignals.length > 0) signals.push("AI adoption signals make workflow orchestration and governance timely.");
  if (trigger.financeTransformationSignals.length > 0) signals.push("Finance transformation signals make reporting and reconciliation automation timely.");
  if (trigger.operationalComplexitySignals.length >= 3) signals.push("Multiple complexity signals suggest manual handoffs may become costly as volume increases.");
  return signals;
}

export function buildTriggerIntelligence(
  profile: ProfileForTriggers,
  hiring: HiringIntelligence,
  content: string,
): TriggerIntelligence {
  const growthSignals = detectGrowthSignals(content, hiring);
  const expansionSignals = detectExpansionSignals(content);
  const transformationSignals = detectTransformationSignals(content);
  const aiMaturitySignals = detectAIMaturitySignals(content, hiring);
  const partnershipSignals = detectPartnershipSignals(content);
  const productLaunchSignals = detectProductLaunchSignals(content);
  const hiringBurstSignals = detectHiringBurstSignals(hiring);
  const operationalComplexitySignals = detectOperationalComplexitySignals(profile, hiring);
  const financeTransformationSignals = unique([
    ...profile.financeWorkflowSignals.map((signal) => `Finance workflow signal: ${signal}.`),
    ...hiring.financeExpansionSignals,
    ...matches(content, [
      ["reconciliation", "Reconciliation positioning points to finance operations automation opportunity."],
      ["billing", "Billing references point to invoice or revenue process pressure."],
      ["financial reporting", "Financial reporting positioning points to reporting automation opportunity."],
      ["revenue cycle", "Revenue cycle positioning points to healthcare finance process pressure."],
    ]),
  ]).slice(0, 7);
  const likelyInitiatives = inferLikelyInitiatives(profile, {
    growthSignals,
    expansionSignals,
    transformationSignals,
    aiMaturitySignals,
    partnershipSignals,
    productLaunchSignals,
    hiringBurstSignals,
    operationalComplexitySignals,
    financeTransformationSignals,
  });
  const base = {
    growthSignals,
    expansionSignals,
    transformationSignals,
    aiMaturitySignals,
    partnershipSignals,
    productLaunchSignals,
    hiringBurstSignals,
    operationalComplexitySignals,
    financeTransformationSignals,
    likelyInitiatives,
    whyNowSignals: [] as string[],
  };
  const urgencySignals = detectUrgencySignals(base);
  const urgencyScore = scoreUrgency(base, urgencySignals);

  return {
    ...base,
    urgencySignals,
    whyNowSignals: unique([...urgencySignals, ...likelyInitiatives.map((initiative) => `Likely initiative: ${initiative}.`)]).slice(0, 6),
    urgencyScore,
  };
}

function inferLikelyInitiatives(
  profile: ProfileForTriggers,
  signals: Pick<
    TriggerIntelligence,
    | "growthSignals"
    | "expansionSignals"
    | "transformationSignals"
    | "aiMaturitySignals"
    | "partnershipSignals"
    | "productLaunchSignals"
    | "hiringBurstSignals"
    | "operationalComplexitySignals"
    | "financeTransformationSignals"
  >,
): string[] {
  const initiatives: string[] = [];
  if (signals.aiMaturitySignals.length > 0) initiatives.push("AI workflow orchestration or AI governance enablement");
  if (signals.transformationSignals.length > 0) initiatives.push("digital transformation or cloud/enterprise workflow modernization");
  if (signals.financeTransformationSignals.length > 0) initiatives.push("finance reporting, reconciliation, or billing workflow automation");
  if (signals.operationalComplexitySignals.length > 0) initiatives.push("delivery handoff, onboarding, or operational reporting automation");
  if (signals.growthSignals.length > 0 || signals.hiringBurstSignals.length > 0) initiatives.push("repeatable GTM and account intelligence workflows");
  if (profile.industry === "healthcare SaaS") initiatives.push("provider onboarding and revenue-cycle workflow improvement");
  return unique(initiatives).slice(0, 6);
}

function scoreUrgency(
  signals: Pick<TriggerIntelligence, "growthSignals" | "expansionSignals" | "transformationSignals" | "aiMaturitySignals" | "hiringBurstSignals" | "operationalComplexitySignals" | "financeTransformationSignals">,
  urgencySignals: string[],
): number {
  let score = 42;
  score += Math.min(12, signals.growthSignals.length * 3);
  score += Math.min(12, signals.expansionSignals.length * 4);
  score += Math.min(12, signals.transformationSignals.length * 3);
  score += Math.min(14, signals.aiMaturitySignals.length * 4);
  score += Math.min(10, signals.hiringBurstSignals.length * 5);
  score += Math.min(10, signals.financeTransformationSignals.length * 3);
  score += Math.min(10, urgencySignals.length * 4);
  score += Math.min(8, signals.operationalComplexitySignals.length * 2);
  return Math.max(35, Math.min(96, score));
}

function matches(content: string, patterns: Array<[string, string]>): string[] {
  const lower = content.toLowerCase();
  return patterns.filter(([pattern]) => lower.includes(pattern.toLowerCase())).map(([, signal]) => signal);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
