export interface WebsitePageResult {
  url: string;
  ok: boolean;
  status?: number;
  content: string;
  error?: string;
}

export interface WebsiteIntelligence {
  requestedUrl: string;
  normalizedUrl: string;
  domain: string;
  pagesAttempted: string[];
  pagesFetched: WebsitePageResult[];
  combinedText: string;
  limited: boolean;
  errors: string[];
}

export interface WebsiteSignals {
  serviceKeywords: string[];
  industrySignals: string[];
  buyerSignals: string[];
  technologySignals: string[];
  hiringOrGrowthSignals: string[];
  caseStudySignals: string[];
  financeSignals: string[];
  salesSignals: string[];
  operationalSignals: string[];
}

const PAGE_PATHS = [
  "/",
  "/about",
  "/services",
  "/solutions",
  "/industries",
  "/case-studies",
  "/customers",
  "/products",
  "/careers",
  "/jobs",
  "/join-us",
  "/work-with-us",
  "/open-positions",
  "/life-at",
  "/team",
] as const;

const MAX_PAGES_PER_COMPANY = 5;
const MAX_CONTENT_PER_PAGE = 18_000;
const MAX_CONTENT_PER_COMPANY = 45_000;
const FETCH_TIMEOUT_MS = 4_000;

export function normalizeCompanyUrl(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/[>,.;)\]}]+$/g, "");
  if (!cleaned) return undefined;

  try {
    const url = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
    if (!url.hostname.includes(".")) return undefined;
    if (!["http:", "https:"].includes(url.protocol)) return undefined;

    url.protocol = "https:";
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/g, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function extractCompanyNameFromUrl(rawUrl: string): string {
  const normalized = normalizeCompanyUrl(rawUrl) ?? rawUrl;
  try {
    const domain = new URL(normalized).hostname.replace(/^www\./i, "");
    const base = domain.split(".")[0] ?? "Company";
    return titleize(base.replace(/[-_]+/g, " "));
  } catch {
    return "Company";
  }
}

export async function fetchWebsiteIntelligence(rawUrl: string): Promise<WebsiteIntelligence> {
  const normalizedUrl = normalizeCompanyUrl(rawUrl);
  if (!normalizedUrl) {
    return {
      requestedUrl: rawUrl,
      normalizedUrl: rawUrl,
      domain: rawUrl,
      pagesAttempted: [],
      pagesFetched: [],
      combinedText: "",
      limited: true,
      errors: ["Invalid website URL"],
    };
  }

  const base = new URL(normalizedUrl);
  const domain = base.hostname.replace(/^www\./i, "");
  const pagesAttempted = buildPageUrls(base).slice(0, MAX_PAGES_PER_COMPANY);
  const pagesFetched = await Promise.all(pagesAttempted.map((pageUrl) => fetchPageText(pageUrl)));
  const errors: string[] = pagesFetched
    .filter((result) => !result.ok)
    .map((result) => `${result.url}: ${result.error ?? result.status ?? "failed"}`);
  let combinedText = "";

  for (const result of pagesFetched) {
    if (!result.ok) {
      continue;
    }

    const remaining = MAX_CONTENT_PER_COMPANY - combinedText.length;
    if (remaining <= 0) break;
    combinedText += `\n\nURL: ${result.url}\n${result.content.slice(0, remaining)}`;
  }

  return {
    requestedUrl: rawUrl,
    normalizedUrl,
    domain,
    pagesAttempted,
    pagesFetched,
    combinedText: combinedText.trim(),
    limited: combinedText.trim().length < 600,
    errors,
  };
}

export function extractWebsiteSignals(content: string): WebsiteSignals {
  return {
    serviceKeywords: extractServiceKeywords(content),
    industrySignals: extractIndustrySignals(content),
    buyerSignals: extractBuyerSignals(content),
    technologySignals: extractTechnologySignals(content),
    hiringOrGrowthSignals: extractHiringOrGrowthSignals(content),
    caseStudySignals: extractCaseStudySignals(content),
    financeSignals: extractByDictionary(content, FINANCE_TERMS),
    salesSignals: extractByDictionary(content, SALES_TERMS),
    operationalSignals: extractByDictionary(content, OPERATIONAL_TERMS),
  };
}

export function extractServiceKeywords(content: string): string[] {
  return extractByDictionary(content, SERVICE_TERMS);
}

export function extractIndustrySignals(content: string): string[] {
  return extractByDictionary(content, INDUSTRY_TERMS);
}

export function extractBuyerSignals(content: string): string[] {
  return extractByDictionary(content, BUYER_TERMS);
}

export function extractTechnologySignals(content: string): string[] {
  return extractByDictionary(content, TECHNOLOGY_TERMS);
}

export function extractHiringOrGrowthSignals(content: string): string[] {
  return extractByDictionary(content, GROWTH_TERMS);
}

export function extractCaseStudySignals(content: string): string[] {
  return extractByDictionary(content, CASE_STUDY_TERMS);
}

function buildPageUrls(base: URL): string[] {
  const root = `${base.protocol}//${base.hostname}`;
  const urls = new Set<string>();
  if (base.pathname && base.pathname !== "/") urls.add(base.toString().replace(/\/$/, ""));
  for (const path of PAGE_PATHS) urls.add(`${root}${path === "/" ? "" : path}`);
  return [...urls];
}

async function fetchPageText(url: string): Promise<WebsitePageResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept": "text/html, text/plain;q=0.8, */*;q=0.5",
        "user-agent": "MailFlowAI/1.0 (+read-only-company-research)",
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      return { url, ok: false, status: response.status, content: "", error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text|html|json|xml/i.test(contentType)) {
      return { url, ok: false, status: response.status, content: "", error: `Unsupported content type: ${contentType}` };
    }

    const raw = (await response.text()).slice(0, MAX_CONTENT_PER_PAGE);
    const content = cleanWebsiteText(raw);
    if (content.length < 80) return { url, ok: false, status: response.status, content: "", error: "Content too short" };
    return { url, ok: true, status: response.status, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fetch failed";
    return { url, ok: false, content: "", error: message };
  }
}

function cleanWebsiteText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractByDictionary(content: string, terms: readonly string[]): string[] {
  const lower = content.toLowerCase();
  const found = terms.filter((term) => lower.includes(term.toLowerCase()));
  return [...new Set(found)].slice(0, 12);
}

function titleize(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ") || "Company";
}

const SERVICE_TERMS = [
  "software development",
  "product engineering",
  "digital transformation",
  "cloud migration",
  "DevOps",
  "data analytics",
  "AI",
  "machine learning",
  "managed services",
  "ERP",
  "CRM",
  "contact center",
  "BPO",
  "healthcare software",
  "revenue cycle",
  "lending",
  "leasing",
  "payments",
  "implementation",
] as const;

const INDUSTRY_TERMS = [
  "healthcare",
  "fintech",
  "financial services",
  "banking",
  "insurance",
  "lending",
  "leasing",
  "retail",
  "ecommerce",
  "manufacturing",
  "telecom",
  "public sector",
  "education",
  "logistics",
  "enterprise",
  "SaaS",
  "clinical",
  "patient",
  "pharmacy",
] as const;

const BUYER_TERMS = [
  "CFO",
  "finance teams",
  "sales teams",
  "operations teams",
  "enterprise",
  "SMB",
  "startups",
  "health systems",
  "providers",
  "banks",
  "lenders",
  "insurers",
  "CXO",
  "IT leaders",
  "developers",
] as const;

const TECHNOLOGY_TERMS = [
  "cloud",
  "AWS",
  "Azure",
  "Google Cloud",
  "Salesforce",
  "Microsoft Dynamics",
  "SAP",
  "Oracle",
  "Kubernetes",
  "data warehouse",
  "API",
  "automation",
  "generative AI",
  "computer vision",
  "decisioning",
  "analytics",
  "cybersecurity",
] as const;

const GROWTH_TERMS = [
  "careers",
  "we are hiring",
  "open positions",
  "global",
  "offices",
  "customers",
  "partners",
  "award",
  "growth",
  "expansion",
  "enterprise clients",
  "case study",
] as const;

const CASE_STUDY_TERMS = [
  "case study",
  "success story",
  "customer story",
  "client success",
  "portfolio",
  "our work",
  "results",
  "implemented",
] as const;

const FINANCE_TERMS = [
  "billing",
  "invoice",
  "reconciliation",
  "payments",
  "collections",
  "revenue cycle",
  "claims",
  "accounts payable",
  "accounts receivable",
  "financial reporting",
  "ERP",
] as const;

const SALES_TERMS = [
  "sales",
  "CRM",
  "pipeline",
  "lead generation",
  "customer acquisition",
  "proposal",
  "demo",
  "qualification",
  "go-to-market",
] as const;

const OPERATIONAL_TERMS = [
  "workflow",
  "operations",
  "onboarding",
  "implementation",
  "support",
  "delivery",
  "resource",
  "project management",
  "managed services",
  "SLA",
] as const;
