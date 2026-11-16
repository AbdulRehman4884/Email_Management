/**
 * src/services/enrichment/websiteFetch.service.ts
 *
 * Fetches and returns cleaned website content using:
 *   1. Jina Reader (primary)   — GET https://r.jina.ai/{url}, Accept: application/json
 *   2. Firecrawl (fallback)    — POST https://api.firecrawl.dev/v0/scrape (requires FIRECRAWL_API_KEY)
 *
 * Timeouts: 15 s per source attempt.
 * Content cap: 8 000 characters (sufficient for LLM enrichment; avoids token overruns).
 * Never throws — all errors are captured in the returned result.
 */

import { z } from "zod";
import { env } from "../../config/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("service:websiteFetch");

// ── Result type ───────────────────────────────────────────────────────────────

export interface FetchWebsiteContentResult {
  success: boolean;
  url: string;
  title?: string;
  content?: string;
  contentLength?: number;
  fallbackUsed?: boolean;
  error?: string;
  source: "jina" | "firecrawl" | "none";
}

const CONTENT_CAP = 8_000;

// ── Jina Reader ───────────────────────────────────────────────────────────────

const JinaResponseSchema = z.object({
  data: z
    .object({
      title:   z.string().optional(),
      content: z.string().optional(),
      url:     z.string().optional(),
    })
    .optional(),
});

async function fetchWithJina(url: string): Promise<FetchWebsiteContentResult> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.JINA_API_KEY) headers["Authorization"] = `Bearer ${env.JINA_API_KEY}`;

  const response = await fetch(jinaUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Jina Reader returned ${response.status}`);
  }

  const raw  = await response.json();
  const data = JinaResponseSchema.parse(raw);
  const page = data.data;

  const content = page?.content?.trim() ?? "";
  if (!content) {
    return {
      success: false,
      url,
      source:  "jina",
      error:   "Empty content returned by Jina Reader",
    };
  }

  return {
    success:       true,
    url:           page?.url ?? url,
    ...(page?.title ? { title: page.title } : {}),
    content:       content.slice(0, CONTENT_CAP),
    contentLength: content.length,
    source:        "jina" as const,
  };
}

// ── Firecrawl ─────────────────────────────────────────────────────────────────

const FirecrawlResponseSchema = z.object({
  data: z
    .object({
      metadata: z.object({ title: z.string().optional() }).optional(),
      markdown: z.string().optional(),
    })
    .optional(),
});

async function fetchWithFirecrawl(
  url: string,
  apiKey: string,
): Promise<FetchWebsiteContentResult> {
  const response = await fetch("https://api.firecrawl.dev/v0/scrape", {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${apiKey}`,
    },
    body:   JSON.stringify({ url, formats: ["markdown"] }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Firecrawl returned ${response.status}`);
  }

  const raw  = await response.json();
  const data = FirecrawlResponseSchema.parse(raw);
  const page = data.data;

  const content = page?.markdown?.trim() ?? "";
  if (!content) {
    return {
      success: false,
      url,
      source:  "firecrawl",
      error:   "Empty content returned by Firecrawl",
    };
  }

  return {
    success:      true,
    url,
    ...(page?.metadata?.title ? { title: page.metadata.title } : {}),
    content:      content.slice(0, CONTENT_CAP),
    contentLength: content.length,
    source:       "firecrawl" as const,
    fallbackUsed: true,
  };
}

// ── URL normalisation ─────────────────────────────────────────────────────────

function normaliseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

// ── Public service function ───────────────────────────────────────────────────

export async function fetchWebsiteContent(url: string): Promise<FetchWebsiteContentResult> {
  const normalised = normaliseUrl(url);

  // ── 1. Jina Reader ────────────────────────────────────────────────────────
  try {
    const result = await fetchWithJina(normalised);
    if (result.success) {
      log.debug(
        { url: normalised, source: "jina", contentLength: result.contentLength },
        "websiteFetch: Jina Reader succeeded",
      );
      return result;
    }
    log.warn({ url: normalised }, "websiteFetch: Jina Reader returned empty content");
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.message.toLowerCase().includes("abort"));
    log.warn(
      { url: normalised, err: err instanceof Error ? err.message : err, isTimeout },
      "websiteFetch: Jina Reader failed",
    );
  }

  // ── 2. Firecrawl fallback ─────────────────────────────────────────────────
  if (env.FIRECRAWL_API_KEY) {
    try {
      const result = await fetchWithFirecrawl(normalised, env.FIRECRAWL_API_KEY);
      if (result.success) {
        log.debug(
          { url: normalised, source: "firecrawl", contentLength: result.contentLength },
          "websiteFetch: Firecrawl succeeded",
        );
        return result;
      }
      log.warn({ url: normalised }, "websiteFetch: Firecrawl returned empty content");
    } catch (err) {
      log.warn(
        { url: normalised, err: err instanceof Error ? err.message : err },
        "websiteFetch: Firecrawl failed",
      );
    }
  }

  // ── 3. All sources failed ─────────────────────────────────────────────────
  return {
    success: false,
    url:     normalised,
    source:  "none",
    error:   "Website content could not be fetched (all sources failed or timed out)",
  };
}

// ── Company website (home + about + services) ─────────────────────────────────

/** Per-page share of the combined text, and the combined cap. */
const SUBPAGE_CAP = 6_000;
const SITE_CONTENT_CAP = 16_000;
/** Pages shorter than this are treated as empty / error pages. */
const MIN_PAGE_CHARS = 200;

const ABOUT_PATH_RE = /\/(about|about-us|company|who-we-are|our-story)(\/|$)/i;
const SERVICES_PATH_RE = /\/(services|our-services|solutions|what-we-do|products)(\/|$)/i;

export interface ScrapedPage {
  url:   string;
  kind:  "home" | "about" | "services";
  chars: number;
}

export interface FetchCompanyWebsiteResult extends FetchWebsiteContentResult {
  /** Pages that contributed text, with how much each gave. */
  pages: ScrapedPage[];
}

/**
 * Picks an about-page and a services-page URL: links found on the homepage
 * first (same host), otherwise the common /about and /services paths.
 */
export function pickSubpageUrls(homeUrl: string, homeContent: string): { about: string; services: string } {
  let origin: string;
  let host: string;
  try {
    const u = new URL(homeUrl);
    origin = u.origin;
    host = u.hostname.replace(/^www\./, "");
  } catch {
    return { about: `${homeUrl.replace(/\/+$/, "")}/about`, services: `${homeUrl.replace(/\/+$/, "")}/services` };
  }

  const links: string[] = [];
  for (const m of homeContent.matchAll(/\]\((https?:\/\/[^)\s"]+)/g)) {
    try {
      const u = new URL(m[1]!);
      if (u.hostname.replace(/^www\./, "") === host) links.push(`${u.origin}${u.pathname}`.replace(/\/+$/, ""));
    } catch {
      // ignore malformed links
    }
  }

  const byShortest = (re: RegExp) =>
    links.filter((l) => re.test(new URL(l).pathname)).sort((a, b) => a.length - b.length)[0];

  return {
    about:    byShortest(ABOUT_PATH_RE) ?? `${origin}/about`,
    services: byShortest(SERVICES_PATH_RE) ?? `${origin}/services`,
  };
}

function looksLikeErrorPage(r: FetchWebsiteContentResult): boolean {
  const head = `${r.title ?? ""} ${(r.content ?? "").slice(0, 400)}`.toLowerCase();
  return /\b404\b|page not found|not be found|doesn['’]t exist|does not exist/.test(head);
}

/**
 * Reads the homepage plus the about and services pages (in parallel) and joins
 * them into one text, each page under its own heading. Subpages that are
 * missing, error pages, or just the homepage again are skipped.
 * Logs how much text each page gave, so "no script" can be traced to scraping vs AI.
 * Never throws.
 */
export async function fetchCompanyWebsite(url: string): Promise<FetchCompanyWebsiteResult> {
  const normalised = normaliseUrl(url);
  const home = await fetchWebsiteContent(normalised);
  const homeContent = home.success ? home.content ?? "" : "";

  const { about, services } = pickSubpageUrls(home.url || normalised, homeContent);
  const [aboutPage, servicesPage] = await Promise.all([
    about === services ? Promise.resolve(undefined) : fetchWebsiteContent(about),
    fetchWebsiteContent(services),
  ]);

  const homeHead = homeContent.slice(0, 300);
  const usable = (r: FetchWebsiteContentResult | undefined): r is FetchWebsiteContentResult =>
    !!r && r.success && (r.content?.length ?? 0) >= MIN_PAGE_CHARS && !looksLikeErrorPage(r) &&
    (r.content ?? "").slice(0, 300) !== homeHead;

  const parts: string[] = [];
  const pages: ScrapedPage[] = [];
  if (homeContent) {
    parts.push(`## Home page (${home.url})\n${homeContent}`);
    pages.push({ url: home.url, kind: "home", chars: homeContent.length });
  }
  for (const [kind, r] of [["about", aboutPage], ["services", servicesPage]] as const) {
    if (!usable(r)) continue;
    const text = (r.content ?? "").slice(0, SUBPAGE_CAP);
    parts.push(`## ${kind === "about" ? "About" : "Services"} page (${r.url})\n${text}`);
    pages.push({ url: r.url, kind, chars: text.length });
  }

  const content = parts.join("\n\n").slice(0, SITE_CONTENT_CAP);
  log.info(
    {
      url:        normalised,
      totalChars: content.length,
      pages:      pages.map((p) => `${p.kind}:${p.chars}`),
      triedAbout: aboutPage ? about : undefined,
      triedServices: services,
      homeSource: home.source,
    },
    "websiteFetch: company website scraped",
  );

  if (!content) {
    return { ...home, url: normalised, pages: [] };
  }
  return {
    success:       true,
    url:           home.url || normalised,
    ...(home.title ? { title: home.title } : {}),
    content,
    contentLength: content.length,
    source:        home.success ? home.source : (aboutPage?.success ? aboutPage.source : servicesPage.source),
    pages,
  };
}
