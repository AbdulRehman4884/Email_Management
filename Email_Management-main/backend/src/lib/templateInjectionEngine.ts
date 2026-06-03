export type BulkTemplateId =
  | "executive_consultative"
  | "soft_relationship"
  | "enterprise_transformation"
  | "cfo_finance_visibility"
  | "fintech_compliance"
  | "product_engineering_delivery"
  | "ai_automation"
  | "operational_visibility"
  | "revops_pipeline"
  | "re_engagement";

export interface TemplateStrategy {
  globalTemplate: BulkTemplateId;
  globalTone: string;
  globalCTAStyle: string;
  industryTemplateMap: Record<string, BulkTemplateId>;
  userCustomizationInstructions?: string;
}

export interface TemplateOption {
  id: BulkTemplateId;
  name: string;
  bestFor: string;
  tone: string;
  typicalBuyer: string;
  ctaStyle: string;
}

export const ALLOWED_BULK_RECIPIENT_PLACEHOLDERS = new Set([
  "name",
  "email",
  "company",
  "website",
  "role",
  "industry",
  "persona",
]);

export interface SanitizedBulkTemplateContent {
  subject: string;
  body: string;
  followup1: string;
  followup2: string;
  cta: string;
  unsupportedPlaceholders: string[];
}

export const TEMPLATE_OPTIONS: TemplateOption[] = [
  { id: "executive_consultative", name: "Executive Consultative", bestFor: "mixed B2B lists and unknown categories", tone: "professional, grounded, senior", typicalBuyer: "VP Operations, COO, CIO", ctaStyle: "short strategic review" },
  { id: "soft_relationship", name: "Soft Relationship Outreach", bestFor: "warm-ish prospects or lower-confidence enrichment", tone: "soft, respectful, low pressure", typicalBuyer: "department leaders", ctaStyle: "compare notes" },
  { id: "enterprise_transformation", name: "Enterprise Transformation", bestFor: "IT services, ERP, cloud, transformation firms", tone: "executive, operational, transformation-aware", typicalBuyer: "CIO, Head of Transformation", ctaStyle: "transformation readiness discussion" },
  { id: "cfo_finance_visibility", name: "CFO Finance Visibility", bestFor: "finance, billing, reconciliation, reporting workflows", tone: "commercial, precise, finance-aware", typicalBuyer: "CFO, Director Finance Operations", ctaStyle: "finance visibility walkthrough" },
  { id: "fintech_compliance", name: "Fintech Compliance / Lending Workflow", bestFor: "lending, leasing, banking, payments, fintech platforms", tone: "compliance-aware, practical, process-led", typicalBuyer: "COO, Finance Operations, Risk leaders", ctaStyle: "lending workflow review" },
  { id: "product_engineering_delivery", name: "Product Engineering / Delivery Scale", bestFor: "software engineering, product delivery, innovation services", tone: "product-led, delivery-aware, concise", typicalBuyer: "CTO, Product, Delivery leaders", ctaStyle: "delivery alignment review" },
  { id: "ai_automation", name: "AI Automation / Workflow Intelligence", bestFor: "AI/data platforms or AI adoption signals", tone: "practical, non-hype AI", typicalBuyer: "AI, Data, Transformation leaders", ctaStyle: "AI enablement discussion" },
  { id: "operational_visibility", name: "Operational Visibility / Delivery Coordination", bestFor: "service delivery, onboarding, implementation-heavy firms", tone: "operational, clear, execution-focused", typicalBuyer: "VP Operations, Delivery Director", ctaStyle: "delivery visibility discussion" },
  { id: "revops_pipeline", name: "RevOps / Pipeline Efficiency", bestFor: "GTM teams, SDR teams, pipeline quality use cases", tone: "revenue-focused, direct, practical", typicalBuyer: "VP Revenue Operations", ctaStyle: "pipeline quality review" },
  { id: "re_engagement", name: "Re-engagement / Follow-up", bestFor: "older leads, dormant accounts, soft re-entry", tone: "brief, courteous, non-pushy", typicalBuyer: "existing contacts", ctaStyle: "soft close" },
];

export function templateOptions(): TemplateOption[] {
  return TEMPLATE_OPTIONS;
}

export function normalizeTemplateStrategy(input: Partial<TemplateStrategy> | null | undefined): TemplateStrategy {
  const allowed = new Set(TEMPLATE_OPTIONS.map((option) => option.id));
  const globalTemplate: BulkTemplateId = allowed.has(input?.globalTemplate as BulkTemplateId)
    ? input!.globalTemplate as BulkTemplateId
    : "executive_consultative";
  const industryTemplateMap = Object.fromEntries(
    Object.entries(input?.industryTemplateMap ?? {})
      .filter(([, value]) => allowed.has(value as BulkTemplateId)),
  ) as Record<string, BulkTemplateId>;

  return {
    globalTemplate,
    globalTone: clean(input?.globalTone) || "professional_soft",
    globalCTAStyle: clean(input?.globalCTAStyle) || "strategic_review",
    industryTemplateMap,
    userCustomizationInstructions: clean(input?.userCustomizationInstructions),
  };
}

export function classifyIndustryGroup(value: string | null | undefined): string {
  const text = String(value ?? "").toLowerCase();
  if (/\b(fintech|lending|leasing|banking|payments|finance)\b/.test(text)) return "fintech";
  if (/\b(product engineering|software|application development|innovation|engineering)\b/.test(text)) return "product_engineering";
  if (/\b(enterprise|digital transformation|cloud|devops|erp|crm|managed services|systems integration|it services)\b/.test(text)) return "enterprise_it";
  if (/\b(healthcare|ehr|emr|clinical|patient|revenue cycle)\b/.test(text)) return "healthcare";
  if (/\b(ai|machine learning|data platform|automation)\b/.test(text)) return "ai_data";
  if (/\b(bpo|contact center|outsourcing|support operations)\b/.test(text)) return "customer_ops";
  return "unknown";
}

export function recommendTemplateForGroup(group: string): BulkTemplateId {
  if (group === "fintech") return "fintech_compliance";
  if (group === "product_engineering") return "product_engineering_delivery";
  if (group === "enterprise_it") return "enterprise_transformation";
  if (group === "healthcare") return "operational_visibility";
  if (group === "ai_data") return "ai_automation";
  if (group === "customer_ops") return "operational_visibility";
  return "executive_consultative";
}

export function resolveTemplateForIndustry(industry: string, strategy: TemplateStrategy): BulkTemplateId {
  const group = classifyIndustryGroup(industry);
  return strategy.industryTemplateMap[group] ?? strategy.globalTemplate;
}

export function templateGuidance(templateId: BulkTemplateId): {
  pressure: string;
  service: string;
  personaHint: string;
  cta: string;
} {
  switch (templateId) {
    case "enterprise_transformation":
      return { pressure: "delivery visibility during transformation work", service: "enterprise account context", personaHint: "Digital Transformation Lead", cta: "Open to a short transformation messaging review?" };
    case "cfo_finance_visibility":
      return { pressure: "finance visibility and exception follow-up", service: "finance workflow clarity", personaHint: "Director Finance Operations", cta: "Should I share a finance visibility walkthrough?" };
    case "fintech_compliance":
      return { pressure: "lending workflow complexity and compliance-aware messaging", service: "lending operations context", personaHint: "Director Finance Operations", cta: "Open to comparing notes on lending workflow messaging?" };
    case "product_engineering_delivery":
      return { pressure: "engineering coordination and product delivery alignment", service: "product delivery context", personaHint: "Digital Transformation Lead", cta: "Worth reviewing a product delivery first-touch draft?" };
    case "ai_automation":
      return { pressure: "AI adoption readiness and workflow governance", service: "AI enablement context", personaHint: "Digital Transformation Lead", cta: "Would an AI enablement outreach preview be useful?" };
    case "operational_visibility":
      return { pressure: "delivery coordination and operational visibility", service: "delivery visibility context", personaHint: "Director Delivery Excellence", cta: "Open to a delivery visibility discussion?" };
    case "revops_pipeline":
      return { pressure: "pipeline quality and account prioritization", service: "account-specific outreach", personaHint: "VP Revenue Operations", cta: "Worth comparing this against one pipeline priority?" };
    case "soft_relationship":
      return { pressure: "buyer relevance and timing", service: "lightweight account context", personaHint: "VP Operations", cta: "Open to comparing notes briefly?" };
    case "re_engagement":
      return { pressure: "clear re-entry without forcing a sales conversation", service: "short account-specific follow-up", personaHint: "VP Operations", cta: "Should I send a concise example?" };
    default:
      return { pressure: "buyer relevance and message quality", service: "account-specific outreach", personaHint: "VP Operations", cta: "Worth reviewing a first-touch draft?" };
  }
}

export function resolveSenderName(value: unknown): string {
  const senderName = clean(value);
  return senderName || "MailFlow";
}

export function sanitizeBulkTemplateContent(
  input: {
    subject: string;
    body: string;
    followup1: string;
    followup2: string;
    cta: string;
  },
  senderNameInput?: unknown,
): SanitizedBulkTemplateContent {
  const senderName = resolveSenderName(senderNameInput);
  const fields = {
    subject: input.subject,
    body: input.body,
    followup1: input.followup1,
    followup2: input.followup2,
    cta: input.cta,
  };
  const unsupported = new Set<string>();
  const sanitized = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      const text = clean(value).replace(/{{\s*sender_name\s*}}/gi, senderName);
      for (const match of text.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)) {
        const placeholder = match[1]?.toLowerCase() ?? "";
        if (!ALLOWED_BULK_RECIPIENT_PLACEHOLDERS.has(placeholder)) {
          unsupported.add(placeholder);
        }
      }
      return [key, text];
    }),
  ) as Omit<SanitizedBulkTemplateContent, "unsupportedPlaceholders">;

  return {
    ...sanitized,
    unsupportedPlaceholders: [...unsupported].sort(),
  };
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}
