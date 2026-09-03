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
