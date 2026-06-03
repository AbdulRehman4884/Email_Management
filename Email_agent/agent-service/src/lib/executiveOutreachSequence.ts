import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import type { ExecutiveIntelligence, BuyerPersonaProfile } from "./executiveIntelligenceEngine.js";
import type { StrategicNarrative } from "./strategicNarrativeEngine.js";
import {
  ctaStyleForPersona,
  selectExecutiveCTA,
  type ExecutiveCTAStyle,
} from "./executiveCTAEngine.js";
import {
  generateArchetypeLinkedInMessage,
  generateExecutiveArchetypeEmail,
} from "./executiveEmailArchetypes.js";

export interface ExecutiveEmailSequence {
  tone: string;
  ctaStyle: "soft" | "direct" | "exploratory" | "strategy-call" | "transformation-discussion";
  coldOutreach: string;
  executiveIntro: string;
  followUp1: string;
  followUp2: string;
  valueReinforcement: string;
  softBreakup: string;
  linkedinMessage: string;
}

const BANNED = /\b(revolutionary|game-changing|unlock|10x|guaranteed)\b/gi;

export function buildExecutiveEmailSequence(
  profile: DeepCompanyProfile,
  executive: ExecutiveIntelligence,
  narrative: StrategicNarrative,
): ExecutiveEmailSequence {
  const persona = executive.buyerPersonaProfiles[0] ?? fallbackPersona(profile);
  const tone = toneFor(persona.persona);
  const style = ctaStyleForPersona(persona.persona, executive.scores.strategicOpportunityScore);
  const ctaStyle = legacyStyle(style);
  const context = { profile, executive, narrative, persona, ctaStyle: style };

  return {
    tone,
    ctaStyle,
    coldOutreach: generateExecutiveArchetypeEmail("strategic-advisory", context, 0),
    executiveIntro: generateExecutiveArchetypeEmail("direct-executive", context, 1),
    followUp1: generateExecutiveArchetypeEmail(archetypeFor(profile, persona), context, 2),
    followUp2: generateExecutiveArchetypeEmail("soft-consultative", context, 3),
    valueReinforcement: generateExecutiveArchetypeEmail("executive-transformation", context, 4),
    softBreakup: email([
      "Hi {{first_name}},",
      "",
      "I may be early on this, so I will close the loop.",
      "",
      `If ${profile.companyName} decides to review ${concise(narrative.businessOutcome).toLowerCase()}, ${selectExecutiveCTA("soft", {
        profile,
        persona,
        department: narrative.firstDepartmentToBenefit,
        pressure: narrative.operationalPressure,
        trigger: "soft-breakup",
      }, 5).replace(/[?]+$/g, ".").replace(/^Open to /i, "I can send ")}`,
      "",
      "Best,",
      "{{sender_name}}",
    ]),
    linkedinMessage: generateArchetypeLinkedInMessage(context),
  };
}

function fallbackPersona(profile: DeepCompanyProfile): BuyerPersonaProfile {
  return {
    persona: profile.primaryBuyerPersona,
    priorities: ["campaign readiness", "decision visibility", "buyer-message relevance"],
    likelyObjections: ["timing", "existing tools"],
    outreachAngle: `Lead with ${profile.industry} workflow readiness.`,
    strongestValueProposition: "Improve personalization quality before campaign execution.",
  };
}

function toneFor(persona: string): string {
  if (/CFO|Finance|Revenue Cycle/i.test(persona)) return "CFO tone: concise, commercial, risk-aware, focused on visibility and controls";
  if (/CIO|ERP|Digital|Transformation|AI|Data/i.test(persona)) return "CIO tone: modernization-aware, security-conscious, practical about implementation";
  if (/COO|Operations|Delivery|Services|Onboarding/i.test(persona)) return "COO tone: execution rhythm, context transfer, throughput, and management visibility";
  return "Executive operator tone: concise, researched, commercially practical";
}

function legacyStyle(style: ExecutiveCTAStyle): ExecutiveEmailSequence["ctaStyle"] {
  if (style === "direct") return "direct";
  if (style === "strategy-call") return "strategy-call";
  if (style === "transformation-discussion") return "transformation-discussion";
  if (style === "exploratory" || style === "finance-review" || style === "delivery-assessment" || style === "operational-review") return "exploratory";
  return "soft";
}

function archetypeFor(profile: DeepCompanyProfile, persona: BuyerPersonaProfile) {
  if (/CFO|Finance|Revenue Cycle/i.test(persona.persona)) return "finance-optimization";
  if (/Delivery|Services|Onboarding|Implementation/i.test(persona.persona)) return "delivery-excellence";
  if (/AI|Data|CIO|Digital/i.test(persona.persona) || profile.aiMaturitySignals.length > 0) return "ai-modernization";
  if (/COO|Operations|Transformation/i.test(persona.persona)) return "operational-insight";
  return "operational-insight";
}

function email(lines: string[]): string {
  return text(lines.join("\n"));
}

function text(value: string): string {
  return value.replace(BANNED, "").replace(/[ \t]{2,}/g, " ").trim();
}

function concise(value: string): string {
  return value.trim().replace(/[.!?]+$/g, "");
}
