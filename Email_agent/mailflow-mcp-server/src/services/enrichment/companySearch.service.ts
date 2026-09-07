/**
 * src/services/enrichment/companySearch.service.ts
 *
 * Searches for a company's official website candidates using DuckDuckGo.
 * No API key required — uses the duck-duck-scrape library.
 *
 * Search result states:
 *   "duckduckgo"    — real candidates returned and filtered
 *   "no_results"    — DDG ran successfully but returned nothing useful
 *   "rate_limited"  — DDG blocked the request (anomaly / too-fast detection)
 *   "search_failed" — unexpected error from DDG
 *   "timeout"       — request exceeded SEARCH_TIMEOUT_MS
 *
 * Retry policy:
 *   Rate-limited errors are retried up to MAX_RETRIES times with a
 *   randomised delay (RETRY_DELAY_MIN_MS … RETRY_DELAY_MIN_MS + RETRY_DELAY_RANGE_MS).
 *   Timeouts and hard failures are NOT retried by the service; callers
 *   may retry based on the `retryable` flag in the result.
 *
 * No fake/heuristic domains are ever generated.
 */

import { search, SafeSearchType } from "duck-duck-scrape";
import type { SearchResults, SearchResult } from "duck-duck-scrape";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("service:companySearch");

// ── Public types ──────────────────────────────────────────────────────────────

export type CompanySearchStatus =
  | "duckduckgo"
  | "no_results"
  | "rate_limited"
  | "search_failed"
  | "timeout";

export interface CandidateWebsite {
  title:   string;
  url:     string;
  snippet: string;
}

export interface SearchCompanyWebOptions {
  location?:   string;
  country?:    string;
  maxResults?: number;
}

export interface CompanySearchResult {
  success:     boolean;
  companyName: string;
  query:       string;
  candidates:  CandidateWebsite[];
  source:      CompanySearchStatus;
  count:       number;
  error?:      string;
  retryable?:  boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SEARCH_TIMEOUT_MS    = 12_000;
const MAX_RETRIES          = 2;
const RETRY_DELAY_MIN_MS   = 800;
const RETRY_DELAY_RANGE_MS = 1_000;
const DEFAULT_MAX          = 8;

export const SOCIAL_DOMAINS = new Set([
  "linkedin.com",    "facebook.com",  "twitter.com",   "x.com",
  "instagram.com",   "crunchbase.com","yelp.com",      "yellowpages.com",
  "bloomberg.com",   "reuters.com",   "forbes.com",    "techcrunch.com",
  "glassdoor.com",   "indeed.com",    "wikipedia.org", "youtube.com",
  "tiktok.com",      "pinterest.com", "reddit.com",    "medium.com",
  "angel.co",        "dnb.com",       "zoominfo.com",  "apollo.io",
  "owler.com",       "manta.com",     "bizbuysell.com","clutch.co",
  "g2.com",          "trustpilot.com","bbb.org",       "kompass.com",
]);

const DIRECTORY_PATTERNS = [
  /\bjobs?\b/, /\bcareers?\b/, /\brecruit\b/, /\bhiring\b/,
  /\bdirectory\b/, /\blisting\b/, /\bprofile\b/, /\breviews?\b/,
];

// ── Internal helpers (sleep is overridable for testing) ───────────────────────

/** Mutable object so tests can replace `.sleep` without ESM read-only binding issues. */
export const _internals = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

class SearchTimeoutError extends Error {
  constructor() {
    super(`Search request timed out after ${SEARCH_TIMEOUT_MS}ms`);
    this.name = "SearchTimeoutError";
  }
}

/** Returns true when the URL's eTLD+1 is in the social-domains set. */
export function isSocialDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (SOCIAL_DOMAINS.has(hostname)) return true;
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      return SOCIAL_DOMAINS.has(parts.slice(-2).join("."));
    }
    return false;
  } catch {
    return false;
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function buildSearchQuery(companyName: string, opts?: SearchCompanyWebOptions): string {
  const geo = opts?.location ?? opts?.country;
  return geo
    ? `"${companyName}" ${geo} official website`
    : `"${companyName}" official website`;
}

function normalizeResults(raw: SearchResult[], max: number): CandidateWebsite[] {
  return raw
    .filter((r) => {
      if (!r.url || !r.url.startsWith("http")) return false;
      if (isSocialDomain(r.url)) return false;
      const lower = r.url.toLowerCase();
      if (DIRECTORY_PATTERNS.some((re) => re.test(lower))) return false;
      return true;
    })
    .slice(0, max)
    .map((r) => ({
      title:   r.title ?? "",
      url:     r.url,
      snippet: stripHtml(r.description ?? r.rawDescription ?? ""),
    }));
}

function randomRetryDelay(): number {
  return RETRY_DELAY_MIN_MS + Math.floor(Math.random() * RETRY_DELAY_RANGE_MS);
}

// ── Error classification ──────────────────────────────────────────────────────

interface ErrorClass {
  source:    CompanySearchStatus;
  autoRetry: boolean;   // whether the service itself should retry
  retryable: boolean;   // whether the caller may retry later
  message:   string;
}

function classifyError(err: unknown): ErrorClass {
  if (err instanceof SearchTimeoutError) {
    return { source: "timeout", autoRetry: false, retryable: true, message: err.message };
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // DuckDuckGo rate-limiting / anomaly detection
  if (
    msg.includes("anomaly") ||
    msg.includes("too quickly") ||
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("blocked")
  ) {
    return { source: "rate_limited", autoRetry: true, retryable: true, message: msg };
  }

  // Network / OS timeout signals
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused")
  ) {
    return { source: "timeout", autoRetry: false, retryable: true, message: msg };
  }

  return { source: "search_failed", autoRetry: false, retryable: false, message: msg };
}

// ── DDG call with built-in timeout ───────────────────────────────────────────

function attemptDdgSearch(query: string): Promise<SearchResults> {
  return new Promise<SearchResults>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SearchTimeoutError()), SEARCH_TIMEOUT_MS);

    search(query, { safeSearch: SafeSearchType.STRICT })
      .then((r) => { clearTimeout(timer); resolve(r); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Searches DuckDuckGo for a company's official website with retry logic.
 *
 * Rate-limited errors are retried up to MAX_RETRIES times.
 * Timeout and hard failures return immediately with retryable metadata.
 * No fake/heuristic domains are generated under any circumstance.
 */
export async function searchCompanyWeb(
  companyName: string,
  options?: SearchCompanyWebOptions,
): Promise<CompanySearchResult> {
  const query = buildSearchQuery(companyName, options);
  const max   = options?.maxResults ?? DEFAULT_MAX;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Randomised delay before retries (never before first attempt)
    if (attempt > 0) {
      const delayMs = randomRetryDelay();
      log.info({ companyName, query, attempt, delayMs }, "companySearch: retry after delay");
      await _internals.sleep(delayMs);
    }

    const t0 = Date.now();

    try {
      const results    = await attemptDdgSearch(query);
      const durationMs = Date.now() - t0;

      if (results.noResults || !results.results?.length) {
        log.info(
          { companyName, query, attempt, durationMs, source: "no_results", candidateCount: 0 },
          "companySearch: DDG returned no results",
        );
        return { success: true, companyName, query, candidates: [], source: "no_results", count: 0 };
      }

      const candidates = normalizeResults(results.results, max);

      if (candidates.length === 0) {
        log.info(
          { companyName, query, attempt, durationMs, source: "no_results", candidateCount: 0 },
          "companySearch: all DDG results filtered out (social/directory)",
        );
        return { success: true, companyName, query, candidates: [], source: "no_results", count: 0 };
      }

      log.info(
        { companyName, query, attempt, durationMs, source: "duckduckgo", candidateCount: candidates.length },
        "companySearch: success",
      );
      return { success: true, companyName, query, candidates, source: "duckduckgo", count: candidates.length };

    } catch (err) {
      const durationMs = Date.now() - t0;
      const classified = classifyError(err);

      log.warn(
        {
          companyName, query, attempt, durationMs,
          source: classified.source,
          errorClassification: classified.source,
          error: classified.message,
        },
        "companySearch: attempt failed",
      );

      // Rate-limited errors are retried; everything else fails fast
      if (attempt < MAX_RETRIES && classified.autoRetry) {
        continue;
      }

      return {
        success:   false,
        companyName,
        query,
        candidates: [],
        source:    classified.source,
        count:     0,
        error:     classified.message,
        retryable: classified.retryable,
      };
    }
  }

  // Unreachable — TypeScript guard
  /* c8 ignore next */
  return { success: false, companyName, query, candidates: [], source: "search_failed", count: 0, error: "exhausted", retryable: false };
}
