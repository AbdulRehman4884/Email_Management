/**
 * src/mcp/tools/enrichment/classifyIndustry.tool.ts
 *
 * Deterministic industry classification — no external API calls.
 * Priority: existingIndustry → domain keywords → companyName → websiteText.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { ClassifyIndustrySchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";

// [keyword, industry, subIndustry?] — checked in order; first match wins
const INDUSTRY_TAXONOMY: Array<[string, string, string?]> = [
  ["saas",          "Technology",            "SaaS"],
  ["fintech",       "Technology",            "FinTech"],
  ["edtech",        "Technology",            "EdTech"],
  ["healthtech",    "Technology",            "HealthTech"],
  ["cybersecurity", "Technology",            "Cybersecurity"],
  ["cyber",         "Technology",            "Cybersecurity"],
  ["blockchain",    "Technology",            "Blockchain"],
  ["machine learning", "Technology",         "AI/ML"],
  ["artificial intelligence", "Technology",  "AI/ML"],
  ["tech",          "Technology"],
  ["software",      "Technology"],
  ["digital",       "Technology"],
  ["cloud",         "Technology"],
  ["data",          "Technology"],
  ["hedge fund",    "Finance & Banking",     "Investment"],
  ["wealth",        "Finance & Banking",     "Wealth Management"],
  ["bank",          "Finance & Banking"],
  ["finance",       "Finance & Banking"],
  ["capital",       "Finance & Banking",     "Investment"],
  ["invest",        "Finance & Banking",     "Investment"],
  ["credit",        "Finance & Banking"],
  ["insurance",     "Insurance"],
  ["insure",        "Insurance"],
  ["underwrite",    "Insurance"],
  ["biotech",       "Healthcare",            "Biotech"],
  ["pharma",        "Healthcare",            "Pharmaceuticals"],
  ["health",        "Healthcare"],
  ["medical",       "Healthcare"],
  ["clinic",        "Healthcare"],
  ["hospital",      "Healthcare"],
  ["ecommerce",     "Retail & E-commerce"],
  ["e-commerce",    "Retail & E-commerce"],
  ["retail",        "Retail & E-commerce"],
  ["marketplace",   "Retail & E-commerce"],
  ["shop",          "Retail & E-commerce"],
  ["supply chain",  "Logistics & Supply Chain"],
  ["logistics",     "Logistics & Supply Chain"],
  ["freight",       "Logistics & Supply Chain"],
  ["transport",     "Logistics & Supply Chain"],
  ["university",    "Education",             "Higher Education"],
  ["school",        "Education"],
  ["academy",       "Education"],
  ["learn",         "Education"],
  ["law firm",      "Legal Services"],
  ["attorney",      "Legal Services"],
  ["legal",         "Legal Services"],
  ["real estate",   "Real Estate"],
  ["property",      "Real Estate"],
  ["realty",        "Real Estate"],
  ["construction",  "Construction"],
  ["build",         "Construction"],
  ["architect",     "Construction"],
  ["hospitality",   "Food & Hospitality"],
  ["restaurant",    "Food & Hospitality"],
  ["hotel",         "Food & Hospitality"],
  ["food",          "Food & Hospitality"],
  ["advertising",   "Media & Creative"],
  ["publishing",    "Media & Creative"],
  ["media",         "Media & Creative"],
  ["design",        "Media & Creative"],
  ["consulting",    "Consulting"],
  ["advisory",      "Consulting"],
  ["strategy",      "Consulting"],
  ["renewable",     "Energy",               "Renewables"],
  ["solar",         "Energy",               "Renewables"],
  ["oil",           "Energy",               "Oil & Gas"],
  ["energy",        "Energy"],
  ["agriculture",   "Agriculture"],
  ["farming",       "Agriculture"],
  ["agri",          "Agriculture"],
  ["manufacturing", "Manufacturing"],
  ["factory",       "Manufacturing"],
];

export interface ClassifyIndustryResult {
  industry: string;
  subIndustry?: string;
  confidence: "low" | "medium" | "high";
}

export const classifyIndustryTool: McpToolDefinition<
  typeof ClassifyIndustrySchema,
  ClassifyIndustryResult
> = {
  name: TOOL_NAMES.CLASSIFY_INDUSTRY,

  description:
    "Classifies the industry of a company using heuristic keyword matching. " +
    "No external API calls. Priority: existingIndustry → domain → companyName → websiteText.",

  inputSchema: ClassifyIndustrySchema,

  handler: async (input, context) => {
    const { companyName, websiteText, domain, existingIndustry } = input;

    if (existingIndustry?.trim()) {
      context.log.debug({ existingIndustry }, "classifyIndustry: using provided value");
      return toolSuccess<ClassifyIndustryResult>({
        industry: existingIndustry.trim(),
        confidence: "high",
      });
    }

    const corpus = [domain ?? "", companyName ?? "", websiteText ?? ""]
      .join(" ")
      .toLowerCase();

    if (!corpus.trim()) {
      return toolSuccess<ClassifyIndustryResult>({ industry: "Unknown", confidence: "low" });
    }

    let matched: { industry: string; subIndustry?: string } | undefined;
    for (const [keyword, industry, subIndustry] of INDUSTRY_TAXONOMY) {
      if (corpus.includes(keyword)) {
        matched = { industry, ...(subIndustry !== undefined ? { subIndustry } : {}) };
        break;
      }
    }

    if (!matched) {
      return toolSuccess<ClassifyIndustryResult>({ industry: "Unknown", confidence: "low" });
    }

    const confidence: "low" | "medium" | "high" =
      websiteText ? "high" : domain ? "medium" : "low";

    context.log.debug(
      { industry: matched.industry, subIndustry: matched.subIndustry, confidence },
      "classifyIndustry: result",
    );
    return toolSuccess<ClassifyIndustryResult>({
      industry: matched.industry,
      ...(matched.subIndustry !== undefined ? { subIndustry: matched.subIndustry } : {}),
      confidence,
    });
  },
};
