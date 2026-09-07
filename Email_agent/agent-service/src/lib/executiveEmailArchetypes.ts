import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import type { BuyerPersonaProfile, ExecutiveIntelligence } from "./executiveIntelligenceEngine.js";
import type { StrategicNarrative } from "./strategicNarrativeEngine.js";
import { selectExecutiveCTA, type ExecutiveCTAStyle } from "./executiveCTAEngine.js";
import { executiveSubjectFor, mapIndustryNarrative } from "./industryNarrativeMapper.js";
import { humanizeOutreachText } from "./outreachHumanizationEngine.js";
import { buildPersonaNarrative, personaOpening } from "./personaNarrativeEngine.js";
import { diversifyStrategicText, pickStrategicPhrase } from "./strategicLanguageVariation.js";

export type ExecutiveEmailArchetype =
  | "strategic-advisory"
  | "operational-insight"
  | "executive-transformation"
  | "ai-modernization"
  | "finance-optimization"
  | "delivery-excellence"
  | "soft-consultative"
  | "direct-executive";

export interface ArchetypeEmailContext {
  profile: DeepCompanyProfile;
  executive: ExecutiveIntelligence;
  narrative: StrategicNarrative;
  persona: BuyerPersonaProfile;
  ctaStyle: ExecutiveCTAStyle;
}

const BANNED = /\b(revolutionary|game-changing|unlock|10x|guaranteed)\b/gi;

export function generateExecutiveArchetypeEmail(
  archetype: ExecutiveEmailArchetype,
  context: ArchetypeEmailContext,
  offset = 0,
): string {
  const { profile, narrative, persona } = context;
  const cta = selectExecutiveCTA(context.ctaStyle, {
    profile,
    persona,
    department: narrative.firstDepartmentToBenefit,
    pressure: narrative.operationalPressure,
    trigger: archetype,
  }, offset);
  const review = pickStrategicPhrase("campaignPreview", {
    companyName: profile.companyName,
    industry: profile.industry,
    persona: persona.persona,
    trigger: archetype,
  }, offset);
  const pressure = clean(narrative.operationalPressure);
  const outcome = clean(narrative.businessOutcome);
  const angle = clean(narrative.strategicAngle);
  const industry = mapIndustryNarrative({
    companyName: profile.companyName,
    industry: profile.industry,
    services: profile.services,
    signals: [...profile.keySignals, ...(profile.triggerSignals ?? [])],
  });
  const personaNarrative = buildPersonaNarrative({
    persona: persona.persona,
    companyName: profile.companyName,
    industry: profile.industry,
    signals: profile.keySignals,
  });
  const opening = personaOpening({
    companyName: profile.companyName,
    persona: persona.persona,
    industry: profile.industry,
    offset,
  });

  const templates: Record<ExecutiveEmailArchetype, string[]> = {
    "strategic-advisory": [
      "Hi {{first_name}},",
      "",
      opening,
      "",
      `What usually becomes difficult at this stage is keeping ${industry.pressures[0]} and ${industry.pressures[1]} visible enough before the campaign reaches senior buyers.`,
      "",
      cta,
      "",
      "Best,",
      "{{sender_name}}",
    ],
    "operational-insight": [
      "Hi {{first_name}},",
      "",
      `A pattern worth testing at ${profile.companyName}: ${industry.valueThemes[0]} may be a stronger first-touch theme than a broad automation message.`,
      "",
      `That gives ${persona.persona} a concrete way to discuss ${outcome.toLowerCase()} without overstating what public data can prove.`,
      "",
      cta,
      "",
      "Best,",
      "{{sender_name}}",
    ],
    "executive-transformation": [
      "Hi {{first_name}},",
      "",
      `${profile.companyName} looks like a business where transformation messaging needs to stay close to operating reality.`,
      "",
      `The useful entry point may be ${narrative.firstDepartmentToBenefit.toLowerCase()}: where ${personaNarrative.priorities[0]}, ${personaNarrative.priorities[1]}, and ${personaNarrative.priorities[2]} meet.`,
      "",
      cta,
      "",
      "Best,",
      "{{sender_name}}",
    ],
    "ai-modernization": [
      "Hi {{first_name}},",
      "",
      `If AI is part of the agenda at ${profile.companyName}, the stronger outreach angle is probably not AI itself.`,
      "",
      `It is whether ${persona.persona} can see where research, qualification, and follow-up become easier to govern and easier to explain.`,
      "",
      cta,
      "",
      "Best,",
      "{{sender_name}}",
    ],
    "finance-optimization": [
      "Hi {{first_name}},",
      "",
      `The finance angle for ${profile.companyName} is straightforward: growth creates more places for billing context, reporting assumptions, and exception follow-up to drift.`,
      "",
      `A ${review} could show where outreach and account follow-up should protect visibility before execution begins.`,
      "",
      cta,
      "",
      "Best,",
      "{{sender_name}}",
    ],
    "delivery-excellence": [
      "Hi {{first_name}},",
      "",
      `For service-led companies like ${profile.companyName}, the commercial risk often sits between promise and delivery.`,
      "",
      `A focused ${review} can translate the company narrative into buyer messages, likely objections, and next-step ownership for ${narrative.firstDepartmentToBenefit.toLowerCase()}.`,
      "",
      cta,
      "",
      "Best,",
      "{{sender_name}}",
    ],
    "soft-consultative": [
      "Hi {{first_name}},",
      "",
      `Timing may be early, but ${profile.companyName}'s growth trajectory raises a practical question around ${angle.toLowerCase()}.`,
      "",
      `I can keep it lightweight: a short perspective on likely buyer pressure, sequence framing, and where the message should stay grounded.`,
      "",
      cta,
      "",
      "Best,",
      "{{sender_name}}",
    ],
    "direct-executive": [
      "Hi {{first_name}},",
      "",
      `${profile.companyName} appears to have enough commercial complexity for a more specific campaign than generic AI or automation outreach.`,
      "",
      `The strongest angle I see is ${angle.toLowerCase()}, aimed at ${persona.persona} and tied to ${personaNarrative.valueProposition.toLowerCase()}.`,
      "",
      cta,
      "",
      "Best,",
      "{{sender_name}}",
    ],
  };

  return email(templates[archetype], context, offset);
}

export function generateExecutiveSubjectLine(context: ArchetypeEmailContext, offset = 0): string {
  return executiveSubjectFor({
    companyName: context.profile.companyName,
    industry: context.profile.industry,
    persona: context.persona.persona,
    signals: context.profile.keySignals,
    offset,
  });
}

export function generateArchetypeLinkedInMessage(
  context: ArchetypeEmailContext,
): string {
  const { profile, narrative, persona } = context;
  return text(
    `Hi {{first_name}}, ${profile.companyName} looks like a useful fit for a ${persona.persona} discussion around ${clean(narrative.strategicAngle).toLowerCase()}. I had a concise campaign angle that keeps the message tied to public positioning.`,
  );
}

function email(lines: string[], context: ArchetypeEmailContext, offset: number): string {
  return text(humanizeOutreachText(diversifyStrategicText(lines.join("\n"), {
    companyName: context.profile.companyName,
    industry: context.profile.industry,
    persona: context.persona.persona,
    trigger: `${context.ctaStyle}:${offset}`,
  }), {
    companyName: context.profile.companyName,
    industry: context.profile.industry,
    persona: context.persona.persona,
    offset,
  }));
}

function text(value: string): string {
  return value.replace(BANNED, "").replace(/[ \t]{2,}/g, " ").trim();
}

function clean(value: string): string {
  return value.trim().replace(/[.!?]+$/g, "");
}
