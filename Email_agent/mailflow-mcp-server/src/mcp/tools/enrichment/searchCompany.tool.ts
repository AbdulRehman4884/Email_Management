/**
 * src/mcp/tools/enrichment/searchCompany.tool.ts
 *
 * Heuristic company lookup — no external API calls.
 * Derives industry and summary from company name keyword matching.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { SearchCompanySchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";

const COMPANY_INDUSTRY_HINTS: Array<[string, string]> = [
  ["saas",       "Technology"],  ["fintech",    "Technology"],
  ["tech",       "Technology"],  ["software",   "Technology"],
  ["digital",    "Technology"],  ["cloud",      "Technology"],
  ["cyber",      "Technology"],  ["analytics",  "Technology"],
  ["platform",   "Technology"],  ["ai",         "Technology"],
  ["bank",       "Finance & Banking"], ["finance",   "Finance & Banking"],
  ["capital",    "Finance & Banking"], ["invest",    "Finance & Banking"],
  ["wealth",     "Finance & Banking"], ["credit",    "Finance & Banking"],
  ["insurance",  "Insurance"],   ["insure",     "Insurance"],
  ["health",     "Healthcare"],  ["medical",    "Healthcare"],
  ["clinic",     "Healthcare"],  ["pharma",     "Healthcare"],
  ["hospital",   "Healthcare"],  ["bio",        "Healthcare"],
  ["retail",     "Retail & E-commerce"], ["shop", "Retail & E-commerce"],
  ["ecommerce",  "Retail & E-commerce"], ["market", "Retail & E-commerce"],
  ["logistics",  "Logistics & Supply Chain"], ["freight", "Logistics & Supply Chain"],
  ["supply",     "Logistics & Supply Chain"], ["transport", "Logistics & Supply Chain"],
  ["school",     "Education"],   ["academy",    "Education"],
  ["learn",      "Education"],   ["university", "Education"],
  ["legal",      "Legal Services"], ["law",      "Legal Services"],
  ["property",   "Real Estate"], ["realty",     "Real Estate"],
  ["estate",     "Real Estate"],
  ["construct",  "Construction"], ["build",     "Construction"],
  ["architect",  "Construction"],
  ["restaurant", "Food & Hospitality"], ["hotel", "Food & Hospitality"],
  ["food",       "Food & Hospitality"], ["cater",  "Food & Hospitality"],
  ["media",      "Media & Creative"],   ["design", "Media & Creative"],
  ["publish",    "Media & Creative"],   ["studio", "Media & Creative"],
  ["consult",    "Consulting"],  ["advisory",   "Consulting"],
  ["strategy",   "Consulting"],
  ["energy",     "Energy"],      ["solar",      "Energy"],
  ["power",      "Energy"],      ["utility",    "Energy"],
  ["agri",       "Agriculture"], ["farm",       "Agriculture"],
  ["manufactur", "Manufacturing"], ["factory",  "Manufacturing"],
];

export interface SearchCompanyResult {
  companyName: string;
  website?: string;
  industry?: string;
  summary?: string;
  source: string;
  confidence: "low" | "medium" | "high";
}

export const searchCompanyTool: McpToolDefinition<
  typeof SearchCompanySchema,
  SearchCompanyResult
> = {
  name: TOOL_NAMES.SEARCH_COMPANY,

  description:
    "Looks up company information using heuristic keyword analysis of the company name. " +
    "No external API calls. Returns industry classification, optional website, and confidence.",

  inputSchema: SearchCompanySchema,

  handler: async (input, context) => {
    const { companyName, website } = input;
    const nameLower = companyName.toLowerCase();

    let industry: string | undefined;
    for (const [keyword, ind] of COMPANY_INDUSTRY_HINTS) {
      if (nameLower.includes(keyword)) {
        industry = ind;
        break;
      }
    }

    const confidence: "low" | "medium" | "high" = industry ? "medium" : "low";
    const summary = industry
      ? `${companyName} appears to operate in the ${industry} sector (inferred from name).`
      : `Company: ${companyName}. Industry could not be determined from name alone.`;

    const result: SearchCompanyResult = {
      companyName,
      ...(website  !== undefined ? { website }  : {}),
      ...(industry !== undefined ? { industry } : {}),
      summary,
      source: "heuristic:name-analysis",
      confidence,
    };

    context.log.debug({ companyName, industry, confidence }, "searchCompany: result");
    return toolSuccess(result);
  },
};
