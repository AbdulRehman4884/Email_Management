import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./db.js";
import { bulkImportJobsTable, bulkImportRowsTable, generatedTemplatesTable } from "../db/schema.js";
import {
  normalizeTemplateStrategy,
  resolveTemplateForIndustry,
  sanitizeBulkTemplateContent,
  templateGuidance,
  templateOptions,
  type BulkTemplateId,
  type TemplateStrategy,
} from "./templateInjectionEngine.js";

export interface BulkQueueOptions {
  batchSize?: number;
  concurrency?: number;
  retries?: number;
}

const DEFAULT_BATCH_SIZE = 50;
const MAX_CONTENT = 18_000;
const FETCH_TIMEOUT_MS = 3500;

const activeJobs = new Set<number>();

export function enqueueBulkProcessing(jobId: number, options: BulkQueueOptions = {}): void {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);
  void processJob(jobId, {
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    concurrency: options.concurrency ?? 2,
    retries: options.retries ?? 1,
  }).finally(() => activeJobs.delete(jobId));
}

async function processJob(jobId: number, options: Required<BulkQueueOptions>): Promise<void> {
  const [jobConfig] = await db.select().from(bulkImportJobsTable).where(eq(bulkImportJobsTable.id, jobId)).limit(1);
  const strategy = normalizeTemplateStrategy(jobConfig?.templateSelection as Partial<TemplateStrategy> | null);
  if (!jobConfig?.templateSelection) {
    await db.update(bulkImportJobsTable)
      .set({ status: "awaiting_template_selection", updatedAt: sql`now()` })
      .where(eq(bulkImportJobsTable.id, jobId));
    return;
  }

  await db.update(bulkImportJobsTable)
    .set({ status: "processing", updatedAt: sql`now()` })
    .where(eq(bulkImportJobsTable.id, jobId));

  while (true) {
    const rows = await db
      .select()
      .from(bulkImportRowsTable)
      .where(and(eq(bulkImportRowsTable.jobId, jobId), eq(bulkImportRowsTable.status, "queued")))
      .orderBy(asc(bulkImportRowsTable.id))
      .limit(options.batchSize);

    if (rows.length === 0) break;

    for (let i = 0; i < rows.length; i += options.concurrency) {
      const slice = rows.slice(i, i + options.concurrency);
      await Promise.all(slice.map((row) => processRow(jobId, row, options.retries, strategy)));
    }
  }

  const remaining = await db
    .select({ id: bulkImportRowsTable.id })
    .from(bulkImportRowsTable)
    .where(and(eq(bulkImportRowsTable.jobId, jobId), eq(bulkImportRowsTable.status, "queued")))
    .limit(1);

  const [job] = await db.select().from(bulkImportJobsTable).where(eq(bulkImportJobsTable.id, jobId)).limit(1);
  const finalStatus = remaining.length > 0 ? "processing" : job?.failedRows && job.failedRows > 0 ? "completed_with_errors" : "completed";
  await db.update(bulkImportJobsTable)
    .set({ status: finalStatus, updatedAt: sql`now()` })
    .where(eq(bulkImportJobsTable.id, jobId));
}

async function processRow(
  jobId: number,
  row: typeof bulkImportRowsTable.$inferSelect,
  retries: number,
  strategy: TemplateStrategy,
): Promise<void> {
  await db.update(bulkImportRowsTable).set({ status: "processing", error: null }).where(eq(bulkImportRowsTable.id, row.id));

  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const intelligence = await enrichCompany(row.website ?? "", row.company ?? "", row.industry ?? "");
      const template = generateExecutiveTemplate({
        name: row.name ?? "",
        email: row.email ?? "",
        company: row.company ?? "the company",
        website: row.website ?? "",
        role: row.role ?? "",
        industry: row.industry || intelligence.industry,
        services: intelligence.services,
        signals: intelligence.signals,
        confidence: intelligence.confidence,
        strategy,
      });

      const existing = await db.select({ id: generatedTemplatesTable.id })
        .from(generatedTemplatesTable)
        .where(eq(generatedTemplatesTable.rowId, row.id))
        .limit(1);

      if (existing[0]) {
        await db.update(generatedTemplatesTable)
          .set({ ...template, jobId, updatedAt: sql`now()` })
          .where(eq(generatedTemplatesTable.id, existing[0].id));
      } else {
        await db.insert(generatedTemplatesTable).values({ rowId: row.id, jobId, ...template });
      }

      await db.update(bulkImportRowsTable).set({ status: "generated", error: null }).where(eq(bulkImportRowsTable.id, row.id));
      await db.update(bulkImportJobsTable)
        .set({
          processedRows: sql`${bulkImportJobsTable.processedRows} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(bulkImportJobsTable.id, jobId));
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Template generation failed";
    }
  }

  await db.update(bulkImportRowsTable).set({ status: "failed", error: lastError }).where(eq(bulkImportRowsTable.id, row.id));
  await db.update(bulkImportJobsTable)
    .set({
      processedRows: sql`${bulkImportJobsTable.processedRows} + 1`,
      failedRows: sql`${bulkImportJobsTable.failedRows} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(bulkImportJobsTable.id, jobId));
}

async function enrichCompany(website: string, company: string, industryHint: string) {
  const text = await fetchWebsiteText(website);
  const lower = text.toLowerCase();
  const industry = industryHint || inferIndustry(lower, website);
  const services = inferServices(lower);
  const signals = inferSignals(lower);
  const confidence = Math.max(0.45, Math.min(0.92, 0.5 + (text.length > 1200 ? 0.18 : 0) + signals.length * 0.04 + services.length * 0.03));
  return {
    company,
    industry,
    services,
    signals,
    confidence,
  };
}

async function fetchWebsiteText(rawUrl: string): Promise<string> {
  if (!rawUrl) return "";
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(normalized, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "text/html,text/plain;q=0.8,*/*;q=0.5",
        "user-agent": "MailFlowAI/1.0 (+bounded-bulk-enrichment)",
      },
    });
    clearTimeout(timer);

    if (!response.ok) return "";
    const raw = (await response.text()).slice(0, MAX_CONTENT);
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!url.hostname.includes(".")) return null;
    url.protocol = "https:";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function inferIndustry(text: string, website: string): string {
  const hostText = website.toLowerCase();
  if (/\bsystemsltd|systems-ltd\b/.test(hostText)) return "enterprise transformation services";
  if (/\bnetsoltech|netsol\b/.test(hostText)) return "fintech and lending platform";
  if (/\b10pearls\b/.test(hostText)) return "product engineering and innovation services";
  if (/\b(healthcare|ehr|emr|patient|claims|clinical|medical)\b/.test(text)) return "healthcare technology";
  if (/\b(fintech|lending|leasing|banking|payments|finance)\b/.test(text)) return "financial technology";
  if (/\b(ai|machine learning|decisioning|predictive|data science)\b/.test(text)) return "AI and data platform";
  if (/\b(cloud|devops|cybersecurity|managed services|erp|crm|digital transformation)\b/.test(text)) return "enterprise IT services";
  if (/\b(contact center|bpo|outsourcing|customer support)\b/.test(text)) return "BPO and customer operations";
  if (/\b(software|product engineering|application development|technology consulting)\b/.test(text)) return "software product engineering";
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, "");
    return `${host.split(".")[0]?.replace(/[-_]/g, " ") || "company"} services`;
  } catch {
    return "business services";
  }
}

function inferServices(text: string): string[] {
  const matches = [
    ["digital transformation", /\bdigital transformation\b/],
    ["cloud modernization", /\bcloud|devops|aws|azure|gcp\b/],
    ["AI workflow enablement", /\b(ai|machine learning|automation|intelligent)\b/],
    ["software engineering", /\bsoftware|application development|product engineering\b/],
    ["implementation services", /\bimplementation|onboarding|deployment\b/],
    ["analytics and reporting", /\banalytics|reporting|dashboard|business intelligence\b/],
    ["finance operations", /\bfinance|billing|reconciliation|accounting|invoice\b/],
  ] as const;
  return matches.filter(([, pattern]) => pattern.test(text)).map(([label]) => label).slice(0, 4);
}

function inferSignals(text: string): string[] {
  const matches = [
    ["growth hiring", /\b(careers|jobs|hiring|join our team|open positions)\b/],
    ["enterprise delivery complexity", /\b(enterprise|global|multi-location|managed services|implementation)\b/],
    ["AI adoption", /\b(ai|machine learning|automation|data science)\b/],
    ["finance visibility need", /\b(finance|billing|reconciliation|invoice|revenue cycle)\b/],
    ["customer onboarding pressure", /\b(onboarding|customer success|support|implementation)\b/],
    ["transformation agenda", /\b(modernization|transformation|cloud migration|erp|crm)\b/],
  ] as const;
  return matches.filter(([, pattern]) => pattern.test(text)).map(([label]) => label).slice(0, 5);
}

export function generateExecutiveTemplate(input: {
  name: string;
  email: string;
  company: string;
  website: string;
  role: string;
  industry: string;
  services: string[];
  signals: string[];
  confidence: number;
  strategy?: TemplateStrategy;
  senderName?: string;
}) {
  const firstName = input.name.split(/\s+/)[0] || "there";
  const strategy = normalizeTemplateStrategy(input.strategy);
  const selectedTemplateId = resolveTemplateForIndustry(input.industry, strategy);
  const guidance = templateGuidance(selectedTemplateId);
  const option = templateOptions().find((item) => item.id === selectedTemplateId);
  const persona = choosePersona(input.role || guidance.personaHint, input.industry, input.signals);
  const pressure = choosePressure(input);
  const narrative = industryNarrative(input.company, input.industry, input.signals, input.services);
  const service = input.services[0] || guidance.service || narrative.valueThemes[0];
  const cta = chooseCta(persona, input.signals, narrative, input.company, selectedTemplateId, guidance.cta);
  const subject = executiveSubject(input.company, persona, narrative, input.signals, selectedTemplateId);
  const confidence = Number(input.confidence.toFixed(2));
  const opening = openingFor(input.company, persona, narrative, input.email);
  const selectedFollowUpStyle = pickFollowUpStyle(input.company);
  const warnings = [
    !input.website ? "missing_website" : "",
    confidence < 0.6 ? "limited_confidence_enrichment" : "",
  ].filter(Boolean);

  const body = humanize([
    `Hi ${firstName},`,
    "",
    opening,
    "",
    `The message I would lead with is ${guidance.pressure || narrative.pressures[0]}: connecting the account story to ${service} without turning it into a generic technology pitch.`,
    "",
    `We help teams prepare executive-ready templates and lead-level messaging before a send is approved, so review focuses on commercial relevance instead of generic volume.`,
    "",
    cta,
    "",
    "Best,",
    "{{sender_name}}",
  ].join("\n"));
  const followup1 = humanize([
    `Hi ${firstName},`,
    "",
    selectedFollowUpStyle.first(input.company, pressure, narrative),
    "",
    selectedFollowUpStyle.bridge,
    "",
    selectedFollowUpStyle.cta,
    "",
    "Best,",
    "{{sender_name}}",
  ].join("\n"));
  const followup2 = humanize([
    `Hi ${firstName},`,
    "",
    selectedFollowUpStyle.second(input.company, narrative),
    "",
    selectedFollowUpStyle.close,
    "",
    "Best,",
    "{{sender_name}}",
  ].join("\n"));
  const sanitized = sanitizeBulkTemplateContent({ subject, body, followup1, followup2, cta }, input.senderName);

  return {
    selectedTemplateId,
    templateName: option?.name ?? selectedTemplateId,
    selectedTone: strategy.globalTone,
    selectedCTAStyle: strategy.globalCTAStyle,
    subject: sanitized.subject,
    body: sanitized.body,
    followup1: sanitized.followup1,
    followup2: sanitized.followup2,
    cta: sanitized.cta,
    rationale: `Template: ${option?.name ?? selectedTemplateId}. Tone: ${strategy.globalTone}. Persona: ${persona}. Narrative: ${narrative.vertical}. Signals used: ${(input.signals.length ? input.signals : ["domain and company context"]).join(", ")}. Confidence ${confidence}. ${strategy.userCustomizationInstructions ? `Instructions: ${strategy.userCustomizationInstructions}.` : ""}`.trim(),
    confidence,
    persona,
    missingDataWarnings: warnings,
    status: "pending_review",
  };
}

function choosePersona(role: string, industry: string, signals: string[]): string {
  const joined = `${role} ${industry} ${signals.join(" ")}`.toLowerCase();
  if (/\bfinance|billing|reconciliation|revenue cycle|cfo\b/.test(joined)) return "Director Finance Operations";
  if (/\bdelivery|implementation|onboarding|services\b/.test(joined)) return "Director Delivery Excellence";
  if (/\bai|data|cloud|erp|digital|transformation|cio|cto\b/.test(joined)) return "Digital Transformation Lead";
  if (/\bsales|revenue|gtm|sdr\b/.test(joined)) return "VP Revenue Operations";
  return "VP Operations";
}

function industryNarrative(company: string, industry: string, signals: string[], services: string[]) {
  const text = `${company} ${industry} ${signals.join(" ")} ${services.join(" ")}`.toLowerCase();
  if (/\b(netsol|lending|leasing|fintech|financial technology|banking|payments)\b/.test(text)) {
    return {
      vertical: "fintech and lending operations",
      pressures: ["lending workflow complexity", "compliance-aware account messaging", "financial platform implementation"],
      valueThemes: ["lending operations context", "finance buyer relevance", "implementation-ready account narratives"],
      subjects: ["Reducing coordination drag in lending operations", "Improving buyer clarity across lending platform deals"],
    };
  }
  if (/\b(systems|enterprise transformation|enterprise it|digital transformation|cloud|devops|erp|managed services)\b/.test(text)) {
    return {
      vertical: "enterprise transformation services",
      pressures: ["delivery visibility", "operational governance", "large-scale execution coordination"],
      valueThemes: ["enterprise account narratives", "delivery governance positioning", "transformation buyer alignment"],
      subjects: ["Improving delivery visibility during enterprise scale-up", "Delivery governance during rapid scaling"],
    };
  }
  if (/\b(10pearls|product engineering|software product|innovation|engineering|application development)\b/.test(text)) {
    return {
      vertical: "product engineering and innovation services",
      pressures: ["engineering velocity", "product delivery alignment", "innovation scaling"],
      valueThemes: ["product delivery context", "engineering-to-business messaging", "innovation buyer relevance"],
      subjects: ["Engineering alignment during product growth", "Improving product delivery conversations at scale"],
    };
  }
  if (/\b(healthcare|ehr|emr|clinical|patient|claims|revenue cycle)\b/.test(text)) {
    return {
      vertical: "healthcare technology",
      pressures: ["implementation complexity", "compliance-sensitive support", "revenue-cycle visibility"],
      valueThemes: ["healthcare buyer context", "implementation readiness", "support continuity"],
      subjects: ["Improving implementation clarity for healthcare buyers", "Reducing onboarding friction in healthcare workflows"],
    };
  }
  if (/\b(ai|machine learning|decisioning|predictive)\b/.test(text)) {
    return {
      vertical: "AI and data platforms",
      pressures: ["buyer education", "ROI proof", "security review"],
      valueThemes: ["AI readiness messaging", "governance-aware outreach", "enterprise proof points"],
      subjects: ["Making AI adoption easier for enterprise buyers", "Improving buyer confidence in AI platform conversations"],
    };
  }
  return {
    vertical: "business services",
    pressures: ["buyer relevance", "message quality", "review consistency"],
    valueThemes: ["account-specific outreach", "sales review quality", "buyer-message alignment"],
    subjects: ["Improving outbound quality without adding review drag", "Sharper account context for executive outreach"],
  };
}

function openingFor(company: string, persona: string, narrative: ReturnType<typeof industryNarrative>, email: string): string {
  const variants = [
    `Reviewing ${company}, the stronger opening for ${persona} is a grounded note around ${narrative.pressures[0]} and ${narrative.pressures[1]}, not broad market messaging.`,
    `A generic sequence would probably undersell ${company}. The stronger entry point is to connect ${narrative.valueThemes[0]} to the buyer concern ${persona} already cares about.`,
    `For ${persona}, the practical discussion at ${company} is less about more outreach and more about whether the right account context reaches the campaign before launch.`,
    `As ${company} scales, the first messaging challenge is making the note feel connected to ${narrative.valueThemes[0]} before a senior buyer dismisses it as automated.`,
    `${company} appears to have enough commercial complexity that ${persona} would likely care more about ${narrative.pressures[0]} than a generic automation message.`,
  ];
  return variants[stableIndex(company + persona + email, variants.length)]!;
}

function executiveSubject(company: string, persona: string, narrative: ReturnType<typeof industryNarrative>, signals: string[], templateId: BulkTemplateId): string {
  const templateSubjects: Partial<Record<BulkTemplateId, string[]>> = {
    cfo_finance_visibility: ["Improving finance visibility before outreach scales", "Cleaner account context for finance-led conversations"],
    fintech_compliance: ["Reducing coordination drag in lending operations", "Improving buyer clarity across lending platform deals"],
    product_engineering_delivery: ["Engineering alignment during product growth", "Improving product delivery conversations at scale"],
    enterprise_transformation: ["Improving delivery visibility during enterprise scale-up", "Delivery governance during rapid scaling"],
    ai_automation: ["Making AI adoption easier for enterprise buyers", "Improving buyer confidence in AI workflow conversations"],
    operational_visibility: ["Improving operational visibility across delivery teams", "Sharper handoffs for implementation-heavy accounts"],
    revops_pipeline: ["Sharper account context for pipeline quality", "Improving outbound quality without adding review drag"],
    soft_relationship: ["A practical note on account context", "A softer path into the buyer conversation"],
    re_engagement: ["Revisiting the conversation with a narrower angle", "A concise follow-up on buyer relevance"],
  };
  const pool = templateSubjects[templateId] ?? narrative.subjects;
  const subject = pool[stableIndex(`${company}|${persona}|${signals.join(",")}|${templateId}`, pool.length)]!;
  return subject
    .replace(/\b(idea|quick|free|guaranteed|10x|unlock|revolutionary|game-changing)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function pickFollowUpStyle(company: string) {
  const styles = [
    {
      first: (name: string, pressure: string) => `The reason I am raising this is that ${pressure.toLowerCase()} usually shows up before teams notice it in campaign results.`,
      bridge: "A small review of sample accounts can often show whether the message is specific enough for senior buyers.",
      cta: "Worth comparing two or three account examples?",
      second: (name: string) => `I will step back after this. If ${name} is tightening outbound quality later, the useful first step is usually a narrow template review rather than a broad platform discussion.`,
      close: "Happy to send a concise example for one buyer persona.",
    },
    {
      first: (name: string, _pressure: string, narrative: ReturnType<typeof industryNarrative>) => `One thing I would avoid for ${name}: leading with generic AI language when the real hook is ${narrative.valueThemes[0]}.`,
      bridge: "That kind of framing tends to make outreach easier for an executive team to review before anything is sent.",
      cta: "Open to seeing what that first-touch angle could look like?",
      second: (name: string, narrative: ReturnType<typeof industryNarrative>) => `Timing may be early, so I will close the loop. The note was mainly about making ${narrative.valueThemes[1]} visible in outbound before the campaign goes live.`,
      close: "If useful later, I can share a short sample sequence.",
    },
    {
      first: (name: string, pressure: string, narrative: ReturnType<typeof industryNarrative>) => `${name} may already have the tools. The gap I am pointing at is message judgment: whether ${narrative.pressures[0]} and ${pressure.toLowerCase()} are clear enough in the first two touches.`,
      bridge: "That is often where senior prospects decide whether a note feels relevant or automated.",
      cta: "Would a short messaging readout be worth reviewing?",
      second: (name: string) => `No problem if this is not active. I thought ${name} was worth a more careful angle than a standard outbound template.`,
      close: "I can leave you with one example if helpful.",
    },
  ];
  return styles[stableIndex(company, styles.length)]!;
}

function choosePressure(input: { industry: string; signals: string[] }): string {
  const joined = `${input.industry} ${input.signals.join(" ")}`.toLowerCase();
  if (/\bfinance|billing|reconciliation|revenue cycle\b/.test(joined)) return "finance visibility and reconciliation pressure";
  if (/\bimplementation|onboarding|delivery\b/.test(joined)) return "delivery coordination and onboarding pressure";
  if (/\bai|data|automation\b/.test(joined)) return "AI workflow readiness and governance pressure";
  if (/\bcloud|erp|crm|transformation\b/.test(joined)) return "modernization and reporting visibility pressure";
  return "campaign quality and account intelligence pressure";
}

function chooseCta(persona: string, signals: string[], narrative: ReturnType<typeof industryNarrative>, company: string, templateId?: BulkTemplateId, fallback?: string): string {
  const joined = `${persona} ${signals.join(" ")}`.toLowerCase();
  const options = [
    `Open to comparing notes on a ${narrative.valueThemes[0]} angle for ${company}?`,
    `Would a short ${narrative.pressures[0]} messaging review be useful?`,
    `Worth reviewing a first-touch draft for ${persona}?`,
  ];
  if (/\bfinance|billing|reconciliation\b/.test(joined)) return "Should I share a finance visibility walkthrough grounded in public context?";
  if (/\bdelivery|implementation|onboarding\b/.test(joined)) return "Open to a delivery coordination review focused on buyer handoff clarity?";
  if (/\bai|digital|transformation|cloud\b/.test(joined)) return "Would a practical modernization-readiness outreach preview be useful?";
  if (templateId && fallback) return fallback;
  return options[stableIndex(`${company}|${persona}|${signals.join(",")}`, options.length)]!;
}

function humanize(value: string): string {
  return value
    .replace(/\bpublic positioning points to\b/gi, "the company story indicates")
    .replace(/\bpractical executive question\b/gi, "commercial question")
    .replace(/\boperational follow-through\b/gi, "follow-up discipline")
    .replace(/\bcampaign personalization\b/gi, "account-specific messaging")
    .replace(/\bworkflow map\b/gi, "operational review")
    .replace(/\bworkflow automation\b/gi, "process support")
    .replace(/\bexecution rhythm and context discipline\b/gi, "delivery coordination and buyer handoff clarity")
    .replace(/\bcampaign intelligence and operational readiness\b/gi, "account intelligence and campaign review quality")
    .replace(/\bWould it be useful\b/g, "Would it help")
    .replace(/\bThe relevant conversation is not another tool pitch\.?\s*It is whether\b/gi, "What usually becomes difficult at this stage is whether")
    .replace(/\bThe relevant conversation is whether\b/gi, "What usually matters is whether")
    .replace(/\bthe relevant conversation is\b/gi, "the practical question is")
    .replace(/\bpressure-testing\b/gi, "comparing notes")
    .replace(/\bcredible outreach angle\b/gi, "practical way into the conversation")
    .replace(/\bread-only view\b/gi, "short perspective")
    .replace(/\bwhat the company can credibly claim\b/gi, "without stretching the positioning")
    .replace(/\bcredibly claim\b/gi, "keep grounded")
    .replace(/\bmarket story does create\b/gi, "growth trajectory raises")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stableIndex(text: string, length: number): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 7919;
  return Math.abs(hash) % Math.max(1, length);
}
