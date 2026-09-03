/**
 * src/mcp/tools/enrichment/extractDomain.tool.ts
 *
 * Extracts and normalizes the registered domain from an email address, URL,
 * or raw domain string. Pure computation — no external API calls.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { ExtractDomainSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import { extractDomain } from "../../../services/enrichment/domainExtraction.service.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { DomainExtractionResult } from "../../../services/enrichment/domainExtraction.service.js";

export { type DomainExtractionResult };

export const extractDomainTool: McpToolDefinition<
  typeof ExtractDomainSchema,
  DomainExtractionResult
> = {
  name: TOOL_NAMES.EXTRACT_DOMAIN,

  description:
    "Extracts and normalizes the registered domain from an email address, URL, or raw domain. " +
    "Returns the domain (SLD + TLD), subdomain (if any), TLD, a canonical website URL, and " +
    "whether the domain belongs to a known personal email provider (e.g. gmail.com). " +
    "No external API calls are made.",

  inputSchema: ExtractDomainSchema,

  handler: async (input, context) => {
    const result = extractDomain(input.input);
    if (!result) {
      context.log.debug({ input: input.input }, "extract_domain: could not parse input");
      return toolFailure(
        "INVALID_INPUT",
        `Could not extract a domain from "${input.input}". ` +
        "Provide a valid email address, URL, or domain name.",
      );
    }
    context.log.debug(
      { input: input.input, domain: result.domain },
      "extract_domain: complete",
    );
    return toolSuccess(result);
  },
};
