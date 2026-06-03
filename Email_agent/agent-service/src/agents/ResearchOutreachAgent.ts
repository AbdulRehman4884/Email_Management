/**
 * Read-only deep SDR research and outreach intelligence for company URLs.
 *
 * This agent intentionally does not set toolName or toolArgs. It produces
 * structured output directly and must never create campaigns, recipients,
 * schedules, SMTP sends, or follow-up automation.
 */

import { BaseAgent } from "./BaseAgent.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import {
  fetchWebsiteIntelligence,
  normalizeCompanyUrl,
  type WebsiteIntelligence,
} from "../lib/companyWebsiteEnrichment.js";
import { generateCompanyPainPoints, type CompanyPainPointSet } from "../lib/companyPainPointEngine.js";
import { buildDeepCompanyProfile, type DeepCompanyProfile } from "../lib/deepCompanyProfile.js";
import { generateOutreachIntelligence, type OutreachIntelligence } from "../lib/outreachIntelligenceEngine.js";
import { buildPersonaIntelligence, type PersonaIntelligence } from "../lib/personaIntelligence.js";
import { buildTriggerAwareOutreach, type TriggerAwareOutreach } from "../lib/triggerAwareOutreach.js";
import { buildExecutiveIntelligence, type ExecutiveIntelligence } from "../lib/executiveIntelligenceEngine.js";
import { buildStrategicNarrative, type StrategicNarrative } from "../lib/strategicNarrativeEngine.js";
import { buildExecutiveEmailSequence, type ExecutiveEmailSequence } from "../lib/executiveOutreachSequence.js";
import {
  fetchExternalBusinessIntelligence,
  type ExternalBusinessIntelligence,
} from "../lib/externalBusinessIntelligence.js";
import { interpretSignalList } from "../lib/executiveSignalInterpreter.js";
import { buildExecutiveCTASet } from "../lib/executiveCTAEngine.js";

const RESEARCH_INTENTS = new Set([
  "research_companies",
  "outreach_research",
  "company_analysis",
  "generate_outreach_from_urls",
]);

const MAX_COMPANIES_PER_REQUEST = 10;

type CompanyReport = {
  profile: DeepCompanyProfile;
  pain: CompanyPainPointSet;
  outreach: OutreachIntelligence;
  personas: PersonaIntelligence;
  triggerOutreach: TriggerAwareOutreach;
  executive: ExecutiveIntelligence;
  narrative: StrategicNarrative;
  sequence: ExecutiveEmailSequence;
  enrichment: WebsiteIntelligence;
  external: ExternalBusinessIntelligence;
};

type OutreachOutputMode = "executive_intelligence" | "template_first_outreach";

export class ResearchOutreachAgent extends BaseAgent {
  readonly domain = "research" as const;

  constructor() {
    super("ResearchOutreachAgent");
  }

  async handle(state: AgentGraphStateType): Promise<Partial<AgentGraphStateType>> {
    if (!state.intent || !RESEARCH_INTENTS.has(state.intent)) {
      return {};
    }

    const urls = this.extractCompanyUrls(state.userMessage);
    if (urls.length === 0) {
      return {
        formattedResponse:
          "Send one or more company website URLs and I will return read-only SDR intelligence and outreach drafts.",
        toolName: undefined,
        toolArgs: {},
        requiresApproval: false,
        pendingActionId: undefined,
      };
    }

    const selectedUrls = urls.slice(0, MAX_COMPANIES_PER_REQUEST);
    const reports: CompanyReport[] = [];

    for (const url of selectedUrls) {
      reports.push(await this.buildCompanyReport(url));
    }

    const outputMode = this.detectOutputMode(state.userMessage);
    const response = outputMode === "template_first_outreach"
      ? this.formatTemplateFirstReport(reports, urls.length)
      : this.formatReport(reports, urls.length);
    return {
      formattedResponse: response,
      toolName: undefined,
      toolArgs: {},
      requiresApproval: false,
      pendingActionId: undefined,
    };
  }

  private extractCompanyUrls(message: string): string[] {
    const explicit = message.match(/https?:\/\/[^\s>)'"]+/gi) ?? [];
    const withoutExplicit = message
      .replace(/https?:\/\/[^\s>)'"]+/gi, " ")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ");
    const bare = withoutExplicit.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? [];
    const unique = new Map<string, string>();

    for (const raw of [...explicit, ...bare]) {
      const normalized = normalizeCompanyUrl(raw);
      if (!normalized) continue;
      unique.set(normalized.toLowerCase(), normalized);
    }

    return [...unique.values()];
  }

  private detectOutputMode(message: string): OutreachOutputMode {
    if (/\b(email templates?|templates?|outreach emails?|cold emails?|donor emails?|campaign emails?|draft emails?|generate email for these links|company links for email|email copy)\b/i.test(message)) {
      return "template_first_outreach";
    }

    return "executive_intelligence";
  }

  private async buildCompanyReport(url: string): Promise<CompanyReport> {
    const enrichment = await fetchWebsiteIntelligence(url);
    const profile = buildDeepCompanyProfile(enrichment);
    const pain = generateCompanyPainPoints(profile);
    const outreach = generateOutreachIntelligence(profile, pain);
    const personas = buildPersonaIntelligence(profile, pain, profile.triggerIntelligence, profile.hiringIntelligence);
    const triggerOutreach = buildTriggerAwareOutreach(profile, pain, profile.triggerIntelligence, personas);
    const external = await fetchExternalBusinessIntelligence(enrichment);
    const executive = buildExecutiveIntelligence(profile, pain, personas, external);
    const narrative = buildStrategicNarrative(profile, pain, executive, external);
    const sequence = buildExecutiveEmailSequence(profile, executive, narrative);
    return { profile, pain, outreach, personas, triggerOutreach, executive, narrative, sequence, enrichment, external };
  }

  private formatReport(reports: CompanyReport[], originalUrlCount: number): string {
    const lines = [
      "# Executive Campaign Intelligence Report",
      "",
      "AI Email Campaign Intelligence Agent output: website-driven intelligence, executive positioning, sequence preview, and campaign readiness guidance. No campaign, recipient, SMTP, schedule, or send action has been executed.",
      "",
      originalUrlCount > MAX_COMPANIES_PER_REQUEST
        ? `Processed the first ${MAX_COMPANIES_PER_REQUEST} URLs. ${originalUrlCount - MAX_COMPANIES_PER_REQUEST} additional URL(s) were skipped to keep this read-only research run bounded.`
        : `Processed ${reports.length} compan${reports.length === 1 ? "y" : "ies"} as campaign intelligence inputs.`,
      "",
      ...reports.flatMap((report, index) => this.formatCompanyReport(report, index + 1)),
      "",
      ...this.formatPortfolioSummary(reports),
    ];

    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  private formatTemplateFirstReport(reports: CompanyReport[], originalUrlCount: number): string {
    const lines = [
      "# Outreach Email Templates",
      "",
      "AI Email Campaign Intelligence Agent output: copy-ready outreach templates generated from company website intelligence. Intelligence is kept short and supportive. No campaign, recipient, SMTP, schedule, or send action has been executed.",
      "",
      originalUrlCount > MAX_COMPANIES_PER_REQUEST
        ? `Processed the first ${MAX_COMPANIES_PER_REQUEST} URLs. ${originalUrlCount - MAX_COMPANIES_PER_REQUEST} additional URL(s) were skipped to keep this read-only template run bounded.`
        : `Generated templates for ${reports.length} compan${reports.length === 1 ? "y" : "ies"}.`,
      "",
      ...reports.flatMap((report, index) => this.formatTemplateFirstCompany(report, index + 1)),
      "",
      ...this.formatTemplatePortfolioSummary(reports),
    ];

    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  private formatTemplateFirstCompany(report: CompanyReport, index: number): string[] {
    const { profile, pain, outreach, personas, triggerOutreach, executive, narrative, sequence, enrichment } = report;
    const primaryPersona = executive.buyerPersonaProfiles[0];
    const subject = triggerOutreach.triggerAwareSubject || outreach.deliverabilitySafeSubject || `${profile.companyName} operational visibility note`;
    const ctas = buildExecutiveCTASet({
      profile,
      persona: primaryPersona,
      department: narrative.firstDepartmentToBenefit,
      pressure: narrative.operationalPressure,
      trigger: executive.strategicTriggers[0]?.trigger,
    });
    const context = this.oneLineContext(report);
    const rationale = enrichment.limited
      ? `Lower-confidence website enrichment. The copy uses domain, industry, and operating-model inference; verify buyer names and public claims before sending.`
      : `Template is based on ${profile.industry} positioning, likely ${personas.primaryBuyer} priorities, and the strongest visible operational signals.`;

    return [
      `## ${index}. ${profile.companyName}`,
      `### Company Context`,
      context,
      "",
      `### Recommended Subject Line`,
      `Subject: ${subject}`,
      "",
      `### Email Body`,
      this.codeBlock(sequence.coldOutreach),
      "",
      `### Follow-Up 1`,
      this.codeBlock(sequence.followUp1 || sequence.executiveIntro),
      "",
      `### Follow-Up 2`,
      this.codeBlock(sequence.followUp2 || sequence.valueReinforcement),
      "",
      `### Recommended CTA`,
      ctas.strategicReview || ctas.consultative || ctas.soft,
      "",
      `### Optional Short Rationale`,
      rationale,
      "",
      `### Campaign Recommendation`,
      `Recommended persona: ${personas.primaryBuyer}. Recommended campaign path: verify contacts, import CSV leads or add manual recipients, preview personalization, create a campaign draft only after approval, then wait for explicit send approval.`,
      "",
      `### Supporting Intelligence`,
      `- Industry: ${profile.industry} - ${profile.subIndustry}`,
      `- Business model: ${profile.businessModel}`,
      `- Confidence: ${profile.confidence}/100${enrichment.limited ? " (limited-confidence analysis)" : ""}`,
      `- Strategic angle: ${narrative.strategicAngle}`,
      `- Likely pain points: ${pain.painPoints.slice(0, 3).join("; ")}`,
      `- AI opportunities: ${pain.aiOpportunities.slice(0, 2).join("; ") || "limited public signal; keep AI claims conservative"}`,
      `- Finance/accounting opportunities: ${pain.financeAutomationOpportunities.slice(0, 2).join("; ") || "limited public signal; verify before finance-specific messaging"}`,
      `- Lead priority: ${outreach.leadPriority} (${outreach.hotLeadScore}/100)`,
      "Read-safe template preview only. No campaign, recipients, SMTP sending, scheduling, or worker action was triggered.",
      "",
    ];
  }

  private formatTemplatePortfolioSummary(reports: CompanyReport[]): string[] {
    const sorted = [...reports].sort((a, b) => b.outreach.hotLeadScore - a.outreach.hotLeadScore);
    return [
      "# Template Campaign Summary",
      `- Templates generated: ${reports.length}`,
      `- Highest priority: ${this.companyList(sorted.slice(0, 3))}`,
      `- Recommended next step: verify buyer names, import CSV or manual leads, preview personalization, then create a campaign draft only if the user explicitly approves.`,
    ];
  }

  private oneLineContext(report: CompanyReport): string {
    const { profile, personas, narrative, enrichment } = report;
    const qualifier = enrichment.limited ? "Based on limited public website access and domain context" : "Based on website positioning";
    return `${qualifier}, ${profile.companyName} appears to be a ${profile.industry} business serving ${profile.targetCustomers.slice(0, 2).join(" and ") || "business buyers"}, with outreach best framed for ${personas.primaryBuyer} around ${narrative.businessOutcome.toLowerCase()}.`;
  }

  private formatCompanyReport(report: CompanyReport, index: number): string[] {
    const { profile, pain, outreach, personas, triggerOutreach, executive, narrative, sequence, enrichment, external } = report;
    const confidenceNote = enrichment.limited ? "limited-confidence analysis" : "website-enriched analysis";
    const primaryPersona = executive.buyerPersonaProfiles[0];
    const ctas = buildExecutiveCTASet({
      profile,
      persona: primaryPersona,
      department: narrative.firstDepartmentToBenefit,
      pressure: narrative.operationalPressure,
      trigger: executive.strategicTriggers[0]?.trigger,
    });
    const interpretedOperationalSignals = interpretSignalList(profile.triggerIntelligence.operationalComplexitySignals, {
      companyName: profile.companyName,
      industry: profile.industry,
      persona: personas.primaryBuyer,
      trigger: "operational-pressure",
    });
    const interpretedAiSignals = interpretSignalList(profile.aiMaturitySignals, {
      companyName: profile.companyName,
      industry: profile.industry,
      persona: personas.primaryBuyer,
      trigger: "ai-maturity",
    });
    const recommendedAction = outreach.hotLeadScore >= 75 || profile.triggerIntelligence.urgencyScore >= 70
      ? `Verify ${personas.primaryBuyer}, import CSV leads or add manual recipients, preview personalization, then create the campaign draft only after user approval. Recommended first campaign angle: ${narrative.strategicAngle}.`
      : `${outreach.nextBestAction} Keep this read-safe until the user approves campaign creation, recipient import, and sending.`;

    return [
      `## ${index}. ${profile.companyName}`,
      `### Strategic Summary`,
      narrative.strategicStory,
      `Website: ${profile.website}`,
      `Industry: ${profile.industry} - ${profile.subIndustry}`,
      `Business model: ${profile.businessModel}`,
      "",
      `### Strategic Insight`,
      `Why they would care: ${narrative.whyCare}`,
      `Why now: ${narrative.whyNow}`,
      `Primary business outcome: ${narrative.businessOutcome}`,
      "",
      `### Recommended Buyer Persona`,
      `Primary: ${personas.primaryBuyer}`,
      `Secondary: ${personas.secondaryBuyers.length > 0 ? personas.secondaryBuyers.join(", ") : "none detected"}`,
      `Persona-specific angle: ${primaryPersona?.outreachAngle ?? triggerOutreach.triggerAwareAngle}`,
      "",
      `### Executive Outreach Email`,
      `Subject: ${triggerOutreach.triggerAwareSubject || outreach.deliverabilitySafeSubject}`,
      "",
      this.codeBlock(sequence.coldOutreach),
      "",
      `### Follow-Up Sequence`,
      `Touch 1 - Executive insight`,
      this.codeBlock(sequence.executiveIntro),
      `Touch 2 - Operational pressure`,
      this.codeBlock(sequence.followUp1),
      `Touch 3 - Finance visibility`,
      this.codeBlock(sequence.followUp2),
      `Touch 4 - Transformation angle`,
      this.codeBlock(sequence.valueReinforcement),
      `Touch 5 - Soft breakup`,
      this.codeBlock(sequence.softBreakup),
      "",
      `### Recommended CTA Strategy`,
      `- Soft CTA: ${ctas.soft}`,
      `- Executive CTA: ${ctas.strategicReview}`,
      `- Consultative CTA: ${ctas.consultative}`,
      `- Department-specific CTA: ${ctas.operational}`,
      `LinkedIn CTA: ${sequence.linkedinMessage}`,
      "",
      `### Campaign Recommendation`,
      `Recommended campaign angle: ${narrative.strategicAngle}`,
      `Recommended campaign path: import CSV leads or add manual recipients, preview personalization, create a campaign draft, review sequence, then wait for explicit user approval before sending.`,
      `Lead priority: ${outreach.leadPriority} (${outreach.hotLeadScore}/100). Strategic opportunity: ${executive.scores.strategicOpportunityScore}/100. Urgency: ${profile.triggerIntelligence.urgencyScore}/100.`,
      "",
      `### Supporting Intelligence`,
      `**Company context**`,
      `- Executive priority: ${executive.executivePriorities[0]?.priority ?? narrative.businessOutcome}`,
      `- Operational pressure: ${narrative.operationalPressure}`,
      `- First department to benefit: ${narrative.firstDepartmentToBenefit}`,
      `- Confidence: ${profile.confidence}/100 (${confidenceNote})`,
      "",
      `**Buyer map**`,
      ...executive.buyerPersonaProfiles.slice(0, 4).flatMap((persona) => [
        `- ${persona.persona}: priorities: ${persona.priorities.join(", ")}; objections: ${persona.likelyObjections.join(", ")}; value: ${persona.strongestValueProposition}`,
      ]),
      "",
      `**Trigger and why-now signals**`,
      ...this.bullets(triggerOutreach.whyNowReasoning),
      ...executive.strategicTriggers.slice(0, 4).flatMap((trigger) => [
        `- ${trigger.trigger} (${trigger.confidence}/100): ${trigger.businessImplication}`,
      ]),
      "",
      `**Hiring and growth**`,
      ...this.bullets(profile.hiringSignals.length > 0 ? profile.hiringSignals : ["No hiring signals detected from available public website content."]),
      `- Departments hiring: ${profile.hiringDepartments.length > 0 ? profile.hiringDepartments.join(", ") : "none detected"}`,
      `- Growth signals: ${profile.growthSignals.length > 0 ? profile.growthSignals.join("; ") : "limited public signal available"}`,
      "",
      `**AI, operations, and finance indicators**`,
      ...this.bullets(interpretedAiSignals.length > 0 ? interpretedAiSignals : ["No explicit AI adoption signal detected; AI fit is inferred from business model and operating complexity."]),
      ...this.bullets(interpretedOperationalSignals),
      ...this.bullets(profile.financeTransformationSignals.length > 0 ? profile.financeTransformationSignals : pain.financeAutomationOpportunities),
      "",
      `**External business intelligence**`,
      ...this.externalIntelligenceLines(external),
      "",
      `**Compact scoring**`,
      `- Outreach readiness: ${executive.scores.outreachReadiness}/100`,
      `- Finance transformation fit: ${executive.scores.financeTransformationFit}/100`,
      `- AI adoption fit: ${executive.scores.aiAdoptionFit}/100`,
      `- Operational complexity fit: ${executive.scores.operationalComplexityFit}/100`,
      "",
      `**Persona-specific outreach variants**`,
      ...triggerOutreach.personaVariants.flatMap((variant) => [
        `- ${variant.persona} email: ${variant.email.replace(/\n+/g, " / ")}`,
        `- ${variant.persona} LinkedIn: ${variant.linkedin}`,
      ]),
      "",
      `**Likely objections**`,
      ...this.bullets(unique([...outreach.likelyObjections, ...triggerOutreach.triggerSpecificObjections])),
      "",
      `**Confidence breakdown**`,
      ...this.bullets(profile.confidenceBreakdown),
      "",
      `### Recommended Campaign Action`,
      recommendedAction,
      "Read-safe strategy preview only. No campaign, recipients, SMTP sending, scheduling, or worker action was triggered.",
      "",
    ];
  }

  private formatPortfolioSummary(reports: CompanyReport[]): string[] {
    const sorted = [...reports].sort((a, b) => b.outreach.hotLeadScore - a.outreach.hotLeadScore);
    const byUrgency = [...reports].sort((a, b) => b.profile.triggerIntelligence.urgencyScore - a.profile.triggerIntelligence.urgencyScore);
    const highest = sorted.slice(0, 3).map((report) => `${report.profile.companyName} (${report.outreach.hotLeadScore}/100)`);
    const hiring = reports.filter((report) => report.profile.hiringIntelligence.openRoles.length > 0).map((report) => report.profile.companyName);
    const ai = reports.filter((report) => report.profile.aiMaturitySignals.length > 0).map((report) => report.profile.companyName);
    const finance = reports.filter((report) => report.profile.financeTransformationSignals.length > 0).map((report) => report.profile.companyName);
    const personas = unique(reports.flatMap((report) => [report.personas.primaryBuyer, ...report.personas.secondaryBuyers])).slice(0, 8);
    const verification = reports
      .filter((report) => report.enrichment.limited || report.profile.confidence < 65)
      .map((report) => report.profile.companyName);
    const objections = unique(reports.flatMap((report) => report.outreach.likelyObjections)).slice(0, 5);
    const externalEvents = reports.flatMap((report) => report.external.events.map((event) => `${report.profile.companyName}: ${event.type} (${event.confidence}/100)`)).slice(0, 5);

    return [
      "# Portfolio Executive Campaign Summary",
      `- Companies with strongest growth signals: ${this.companyList(byUrgency.slice(0, 3))}`,
      `- Companies with strongest hiring signals: ${hiring.length > 0 ? hiring.join(", ") : "none detected from available careers content"}`,
      `- Strongest AI adoption signals: ${ai.length > 0 ? ai.join(", ") : "none detected from available website content"}`,
      `- Strongest finance transformation indicators: ${finance.length > 0 ? finance.join(", ") : "none detected from available website content"}`,
      `- Most urgent opportunities: ${this.companyList(byUrgency.slice(0, 3), "urgency")}`,
      `- Best outreach timing: prioritize accounts with hiring, AI, finance, or delivery expansion signals this week; verify missing career/news signals before outreach.`,
      `- Highest-priority buyer personas: ${personas.length > 0 ? personas.join(", ") : "VP Revenue Operations, Director Professional Services, Director Financial Operations"}`,
      `- Recommended first-touch strategy: ${this.bestFirstTouchAngle(sorted)}`,
      `- Highest priority leads: ${highest.length > 0 ? highest.join(", ") : "none identified"}`,
      `- Highest strategic opportunity scores: ${this.strategicScoreList(sorted.slice(0, 3))}`,
      `- Common objections: ${objections.length > 0 ? objections.join("; ") : "timing, existing tools, and implementation effort"}`,
      `- External trigger watchlist: ${externalEvents.length > 0 ? externalEvents.join("; ") : "no bounded external event signals detected"}`,
      `- Companies requiring verification: ${verification.length > 0 ? verification.join(", ") : "none from this run"}`,
      "- Recommended next step: verify buyer names, import CSV or manual leads, preview personalization, and create a campaign draft for user approval before any send action.",
    ];
  }

  private bestFirstTouchAngle(sortedReports: CompanyReport[]): string {
    const top = sortedReports[0];
    if (!top) return "start with read-only workflow research before any campaign action";
    if (top.profile.industry === "AI decisioning platform") return "proof-of-value reporting and explainability support for AI buyers";
    if (top.profile.industry === "healthcare SaaS") return "onboarding, billing, and support handoff automation";
    if (top.profile.industry === "enterprise IT services") return "proposal-to-resource planning and delivery handoff automation";
    if (top.profile.industry === "software product engineering") return "discovery-to-SOW scoping and resource planning automation";
    if (top.profile.industry === "fintech platform") return "finance workflow, reconciliation, and implementation reporting automation";
    if (top.profile.industry === "BPO/contact center") return "SLA reporting, workforce operations, and billing reconciliation automation";
    return "manual research, qualification, and finance handoff reduction";
  }

  private bullets(items: string[]): string[] {
    return (items.length > 0 ? items : ["Limited public signal available; verify before outreach."]).map((item) => `- ${item}`);
  }

  private externalIntelligenceLines(external: ExternalBusinessIntelligence): string[] {
    if (external.events.length === 0) {
      return [
        "- No bounded external event signal detected from available public pages.",
        `- Sources attempted: ${external.sourcesAttempted.length > 0 ? external.sourcesAttempted.join(", ") : "none"}`,
        ...this.bullets(external.verificationNeededFlags),
      ];
    }

    return [
      `External trigger confidence: ${external.externalTriggerConfidence}/100`,
      `Strategic event confidence: ${external.strategicEventConfidence}/100`,
      ...external.events.map((event) => `- ${event.type} (${event.confidence}/100): ${event.summary} Source: ${event.sourceUrl}. ${event.verificationNeeded ? "Manual verification required before direct mention." : "Usable as a careful timing signal."}`),
      ...this.bullets(external.verificationNeededFlags),
    ];
  }

  private inline(items: string[]): string {
    return items.length > 0 ? items.join(", ") : "Founder, COO, VP Sales";
  }

  private companyList(reports: CompanyReport[], score: "lead" | "urgency" = "lead"): string {
    if (reports.length === 0) return "none identified";
    return reports
      .map((report) => `${report.profile.companyName} (${score === "urgency" ? report.profile.triggerIntelligence.urgencyScore : report.outreach.hotLeadScore}/100)`)
      .join(", ");
  }

  private strategicScoreList(reports: CompanyReport[]): string {
    if (reports.length === 0) return "none identified";
    return reports
      .map((report) => `${report.profile.companyName} (${report.executive.scores.strategicOpportunityScore}/100)`)
      .join(", ");
  }

  private indentBlock(value: string): string {
    return value
      .split("\n")
      .map((line) => (line.trim() ? `  ${line}` : ""))
      .join("\n");
  }

  private codeBlock(value: string): string {
    return ["```text", value.trim(), "```"].join("\n");
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export const researchOutreachAgent = new ResearchOutreachAgent();
