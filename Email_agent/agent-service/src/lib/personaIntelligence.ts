import type { CompanyPainPointSet } from "./companyPainPointEngine.js";
import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import type { HiringIntelligence } from "./hiringIntelligence.js";
import type { TriggerIntelligence } from "./triggerIntelligence.js";
import { diversifyStrategicText } from "./strategicLanguageVariation.js";

type ProfileForPersona = Pick<DeepCompanyProfile, "industry" | "likelyBuyerPersonas" | "companyName">;

export interface PersonaStrategy {
  persona: string;
  priority: "primary" | "secondary" | "nurture";
  painPoints: string[];
  triggerAlignment: string[];
  angle: string;
}

export interface PersonaIntelligence {
  primaryBuyer: string;
  secondaryBuyers: string[];
  personaStrategies: PersonaStrategy[];
}

export function inferPrimaryBuyer(profile: ProfileForPersona, trigger: TriggerIntelligence, hiring: HiringIntelligence): string {
  if (hiring.departmentsHiring.includes("GTM / revenue")) return "VP Revenue Operations";
  if (hiring.departmentsHiring.includes("customer success / delivery")) return "Director Professional Services";
  if (hiring.departmentsHiring.includes("finance operations") || trigger.financeTransformationSignals.length > 0) return "Director Financial Operations";
  if (trigger.aiMaturitySignals.length > 0) return "Enterprise Transformation Director";
  if (profile.industry === "healthcare SaaS") return "Healthcare Revenue Cycle Lead";
  if (profile.industry === "software product engineering") return "Director Delivery Excellence";
  if (profile.industry === "BPO/contact center") return "Director Delivery Excellence";
  return profile.likelyBuyerPersonas[0] ?? "VP Revenue Operations";
}

export function inferSecondaryBuyers(profile: ProfileForPersona, trigger: TriggerIntelligence, hiring: HiringIntelligence): string[] {
  const personas = [
    ...profile.likelyBuyerPersonas,
    ...(trigger.operationalComplexitySignals.length > 0 ? ["Implementation Excellence Lead", "Director Delivery Excellence"] : []),
    ...(trigger.aiMaturitySignals.length > 0 ? ["Head of Solution Engineering", "Enterprise Transformation Director"] : []),
    ...(trigger.financeTransformationSignals.length > 0 ? ["Director Financial Operations"] : []),
    ...(hiring.departmentsHiring.includes("GTM / revenue") ? ["VP Revenue Operations"] : []),
  ];
  return unique(personas).slice(0, 6);
}

export function mapPainPointsToPersona(persona: string, pain: CompanyPainPointSet): string[] {
  if (/Revenue|Sales|GTM/i.test(persona)) return pain.painPoints.filter((point) => /SDR|lead|sales|pipeline|proposal|account/i.test(point)).slice(0, 3);
  if (/Delivery|Implementation|Professional Services|Onboarding/i.test(persona)) return pain.painPoints.filter((point) => /delivery|handoff|implementation|onboarding|resource|support/i.test(point)).slice(0, 3);
  if (/Finance|Revenue Cycle|CFO/i.test(persona)) return pain.painPoints.filter((point) => /finance|billing|claims|reconciliation|reporting|invoice/i.test(point)).slice(0, 3);
  if (/Transformation|Solution|Engineering|CTO|CIO/i.test(persona)) return pain.painPoints.filter((point) => /AI|integration|workflow|data|technical|security|automation/i.test(point)).slice(0, 3);
  return pain.painPoints.slice(0, 3);
}

export function mapTriggersToPersona(persona: string, trigger: TriggerIntelligence): string[] {
  if (/Revenue|Sales|GTM/i.test(persona)) return unique([...trigger.growthSignals, ...trigger.hiringBurstSignals]).slice(0, 3);
  if (/Delivery|Implementation|Professional Services|Onboarding/i.test(persona)) return trigger.operationalComplexitySignals.slice(0, 3);
  if (/Finance|Revenue Cycle|CFO/i.test(persona)) return trigger.financeTransformationSignals.slice(0, 3);
  if (/Transformation|Solution|Engineering|CTO|CIO/i.test(persona)) return unique([...trigger.aiMaturitySignals, ...trigger.transformationSignals]).slice(0, 3);
  return trigger.whyNowSignals.slice(0, 3);
}

export function generatePersonaSpecificAngles(persona: string, profile: ProfileForPersona, trigger: TriggerIntelligence): string {
  const context = { companyName: profile.companyName, industry: profile.industry, persona };
  if (/Revenue|Sales|GTM/i.test(persona)) return diversifyStrategicText(`Position account intelligence and SDR execution support around ${profile.companyName}'s growth and pipeline execution pressure.`, context);
  if (/Delivery|Implementation|Professional Services|Onboarding/i.test(persona)) return diversifyStrategicText(`Position delivery continuity and onboarding support around ${profile.companyName}'s implementation and scaling signals.`, context);
  if (/Finance|Revenue Cycle|CFO/i.test(persona)) return diversifyStrategicText(`Position reconciliation, billing, and reporting automation around ${profile.companyName}'s finance process signals.`, context);
  if (/Transformation|Solution|Engineering|CTO|CIO/i.test(persona)) return diversifyStrategicText(`Position AI orchestration and governance around ${trigger.aiMaturitySignals.length > 0 ? "detected AI signals" : "modernization signals"}.`, context);
  return diversifyStrategicText(`Position a small operational review around ${profile.companyName}'s current growth signals.`, context);
}

export function generatePersonaPriority(persona: string, primaryBuyer: string): PersonaStrategy["priority"] {
  if (persona === primaryBuyer) return "primary";
  if (/Director|Head|VP|Lead|CFO|CIO|CTO/i.test(persona)) return "secondary";
  return "nurture";
}

export function buildPersonaIntelligence(
  profile: DeepCompanyProfile,
  pain: CompanyPainPointSet,
  trigger: TriggerIntelligence,
  hiring: HiringIntelligence,
): PersonaIntelligence {
  const primaryBuyer = inferPrimaryBuyer(profile, trigger, hiring);
  const secondaryBuyers = inferSecondaryBuyers(profile, trigger, hiring).filter((persona) => persona !== primaryBuyer);
  const all = unique([primaryBuyer, ...secondaryBuyers]).slice(0, 6);
  const personaStrategies = all.map((persona) => ({
    persona,
    priority: generatePersonaPriority(persona, primaryBuyer),
    painPoints: mapPainPointsToPersona(persona, pain),
    triggerAlignment: mapTriggersToPersona(persona, trigger),
    angle: generatePersonaSpecificAngles(persona, profile, trigger),
  }));

  return { primaryBuyer, secondaryBuyers, personaStrategies };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
