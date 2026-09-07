import type { CompanyPainPointSet } from "./companyPainPointEngine.js";
import type { DeepCompanyProfile } from "./deepCompanyProfile.js";
import type { PersonaIntelligence } from "./personaIntelligence.js";
import type { ExternalBusinessIntelligence } from "./externalBusinessIntelligence.js";
import { interpretSignalList } from "./executiveSignalInterpreter.js";
import { diversifyStrategicLines, diversifyStrategicText } from "./strategicLanguageVariation.js";

export interface ExecutivePriority {
  priority: string;
  businessImplication: string;
  confidence: number;
  sourceSignals: string[];
}

export interface StrategicTrigger {
  trigger: string;
  confidence: number;
  businessImplication: string;
  outreachRecommendation: string;
}

export interface BuyerPersonaProfile {
  persona: string;
  priorities: string[];
  likelyObjections: string[];
  outreachAngle: string;
  strongestValueProposition: string;
}

export interface CommercialOpportunityScores {
  urgencyScore: number;
  outreachReadiness: number;
  financeTransformationFit: number;
  aiAdoptionFit: number;
  workflowAutomationFit: number;
  operationalComplexityFit: number;
  enterpriseMaturity: number;
  strategicOpportunityScore: number;
}

export interface ExecutiveIntelligence {
  executivePriorities: ExecutivePriority[];
  boardLevelConcerns: string[];
  departmentalFriction: string[];
  processInefficiencies: string[];
  scalingRisks: string[];
  profitabilityPressures: string[];
  strategicTriggers: StrategicTrigger[];
  buyerPersonaProfiles: BuyerPersonaProfile[];
  scores: CommercialOpportunityScores;
  sourceAwareness: string[];
  confidence: number;
}

export function buildExecutiveIntelligence(
  profile: DeepCompanyProfile,
  pain: CompanyPainPointSet,
  personas: PersonaIntelligence,
  external?: ExternalBusinessIntelligence,
): ExecutiveIntelligence {
  const sourceSignals = sourceSignalsFor(profile);
  const executivePriorities = buildExecutivePriorities(profile, pain, sourceSignals);
  const strategicTriggers = buildStrategicTriggers(profile, external);
  const scores = scoreCommercialOpportunity(profile, pain, strategicTriggers);
  const buyerPersonaProfiles = buildBuyerPersonaProfiles(profile, pain, personas);
  const confidence = Math.round((profile.confidence + average(strategicTriggers.map((trigger) => trigger.confidence)) + scores.outreachReadiness) / 3);

  return {
    executivePriorities,
    boardLevelConcerns: boardConcernsFor(profile),
    departmentalFriction: departmentalFrictionFor(profile, pain),
    processInefficiencies: processInefficienciesFor(profile, pain),
    scalingRisks: scalingRisksFor(profile),
    profitabilityPressures: profitabilityPressuresFor(profile),
    strategicTriggers,
    buyerPersonaProfiles,
    scores,
    sourceAwareness: sourceAwarenessFor(profile),
    confidence: clamp(confidence),
  };
}

function buildExecutivePriorities(profile: DeepCompanyProfile, pain: CompanyPainPointSet, sourceSignals: string[]): ExecutivePriority[] {
  const priorities: ExecutivePriority[] = [
    {
      priority: primaryOutcomeFor(profile),
      businessImplication: `Outreach should connect ${profile.companyName}'s ${profile.industry} model to measurable operating leverage, not generic AI adoption.`,
      confidence: signalConfidence(profile, sourceSignals),
      sourceSignals,
    },
  ];

  if (profile.financeTransformationSignals.length > 0 || pain.financeAutomationOpportunities.length > 0) {
    priorities.push({
      priority: "Finance visibility and control",
      businessImplication: "Finance leaders may care about billing readiness, reconciliation, margin visibility, and management reporting as delivery volume grows.",
      confidence: profile.financeTransformationSignals.length > 0 ? 82 : 66,
      sourceSignals: profile.financeTransformationSignals.slice(0, 3),
    });
  }

  if (profile.aiMaturitySignals.length > 0) {
    priorities.push({
      priority: "AI workflow enablement with governance",
      businessImplication: "AI positioning should focus on controlled workflow support, proof-of-value reporting, and buyer education.",
      confidence: 78,
      sourceSignals: profile.aiMaturitySignals.slice(0, 3),
    });
  }

  if (profile.triggerIntelligence.operationalComplexitySignals.length > 0) {
    priorities.push({
      priority: "Operational scalability",
      businessImplication: "Operations and delivery leaders may be trying to reduce handoff loss, reporting lag, and repeat discovery work.",
      confidence: 76,
      sourceSignals: profile.triggerIntelligence.operationalComplexitySignals.slice(0, 3),
    });
  }

  return priorities.slice(0, 5);
}

function buildStrategicTriggers(profile: DeepCompanyProfile, external?: ExternalBusinessIntelligence): StrategicTrigger[] {
  const triggerSets: Array<[string, string[], string, string]> = [
    ["Hiring expansion", profile.hiringSignals, "Visible hiring activity points to capacity growth and the need for repeatable operating practices.", "Reference team growth carefully and offer an operational readiness assessment rather than assuming headcount targets."],
    ["AI initiative", profile.aiMaturitySignals, "AI-related positioning points to a practical modernization agenda where governance, adoption, and measurable value matter.", "Lead with controlled AI enablement and avoid broad automation claims."],
    ["Digital transformation", profile.triggerIntelligence.transformationSignals, "Modernization themes point to integration effort, implementation discipline, and cross-functional execution pressure.", "Position outreach around delivery rhythm, management visibility, and change-management support."],
    ["Finance modernization", profile.financeTransformationSignals, "Finance-facing signals point to billing readiness, reconciliation control, management reporting, or exception handling pressure.", "Use a CFO or finance operations angle tied to visibility and controls."],
    ["Operational complexity", profile.triggerIntelligence.operationalComplexitySignals, "Multiple operating signals point to coordination pressure across sales, delivery, support, or finance.", "Use a COO or operations angle around repeatable ownership and management visibility."],
    ["Enterprise scaling", profile.growthSignals, "Growth or enterprise positioning can increase onboarding, account coordination, and executive reporting needs.", "Use a campaign angle around account intelligence and disciplined execution."],
  ];

  const websiteTriggers = triggerSets
    .filter(([, signals]) => signals.length > 0)
    .map(([trigger, signals, businessImplication, outreachRecommendation]) => ({
      trigger,
      confidence: Math.min(92, 58 + signals.length * 8),
      businessImplication: diversifyStrategicText(businessImplication, contextFor(profile, trigger)),
      outreachRecommendation: diversifyStrategicText(outreachRecommendation, contextFor(profile, trigger)),
    }))
    .slice(0, 6);

  const externalTriggers = (external?.events ?? []).slice(0, 3).map((event) => ({
    trigger: `External ${event.type} signal`,
    confidence: event.confidence,
    businessImplication: event.summary,
    outreachRecommendation: event.verificationNeeded
      ? "Verify the event before referencing it directly; use it internally to prioritize timing."
      : "Use the event as a careful timing hook while keeping the message tied to public positioning.",
  }));

  return [...websiteTriggers, ...externalTriggers].slice(0, 8);
}

function buildBuyerPersonaProfiles(
  profile: DeepCompanyProfile,
  pain: CompanyPainPointSet,
  personas: PersonaIntelligence,
): BuyerPersonaProfile[] {
  const preferred = [
    personas.primaryBuyer,
    ...personas.secondaryBuyers,
    "CFO",
    "CIO",
    "COO",
    "VP Operations",
    "Head of Transformation",
    "Director Finance Operations",
    "Delivery Director",
    "Head of Shared Services",
    "ERP Lead",
    "Digital Transformation Lead",
  ];

  return unique(preferred)
    .slice(0, 7)
    .map((persona) => ({
      persona,
      priorities: prioritiesForPersona(persona, profile),
      likelyObjections: objectionsForPersona(persona, profile),
      outreachAngle: angleForPersona(persona, profile),
      strongestValueProposition: valuePropositionForPersona(persona, profile, pain),
    }));
}

function scoreCommercialOpportunity(
  profile: DeepCompanyProfile,
  pain: CompanyPainPointSet,
  triggers: StrategicTrigger[],
): CommercialOpportunityScores {
  const financeTransformationFit = clamp(45 + profile.financeTransformationSignals.length * 10 + pain.financeAutomationOpportunities.length * 3);
  const aiAdoptionFit = clamp(42 + profile.aiMaturitySignals.length * 12 + profile.technologySignals.length * 3);
  const workflowAutomationFit = clamp(50 + pain.painPoints.length * 5 + profile.operationalSignals.length * 4);
  const operationalComplexityFit = clamp(48 + profile.triggerIntelligence.operationalComplexitySignals.length * 8 + profile.hiringSignals.length * 3);
  const enterpriseMaturity = clamp(48 + (profile.businessModel.includes("enterprise") ? 18 : 0) + profile.targetCustomers.length * 4 + profile.confidence * 0.12);
  const urgencyScore = profile.triggerIntelligence.urgencyScore;
  const outreachReadiness = clamp(Math.round((profile.confidence + average(triggers.map((trigger) => trigger.confidence)) + workflowAutomationFit) / 3));
  const strategicOpportunityScore = clamp(Math.round(
    urgencyScore * 0.2 +
    outreachReadiness * 0.18 +
    financeTransformationFit * 0.12 +
    aiAdoptionFit * 0.12 +
    workflowAutomationFit * 0.16 +
    operationalComplexityFit * 0.12 +
    enterpriseMaturity * 0.1,
  ));

  return {
    urgencyScore,
    outreachReadiness,
    financeTransformationFit,
    aiAdoptionFit,
    workflowAutomationFit,
    operationalComplexityFit,
    enterpriseMaturity,
    strategicOpportunityScore,
  };
}

function primaryOutcomeFor(profile: DeepCompanyProfile): string {
  if (profile.industry === "BPO/contact center") return "SLA reporting and workforce coordination";
  if (profile.industry === "healthcare SaaS") return "customer onboarding and revenue-cycle workflow visibility";
  if (profile.industry === "fintech platform") return "finance workflow control and implementation visibility";
  if (profile.industry === "AI decisioning platform") return "proof-of-value reporting and AI workflow governance";
  if (profile.industry === "enterprise IT services") return "delivery efficiency, resource planning, and margin visibility";
  if (profile.industry === "software product engineering") return "scoping discipline, delivery continuity, and account expansion intelligence";
  return "process intelligence and executive-level visibility";
}

function boardConcernsFor(profile: DeepCompanyProfile): string[] {
  return diversifyStrategicLines(unique([
    `${profile.companyName} may need to show that growth can scale without adding avoidable manual coordination cost.`,
    profile.financeTransformationSignals.length > 0 ? "Finance visibility, billing accuracy, and reporting cadence may be board-relevant as operating complexity grows." : "",
    profile.aiMaturitySignals.length > 0 ? "AI initiatives may require proof that operational impact, governance, and adoption risk are being managed." : "",
    profile.industry.includes("services") || profile.industry.includes("engineering") ? "Delivery margin and resource utilization may be more commercially important than top-line activity alone." : "",
  ]).slice(0, 4), contextFor(profile, "board"));
}

function departmentalFrictionFor(profile: DeepCompanyProfile, pain: CompanyPainPointSet): string[] {
  return diversifyStrategicLines(unique([
    "Sales-to-delivery context transfer can lose precision when account research, proposal assumptions, and implementation notes live separately.",
    pain.financeAutomationOpportunities[0] ?? "",
    profile.hiringDepartments.length > 0 ? `Hiring signals across ${profile.hiringDepartments.join(", ")} suggest coordination pressure between teams.` : "",
  ]).slice(0, 4), contextFor(profile, "friction"));
}

function processInefficienciesFor(profile: DeepCompanyProfile, pain: CompanyPainPointSet): string[] {
  return diversifyStrategicLines(unique([
    pain.painPoints[0],
    "Manual account research and persona preparation can slow campaign launch quality.",
    ...interpretSignalList(profile.triggerIntelligence.operationalComplexitySignals.slice(0, 2), contextFor(profile, "process")),
  ]).slice(0, 4), contextFor(profile, "process"));
}

function scalingRisksFor(profile: DeepCompanyProfile): string[] {
  return diversifyStrategicLines(unique([
    profile.growthSignals.length > 0 ? "Growth signals suggest repeatable reporting and handoff discipline will matter more over time." : "",
    profile.hiringSignals.length > 0 ? "Hiring expansion can add throughput before execution standards catch up." : "",
    profile.risks[0] ?? "Public signals are incomplete, so buyer and trigger assumptions should be verified before campaign execution.",
  ]).slice(0, 4), contextFor(profile, "risk"));
}

function profitabilityPressuresFor(profile: DeepCompanyProfile): string[] {
  if (profile.industry === "BPO/contact center") return ["SLA variance, staffing mix, and client reporting effort can affect account profitability."];
  if (profile.industry.includes("services") || profile.industry.includes("engineering")) return ["Proposal accuracy, resource planning, and delivery continuity can affect project margin."];
  if (profile.industry === "fintech platform") return ["Implementation delays and reconciliation exceptions can affect customer economics and renewal confidence."];
  return ["Manual operating practices can create hidden cost in research, reporting, implementation, and customer follow-up."];
}

function prioritiesForPersona(persona: string, profile: DeepCompanyProfile): string[] {
  if (/CFO|Finance|Revenue Cycle/i.test(persona)) return ["reporting accuracy", "billing readiness", "reconciliation control", "margin visibility"];
  if (/CIO|ERP|Digital|Transformation|AI|Data/i.test(persona)) return ["secure workflow modernization", "integration effort", "governance", "adoption risk"];
  if (/COO|Operations|Delivery|Services|Onboarding|Shared Services/i.test(persona)) return ["context transfer", "execution rhythm", "SLA visibility", "resource coordination"];
  if (/Revenue|Sales|GTM/i.test(persona)) return ["account intelligence", "pipeline quality", "persona relevance", "faster campaign preparation"];
  return [primaryOutcomeFor(profile), "clear next-step ownership", "low implementation burden"];
}

function objectionsForPersona(persona: string, profile: DeepCompanyProfile): string[] {
  if (/CFO|Finance|Revenue Cycle/i.test(persona)) return ["control disruption", "unclear ROI", "data quality"];
  if (/CIO|ERP|Digital|Transformation|AI|Data/i.test(persona)) return ["security review", "integration burden", "AI governance"];
  if (/COO|Operations|Delivery|Services|Onboarding|Shared Services/i.test(persona)) return ["implementation overhead", "team bandwidth", "change fatigue"];
  return profile.risks.slice(0, 3).length > 0 ? profile.risks.slice(0, 3) : ["timing", "existing tools", "ownership"];
}

function angleForPersona(persona: string, profile: DeepCompanyProfile): string {
  if (/CFO|Finance|Revenue Cycle/i.test(persona)) return `Lead with finance visibility, billing readiness, and exception reporting for ${profile.companyName}.`;
  if (/CIO|ERP|Digital|Transformation|AI|Data/i.test(persona)) return `Lead with governed workflow automation that complements existing systems without a heavy platform change.`;
  if (/COO|Operations|Delivery|Services|Onboarding|Shared Services/i.test(persona)) return `Lead with delivery continuity, SLA reporting, and execution rhythm improvements.`;
  if (/Revenue|Sales|GTM/i.test(persona)) return `Lead with campaign intelligence, account research quality, and faster personalization workflows.`;
  return `Lead with ${primaryOutcomeFor(profile)}.`;
}

function valuePropositionForPersona(persona: string, profile: DeepCompanyProfile, pain: CompanyPainPointSet): string {
  if (/CFO|Finance|Revenue Cycle/i.test(persona)) return pain.financeAutomationOpportunities[0] ?? "Reduce manual finance reporting and reconciliation effort.";
  if (/CIO|ERP|Digital|Transformation|AI|Data/i.test(persona)) return pain.aiOpportunities[0] ?? "Add read-only AI workflow intelligence before system changes.";
  if (/COO|Operations|Delivery|Services|Onboarding|Shared Services/i.test(persona)) return interpretSignalList(profile.triggerIntelligence.operationalComplexitySignals.slice(0, 1), contextFor(profile, persona))[0] ?? "Improve next-step ownership and management visibility.";
  return pain.painPoints[0] ?? "Improve campaign personalization and workflow quality before execution.";
}

function sourceSignalsFor(profile: DeepCompanyProfile): string[] {
  return unique([
    ...profile.keySignals,
    ...profile.growthSignals,
    ...profile.hiringSignals,
    ...profile.technologySignals,
  ]).slice(0, 6);
}

function sourceAwarenessFor(profile: DeepCompanyProfile): string[] {
  return unique([
    `Website: ${profile.website}`,
    `Confidence: ${profile.confidence}/100`,
    ...profile.confidenceBreakdown,
    ...profile.assumptions,
  ]).slice(0, 8);
}

function signalConfidence(profile: DeepCompanyProfile, signals: string[]): number {
  return clamp(profile.confidence + Math.min(12, signals.length * 2));
}

function average(values: number[]): number {
  if (values.length === 0) return 60;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number): number {
  return Math.max(35, Math.min(96, Math.round(value)));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function contextFor(profile: DeepCompanyProfile, trigger: string) {
  return {
    companyName: profile.companyName,
    industry: profile.industry,
    persona: profile.primaryBuyerPersona,
    trigger,
  };
}
