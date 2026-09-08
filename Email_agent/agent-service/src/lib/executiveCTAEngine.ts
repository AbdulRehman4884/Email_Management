import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import type { BuyerPersonaProfile } from "./executiveIntelligenceEngine.js";
import { mapIndustryNarrative } from "./industryNarrativeMapper.js";
import { humanizeOutreachText } from "./outreachHumanizationEngine.js";
import { pickStrategicPhrase } from "./strategicLanguageVariation.js";

export type ExecutiveCTAStyle =
  | "soft"
  | "direct"
  | "exploratory"
  | "strategy-call"
  | "transformation-discussion"
  | "finance-review"
  | "delivery-assessment"
  | "operational-review";

export interface ExecutiveCTAContext {
  profile: DeepCompanyProfile;
  persona?: BuyerPersonaProfile;
  department?: string;
  pressure?: string;
  trigger?: string;
  maturity?: "early" | "developing" | "mature";
}

export interface ExecutiveCTASet {
  soft: string;
  direct: string;
  consultative: string;
  operational: string;
  exploratory: string;
  strategicReview: string;
  transformation: string;
  financeReview: string;
  deliveryAssessment: string;
}

export function buildExecutiveCTASet(context: ExecutiveCTAContext): ExecutiveCTASet {
  const department = departmentLabel(context);
  const persona = context.persona?.persona ?? context.profile.primaryBuyerPersona;
  const narrative = mapIndustryNarrative({
    companyName: context.profile.companyName,
    industry: context.profile.industry,
    services: context.profile.services,
    signals: [...context.profile.keySignals, ...(context.profile.triggerSignals ?? [])],
  });
  const review = pickStrategicPhrase("nextStep", {
    companyName: context.profile.companyName,
    industry: context.profile.industry,
    persona,
    trigger: context.trigger,
  });
  const campaignPreview = pickStrategicPhrase("campaignPreview", {
    companyName: context.profile.companyName,
    industry: context.profile.industry,
    persona,
    trigger: context.trigger,
  });

  const set = {
    soft: `Open to comparing notes on a ${review} for ${department}?`,
    direct: `Would it be worth a focused discussion on ${narrative.pressures[0] ?? "message quality"}?`,
    consultative: `I can outline where the first measurable improvement may sit, if that helps your team assess fit.`,
    operational: `Should I send a concise ${review} focused on ${department}?`,
    exploratory: `Worth comparing this against one current priority for ${department}?`,
    strategicReview: `Open to a ${campaignPreview} before this turns into a campaign plan?`,
    transformation: `Would a practical discussion on ${narrative.valueThemes[0] ?? "transformation messaging"} be useful?`,
    financeReview: `Should I share a finance visibility walkthrough grounded in public context and assumed workflows?`,
    deliveryAssessment: `Open to a delivery coordination review focused on where buyer handoff clarity may get harder?`,
  };

  return Object.fromEntries(
    Object.entries(set).map(([key, value]) => [key, humanizeOutreachText(value, {
      companyName: context.profile.companyName,
      industry: context.profile.industry,
      persona,
      offset: key.length,
    })]),
  ) as unknown as ExecutiveCTASet;
}

export function selectExecutiveCTA(
  style: ExecutiveCTAStyle,
  context: ExecutiveCTAContext,
  offset = 0,
): string {
  const ctas = buildExecutiveCTASet({ ...context, trigger: `${context.trigger ?? ""}:${offset}` });
  if (style === "direct") return ctas.direct;
  if (style === "strategy-call") return ctas.strategicReview;
  if (style === "transformation-discussion") return ctas.transformation;
  if (style === "finance-review") return ctas.financeReview;
  if (style === "delivery-assessment") return ctas.deliveryAssessment;
  if (style === "operational-review") return ctas.operational;
  if (style === "exploratory") return ctas.exploratory;
  return ctas.soft;
}

export function ctaStyleForPersona(persona: string, score: number): ExecutiveCTAStyle {
  if (/CFO|Finance|Revenue Cycle/i.test(persona)) return "finance-review";
  if (/Delivery|Services|Onboarding|Implementation/i.test(persona)) return "delivery-assessment";
  if (/Transformation|Digital|CIO|AI|Data/i.test(persona)) return "transformation-discussion";
  if (score >= 78) return "strategy-call";
  if (/CFO|COO|VP/i.test(persona)) return "exploratory";
  return "soft";
}

function departmentLabel(context: ExecutiveCTAContext): string {
  if (context.department) return context.department.toLowerCase();
  const persona = context.persona?.persona ?? context.profile.primaryBuyerPersona;
  if (/CFO|Finance|Revenue Cycle/i.test(persona)) return "finance operations";
  if (/Delivery|Services|Onboarding|Implementation/i.test(persona)) return "delivery leadership";
  if (/Transformation|Digital|CIO|AI|Data/i.test(persona)) return "transformation leadership";
  if (/Revenue|Sales|GTM/i.test(persona)) return "revenue operations";
  return "operations leadership";
}
