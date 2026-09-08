/**
 * src/mcp/tools/enrichment/searchCompanyWeb.tool.ts
 *
 * Searches for a company's official website using DuckDuckGo.
 * Returns up to 8 candidate website URLs (filtered, no social/directory sites).
 *
 * Source values propagated to callers:
 *   "duckduckgo"    — real candidates found
 *   "no_results"    — DDG ran but found nothing useful
 *   "rate_limited"  — DDG temporarily blocked the request
 *   "search_failed" — unexpected DDG error
 *   "timeout"       — request exceeded the timeout threshold
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { SearchCompanyWebSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import { searchCompanyWeb } from "../../../services/enrichment/companySearch.service.js";
import type { CandidateWebsite, CompanySearchStatus } from "../../../services/enrichment/companySearch.service.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export interface SearchCompanyWebResult {
  companyName: string;
  query:       string;
  candidates:  CandidateWebsite[];
  source:      CompanySearchStatus;
  count:       number;
  success:     boolean;
  error?:      string;
  retryable?:  boolean;
}

export const searchCompanyWebTool: McpToolDefinition<
  typeof SearchCompanyWebSchema,
  SearchCompanyWebResult
> = {
  name: TOOL_NAMES.SEARCH_COMPANY_WEB,

  description:
    "Searches for a company's official website using DuckDuckGo and returns filtered " +
    "candidate URLs. Supply optional location/country to narrow results. " +
    "Never returns fake or guessed domains. " +
    "Source field indicates result quality: duckduckgo | no_results | rate_limited | search_failed | timeout.",

  inputSchema: SearchCompanyWebSchema,

  handler: async (input, context) => {
    const { companyName, location, country, maxResults } = input;
    context.log.debug({ companyName, location, country }, "search_company_web: starting");

    const result = await searchCompanyWeb(companyName, {
      ...(location   !== undefined && { location }),
      ...(country    !== undefined && { country }),
      ...(maxResults !== undefined && { maxResults }),
    });

    context.log.info(
      { companyName, count: result.count, source: result.source, success: result.success },
      "search_company_web: complete",
    );

    return toolSuccess({
      companyName:  result.companyName,
      query:        result.query,
      candidates:   result.candidates,
      source:       result.source,
      count:        result.count,
      success:      result.success,
      ...(result.error     !== undefined && { error:     result.error }),
      ...(result.retryable !== undefined && { retryable: result.retryable }),
    });
  },
};
