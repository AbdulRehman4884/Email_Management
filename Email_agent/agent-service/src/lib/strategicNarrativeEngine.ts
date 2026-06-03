import type { CompanyPainPointSet } from "./companyPainPointEngine.js";
import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import type { ExecutiveIntelligence } from "./executiveIntelligenceEngine.js";
import type { ExternalBusinessIntelligence } from "./externalBusinessIntelligence.js";
import { interpretExecutiveSignal } from "./executiveSignalInterpreter.js";
import { mapIndustryNarrative } from "./industryNarrativeMapper.js";
import { humanizeOutreachText } from "./outreachHumanizationEngine.js";
import { diversifyStrategicText, pickStrategicPhrase } from "./strategicLanguageVariation.js";

export interface StrategicNarrative {
  strategicStory: string;
  whyCare: string;
  whyNow: string;
  operationalPressure: string;
  businessOutcome: string;
  firstDepartmentToBenefit: string;
  strategicAngle: string;
  personalizationBasis: string[];
  campaignPositioning: string;
}

export function buildStrategicNarrative(
  profile: DeepCompanyProfile,
  pain: CompanyPainPointSet,
  executive: ExecutiveIntelligence,
  external?: ExternalBusinessIntelligence,
): StrategicNarrative {
  const primaryPriority = executive.executivePriorities[0]?.priority ?? "process intelligence and executive-level visibility";
  const industryNarrative = mapIndustryNarrative({
    companyName: profile.companyName,
    industry: profile.industry,
    services: profile.services,
    signals: [...profile.keySignals, ...profile.triggerSignals],
  });
  const trigger = executive.strategicTriggers[0];
  const buyer = executive.buyerPersonaProfiles[0];
  const businessOutcome = outcomeFor(profile, executive);
  const campaignPreview = pickStrategicPhrase("campaignPreview", contextFor(profile, "positioning"));
  const firstExternal = external?.events[0];
  const whyNow = firstExternal
    ? `${firstExternal.summary} This should be verified before direct use, but it improves outreach timing confidence.`
    : trigger
      ? `${trigger.trigger} gives the campaign a timely reason to discuss ${trigger.businessImplication.toLowerCase()}`
      : "Public signals are moderate, so the campaign should use a careful verification-first message before asserting urgency.";

  return {
    strategicStory: humanizeOutreachText(`${profile.companyName} appears to operate in a ${profile.industry} model where ${industryNarrative.executiveFrame}. The campaign should frame the conversation around ${industryNarrative.valueThemes[0]} and ${industryNarrative.valueThemes[1] ?? primaryPriority.toLowerCase()}, not a broad AI pitch.`, contextFor(profile, "story")),
    whyCare: `${buyer?.persona ?? profile.primaryBuyerPersona} would likely care because the first visible value is ${buyer?.strongestValueProposition ?? pain.painPoints[0] ?? "less manual research and handoff effort"}.`,
    whyNow: diversifyStrategicText(whyNow, contextFor(profile, "why-now")),
    operationalPressure: executive.processInefficiencies[0] ?? pain.painPoints[0] ?? "manual context transfer can make reporting, personalization, and follow-up harder to scale.",
    businessOutcome,
    firstDepartmentToBenefit: firstDepartmentFor(buyer?.persona ?? profile.primaryBuyerPersona),
    strategicAngle: angleFor(profile, executive),
    personalizationBasis: [
      ...executive.sourceAwareness,
      ...((external?.events ?? []).slice(0, 2).map((event) => interpretExecutiveSignal(event.summary, contextFor(profile, event.type)))),
    ],
    campaignPositioning: humanizeOutreachText(`Position this as AI Email Campaign Intelligence: website enrichment, persona-aware messaging, ${campaignPreview}, CSV/manual lead personalization, then user-approved campaign execution.`, contextFor(profile, "campaign-positioning")),
  };
}

function outcomeFor(profile: DeepCompanyProfile, executive: ExecutiveIntelligence): string {
  if (executive.scores.financeTransformationFit >= 72) return "cleaner finance visibility and fewer manual reconciliation or billing handoffs";
  if (executive.scores.operationalComplexityFit >= 72) return "better delivery rhythm, context transfer, and operating visibility";
  if (executive.scores.aiAdoptionFit >= 72) return "controlled AI workflow enablement with clearer proof-of-value";
  if (profile.industry.includes("services")) return "stronger proposal quality and delivery margin protection";
  return "better account-specific messaging and follow-up discipline";
}

function firstDepartmentFor(persona: string): string {
  if (/CFO|Finance|Revenue Cycle/i.test(persona)) return "Finance operations";
  if (/COO|Operations|Delivery|Services|Onboarding|Shared Services/i.test(persona)) return "Operations or delivery leadership";
  if (/CIO|ERP|Digital|Transformation|AI|Data/i.test(persona)) return "Digital transformation or IT leadership";
  if (/Revenue|Sales|GTM/i.test(persona)) return "Revenue operations";
  return "Operations leadership";
}

function angleFor(profile: DeepCompanyProfile, executive: ExecutiveIntelligence): string {
  if (executive.scores.financeTransformationFit >= 75) return `${profile.companyName} finance visibility and workflow control`;
  if (executive.scores.operationalComplexityFit >= 75) return `${profile.companyName} delivery coordination and buyer handoff clarity`;
  if (executive.scores.aiAdoptionFit >= 75) return `${profile.companyName} governed AI adoption and buyer education`;
  return `${profile.companyName} account intelligence and campaign review quality`;
}

function contextFor(profile: DeepCompanyProfile, trigger: string) {
  return {
    companyName: profile.companyName,
    industry: profile.industry,
    persona: profile.primaryBuyerPersona,
    trigger,
  };
}
