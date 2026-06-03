import type { CompanyPainPointSet } from "./companyPainPointEngine.js";
import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import type { PersonaIntelligence, PersonaStrategy } from "./personaIntelligence.js";
import type { TriggerIntelligence } from "./triggerIntelligence.js";
import { buildExecutiveCTASet } from "./executiveCTAEngine.js";
import { interpretExecutiveSignal } from "./executiveSignalInterpreter.js";
import { executiveSubjectFor, mapIndustryNarrative } from "./industryNarrativeMapper.js";
import { humanizeOutreachText } from "./outreachHumanizationEngine.js";
import { diversifyStrategicText, pickStrategicPhrase } from "./strategicLanguageVariation.js";

export interface TriggerAwareOutreach {
  triggerAwareAngle: string;
  urgencyAwareCTA: string;
  triggerAwareSubject: string;
  founderLedEmail: string;
  personaVariants: Array<{
    persona: string;
    email: string;
    linkedin: string;
  }>;
  triggerSpecificObjections: string[];
  whyNowReasoning: string[];
}

export function generateTriggerAwareAngle(profile: DeepCompanyProfile, trigger: TriggerIntelligence): string {
  const why = trigger.whyNowSignals[0] ?? "signals suggest operational workflows may need more repeatability";
  const narrative = mapIndustryNarrative({ companyName: profile.companyName, industry: profile.industry, services: profile.services, signals: profile.keySignals });
  if (trigger.hiringBurstSignals.length > 0) return humanizeOutreachText(`${why} Lead with a hiring-driven angle tied to ${narrative.pressures[0]}, onboarding clarity, and reporting consistency.`, contextFor(profile, "hiring"));
  if (trigger.financeTransformationSignals.length > 0) return humanizeOutreachText(`${why} Lead with finance visibility around reconciliation, billing context, and reporting quality.`, contextFor(profile, "finance"));
  if (trigger.aiMaturitySignals.length > 0) return humanizeOutreachText(`${why} Lead with AI adoption, governance, and proof-of-value support.`, contextFor(profile, "ai"));
  if (trigger.operationalComplexitySignals.length > 0) return humanizeOutreachText(`${why} Lead with delivery continuity and cross-functional alignment.`, contextFor(profile, "operations"));
  return humanizeOutreachText(`Lead with a low-risk ${pickStrategicPhrase("nextStep", contextFor(profile, "fallback"))} for ${profile.companyName}'s likely sales, delivery, and finance coordination points.`, contextFor(profile, "fallback"));
}

export function generateUrgencyAwareCTA(trigger: TriggerIntelligence): string {
  if (trigger.urgencyScore >= 78) return "Open to a brief note on the highest-friction handoff point?";
  if (trigger.urgencyScore >= 62) return "Worth comparing this against the team most affected by the current timing signal?";
  return "Open to a brief note with one practical improvement area?";
}

export function generateRoleSpecificEmail(
  profile: DeepCompanyProfile,
  persona: PersonaStrategy,
  trigger: TriggerIntelligence,
  cta = generateUrgencyAwareCTA(trigger),
): string {
  const triggerLine = interpretExecutiveSignal(persona.triggerAlignment[0] ?? trigger.whyNowSignals[0] ?? "public signals point to operating scale becoming more important", contextFor(profile, persona.persona));
  const painLine = persona.painPoints[0] ?? "manual research, handoffs, and reporting can become expensive as teams scale";
  return humanizeOutreachText([
    "Hi {{first_name}},",
    "",
    `${profile.companyName} looks like a relevant account for ${persona.persona} because ${trimPeriod(triggerLine).charAt(0).toLowerCase()}${trimPeriod(triggerLine).slice(1)}.`,
    "",
    `The likely pressure point is ${painLine.charAt(0).toLowerCase()}${trimPeriod(painLine).slice(1)}.`,
    "",
    `A useful starting point would be read-only account intelligence that prepares context, flags likely objections, and clarifies next-step ownership before the team acts.`,
    "",
    cta,
    "",
    "Best,",
    "{{sender_name}}",
  ].join("\n"), contextFor(profile, persona.persona));
}

export function generateRoleSpecificLinkedIn(profile: DeepCompanyProfile, persona: PersonaStrategy, trigger: TriggerIntelligence): string {
  const reason = interpretExecutiveSignal(persona.triggerAlignment[0] ?? trigger.whyNowSignals[0] ?? "public signals point to scaling pressure", contextFor(profile, persona.persona));
  return humanizeOutreachText(`Hi {{first_name}}, ${profile.companyName} looks relevant through a ${persona.persona} lens. ${trimPeriod(reason)}. I had a concise outreach angle if useful.`, contextFor(profile, persona.persona));
}

export function generateTriggerSpecificObjections(trigger: TriggerIntelligence): string[] {
  const objections: string[] = [];
  if (trigger.aiMaturitySignals.length > 0) objections.push("AI governance, explainability, or security review may slow adoption.");
  if (trigger.financeTransformationSignals.length > 0) objections.push("Finance stakeholders may need proof that automation will not disrupt controls.");
  if (trigger.hiringBurstSignals.length > 0) objections.push("Team may be focused on hiring capacity before process automation.");
  if (trigger.operationalComplexitySignals.length > 0) objections.push("Operations leaders may worry about implementation overhead.");
  return objections.length > 0 ? objections : ["Timing, ownership, and implementation effort may be the first objections."];
}

export function generateWhyNowReasoning(trigger: TriggerIntelligence): string[] {
  return trigger.whyNowSignals.length > 0
    ? trigger.whyNowSignals
    : ["Current website signals are moderate; verify recent hiring, partnership, and product activity before prioritizing."];
}

export function buildTriggerAwareOutreach(
  profile: DeepCompanyProfile,
  pain: CompanyPainPointSet,
  trigger: TriggerIntelligence,
  personas: PersonaIntelligence,
): TriggerAwareOutreach {
  const urgencyAwareCTA = generateUrgencyAwareCTA(trigger);
  const triggerAwareAngle = generateTriggerAwareAngle(profile, trigger);
  const personaVariants = personas.personaStrategies.slice(0, 3).map((persona) => ({
    persona: persona.persona,
    email: generateRoleSpecificEmail(profile, persona, trigger, urgencyAwareCTA),
    linkedin: generateRoleSpecificLinkedIn(profile, persona, trigger),
  }));
  const primaryPain = pain.painPoints[0] ?? "workflow scale pressure";
  const ctaSet = buildExecutiveCTASet({ profile, department: personas.primaryBuyer, trigger: trigger.whyNowSignals[0] });

  return {
    triggerAwareAngle,
    urgencyAwareCTA,
    triggerAwareSubject: subjectFor(profile, trigger),
    founderLedEmail: humanizeOutreachText([
      "Hi {{first_name}},",
      "",
      `${profile.companyName} appears to have a timely outreach angle: ${trimPeriod(interpretExecutiveSignal(trigger.whyNowSignals[0] ?? "public signals point to operating scale becoming more important", contextFor(profile, "founder"))).charAt(0).toLowerCase()}${trimPeriod(interpretExecutiveSignal(trigger.whyNowSignals[0] ?? "public signals point to operating scale becoming more important", contextFor(profile, "founder"))).slice(1)}.`,
      "",
      `That usually creates pressure around ${primaryPain.charAt(0).toLowerCase()}${trimPeriod(primaryPain).slice(1)}.`,
      "",
      `A low-risk first step could be a read-only ${pickStrategicPhrase("nextStep", contextFor(profile, "founder"))} before any system changes.`,
      "",
      ctaSet.consultative,
      "",
      "Best,",
      "{{sender_name}}",
    ].join("\n"), contextFor(profile, "founder")),
    personaVariants,
    triggerSpecificObjections: generateTriggerSpecificObjections(trigger),
    whyNowReasoning: generateWhyNowReasoning(trigger),
  };
}

function subjectFor(profile: DeepCompanyProfile, trigger: TriggerIntelligence): string {
  return executiveSubjectFor({
    companyName: profile.companyName,
    industry: profile.industry,
    persona: profile.primaryBuyerPersona,
    signals: [...profile.keySignals, ...trigger.whyNowSignals],
    offset: trigger.urgencyScore,
  });
}

function trimPeriod(value: string): string {
  return value.trim().replace(/[.!?]+$/g, "");
}

function contextFor(profile: DeepCompanyProfile, trigger: string) {
  return {
    companyName: profile.companyName,
    industry: profile.industry,
    persona: profile.primaryBuyerPersona,
    trigger,
  };
}
