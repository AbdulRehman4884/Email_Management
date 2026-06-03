import { normalizeCompanyUrl, type WebsiteIntelligence } from "./companyWebsiteEnrichment.js";

export interface ExternalBusinessEvent {
  type: "partnership" | "expansion" | "product" | "event" | "executive" | "funding" | "acquisition" | "market";
  summary: string;
  confidence: number;
  sourceUrl: string;
  verificationNeeded: boolean;
}

export interface ExternalBusinessIntelligence {
  events: ExternalBusinessEvent[];
  externalTriggerConfidence: number;
  strategicEventConfidence: number;
  verificationNeededFlags: string[];
  sourcesAttempted: string[];
  sourcesFetched: string[];
  limited: boolean;
}

const EXTERNAL_PATHS = ["/news", "/press", "/press-releases", "/blog", "/insights", "/events", "/partners"];
const MAX_EXTERNAL_PAGES = 3;
const MAX_EXTERNAL_CONTENT = 18000;
const FETCH_TIMEOUT_MS = 3000;

export async function fetchExternalBusinessIntelligence(
  enrichment: WebsiteIntelligence,
): Promise<ExternalBusinessIntelligence> {
  const candidates = buildExternalUrls(enrichment.normalizedUrl);
  const sourcesAttempted = candidates.slice(0, MAX_EXTERNAL_PAGES);
  const fetched: Array<{ url: string; content: string }> = [];

  for (const url of sourcesAttempted) {
    const content = await safeFetchText(url);
    if (content) {
      fetched.push({ url, content: content.slice(0, MAX_EXTERNAL_CONTENT) });
    }
  }

  const events = detectExternalEvents([
    ...enrichment.pagesFetched.map((page) => ({ url: page.url, content: page.content })),
    ...fetched,
  ]);
  const confidence = events.length > 0 ? Math.min(88, 52 + events.length * 9) : 42;

  return {
    events,
    externalTriggerConfidence: confidence,
    strategicEventConfidence: events.some((event) => event.confidence >= 72) ? confidence : Math.max(35, confidence - 10),
    verificationNeededFlags: verificationFlags(events, fetched.length, sourcesAttempted.length),
    sourcesAttempted,
    sourcesFetched: fetched.map((page) => page.url),
    limited: fetched.length === 0 && events.length === 0,
  };
}

export function detectExternalEvents(pages: Array<{ url: string; content: string }>): ExternalBusinessEvent[] {
  const events: ExternalBusinessEvent[] = [];

  for (const page of pages) {
    const text = compact(page.content);
    if (!text) continue;

    maybePush(events, page.url, text, "partnership", /\b(partner|partnership|alliance|ecosystem|collaboration)\b/i, "Public pages reference partnership or ecosystem activity that may widen account coordination needs.");
    maybePush(events, page.url, text, "expansion", /\b(expansion|new office|global delivery|new market|regional growth|opened)\b/i, "Public pages reference expansion or market growth that may increase operating complexity.");
    maybePush(events, page.url, text, "product", /\b(launch|released|new product|platform update|solution launch)\b/i, "Public pages reference product or solution activity that can support a timely buyer-education angle.");
    maybePush(events, page.url, text, "event", /\b(conference|webinar|summit|expo|event|panel)\b/i, "Public pages reference event activity that may create a useful near-term outreach hook.");
    maybePush(events, page.url, text, "executive", /\b(appointed|joins as|named|chief|vice president|vp)\b/i, "Public pages reference leadership or executive movement that should be verified before use in outreach.");

    if (/\b(funding|raised|series [abcde]|investment round)\b/i.test(text)) {
      maybePush(events, page.url, text, "funding", /\b(funding|raised|series [abcde]|investment round)\b/i, "Public pages explicitly reference funding or investment activity; verify details before using it.");
    }

    if (/\b(acquired|acquisition|merger|merged)\b/i.test(text)) {
      maybePush(events, page.url, text, "acquisition", /\b(acquired|acquisition|merger|merged)\b/i, "Public pages explicitly reference acquisition or merger activity; verify details before using it.");
    }
  }

  return uniqueEvents(events).slice(0, 8);
}

function maybePush(
  events: ExternalBusinessEvent[],
  sourceUrl: string,
  text: string,
  type: ExternalBusinessEvent["type"],
  pattern: RegExp,
  summary: string,
): void {
  if (!pattern.test(text)) return;
  const explicitStrategic = /\b(announced|launch|partner|expansion|appointed|acquired|raised|new office)\b/i.test(text);
  events.push({
    type,
    summary,
    confidence: explicitStrategic ? 74 : 62,
    sourceUrl,
    verificationNeeded: type === "funding" || type === "acquisition" || type === "executive",
  });
}

function buildExternalUrls(website: string): string[] {
  const normalized = normalizeCompanyUrl(website);
  if (!normalized) return [];
  const base = normalized.replace(/\/+$/g, "");
  return EXTERNAL_PATHS.map((path) => `${base}${path}`);
}

async function safeFetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "user-agent": "MailFlowAI/1.0 research-enrichment",
      },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text|html|xml|json/i.test(contentType)) return null;
    return htmlToText(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, MAX_EXTERNAL_CONTENT).trim();
}

function uniqueEvents(events: ExternalBusinessEvent[]): ExternalBusinessEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.type}:${event.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function verificationFlags(
  events: ExternalBusinessEvent[],
  fetchedCount: number,
  attemptedCount: number,
): string[] {
  const flags = events
    .filter((event) => event.verificationNeeded)
    .map((event) => `${event.type} signal from ${event.sourceUrl} requires manual verification`);
  if (attemptedCount > 0 && fetchedCount === 0) {
    flags.push("External news and press pages were attempted but not available in this run.");
  }
  if (events.length === 0) {
    flags.push("No bounded external event signal detected from available public pages.");
  }
  return flags;
}
