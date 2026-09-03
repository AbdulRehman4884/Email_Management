/**
 * src/mcp/tools/enrichment/verifyCompanyWebsite.tool.ts
 *
 * Verifies whether a given URL is likely the official website for
 * the specified company. Returns a confidence score, verification signals,
 * and any warnings.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { VerifyCompanyWebsiteSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import { verifyCompanyWebsite } from "../../../services/enrichment/companyWebsiteVerifier.service.js";
import type { VerificationResult } from "../../../services/enrichment/companyWebsiteVerifier.service.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export const verifyCompanyWebsiteTool: McpToolDefinition<
  typeof VerifyCompanyWebsiteSchema,
  VerificationResult
> = {
  name: TOOL_NAMES.VERIFY_COMPANY_WEBSITE,

  description:
    "Verifies whether a URL is likely the official website for a given company. " +
    "Checks HTTPS, domain-name similarity, root domain, and social/directory site detection. " +
    "Returns a 0–100 confidence score, a boolean verified flag, positive signals, and warnings.",

  inputSchema: VerifyCompanyWebsiteSchema,

  handler: async (input, context) => {
    const { companyName, url } = input;
    context.log.debug({ companyName, url }, "verify_company_website: starting");

    const result = verifyCompanyWebsite(companyName, url);

    context.log.info(
      { companyName, url, verified: result.verified, confidence: result.confidence },
      "verify_company_website: complete",
    );

    return toolSuccess(result);
  },
};
