import type { DeepCompanyProfile } from "./deepCompanyProfile.js";

export interface CompanyPainPointSet {
  painPoints: string[];
  aiOpportunities: string[];
  financeAutomationOpportunities: string[];
}

export function generateCompanyPainPoints(profile: DeepCompanyProfile): CompanyPainPointSet {
  const painPoints = unique([
    ...industryPainPoints(profile),
    ...workflowPainPoints(profile),
    ...personaPainPoints(profile),
  ]).slice(0, 7);

  const aiOpportunities = unique([
    ...industryAiOpportunities(profile),
    "AI SDR research briefs from website, persona, and account signals before first touch",
    "Reply and objection classification that routes interested, skeptical, and timing-based replies differently",
    "CRM note generation and next-action recommendations after discovery calls or inbound requests",
  ]).slice(0, 6);

  const financeAutomationOpportunities = unique([
    ...industryFinanceOpportunities(profile),
    "Sales-to-finance handoff automation when deals move from proposal to implementation",
    "Automated invoice, payment, and collections status summaries for account owners",
    "Pipeline-to-cash reporting that connects sales forecast, delivery capacity, and expected billing",
  ]).slice(0, 6);

  return { painPoints, aiOpportunities, financeAutomationOpportunities };
}

function industryPainPoints(profile: DeepCompanyProfile): string[] {
  switch (profile.industry) {
    case "healthcare SaaS":
      return [
        "Onboarding can be slow because provider workflows, billing rules, and compliance checks vary by customer.",
        "Support teams may handle repetitive questions around EHR setup, claims, billing, and patient workflow issues.",
        "Sales-to-implementation handoff can lose context when practice needs are captured manually.",
        "Revenue cycle and claims workflows create finance friction when exceptions are tracked outside the core system.",
      ];
    case "enterprise IT services":
      return [
        "Proposal-to-resource planning gaps can appear when sales promises are not translated into delivery capacity early enough.",
        "Account intelligence can be inconsistent across long enterprise sales cycles and multiple stakeholders.",
        "Manual pipeline reporting can hide delivery risk, margin pressure, and delayed project starts.",
        "Client onboarding often requires repeated discovery across sales, delivery, finance, and support teams.",
      ];
    case "software product engineering":
      return [
        "Discovery and proposal preparation can consume senior engineering and product leadership time.",
        "Resource allocation risk increases when pipeline, skills, and project timelines are tracked separately.",
        "Delivery handoff can lose context from sales calls, technical scoping, and stakeholder requirements.",
        "Account expansion opportunities may be missed when project insights are not converted into sales signals.",
      ];
    case "fintech platform":
      return [
        "Enterprise buyers often need ROI proof, risk controls, and integration clarity before committing.",
        "Implementation teams may manage complex finance workflows across lending, leasing, payments, and reporting.",
        "Manual reconciliation and exception handling can slow finance operations for both vendor and client teams.",
        "Sales cycles can stall when technical, risk, and finance stakeholders are not aligned early.",
      ];
    case "AI decisioning platform":
      return [
        "Enterprise buyers may need education around model explainability, governance, and measurable ROI.",
        "Security and compliance objections can slow procurement even when the business case is strong.",
        "Sales teams must translate AI outcomes into practical operating metrics for non-technical buyers.",
        "Proof-of-value cycles can become manual if experiment setup, reporting, and stakeholder follow-up are fragmented.",
      ];
    case "BPO/contact center":
      return [
        "High-volume operations create workforce planning, SLA reporting, and quality monitoring pressure.",
        "Client reporting may depend on manual consolidation across support, operations, and finance systems.",
        "Sales proposals need credible staffing, ramp, and performance assumptions before contract approval.",
        "Billing and reconciliation can become complex when pricing depends on volumes, SLAs, or blended teams.",
      ];
    default:
      return [
        "SDR research can stay manual and inconsistent across accounts.",
        "Lead qualification and proposal preparation may depend on repeated copy-paste work.",
        "Sales, delivery, and finance handoffs can lose context when teams operate in separate systems.",
      ];
  }
}

function workflowPainPoints(profile: DeepCompanyProfile): string[] {
  const points: string[] = [];
  if (profile.salesWorkflowSignals.length > 0) points.push("Sales workflow signals suggest room to automate lead qualification, proposal notes, and pipeline summaries.");
  if (profile.financeWorkflowSignals.length > 0) points.push("Finance workflow signals suggest billing, reconciliation, payment follow-up, or reporting could be partly automated.");
  if (profile.operationalSignals.length > 0) points.push("Operational delivery signals suggest onboarding, implementation, and support handoffs may benefit from AI-generated context.");
  if (profile.growthSignals.length > 0) points.push("Growth signals suggest reporting consistency and repeatable outbound research will matter as the team scales.");
  return points;
}

function personaPainPoints(profile: DeepCompanyProfile): string[] {
  if (profile.likelyBuyerPersonas.some((persona) => /CFO|Revenue Cycle|Finance/i.test(persona))) {
    return ["Finance buyers will care about clean reporting, reconciliation, billing accuracy, and lower manual follow-up."];
  }
  if (profile.likelyBuyerPersonas.some((persona) => /CTO|Engineering|CIO|Data/i.test(persona))) {
    return ["Technical buyers will care about integration effort, data quality, security posture, and implementation burden."];
  }
  if (profile.likelyBuyerPersonas.some((persona) => /Sales|RevOps|Business Development/i.test(persona))) {
    return ["Revenue buyers will care about faster account research, better lead scoring, and more precise first-touch messaging."];
  }
  return [];
}

function industryAiOpportunities(profile: DeepCompanyProfile): string[] {
  switch (profile.industry) {
    case "healthcare SaaS":
      return [
        "AI-assisted onboarding summaries for each provider account, including workflow, billing, and support risks.",
        "Support triage that classifies billing, claims, setup, and compliance-heavy requests before escalation.",
      ];
    case "enterprise IT services":
      return [
        "AI account briefs that connect company initiatives, likely tech stack, stakeholders, and proposal angles.",
        "Proposal-to-delivery assistant that turns discovery notes into resource, timeline, and risk summaries.",
      ];
    case "software product engineering":
      return [
        "AI scoping assistant that converts discovery notes into draft requirements, assumptions, and resource needs.",
        "Account expansion signal detection from project notes, support tickets, and roadmap conversations.",
      ];
    case "fintech platform":
      return [
        "AI implementation brief that maps finance workflows, integration dependencies, and stakeholder objections.",
        "Risk and ROI narrative generation for lending, leasing, or payments buyers.",
      ];
    case "AI decisioning platform":
      return [
        "Explainability-ready sales enablement that turns AI value propositions into buyer-specific proof points.",
        "Proof-of-value reporting workflow that summarizes experiment outcomes, objections, and next steps.",
      ];
    case "BPO/contact center":
      return [
        "AI QA and call-summary workflows that surface SLA risks, customer themes, and coaching opportunities.",
        "Workforce and account reporting assistant for client-ready operational summaries.",
      ];
    default:
      return ["AI assistant for account research, lead scoring, and workflow follow-up."];
  }
}

function industryFinanceOpportunities(profile: DeepCompanyProfile): string[] {
  switch (profile.industry) {
    case "healthcare SaaS":
      return [
        "Claims, billing, and revenue-cycle exception summaries for customer success and finance teams.",
        "Automated implementation-to-billing checklist so customer setup changes do not delay invoicing.",
      ];
    case "enterprise IT services":
      return [
        "Project margin and billing readiness summaries tied to proposal scope and delivery staffing.",
        "Resource allocation and invoice milestone checks before delivery commitments are finalized.",
      ];
    case "software product engineering":
      return [
        "Statement-of-work to billing milestone tracking across sales, delivery, and finance.",
        "Automated project profitability snapshots using planned effort, actual delivery notes, and invoicing status.",
      ];
    case "fintech platform":
      return [
        "Automated reconciliation and exception workflows for finance operations teams.",
        "Customer-ready finance reporting packs for lending, leasing, or payment workflow performance.",
      ];
    case "AI decisioning platform":
      return [
        "ROI reporting packs that connect AI recommendations to operational and revenue outcomes.",
        "Procurement-ready finance summaries for pilot costs, savings assumptions, and measured impact.",
      ];
    case "BPO/contact center":
      return [
        "SLA-based billing reconciliation across volume, staffing, quality, and client reporting data.",
        "Automated variance reports for finance and account owners before monthly reviews.",
      ];
    default:
      return ["Invoice reconciliation, payment follow-up, and management reporting automation."];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
