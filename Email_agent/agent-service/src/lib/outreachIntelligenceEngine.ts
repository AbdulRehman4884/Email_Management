import type { CompanyPainPointSet } from "./companyPainPointEngine.js";
import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import { buildExecutiveCTASet } from "./executiveCTAEngine.js";
import { executiveSubjectFor, mapIndustryNarrative } from "./industryNarrativeMapper.js";
import { humanizeOutreachText } from "./outreachHumanizationEngine.js";
import { diversifyStrategicText } from "./strategicLanguageVariation.js";

export interface OutreachIntelligence {
  outreachAngle: string;
  valueHypothesis: string;
  bestCTA: string;
  deliverabilitySafeSubject: string;
  founderStyleEmail: string;
  linkedinMessage: string;
  likelyObjections: string[];
  objectionHandlingNotes: string[];
  hotLeadScore: number;
  leadPriority: "high" | "medium" | "low";
  nextBestAction: string;
}

const BANNED_WORDS = /\b(revolutionary|game-changing|unlock)\b/gi;

export function generateOutreachIntelligence(
  profile: DeepCompanyProfile,
  pain: CompanyPainPointSet,
): OutreachIntelligence {
  const primaryPain = cleanFragment(pain.painPoints[0] ?? "manual account research and operational handoffs");
  const primaryOpportunity = cleanFragment(pain.aiOpportunities[0] ?? "AI-assisted account research and next-step recommendations");
  const financeOpportunity = cleanFragment(pain.financeAutomationOpportunities[0] ?? "finance workflow reporting automation");
  const narrative = mapIndustryNarrative({
    companyName: profile.companyName,
    industry: profile.industry,
    services: profile.services,
    signals: profile.keySignals,
  });

  const outreachAngle = sentence(
    `Lead with ${profile.companyName}'s ${narrative.vertical} context: connect ${narrative.pressures[0]} to ${primaryOpportunity.toLowerCase()}.`,
  );

  const valueHypothesis = sentence(
    `${profile.companyName} may get leverage from a lightweight account review that prepares research, likely objections, and finance notes before the first sales conversation.`,
  );

  const bestCTA = buildExecutiveCTASet({ profile }).strategicReview;
  const hotLeadScore = scoreLead(profile, pain);
  const leadPriority = hotLeadScore >= 82 ? "high" : hotLeadScore >= 68 ? "medium" : "low";
  const likelyObjections = objectionsFor(profile);
  const objectionHandlingNotes = objectionNotesFor(profile);

  const founderStyleEmail = sanitizeEmail(
    [
      "Hi {{first_name}},",
      "",
      `${profile.companyName}'s ${narrative.vertical} story gives the first touch a practical way in around ${narrative.valueThemes.slice(0, 2).join(" and ").toLowerCase()}.`,
      "",
      `A pattern I see with teams in this category is that ${primaryPain.charAt(0).toLowerCase()}${primaryPain.slice(1)}.`,
      "",
      `One practical use case: ${primaryOpportunity}. A second is ${financeOpportunity.charAt(0).toLowerCase()}${financeOpportunity.slice(1)}.`,
      "",
      humanizeOutreachText(bestCTA, { companyName: profile.companyName, industry: profile.industry }),
      "",
      "Best,",
      "{{sender_name}}",
    ].join("\n"),
  );

  const linkedinMessage = sanitizeText(
    `Hi {{first_name}}, ${profile.companyName}'s ${narrative.vertical} work looks like a fit for a more specific executive outreach angle. I had a concise idea for improving account context before a campaign goes live.`,
  );

  return {
    outreachAngle: sanitizeText(outreachAngle),
    valueHypothesis: sanitizeText(valueHypothesis),
    bestCTA,
    deliverabilitySafeSubject: subjectFor(profile),
    founderStyleEmail,
    linkedinMessage,
    likelyObjections,
    objectionHandlingNotes,
    hotLeadScore,
    leadPriority,
    nextBestAction: nextActionFor(leadPriority, profile),
  };
}

function subjectFor(profile: DeepCompanyProfile): string {
  return executiveSubjectFor({
    companyName: profile.companyName,
    industry: profile.industry,
    persona: profile.primaryBuyerPersona,
    signals: profile.keySignals,
  });
  /*
  if (profile.industry === "healthcare SaaS") return `${profile.companyName} onboarding idea`;
  if (profile.industry === "fintech platform") return `${profile.companyName} finance workflow note`;
  if (profile.industry === "AI decisioning platform") return `${profile.companyName} proof-of-value idea`;
  if (profile.industry === "enterprise IT services") return `${profile.companyName} delivery handoff idea`;
  if (profile.industry === "software product engineering") return `${profile.companyName} scoping workflow idea`;
  if (profile.industry === "BPO/contact center") return `${profile.companyName} reporting workflow idea`;
  return `${profile.companyName} workflow idea`;
  */
}

function objectionsFor(profile: DeepCompanyProfile): string[] {
  switch (profile.industry) {
    case "healthcare SaaS":
      return ["Compliance and data privacy concerns", "Integration effort with existing EHR or billing workflows", "Implementation bandwidth"];
    case "enterprise IT services":
      return ["Already has CRM/project tools", "Delivery teams are busy", "Needs proof this improves margins or cycle time"];
    case "software product engineering":
      return ["Senior team does scoping manually today", "Concern about AI quality for technical discovery", "Unclear ownership between sales and delivery"];
    case "fintech platform":
      return ["Risk and security review", "ROI proof for finance stakeholders", "Integration burden with existing systems"];
    case "AI decisioning platform":
      return ["Explainability requirements", "Security and procurement review", "Need for measurable pilot outcomes"];
    case "BPO/contact center":
      return ["Existing workforce and QA tools", "Client data sensitivity", "Need to prove reporting time savings"];
    default:
      return ["Timing", "Existing tools", "Implementation effort"];
  }
}

function objectionNotesFor(profile: DeepCompanyProfile): string[] {
  if (profile.industry === "AI decisioning platform") {
    return ["Lead with a contained proof-of-value workflow and avoid claims about model performance.", "Offer reporting, explainability, and buyer education support rather than broad AI replacement."];
  }
  if (profile.industry === "healthcare SaaS") {
    return ["Keep the first touch operational and avoid unverified compliance claims.", "Frame the idea around admin handoffs, billing exceptions, and support triage."];
  }
  if (profile.industry.includes("IT") || profile.industry.includes("engineering")) {
    return ["Tie the use case to proposal quality, resource planning, and delivery margin.", "Avoid implying their delivery process is broken; position as a lightweight research and handoff layer."];
  }
    return ["Keep the scope small and measurable.", "Use a soft CTA that offers a specific operational review instead of a sales demo."];
}

function scoreLead(profile: DeepCompanyProfile, pain: CompanyPainPointSet): number {
  let score = 52;
  score += Math.round(profile.confidence * 0.22);
  if (profile.industry !== "B2B services or technology provider") score += 8;
  if (profile.financeWorkflowSignals.length > 0) score += 5;
  if (profile.salesWorkflowSignals.length > 0) score += 5;
  if (profile.growthSignals.length > 0) score += 4;
  if (pain.painPoints.length >= 5) score += 4;
  if (profile.risks.length >= 3) score -= 4;
  return Math.max(35, Math.min(95, score));
}

function nextActionFor(priority: OutreachIntelligence["leadPriority"], profile: DeepCompanyProfile): string {
  if (priority === "high") {
    return `Prioritize ${profile.companyName} for a founder-led first touch using the ${profile.industry} operating-intelligence angle, then verify buyer names on LinkedIn.`;
  }
  if (priority === "medium") {
    return `Run a lightweight LinkedIn-first touch for ${profile.companyName}, then follow with the email if the buyer persona is confirmed.`;
  }
  return `Keep ${profile.companyName} in research queue until website, buyer, or growth signals are verified.`;
}

function sentence(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}

function sanitizeEmail(value: string): string {
  const cleaned = value.replace(BANNED_WORDS, "").replace(/[ \t]{2,}/g, " ").trim();
  const words = cleaned.split(/\s+/);
  if (words.length <= 140) return cleaned;

  const allowed = new Set(words.slice(0, 140));
  let used = 0;
  return cleaned
    .split("\n")
    .map((line) =>
      line
        .split(/\s+/)
        .filter((word) => {
          if (!word || used >= 140 || !allowed.has(word)) return false;
          used += 1;
          return true;
        })
        .join(" "),
    )
    .join("\n")
    .trim();
}

function sanitizeText(value: string): string {
  return diversifyStrategicText(value.replace(BANNED_WORDS, "").replace(/\s{2,}/g, " ")).trim();
}

function cleanFragment(value: string): string {
  return value.trim().replace(/[.!?]+$/g, "");
}
