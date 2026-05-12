/**
 * src/mcp/tools/enrichment/enrichDomain.tool.ts
 *
 * Heuristic domain enrichment — no external API calls.
 * Derives company name and industry hints from the domain's second-level label
 * and known TLD patterns.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { EnrichDomainSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";

const PERSONAL_DOMAINS = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "hotmail", "outlook", "live",
  "msn", "icloud", "me", "mac", "aol", "aim", "protonmail", "proton",
  "fastmail", "tutanota", "tuta", "gmx", "mail", "inbox", "yandex", "rocketmail",
]);

// Industry hints keyed by common domain keywords
const DOMAIN_INDUSTRY_HINTS: Array<[string, string]> = [
  ["tech",    "Technology"], ["soft",     "Technology"], ["digital",  "Technology"],
  ["code",    "Technology"], ["dev",      "Technology"], ["data",     "Technology"],
  ["cloud",   "Technology"], ["sys",      "Technology"], ["net",      "Technology"],
  ["bank",    "Finance & Banking"], ["finance",  "Finance & Banking"], ["capital",  "Finance & Banking"],
  ["invest",  "Finance & Banking"], ["fund",     "Finance & Banking"], ["wealth",   "Finance & Banking"],
  ["health",  "Healthcare"], ["medical",  "Healthcare"], ["clinic",   "Healthcare"],
  ["pharma",  "Healthcare"], ["hospital", "Healthcare"], ["care",     "Healthcare"],
  ["retail",  "Retail & E-commerce"], ["shop",     "Retail & E-commerce"], ["store",    "Retail & E-commerce"],
  ["trade",   "Trading & Commerce"],  ["market",   "Retail & E-commerce"],
  ["logistic","Logistics & Supply Chain"], ["freight",  "Logistics & Supply Chain"],
  ["supply",  "Logistics & Supply Chain"], ["transport","Logistics & Supply Chain"],
  ["school",  "Education"], ["edu",      "Education"], ["academy",  "Education"],
  ["learn",   "Education"], ["univers",  "Education"],
  ["legal",   "Legal Services"], ["law",      "Legal Services"], ["attorney", "Legal Services"],
  ["property","Real Estate"], ["realty",   "Real Estate"], ["estate",   "Real Estate"],
  ["build",   "Construction"], ["construct","Construction"], ["architect","Construction"],
  ["food",    "Food & Hospitality"], ["restaurant","Food & Hospitality"], ["cater",    "Food & Hospitality"],
  ["media",   "Media & Creative"], ["publish",  "Media & Creative"], ["design",   "Media & Creative"],
  ["consult", "Consulting"], ["advisor",  "Consulting"], ["strateg",  "Consulting"],
  ["insure",  "Insurance"], ["insurance","Insurance"], ["risk",     "Insurance"],
  ["energy",  "Energy"], ["solar",    "Energy"], ["power",    "Energy"], ["utility",  "Energy"],
  ["agri",    "Agriculture"], ["farm",     "Agriculture"],
  ["manuf",   "Manufacturing"], ["factory",  "Manufacturing"], ["industri", "Manufacturing"],
];

export interface EnrichDomainResult {
  domain: string;
  website?: string;
  companyName?: string;
  industry?: string;
  summary?: string;
  source: string;
  confidence: "low" | "medium" | "high";
}

export const enrichDomainTool: McpToolDefinition<
  typeof EnrichDomainSchema,
  EnrichDomainResult
> = {
  name: TOOL_NAMES.ENRICH_DOMAIN,

  description:
    "Enriches a domain with heuristic company and industry information. " +
    "Uses domain label analysis — no external API calls. " +
    "Returns companyName, industry, confidence level, and source.",

  inputSchema: EnrichDomainSchema,

  handler: async (input, context) => {
    const domain = input.domain.toLowerCase().replace(/^www\./, "");

    if (!domain || !domain.includes(".")) {
      return toolFailure("INVALID_DOMAIN", `'${input.domain}' is not a valid domain`);
    }

    const parts = domain.split(".");
    const sld = parts[parts.length - 2] ?? ""; // second-level domain label

    if (PERSONAL_DOMAINS.has(sld)) {
      context.log.debug({ domain }, "enrichDomain: personal email provider — skipping");
      return toolSuccess<EnrichDomainResult>({
        domain,
        source: "heuristic",
        confidence: "low",
        summary: "Consumer email provider — no company enrichment available.",
      });
    }

    // Derive company name from domain (capitalize SLD, strip common suffixes)
    const cleanSld = sld
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const companyName = cleanSld || undefined;

    // Match industry from domain label
    const sldLower = sld.toLowerCase();
    let industry: string | undefined;
    for (const [keyword, ind] of DOMAIN_INDUSTRY_HINTS) {
      if (sldLower.includes(keyword)) {
        industry = ind;
        break;
      }
    }

    const confidence: "low" | "medium" | "high" = industry ? "medium" : "low";

    const result: EnrichDomainResult = {
      domain,
      website: `https://${domain}`,
      ...(companyName !== undefined ? { companyName } : {}),
      ...(industry    !== undefined ? { industry }    : {}),
      summary: industry
        ? `${companyName ?? domain} operates in the ${industry} sector (inferred from domain).`
        : `Company inferred from domain: ${companyName ?? domain}. Industry could not be determined.`,
      source: "heuristic:domain-analysis",
      confidence,
    };

    context.log.debug({ domain, companyName, industry, confidence }, "enrichDomain: result");
    return toolSuccess(result);
  },
};
