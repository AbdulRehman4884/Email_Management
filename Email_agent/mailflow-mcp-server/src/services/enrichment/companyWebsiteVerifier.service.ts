/**
 * src/services/enrichment/companyWebsiteVerifier.service.ts
 *
 * Evaluates a URL and determines how likely it is to be the official
 * website for the given company.
 *
 * Confidence scoring (100-point max):
 *   HTTPS                    — +20
 *   Not social/directory     — +40
 *   Domain contains company  — +20
 *   Root domain URL          — +20
 *
 * `verified` = confidence >= 60 AND not a social/directory domain.
 */

import { isSocialDomain } from "./companySearch.service.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VerificationResult {
  url:        string;
  verified:   boolean;
  confidence: number;
  signals:    string[];
  warnings:   string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function domainMatchesCompany(companyName: string, url: string): boolean {
  try {
    const hostname  = new URL(url).hostname.replace(/^www\./, "");
    const domainSlug = (hostname.split(".")[0] ?? "").toLowerCase();
    const tokens     = tokenize(companyName).filter((t) => t.length > 3);
    return tokens.some((t) => domainSlug.includes(t));
  } catch {
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function verifyCompanyWebsite(
  companyName: string,
  url:         string,
): VerificationResult {
  const signals: string[] = [];
  const warnings: string[] = [];
  let confidence = 0;

  const isHttps = url.startsWith("https://");
  if (isHttps) {
    confidence += 20;
    signals.push("HTTPS connection");
  } else {
    warnings.push("URL is not HTTPS");
  }

  const isSocial = isSocialDomain(url);
  if (!isSocial) {
    confidence += 40;
    signals.push("Not a social media or directory site");
  } else {
    warnings.push("URL appears to be a social media or directory profile");
  }

  const hasNameInDomain = domainMatchesCompany(companyName, url);
  if (hasNameInDomain) {
    confidence += 20;
    signals.push("Domain name matches company name");
  } else {
    warnings.push("Domain does not closely match company name");
  }

  let isRoot = false;
  try {
    const parsed = new URL(url);
    isRoot = parsed.pathname === "/" || parsed.pathname === "";
    if (isRoot) {
      confidence += 20;
      signals.push("Root domain URL (not a subpage)");
    }
  } catch {
    warnings.push("URL could not be parsed");
  }

  const verified = confidence >= 60 && !isSocial;

  return { url, verified, confidence, signals, warnings };
}
