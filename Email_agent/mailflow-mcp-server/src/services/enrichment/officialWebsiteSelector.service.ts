/**
 * src/services/enrichment/officialWebsiteSelector.service.ts
 *
 * Scores a list of candidate websites and selects the most likely
 * official company website.
 *
 * Scoring (100-point max):
 *   Domain slug similarity  — 0–40
 *   Title similarity        — 0–25
 *   Not social/directory    — +15
 *   HTTPS                   — +5
 *   Root domain             — +5
 *   Snippet mention         — +10
 *   Location/country match  — +10
 *
 * A candidate is "selected" when its score reaches the SELECTION_THRESHOLD.
 */

import { isSocialDomain } from "./companySearch.service.js";
import type { CandidateWebsite } from "./companySearch.service.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScoredCandidate extends CandidateWebsite {
  score:    number;
  selected: boolean;
  reasons:  string[];
}

export interface ScoreOptions {
  location?: string;
  country?:  string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SELECTION_THRESHOLD = 40;

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function domainSlugSimilarity(companyName: string, url: string): number {
  try {
    const hostname   = new URL(url).hostname.replace(/^www\./, "");
    const domainSlug = (hostname.split(".")[0] ?? "").toLowerCase();
    const tokens     = Array.from(tokenize(companyName)).filter((t) => t.length > 2);
    if (tokens.length === 0) return 0;
    const matches = tokens.filter((t) => domainSlug.includes(t)).length;
    return Math.round((matches / tokens.length) * 40);
  } catch {
    return 0;
  }
}

function titleSimilarity(companyName: string, title: string): number {
  const nameTokens  = Array.from(tokenize(companyName)).filter((t) => t.length > 2);
  const titleTokens = tokenize(title);
  if (nameTokens.length === 0) return 0;
  const matches = nameTokens.filter((t) => titleTokens.has(t)).length;
  return Math.round((matches / nameTokens.length) * 25);
}

function isRootUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname === "/" || pathname === "";
  } catch {
    return false;
  }
}

function snippetMentions(companyName: string, snippet: string): number {
  const tokens       = Array.from(tokenize(companyName)).filter((t) => t.length > 3);
  const lowerSnippet = snippet.toLowerCase();
  return tokens.some((t) => lowerSnippet.includes(t)) ? 10 : 0;
}

function locationMatch(url: string, snippet: string, title: string, opts: ScoreOptions): number {
  const geo = opts.location ?? opts.country;
  if (!geo) return 0;
  const geoLower = geo.toLowerCase();
  const haystack = `${url} ${snippet} ${title}`.toLowerCase();
  return haystack.includes(geoLower) ? 10 : 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scores each candidate and marks the highest-scoring one as `selected`
 * (provided it clears SELECTION_THRESHOLD).
 *
 * Returns candidates sorted highest-score first.
 */
export function scoreAndSelect(
  companyName: string,
  candidates:  CandidateWebsite[],
  opts:        ScoreOptions = {},
): ScoredCandidate[] {
  const scored = candidates.map((c) => {
    const reasons: string[] = [];
    let score = 0;

    const ds = domainSlugSimilarity(companyName, c.url);
    if (ds > 0) { score += ds; reasons.push(`domain matches name (+${ds})`); }

    const ts = titleSimilarity(companyName, c.title);
    if (ts > 0) { score += ts; reasons.push(`title matches (+${ts})`); }

    if (!isSocialDomain(c.url)) {
      score += 15;
      reasons.push("not a social/directory site (+15)");
    }

    if (c.url.startsWith("https://")) {
      score += 5;
      reasons.push("HTTPS (+5)");
    }

    if (isRootUrl(c.url)) {
      score += 5;
      reasons.push("root domain URL (+5)");
    }

    const ss = snippetMentions(companyName, c.snippet);
    if (ss > 0) { score += ss; reasons.push(`snippet mentions company (+${ss})`); }

    const lm = locationMatch(c.url, c.snippet, c.title, opts);
    if (lm > 0) { score += lm; reasons.push(`location/country match (+${lm})`); }

    return { ...c, score, selected: false, reasons };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Mark the top-scorer as selected if it clears the threshold
  if (scored.length > 0 && scored[0]!.score >= SELECTION_THRESHOLD) {
    scored[0]!.selected = true;
  }

  return scored;
}
